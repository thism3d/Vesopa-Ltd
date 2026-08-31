import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { q, one, exec, nextRef, pool } from "../lib/db.js";
import { upload, UPLOAD_DIR, isImage, prettySize } from "../lib/uploads.js";
import { listZip } from "../lib/zip.js";
import { requireAuth, hashPassword, checkPassword, passwordProblem, emailProblem, normaliseEmail } from "../lib/auth.js";
import { can, requireCap, ORG_ROLES, roleLabel } from "../lib/permissions.js";
import { priceQuote, SERVICES, TIERS, FEATURES, TIMELINES, moneyRound } from "../lib/pricing.js";
import { recalc, balanceOf } from "../lib/invoices.js";
import { sendMail, layout, esc } from "../lib/mail.js";
import { notifyAdmins, notify, unreadCount } from "../lib/notify.js";
import { toProject, toUser, toAdmins, joinProjectRoom } from "../lib/realtime.js";
import { config } from "../lib/config.js";

const router = Router();
router.use(requireAuth);

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Everything in the customer area wants these two, and the templates read them
// off res.locals rather than being handed them route by route.
router.use(async (req, res, next) => {
  try {
    res.locals.unread = await unreadCount(req.user.id);
    res.locals.can = (cap) => can(req.user, cap);
    next();
  } catch (err) { next(err); }
});

/** Access is decided on the organisation, not the person who happened to
 *  create the record — that is what makes a team work at all. */
async function ownedProject(req, id) {
  const p = await one("SELECT * FROM projects WHERE id = ?", [id]);
  if (!p) return null;
  if (req.user.role === "admin") return p;
  if (p.user_id === req.user.id) return p;
  if (p.org_id && req.user.org_id && p.org_id === req.user.org_id) return p;
  return null;
}

/** The org's people, or just this user if somehow they have no org. */
const orgScope = (user) =>
  user.org_id
    ? { where: "(u.org_id = ? OR u.id = ?)", params: [user.org_id, user.id] }
    : { where: "u.id = ?", params: [user.id] };

/** Every invoice belonging to the signed-in person's organisation. */
async function orgInvoices(user, { includeDrafts = false } = {}) {
  const scope = user.org_id ? "(i.org_id = ? OR i.user_id = ?)" : "i.user_id = ?";
  const params = user.org_id ? [user.org_id, user.id] : [user.id];
  return q(
    `SELECT i.*, p.title AS project_title FROM invoices i
       LEFT JOIN projects p ON p.id = i.project_id
      WHERE ${scope} ${includeDrafts ? "" : "AND i.status <> 'draft'"}
      ORDER BY i.issue_date DESC, i.id DESC`,
    params,
  );
}

async function orgProjects(user) {
  const scope = user.org_id ? "(org_id = ? OR user_id = ?)" : "user_id = ?";
  const params = user.org_id ? [user.org_id, user.id] : [user.id];
  return q(
    `SELECT * FROM projects WHERE ${scope}
      ORDER BY FIELD(status,'in_progress','review','scoping','enquiry','on_hold','live','complete','cancelled'),
               created_at DESC`,
    params,
  );
}

async function pendingCharges(user) {
  const scope = user.org_id ? "(c.org_id = ? OR c.user_id = ?)" : "c.user_id = ?";
  const params = user.org_id ? [user.org_id, user.id] : [user.id];
  return q(
    `SELECT c.*, p.title AS project_title FROM charges c
       LEFT JOIN projects p ON p.id = c.project_id
      WHERE ${scope} AND c.status = 'pending' ORDER BY c.incurred_on DESC, c.id DESC`,
    params,
  );
}

async function orgSubscriptions(user) {
  const scope = user.org_id ? "(s.org_id = ? OR s.user_id = ?)" : "s.user_id = ?";
  const params = user.org_id ? [user.org_id, user.id] : [user.id];
  return q(
    `SELECT s.*, p.title AS project_title FROM subscriptions s
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE ${scope} AND s.status <> 'cancelled' ORDER BY s.next_charge_date`,
    params,
  );
}

/* ---------- dashboard ---------- */

