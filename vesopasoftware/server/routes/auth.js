import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { q, one, exec } from "../lib/db.js";
import {
  findUserByEmail, createUser, checkPassword, hashPassword,
  passwordProblem, emailProblem, normaliseEmail,
} from "../lib/auth.js";
import { sendMail, layout, esc } from "../lib/mail.js";
import { notifyAdmins, notify } from "../lib/notify.js";
import { config } from "../lib/config.js";

const router = Router();

// Login and reset are the two endpoints worth guessing at, so they get their
// own budget. keyGenerator folds in the email: one attacker hammering one
// account cannot also lock out everybody else behind the same NAT.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${normaliseEmail(req.body?.email || "")}`,
  handler: (req, res) =>
    res.status(429).render("auth/login", {
      title: "Sign in",
      error: "Too many attempts. Wait fifteen minutes and try again.",
      email: req.body?.email || "",
    }),
});

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ---------- login ---------- */

router.get("/login", (req, res) => {
  if (req.user) return res.redirect(req.user.role === "admin" ? "/portal/admin" : "/portal");
  res.render("auth/login", { title: "Sign in", error: null, email: req.query.email || "" });
});

router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body.email);
    const password = String(req.body.password || "");
    const user = await findUserByEmail(email);

    // One message for "no such account" and "wrong password" alike: telling
    // them apart is how an address list gets confirmed.
    const fail = () =>
      res.status(401).render("auth/login", {
        title: "Sign in", error: "Those details do not match an account.", email: req.body.email || "",
      });

    if (!user) { await hashPassword(password); return fail(); } // equalise timing
    if (!(await checkPassword(password, user.password_hash))) return fail();
    if (user.status !== "active") {
      return res.status(403).render("auth/login", {
        title: "Sign in", error: "That account is suspended. Email info@vesopasoftware.com.", email,
      });
    }

    await exec("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);

    // Rotate the session id on privilege change — stops a fixated session id
    // from surviving into an authenticated one.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      const to = req.session.returnTo || (user.role === "admin" ? "/portal/admin" : "/portal");
      delete req.session.returnTo;
      req.session.save(() => res.redirect(to));
    });
  } catch (err) { next(err); }
});

/* ---------- register ---------- */

/* Registration stands on its own — anybody can just make an account.
 *
 * But somebody arriving from the quote builder has already told us what they
 * want, and the POST below quietly claims every unclaimed quote on their
 * email. Quietly is the problem: they had no way of knowing it happened. If a
 * reference is on the URL it is looked up and shown, so the page says what is
 * about to come with them. Nothing depends on it — a bad or missing ref just
 * renders the ordinary form. */
router.get("/register", async (req, res, next) => {
  try {
    if (req.user) return res.redirect("/portal");

    const ref = String(req.query.quote || "").trim().slice(0, 40);
    let quote = null;
    if (ref) {
      quote = await one(
        `SELECT ref, name, email, company, phone, service_type, scope_tier, timeline,
                estimate_min, estimate_max, currency
           FROM quotes WHERE ref = ? AND user_id IS NULL`, [ref]);
    }

    res.render("auth/register", {
      title: "Create an account", error: null, quote,
      form: {
        // The quote's own answers beat the query string: they came from a form
        // this person filled in, not from a link that could have been edited.
        email: quote?.email || req.query.email || "",
        name: quote?.name || "",
        company: quote?.company || "",
        phone: quote?.phone || "",
      },
    });
  } catch (err) { next(err); }
});