router.get("/", async (req, res, next) => {
  try {
    if (req.user.role === "admin") return res.redirect("/portal/admin");

    const [projects, quotes, invoices, updates, charges, subs] = await Promise.all([
      orgProjects(req.user),
      q("SELECT * FROM quotes WHERE user_id = ? ORDER BY created_at DESC LIMIT 5", [req.user.id]),
      orgInvoices(req.user),
      q(`SELECT pu.*, p.title AS project_title, p.ref AS project_ref, p.id AS pid
           FROM project_updates pu JOIN projects p ON p.id = pu.project_id
          WHERE ${req.user.org_id ? "(p.org_id = ? OR p.user_id = ?)" : "p.user_id = ?"}
            AND pu.is_internal = 0
          ORDER BY pu.created_at DESC LIMIT 8`,
        req.user.org_id ? [req.user.org_id, req.user.id] : [req.user.id]),
      pendingCharges(req.user),
      orgSubscriptions(req.user),
    ]);

    const outstanding = invoices
      .filter((i) => i.status !== "paid" && i.status !== "void")
      .reduce((s, i) => s + balanceOf(i), 0);
    const paidTotal = invoices.reduce((s, i) => s + Number(i.amount_paid || 0), 0);
    const pendingTotal = charges.reduce((s, c) => s + Number(c.amount || 0), 0);
    const monthlyRecurring = subs
      .filter((s) => s.status === "active")
      .reduce((s, x) => s + Number(x.amount) / (x.interval_unit === "yearly" ? 12 : x.interval_unit === "quarterly" ? 3 : 1), 0);

    res.render("customer/dashboard", {
      title: "Your dashboard",
      projects, quotes, invoices, updates, charges, subs,
      outstanding, paidTotal, pendingTotal, monthlyRecurring,
    });
  } catch (err) { next(err); }
});

/* ---------- projects ---------- */

router.get("/projects", async (req, res, next) => {
  try {
    res.render("customer/projects", { title: "Your projects", projects: await orgProjects(req.user) });
  } catch (err) { next(err); }
});

router.get("/projects/new", requireCap("project.create"), (req, res) =>
  res.render("customer/project-new", {
    title: "Start a project",
    services: SERVICES, tiers: TIERS, features: FEATURES, timelines: TIMELINES,
    error: null, form: {},
  }));

router.post("/projects/new", requireCap("project.create"), async (req, res, next) => {
  try {
    const b = req.body || {};
    const title = String(b.title || "").trim().slice(0, 160);
    if (!title) {
      return res.status(400).render("customer/project-new", {
        title: "Start a project", services: SERVICES, tiers: TIERS, features: FEATURES, timelines: TIMELINES,
        error: "Give the project a name so we both know what we are talking about.", form: b,
      });
    }

    const features = Array.isArray(b.features) ? b.features : b.features ? [b.features] : [];
    const priced = priceQuote({ ...b, features });
    const quoteRef = await nextRef("quotes", "ref", "VQ");

    const quote = await exec(
      `INSERT INTO quotes (ref, user_id, name, email, phone, company, service_type, scope_tier,
                           timeline, features, estimate_min, estimate_max, currency, message, source, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'portal', 'new')`,
      [quoteRef, req.user.id, req.user.name, req.user.email, req.user.phone, req.user.company,
       priced.service.id, priced.tier.id, priced.timeline.id, JSON.stringify(features),
       priced.min, priced.max, config.currency, String(b.description || "").slice(0, 4000) || null],
    );

    const projectRef = await nextRef("projects", "ref", "VP");
    const project = await exec(
      `INSERT INTO projects (ref, user_id, org_id, quote_id, title, service_type, description,
                             status, budget_amount, currency, target_date)
       VALUES (?,?,?,?,?,?,?, 'enquiry', ?, ?, ?)`,
      [projectRef, req.user.id, req.user.org_id, quote.insertId, title, priced.service.id,
       String(b.description || "").slice(0, 4000) || null, priced.min, config.currency, b.target_date || null],
    );

    await exec(
      "INSERT INTO project_members (project_id, user_id, side, role_label) VALUES (?,?, 'customer', ?)",
      [project.insertId, req.user.id, req.user.job_title || "Main contact"],
    );
    await exec(
      `INSERT INTO project_updates (project_id, author_id, title, body, progress_pct) VALUES (?,?,?,?,0)`,
      [project.insertId, req.user.id, "Brief submitted",
       `Estimate ${moneyRound(priced.min)} – ${moneyRound(priced.max)}. Waiting on Vesopa to scope it.`],
    );

    joinProjectRoom(req.user.id, project.insertId);

    const band = `${moneyRound(priced.min)} – ${moneyRound(priced.max)}`;
    await sendMail({
      to: req.user.email,
      subject: `Brief received — ${projectRef} ${title}`,
      template: "project_new_customer",
      text: `We have your brief for ${title} (${projectRef}). Estimate ${band}.`,
      html: layout({
        heading: "We have your brief",
        lines: [`<b>${esc(title)}</b> is logged as ${projectRef}.`,
                `Working estimate <b>${band}</b> — ${esc(priced.service.label)}, ${esc(priced.tier.label)}.`,
                `Next: one of us scopes it and comes back with a firm figure. Every step shows on your dashboard.`],
        cta: { label: "Track this project", href: `${config.baseUrl}/portal/projects/${project.insertId}` },
      }),
    });
    await sendMail({
      to: config.mail.admin,
      subject: `New brief ${projectRef} — ${req.user.name} — ${band}`,
      template: "project_new_admin",
      text: `${req.user.name}: ${title}\n${band}`,
      html: layout({
        heading: `New brief ${projectRef}`,
        lines: [`<b>${esc(req.user.name)}</b>${req.user.company ? ` · ${esc(req.user.company)}` : ""} · ${esc(req.user.email)}`,
                `<b>${esc(title)}</b> — ${esc(priced.service.label)}, ${esc(priced.tier.label)}, ${esc(priced.timeline.label)}`,
                `Estimate <b>${band}</b>`,
                b.description ? `“${esc(String(b.description).slice(0, 1000))}”` : "No description given."],
        cta: { label: "Open project", href: `${config.baseUrl}/portal/admin/projects/${project.insertId}` },
      }),
    });

    await notifyAdmins({
      kind: "project", title: `New brief: ${title}`,
      body: `${req.user.name} · ${band}`, href: `/portal/admin/projects/${project.insertId}`,
    });
    toAdmins("project:new", { id: project.insertId, ref: projectRef, title, customer: req.user.name });

    req.flash("ok", `Brief received. Your reference is ${projectRef}.`);
    res.redirect(`/portal/projects/${project.insertId}`);
  } catch (err) { next(err); }
});

router.get("/projects/:id", async (req, res, next) => {
  try {
    const project = await ownedProject(req, req.params.id);
    if (!project) {
      return res.status(404).render("error", {
        title: "No such project", message: "That project does not exist, or is not yours.", back: "/portal",
      });
    }

    const [updates, messages, invoices, members, charges, files, tasks] = await Promise.all([
      q(`SELECT pu.*, u.name AS author FROM project_updates pu
           LEFT JOIN users u ON u.id = pu.author_id
          WHERE pu.project_id = ? AND pu.is_internal = 0 ORDER BY pu.created_at DESC`, [project.id]),
      // A private message is visible only to its two ends. Everything with a
      // NULL recipient is the open thread.
      q(`SELECT m.*, u.name AS author, u.role AS author_role, u.job_title,
                i.number AS invoice_number, i.total AS invoice_total, i.status AS invoice_status,
                i.currency AS invoice_currency, i.amount_paid AS invoice_paid
           FROM messages m
           LEFT JOIN users u ON u.id = m.user_id
           LEFT JOIN invoices i ON i.id = m.invoice_id
          WHERE m.project_id = ?
            AND (m.recipient_id IS NULL OR m.recipient_id = ? OR m.user_id = ?)
          ORDER BY m.created_at ASC`, [project.id, req.user.id, req.user.id]),
      q(`SELECT * FROM invoices WHERE project_id = ? AND status <> 'draft' ORDER BY issue_date DESC`, [project.id]),
      q(`SELECT pm.*, u.name, u.email, u.job_title, u.org_role, u.role
           FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = ? ORDER BY pm.side DESC, u.name`, [project.id]),
      q(`SELECT * FROM charges WHERE project_id = ? AND status = 'pending' ORDER BY incurred_on DESC`, [project.id]),
      q(`SELECT f.*, u.name AS uploader FROM project_files f LEFT JOIN users u ON u.id = f.user_id
          WHERE f.project_id = ? ORDER BY f.created_at DESC`, [project.id]),
      q(`SELECT t.*, a.name AS assignee FROM project_tasks t LEFT JOIN users a ON a.id = t.assignee_id
          WHERE t.project_id = ? AND t.is_visible = 1
          ORDER BY FIELD(t.status,'doing','todo','blocked','done'), t.sort_order, t.id`, [project.id]),
    ]);

    await exec(
      "UPDATE messages SET read_at = NOW() WHERE project_id = ? AND read_at IS NULL AND user_id <> ?",
      [project.id, req.user.id],
    );

    res.render("customer/project", {
      title: project.title, project, updates, messages, invoices, members, charges,
      files, tasks, roleLabel, prettySize,
    });
  } catch (err) { next(err); }
});

/* ---------- the conversation ---------- */