router.post("/register", authLimiter, async (req, res, next) => {
  const form = {
    email: normaliseEmail(req.body.email),
    name: String(req.body.name || "").trim().slice(0, 120),
    company: String(req.body.company || "").trim().slice(0, 150),
    phone: String(req.body.phone || "").trim().slice(0, 40),
  };
  const bad = (error) => res.status(400).render("auth/register", { title: "Create an account", error, form, quote: null });

  try {
    if (!form.name) return bad("Your name is required.");
    const ep = emailProblem(form.email); if (ep) return bad(ep);
    const pp = passwordProblem(req.body.password); if (pp) return bad(pp);
    if (req.body.password !== req.body.password2) return bad("The two passwords do not match.");
    if (await findUserByEmail(form.email)) return bad("An account already exists for that address. Sign in instead.");

    const id = await createUser({ ...form, password: req.body.password, role: "customer" });

    // Every customer gets an organisation, sole trader or not, so "add a
    // colleague" later needs no migration and no second code path.
    const org = await exec("INSERT INTO organisations (name, owner_id) VALUES (?,?)", [
      form.company || form.name,
      id,
    ]);
    await exec("UPDATE users SET org_id = ?, org_role = 'owner' WHERE id = ?", [org.insertId, id]);

    // Anything they quoted before signing up becomes theirs.
    const claimed = await exec(
      "UPDATE quotes SET user_id = ? WHERE user_id IS NULL AND email = ?", [id, form.email],
    );

    await sendMail({
      to: form.email,
      subject: "Your Vesopa Software account is live",
      template: "welcome",
      text: `Welcome ${form.name}. Your account is ready: ${config.baseUrl}/portal`,
      html: layout({
        heading: `Welcome, ${esc(form.name.split(" ")[0])}`,
        lines: [
          `Your Vesopa Software account is live. It is where your projects, their progress, your quotes and every invoice live in one place.`,
          claimed.affectedRows
            ? `We have attached ${claimed.affectedRows} quote${claimed.affectedRows > 1 ? "s" : ""} you already requested to this account.`
            : `Start by telling us about a project — you will get an estimate straight away.`,
          `Signed in as <b>${esc(form.email)}</b>.`,
        ],
        cta: { label: "Open your portal", href: `${config.baseUrl}/portal` },
      }),
    });

    await notifyAdmins({
      kind: "customer",
      title: `New customer: ${form.name}`,
      body: form.company ? `${form.company} · ${form.email}` : form.email,
      href: `/portal/admin/customers/${id}`,
    });
    await notify(id, {
      kind: "welcome",
      title: "Welcome to Vesopa Software",
      body: "Submit a project brief and we will come back with a plan.",
      href: "/portal/projects/new",
    });

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = id;
      req.session.flash = { kind: "ok", message: "Account created. Welcome aboard." };
      req.session.save(() => res.redirect("/portal"));
    });
  } catch (err) { next(err); }
});

/* ---------- logout ---------- */

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("vesopa.sid");
    res.redirect("/portal/login");
  });
});

/* ---------- forgotten password ---------- */

router.get("/forgot", (req, res) =>
  res.render("auth/forgot", { title: "Reset your password", error: null, sent: false }));

router.post("/forgot", authLimiter, async (req, res, next) => {
  try {
    const email = normaliseEmail(req.body.email);
    const user = await findUserByEmail(email);

    // Always render the same "check your inbox" page. Whether an address holds
    // an account is not something a stranger gets to find out from this form.
    const done = () => res.render("auth/forgot", { title: "Reset your password", error: null, sent: true });
    if (!user) return done();

    // One live link at a time: issuing a new one retires the old.
    await exec("UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL", [user.id]);

    const token = crypto.randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // one hour
    await exec(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)",
      [user.id, sha(token), expires],
    );

    const link = `${config.baseUrl}/portal/reset/${token}`;
    await sendMail({
      to: user.email,
      subject: "Reset your Vesopa password",
      template: "password_reset",
      text: `Reset your password: ${link}\nThis link works once and expires in an hour.`,
      html: layout({
        heading: "Reset your password",
        lines: [
          `Someone asked to reset the password for <b>${esc(user.email)}</b>.`,
          `The link below works once and expires in an hour.`,
          `If that was not you, ignore this — nothing has changed and your password still works.`,
        ],
        cta: { label: "Set a new password", href: link },
      }),
    });

    done();
  } catch (err) { next(err); }
});

async function liveReset(token) {
  if (!token) return null;
  return one(
    `SELECT pr.*, u.email, u.name FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW() LIMIT 1`,
    [sha(token)],
  );
}

router.get("/reset/:token", async (req, res, next) => {
  try {
    const reset = await liveReset(req.params.token);
    if (!reset) {
      return res.status(400).render("auth/reset", {
        title: "Reset your password", token: null,
        error: "That link has expired or has already been used. Ask for a new one.",
      });
    }
    res.render("auth/reset", { title: "Reset your password", token: req.params.token, error: null });
  } catch (err) { next(err); }
});