router.post("/projects/:id/messages", requireCap("message.send"), async (req, res, next) => {
  try {
    const project = await ownedProject(req, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: "No such project." });

    const body = String(req.body.body || "").trim().slice(0, 4000);
    if (!body) return res.status(400).json({ ok: false, error: "Empty message." });

    // A direct message must be addressed to someone actually on the project,
    // or it is quietly downgraded to the open thread rather than leaking.
    let recipientId = Number(req.body.recipient_id) || null;
    if (recipientId) {
      const member = await one(
        "SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?",
        [project.id, recipientId],
      );
      if (!member) recipientId = null;
    }

    const result = await exec(
      "INSERT INTO messages (project_id, user_id, recipient_id, body) VALUES (?,?,?,?)",
      [project.id, req.user.id, recipientId, body],
    );
    const row = await one(
      `SELECT m.*, u.name AS author, u.role AS author_role, u.job_title FROM messages m
         LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`, [result.insertId]);

    // Private messages go to the two ends only; open ones to the room.
    if (recipientId) {
      toUser(recipientId, "message", { projectId: project.id, message: row });
      toUser(req.user.id, "message", { projectId: project.id, message: row });
      await notify(recipientId, {
        kind: "message", title: `${req.user.name} messaged you privately`,
        body: body.slice(0, 200), href: `/portal/projects/${project.id}`,
      });
    } else {
      toProject(project.id, "message", { projectId: project.id, message: row });
      if (req.user.role === "admin") {
        await notify(project.user_id, {
          kind: "message", title: `Message about ${project.title}`,
          body: body.slice(0, 200), href: `/portal/projects/${project.id}`,
        });
      } else {
        await notifyAdmins({
          kind: "message", title: `${req.user.name} on ${project.title}`,
          body: body.slice(0, 200), href: `/portal/admin/projects/${project.id}`,
        });
      }
    }

    res.json({ ok: true, message: row });
  } catch (err) { next(err); }
});

/* ---------- project files ----------
   Either side can attach assets. The bytes live outside the web root and are
   only ever served back through this route, which re-checks project access —
   an uploads/ directory hung off express.static would hand every file to
   anybody who guessed a name. */

router.post("/projects/:id/files", requireCap("message.send"), upload.array("files", 10), async (req, res, next) => {
  try {
    const project = await ownedProject(req, req.params.id);
    if (!project) return res.status(404).render("error", { title: "No such project", message: "Not yours.", back: "/portal" });

    for (const f of req.files || []) {
      await exec(
        `INSERT INTO project_files (project_id, user_id, side, stored_name, original_name, mime, size_bytes, caption)
         VALUES (?,?,?,?,?,?,?,?)`,
        [project.id, req.user.id, req.user.role === "admin" ? "vesopa" : "customer",
         f.filename, f.originalname.slice(0, 255), f.mimetype, f.size,
         String(req.body.caption || "").slice(0, 255) || null],
      );
    }

    if (req.files?.length) {
      toProject(project.id, "files", { projectId: project.id, count: req.files.length, by: req.user.name });
      if (req.user.role !== "admin") {
        await notifyAdmins({
          kind: "file", title: `${req.user.name} added ${req.files.length} file(s)`,
          body: project.title, href: `/portal/admin/projects/${project.id}`,
        });
      } else {
        await notify(project.user_id, {
          kind: "file", title: `New files on ${project.title}`,
          body: `${req.files.length} file(s) added by ${req.user.name}.`, href: `/portal/projects/${project.id}`,
        });
      }
    }

    req.flash("ok", `${req.files?.length || 0} file(s) attached.`);
    res.redirect(`${req.user.role === "admin" ? "/portal/admin" : "/portal"}/projects/${project.id}`);
  } catch (err) { next(err); }
});

router.get("/files/:id", async (req, res, next) => {
  try {
    const file = await one("SELECT * FROM project_files WHERE id = ?", [req.params.id]);
    if (!file) return res.status(404).render("error", { title: "No such file", message: "Gone.", back: "/portal" });
    const project = await ownedProject(req, file.project_id);
    if (!project) return res.status(404).render("error", { title: "No such file", message: "Not yours.", back: "/portal" });

    res.sendFile(path.join(UPLOAD_DIR, file.stored_name), {
      headers: {
        "Content-Type": file.mime || "application/octet-stream",
        // Inline for things a browser renders, attachment for everything else.
        "Content-Disposition":
          `${isImage(file.mime) || file.mime === "application/pdf" ? "inline" : "attachment"}; ` +
          `filename="${file.original_name.replace(/["\\]/g, "")}"`,
      },
    });
  } catch (err) { next(err); }
});

/** Peek inside a .zip without unpacking it — the file manager's archive preview. */
router.get("/files/:id/zip.json", async (req, res, next) => {
  try {
    const file = await one("SELECT * FROM project_files WHERE id = ?", [req.params.id]);
    if (!file) return res.status(404).json({ ok: false, error: "No such file." });
    if (!(await ownedProject(req, file.project_id))) return res.status(404).json({ ok: false, error: "Not yours." });
    if (!/zip/i.test(file.mime || "") && !/\.zip$/i.test(file.original_name)) {
      return res.status(400).json({ ok: false, error: "Not a zip archive." });
    }
    const listing = await listZip(path.join(UPLOAD_DIR, file.stored_name));
    res.json(listing);
  } catch (err) { next(err); }
});