router.post("/reset/:token", authLimiter, async (req, res, next) => {
  try {
    const reset = await liveReset(req.params.token);
    if (!reset) {
      return res.status(400).render("auth/reset", {
        title: "Reset your password", token: null,
        error: "That link has expired or has already been used. Ask for a new one.",
      });
    }
    const pp = passwordProblem(req.body.password);
    if (pp) return res.status(400).render("auth/reset", { title: "Reset your password", token: req.params.token, error: pp });
    if (req.body.password !== req.body.password2) {
      return res.status(400).render("auth/reset", {
        title: "Reset your password", token: req.params.token, error: "The two passwords do not match.",
      });
    }

    await exec("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(req.body.password), reset.user_id]);
    await exec("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [reset.id]);

    // Any other session for this account is now suspect — a password reset is
    // exactly the moment to evict whoever else was signed in.
    await exec("DELETE FROM sessions WHERE data LIKE ?", [`%"userId":${reset.user_id}%`]).catch(() => {});

    await sendMail({
      to: reset.email,
      subject: "Your Vesopa password has changed",
      template: "password_changed",
      text: "Your password was changed. If this was not you, contact us at once.",
      html: layout({
        heading: "Your password has changed",
        lines: [`The password for <b>${esc(reset.email)}</b> was just changed, and every other session has been signed out.`,
                `If that was not you, reply to this email immediately.`],
        cta: { label: "Sign in", href: `${config.baseUrl}/portal/login` },
      }),
    });

    req.session.flash = { kind: "ok", message: "Password updated. Sign in with it." };
    res.redirect("/portal/login");
  } catch (err) { next(err); }
});

/* ---------- accepting a team invitation ---------- */

async function liveInvite(token) {
  if (!token) return null;
  return one(
    `SELECT i.*, o.name AS org_name FROM invitations i
       JOIN organisations o ON o.id = i.org_id
      WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > NOW() LIMIT 1`,
    [sha(token)],
  );
}

router.get("/invite/:token", async (req, res, next) => {
  try {
    const invite = await liveInvite(req.params.token);
    if (!invite) {
      return res.status(400).render("auth/invite", {
        title: "Join the team", invite: null, token: null,
        error: "That invitation has expired or has already been used. Ask for a new one.",
      });
    }
    res.render("auth/invite", { title: `Join ${invite.org_name}`, invite, token: req.params.token, error: null });
  } catch (err) { next(err); }
});

router.post("/invite/:token", authLimiter, async (req, res, next) => {
  try {
    const invite = await liveInvite(req.params.token);
    const stale = () =>
      res.status(400).render("auth/invite", {
        title: "Join the team", invite: null, token: null,
        error: "That invitation has expired or has already been used. Ask for a new one.",
      });
    if (!invite) return stale();

    const bad = (error) =>
      res.status(400).render("auth/invite", { title: "Join the team", invite, token: req.params.token, error });

    const name = String(req.body.name || invite.name || "").trim().slice(0, 120);
    if (!name) return bad("Your name is required.");
    const pp = passwordProblem(req.body.password); if (pp) return bad(pp);
    if (req.body.password !== req.body.password2) return bad("The two passwords do not match.");

    // An address that already holds an account cannot be re-registered here.
    // Moving an existing user between organisations is a support action, not
    // something an invitation link should be able to do silently.
    if (await findUserByEmail(invite.email)) {
      return bad("An account already exists for that address. Sign in with it instead.");
    }

    const id = await createUser({
      email: invite.email, password: req.body.password, name,
      company: invite.org_name, phone: String(req.body.phone || "").trim().slice(0, 40),
      role: "customer",
    });
    await exec("UPDATE users SET org_id = ?, org_role = ?, job_title = ? WHERE id = ?", [
      invite.org_id, invite.org_role, String(req.body.job_title || "").trim().slice(0, 100) || null, id,
    ]);
    await exec("UPDATE invitations SET accepted_at = NOW() WHERE id = ?", [invite.id]);

    if (invite.invited_by) {
      await notify(invite.invited_by, {
        kind: "team", title: `${name} joined your team`,
        body: `${invite.email} · ${invite.org_role}`, href: "/portal/team",
      });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = id;
      req.session.flash = { kind: "ok", message: `You are in. Welcome to ${invite.org_name}.` };
      req.session.save(() => res.redirect("/portal"));
    });
  } catch (err) { next(err); }
});

/* ---------- notifications (read + mark read) ---------- */

router.get("/notifications.json", async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false });
  const rows = await q(
    "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 15", [req.user.id],
  );
  const [{ n }] = await q(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", [req.user.id],
  );
  res.json({ ok: true, unread: n, items: rows });
});

router.post("/notifications/read", async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false });
  await exec("UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL", [req.user.id]);
  res.json({ ok: true });
});

export default router;