router.post("/files/:id/delete", async (req, res, next) => {
  try {
    const file = await one("SELECT * FROM project_files WHERE id = ?", [req.params.id]);
    if (!file) return res.redirect("/portal");
    const project = await ownedProject(req, file.project_id);
    // Only the uploader or Vesopa staff can remove an attachment.
    if (!project || (req.user.role !== "admin" && file.user_id !== req.user.id)) {
      req.flash("warn", "That is not yours to remove.");
      return res.redirect(`/portal/projects/${file.project_id}`);
    }
    await exec("DELETE FROM project_files WHERE id = ?", [file.id]);
    await fs.promises.unlink(path.join(UPLOAD_DIR, file.stored_name)).catch(() => {});
    req.flash("ok", "File removed.");
    res.redirect(`${req.user.role === "admin" ? "/portal/admin" : "/portal"}/projects/${file.project_id}`);
  } catch (err) { next(err); }
});

/* ---------- quotes ---------- */

router.get("/quotes", async (req, res, next) => {
  try {
    const scope = req.user.org_id
      ? "(q.user_id = ? OR q.user_id IN (SELECT id FROM users WHERE org_id = ?))"
      : "q.user_id = ?";
    const params = req.user.org_id ? [req.user.id, req.user.org_id] : [req.user.id];
    const rows = await q(`SELECT q.* FROM quotes q WHERE ${scope} ORDER BY q.created_at DESC`, params);
    res.render("customer/quotes", { title: "Your quotes", quotes: rows, FEATURES });
  } catch (err) { next(err); }
});

/* ---------- billing ---------- */

router.get("/invoices", requireCap("billing.view"), async (req, res, next) => {
  try {
    const [invoices, charges, subs] = await Promise.all([
      orgInvoices(req.user), pendingCharges(req.user), orgSubscriptions(req.user),
    ]);
    res.render("customer/invoices", { title: "Billing", invoices, charges, subs });
  } catch (err) { next(err); }
});

router.get("/invoices/:id", requireCap("billing.view"), async (req, res, next) => {
  try {
    const inv = await one("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
    const mine =
      inv &&
      (req.user.role === "admin" ||
        inv.user_id === req.user.id ||
        (inv.org_id && req.user.org_id && inv.org_id === req.user.org_id));
    if (!inv || !mine || (req.user.role !== "admin" && inv.status === "draft")) {
      return res.status(404).render("error", {
        title: "No such invoice", message: "That invoice does not exist, or is not yours.", back: "/portal/invoices",
      });
    }
    const [items, payments, customer, project] = await Promise.all([
      q("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id", [inv.id]),
      q("SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at DESC", [inv.id]),
      one("SELECT * FROM users WHERE id = ?", [inv.user_id]),
      inv.project_id ? one("SELECT * FROM projects WHERE id = ?", [inv.project_id]) : null,
    ]);
    res.render("customer/invoice", { title: `Invoice ${inv.number}`, inv, items, payments, customer, project });
  } catch (err) { next(err); }
});

/** Pay an invoice.
 *
 *  PAYMENT_MODE=mock settles immediately so the whole money flow — balance,
 *  status, earnings, receipt email — is exercisable before a gateway exists.
 *  When a real provider lands, this handler redirects to it instead and the
 *  settle logic moves to its webhook; the provider_ref UNIQUE index is already
 *  there to make that webhook safe to replay. */
router.post("/invoices/:id/pay", requireCap("billing.pay"), async (req, res, next) => {
  try {
    const inv = await one("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
    const mine =
      inv && (inv.user_id === req.user.id || (inv.org_id && req.user.org_id && inv.org_id === req.user.org_id));
    if (!inv || !mine) {
      return res.status(404).render("error", {
        title: "No such invoice", message: "That invoice is not yours.", back: "/portal/invoices",
      });
    }
    if (config.payment.mode === "off") {
      req.flash("warn", "Online payment is switched off. Pay by transfer using the details on the invoice.");
      return res.redirect(`/portal/invoices/${inv.id}`);
    }
    const due = balanceOf(inv);
    if (due <= 0 || inv.status === "void") {
      req.flash("warn", "Nothing left to pay on that invoice.");
      return res.redirect(`/portal/invoices/${inv.id}`);
    }

    await exec(
      `INSERT INTO payments (invoice_id, user_id, amount, currency, method, provider, provider_ref, status, note)
       VALUES (?,?,?,?, 'mock', 'mock', ?, 'settled', ?)`,
      [inv.id, inv.user_id, due, inv.currency, `mock_${crypto.randomBytes(8).toString("hex")}`,
       `Paid in the portal by ${req.user.name} (mock gateway)`],
    );
    const totals = await recalc(inv.id);

    await sendMail({
      to: req.user.email,
      subject: `Receipt — invoice ${inv.number}`,
      template: "receipt",
      text: `Thank you. We have received ${moneyRound(due, inv.currency)} against invoice ${inv.number}.`,
      html: layout({
        heading: "Payment received",
        lines: [`Thank you — <b>${moneyRound(due, inv.currency)}</b> received against invoice <b>${inv.number}</b>.`,
                `That invoice is now ${totals.status === "paid" ? "paid in full" : "part paid"}.`],
        cta: { label: "View invoice", href: `${config.baseUrl}/portal/invoices/${inv.id}` },
      }),
    });

    await notifyAdmins({
      kind: "payment", title: `Payment ${moneyRound(due, inv.currency)} — ${req.user.name}`,
      body: `Invoice ${inv.number} is now ${totals.status}.`, href: `/portal/admin/invoices/${inv.id}`,
    });
    toAdmins("payment", { invoiceId: inv.id, number: inv.number, amount: due, customer: req.user.name });
    if (inv.project_id) toProject(inv.project_id, "invoice:paid", { invoiceId: inv.id, number: inv.number });

    req.flash("ok", `Payment of ${moneyRound(due, inv.currency)} received. Thank you.`);
    res.redirect(`/portal/invoices/${inv.id}`);
  } catch (err) { next(err); }
});

/** Pay several invoices in one go. The whole selection settles or none of it
 *  does — a batch that half-pays is worse than one that failed cleanly. */
router.post("/invoices/pay-batch", requireCap("billing.pay"), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const ids = [].concat(req.body.invoice_ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) { req.flash("warn", "Tick the invoices you want to pay."); return res.redirect("/portal/invoices"); }
    if (config.payment.mode === "off") {
      req.flash("warn", "Online payment is switched off. Pay by transfer using the details on the invoice.");
      return res.redirect("/portal/invoices");
    }

    const scope = req.user.org_id ? "(org_id = ? OR user_id = ?)" : "user_id = ?";
    const scopeParams = req.user.org_id ? [req.user.org_id, req.user.id] : [req.user.id];
    const [invoices] = await conn.query(
      `SELECT * FROM invoices WHERE id IN (${ids.map(() => "?").join(",")})
         AND ${scope} AND status IN ('sent','part_paid')`,
      [...ids, ...scopeParams],
    );
    if (!invoices.length) { req.flash("warn", "Nothing payable in that selection."); return res.redirect("/portal/invoices"); }

    await conn.beginTransaction();
    let total = 0;
    for (const inv of invoices) {
      const due = Math.round(((Number(inv.total) || 0) - (Number(inv.amount_paid) || 0)) * 100) / 100;
      if (due <= 0) continue;
      await conn.query(
        `INSERT INTO payments (invoice_id, user_id, amount, currency, method, provider, provider_ref, status, note)
         VALUES (?,?,?,?, 'mock', 'mock', ?, 'settled', ?)`,
        [inv.id, inv.user_id, due, inv.currency, `mock_${crypto.randomBytes(8).toString("hex")}`,
         `Batch payment by ${req.user.name} (mock gateway)`],
      );
      total += due;
    }
    await conn.commit();

    // recalc() runs on the pool, outside the transaction, once the payments
    // are durable — it reads them back to derive each invoice's new state.
    for (const inv of invoices) await recalc(inv.id);

    await sendMail({
      to: req.user.email,
      subject: `Receipt — ${invoices.length} invoices paid`,
      template: "receipt_batch",
      text: `Thank you. ${moneyRound(total, config.currency)} received across ${invoices.length} invoices.`,
      html: layout({
        heading: "Payment received",
        lines: [`Thank you — <b>${moneyRound(total, config.currency)}</b> received across ${invoices.length} invoice(s):`,
                invoices.map((i) => esc(i.number)).join(", ")],
        cta: { label: "View billing", href: `${config.baseUrl}/portal/invoices` },
      }),
    });
    await notifyAdmins({
      kind: "payment", title: `Batch payment ${moneyRound(total, config.currency)} — ${req.user.name}`,
      body: `${invoices.length} invoices settled.`, href: "/portal/admin/invoices",
    });
    toAdmins("payment", { batch: true, amount: total, customer: req.user.name });

    req.flash("ok", `Paid ${moneyRound(total, config.currency)} across ${invoices.length} invoice(s). Thank you.`);
    res.redirect("/portal/invoices");
  } catch (err) {
    await conn.rollback().catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

/* ---------- tasks ---------- */

/** A customer can tick off their own actions and raise a request; only Vesopa
 *  can create work assigned to Vesopa. */
router.post("/projects/:id/tasks/:taskId/status", requireCap("message.send"), async (req, res, next) => {
  try {
    const project = await ownedProject(req, req.params.id);
    if (!project) return res.status(404).json({ ok: false, error: "Not yours." });

    const task = await one("SELECT * FROM project_tasks WHERE id = ? AND project_id = ?",
      [req.params.taskId, project.id]);
    if (!task || (!task.is_visible && req.user.role !== "admin")) {
      return res.status(404).json({ ok: false, error: "No such task." });
    }

    const status = ["todo", "doing", "blocked", "done"].includes(req.body.status) ? req.body.status : "todo";
    await exec("UPDATE project_tasks SET status = ?, done_at = ? WHERE id = ?",
      [status, status === "done" ? new Date() : null, task.id]);

    const [{ done, total }] = await q(
      `SELECT SUM(status='done') AS done, COUNT(*) AS total FROM project_tasks WHERE project_id = ?`,
      [project.id]);
    const pct = total ? Math.round((done / total) * 100) : project.progress_pct;

    toProject(project.id, "task", { projectId: project.id, taskId: task.id, status, done, total, pct });
    res.json({ ok: true, status, done, total, pct });
  } catch (err) { next(err); }
});

/* ---------- billing details the customer gives us ---------- */

router.get("/billing-details", requireCap("billing.view"), async (req, res, next) => {
  try {
    const org = req.user.org_id ? await one("SELECT * FROM organisations WHERE id = ?", [req.user.org_id]) : null;
    const banks = await q("SELECT * FROM bank_accounts WHERE active = 1 ORDER BY is_default DESC, label");
    res.render("customer/billing-details", { title: "Billing details", org, banks });
  } catch (err) { next(err); }
});

router.post("/billing-details", requireCap("org.edit"), async (req, res, next) => {
  try {
    if (!req.user.org_id) { req.flash("warn", "Your account has no organisation."); return res.redirect("/portal/billing-details"); }
    await exec(
      `UPDATE organisations SET name=?, vat_number=?, reg_number=?, billing_email=?,
                                billing_contact=?, address=?, country=? WHERE id=?`,
      [String(req.body.name || "").trim().slice(0, 150) || "Unnamed",
       String(req.body.vat_number || "").trim().slice(0, 40) || null,
       String(req.body.reg_number || "").trim().slice(0, 40) || null,
       String(req.body.billing_email || "").trim().slice(0, 190) || null,
       String(req.body.billing_contact || "").trim().slice(0, 120) || null,
       String(req.body.address || "").trim().slice(0, 400) || null,
       String(req.body.country || "").trim().slice(0, 80) || null,
       req.user.org_id],
    );
    req.flash("ok", "Billing details saved. They will appear on your invoices.");
    res.redirect("/portal/billing-details");
  } catch (err) { next(err); }
});

/* ---------- team ---------- */

router.get("/team", requireCap("team.view"), async (req, res, next) => {
  try {
    if (!req.user.org_id) {
      return res.render("customer/team", { title: "Your team", members: [], invites: [], org: null, ORG_ROLES, error: null });
    }
    const [members, invites, org] = await Promise.all([
      q(`SELECT id, name, email, org_role, job_title, status, last_login_at, created_at
           FROM users WHERE org_id = ? ORDER BY FIELD(org_role,'owner','manager','billing','member','viewer'), name`,
        [req.user.org_id]),
      q(`SELECT * FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC`, [req.user.org_id]),
      one("SELECT * FROM organisations WHERE id = ?", [req.user.org_id]),
    ]);
    res.render("customer/team", { title: "Your team", members, invites, org, ORG_ROLES, error: null });
  } catch (err) { next(err); }
});

router.post("/team/invite", requireCap("team.manage"), async (req, res, next) => {
  try {
    if (!req.user.org_id) { req.flash("warn", "Your account has no organisation yet."); return res.redirect("/portal/team"); }

    const email = normaliseEmail(req.body.email);
    const ep = emailProblem(email);
    if (ep) { req.flash("warn", ep); return res.redirect("/portal/team"); }
    if (await one("SELECT id FROM users WHERE email = ?", [email])) {
      req.flash("warn", "Somebody already holds an account with that address.");
      return res.redirect("/portal/team");
    }

    const org_role = ORG_ROLES.some((r) => r.id === req.body.org_role) ? req.body.org_role : "member";
    const name = String(req.body.name || "").trim().slice(0, 120) || null;

    // One live invitation per address per org.
    await exec("UPDATE invitations SET expires_at = NOW() WHERE org_id = ? AND email = ? AND accepted_at IS NULL",
      [req.user.org_id, email]);

    const token = crypto.randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await exec(
      `INSERT INTO invitations (org_id, email, name, org_role, token_hash, invited_by, expires_at)
       VALUES (?,?,?,?,?,?,?)`,
      [req.user.org_id, email, name, org_role, sha(token), req.user.id, expires],
    );

    const org = await one("SELECT name FROM organisations WHERE id = ?", [req.user.org_id]);
    await sendMail({
      to: email,
      subject: `${req.user.name} has added you to ${org?.name || "their team"} on Vesopa`,
      template: "invite",
      text: `Join ${org?.name}: ${config.baseUrl}/portal/invite/${token}`,
      html: layout({
        heading: `Join ${esc(org?.name || "the team")}`,
        lines: [
          `${esc(req.user.name)} has added you to <b>${esc(org?.name || "their team")}</b> on the Vesopa Software portal, as <b>${esc(roleLabel(org_role))}</b>.`,
          `You will be able to see project progress, the conversation with our team${["owner", "billing"].includes(org_role) ? " and the invoices" : ""}.`,
          `The link works once and expires in seven days.`,
        ],
        cta: { label: "Set your password and join", href: `${config.baseUrl}/portal/invite/${token}` },
      }),
    });

    req.flash("ok", `Invitation sent to ${email}.`);
    res.redirect("/portal/team");
  } catch (err) { next(err); }
});

router.post("/team/:id/role", requireCap("team.manage"), async (req, res, next) => {
  try {
    const member = await one("SELECT * FROM users WHERE id = ? AND org_id = ?", [req.params.id, req.user.org_id]);
    if (!member) { req.flash("warn", "No such team member."); return res.redirect("/portal/team"); }

    const org_role = ORG_ROLES.some((r) => r.id === req.body.org_role) ? req.body.org_role : null;
    if (!org_role) { req.flash("warn", "Unknown role."); return res.redirect("/portal/team"); }

    // Never let the last owner demote themselves out of their own account.
    if (member.org_role === "owner" && org_role !== "owner") {
      const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND org_role='owner' AND status='active'",
        [req.user.org_id]);
      if (n <= 1) {
        req.flash("warn", "That is the only owner. Promote somebody else first.");
        return res.redirect("/portal/team");
      }
    }

    await exec("UPDATE users SET org_role = ? WHERE id = ?", [org_role, member.id]);
    await notify(member.id, {
      kind: "team", title: `Your role is now ${roleLabel(org_role)}`,
      body: `Changed by ${req.user.name}.`, href: "/portal/team",
    });
    req.flash("ok", `${member.name} is now ${roleLabel(org_role)}.`);
    res.redirect("/portal/team");
  } catch (err) { next(err); }
});

router.post("/team/:id/suspend", requireCap("team.manage"), async (req, res, next) => {
  try {
    const member = await one("SELECT * FROM users WHERE id = ? AND org_id = ?", [req.params.id, req.user.org_id]);
    if (!member || member.id === req.user.id) {
      req.flash("warn", member ? "You cannot suspend yourself." : "No such team member.");
      return res.redirect("/portal/team");
    }
    const status = member.status === "active" ? "suspended" : "active";
    await exec("UPDATE users SET status = ? WHERE id = ?", [status, member.id]);
    req.flash("ok", `${member.name} is now ${status}.`);
    res.redirect("/portal/team");
  } catch (err) { next(err); }
});

router.post("/team/invite/:id/revoke", requireCap("team.manage"), async (req, res, next) => {
  try {
    await exec("UPDATE invitations SET expires_at = NOW() WHERE id = ? AND org_id = ?",
      [req.params.id, req.user.org_id]);
    req.flash("ok", "Invitation revoked.");
    res.redirect("/portal/team");
  } catch (err) { next(err); }
});

/* ---------- account ---------- */

router.get("/account", (req, res) =>
  res.render("customer/account", { title: "Your account", error: null }));

router.post("/account", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 120);
    if (!name) {
      return res.status(400).render("customer/account", { title: "Your account", error: "Your name cannot be empty." });
    }
    await exec("UPDATE users SET name = ?, company = ?, phone = ?, job_title = ? WHERE id = ?", [
      name,
      String(req.body.company || "").trim().slice(0, 150) || null,
      String(req.body.phone || "").trim().slice(0, 40) || null,
      String(req.body.job_title || "").trim().slice(0, 100) || null,
      req.user.id,
    ]);
    req.flash("ok", "Details saved.");
    res.redirect("/portal/account");
  } catch (err) { next(err); }
});

router.post("/account/password", async (req, res, next) => {
  try {
    const full = await one("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const bad = (error) => res.status(400).render("customer/account", { title: "Your account", error });

    if (!(await checkPassword(String(req.body.current || ""), full.password_hash))) {
      return bad("That is not your current password.");
    }
    const pp = passwordProblem(req.body.password); if (pp) return bad(pp);
    if (req.body.password !== req.body.password2) return bad("The two new passwords do not match.");

    await exec("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(req.body.password), req.user.id]);
    await sendMail({
      to: full.email,
      subject: "Your Vesopa password has changed",
      template: "password_changed",
      text: "Your password was changed from your account page.",
      html: layout({
        heading: "Your password has changed",
        lines: ["Changed just now from your account page. If that was not you, reply to this email immediately."],
      }),
    });
    req.flash("ok", "Password changed.");
    res.redirect("/portal/account");
  } catch (err) { next(err); }
});

export default router;
