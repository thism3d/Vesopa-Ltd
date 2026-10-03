/* Accounts Vesopa opens on a customer's behalf.
 *
 * When we set somebody up — converting a quote, or onboarding a client like
 * Metric Group — we must not choose their password. The old convert route
 * emailed a generated one in the clear, which meant a password sitting in an
 * inbox forever and one we had seen. This replaces that with the reset
 * mechanism the portal already has: the account is created with a password
 * nobody knows, and the person is sent a single-use link to set their own.
 *
 * It reuses `password_resets` and /portal/reset/:token as they are, so there
 * is no second token table and no second page to keep secure. Only the expiry
 * differs: a reset is good for an hour, a welcome link for a week, because the
 * person did not ask for it and may not open their email today.
 */
import crypto from "node:crypto";
import { one, exec } from "./db.js";
import { createUser } from "./auth.js";
import { sendMail, layout, esc } from "./mail.js";
import { notifyAdmins, notify } from "./notify.js";
import { config } from "./config.js";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export const WELCOME_LINK_DAYS = 7;

/** The sentence every "how to sign in" email adds once Continue with Vesopa
 *  is switched on (config.vesopaAuth.enabled), or null while it is dormant —
 *  an email must not offer a button the sign-in page does not draw. HTML. */
export function vesopaSignInLine(email) {
  if (!config.vesopaAuth?.enabled) return null;
  return `You can also skip the password: choose <b>Continue with Vesopa</b> on the sign-in page and use ` +
    `your Vesopa account with this same address, <b>${esc(email)}</b>. If you do not have one yet, you can ` +
    `make it there with an emailed code.`;
}

/** The plain-text twin of vesopaSignInLine, for the text part of an email. */
export function vesopaSignInText(email) {
  if (!config.vesopaAuth?.enabled) return "";
  return `\nOr choose "Continue with Vesopa" on the sign-in page with your Vesopa account for ${email}.\n`;
}

/**
 * Everything a new customer gets once their users row exists — the one
 * definition shared by /portal/register and the first Continue with Vesopa
 * (routes/vesopa-sso.js), so the two doors open exactly the same account:
 *
 *   an organisation they own (sole trader or not, so "add a colleague" later
 *   needs no migration), every unclaimed quote on their address, the welcome
 *   email, the notice to staff, and their own first notification.
 *
 * `via` is "password" or "vesopa"; it only changes how the welcome email
 * says to sign in next time.
 */
export async function openCustomerAccount({ id, name, email, company = "", via = "password" }) {
  const org = await exec("INSERT INTO organisations (name, owner_id) VALUES (?,?)", [company || name, id]);
  await exec("UPDATE users SET org_id = ?, org_role = 'owner' WHERE id = ?", [org.insertId, id]);

  // Anything they quoted before signing up becomes theirs.
  const claimed = await exec("UPDATE quotes SET user_id = ? WHERE user_id IS NULL AND email = ?", [id, email]);

  const signIn = via === "vesopa"
    ? `You signed in with your Vesopa account (<b>${esc(email)}</b>). Next time, choose ` +
      `<b>Continue with Vesopa</b> on the sign-in page — there is no separate password to remember.`
    : `Signed in as <b>${esc(email)}</b>.`;

  await sendMail({
    to: email,
    subject: "Your Vesopa Software account is live",
    template: "welcome",
    text: `Welcome ${name}. Your account is ready: ${config.baseUrl}/portal` +
      (via === "vesopa"
        ? `\nNext time, choose "Continue with Vesopa" on the sign-in page.\n`
        : vesopaSignInText(email)),
    html: layout({
      heading: `Welcome, ${esc(String(name).split(" ")[0])}`,
      lines: [
        `Your Vesopa Software account is live. It is where your projects, their progress, your quotes and every invoice live in one place.`,
        claimed.affectedRows
          ? `We have attached ${claimed.affectedRows} quote${claimed.affectedRows > 1 ? "s" : ""} you already requested to this account.`
          : `Start by telling us about a project — you will get an estimate straight away.`,
        signIn,
        ...(via === "vesopa" ? [] : [vesopaSignInLine(email)].filter(Boolean)),
      ],
      cta: { label: "Open your portal", href: `${config.baseUrl}/portal` },
    }),
  });

  await notifyAdmins({
    kind: "customer",
    title: `New customer: ${name}`,
    body: [company, email, via === "vesopa" ? "via Continue with Vesopa" : ""].filter(Boolean).join(" · "),
    href: `/portal/admin/customers/${id}`,
  });
  await notify(id, {
    kind: "welcome",
    title: "Welcome to Vesopa Software",
    body: "Submit a project brief and we will come back with a plan.",
    href: "/portal/projects/new",
  });

  return { orgId: org.insertId, claimed: claimed.affectedRows };
}

/** Create a customer account nobody can sign in to until they set a password.
 *  The stored hash is of 32 random bytes that are immediately discarded, so it
 *  is a well-formed bcrypt hash that no input will ever match. */
export async function createInvitedUser({ email, name, company = null, phone = null }) {
  return createUser({
    email, name, company, phone, role: "customer",
    password: crypto.randomBytes(32).toString("base64url"),
  });
}

/** Is there a set-password link for this user that still works? */
export async function hasLiveSetPasswordLink(userId) {
  return Boolean(await one(
    "SELECT id FROM password_resets WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1",
    [userId],
  ));
}

/**
 * Issue a fresh single-use link and email it. Any earlier live link is retired
 * first, exactly as /portal/forgot does, so there is only ever one.
 *
 * `lines` are extra paragraphs for the email (already HTML-escaped by the
 * caller), placed between the greeting and the instructions.
 */
export async function sendSetPasswordLink(user, {
  days = WELCOME_LINK_DAYS,
  subject = "Your Vesopa Software portal account",
  heading = null,
  lines = [],
  template = "welcome_set_password",
} = {}) {
  await exec("UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL", [user.id]);

  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await exec(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)",
    [user.id, sha(token), expires],
  );

  const link = `${config.baseUrl}/portal/reset/${token}`;
  const first = String(user.name || "").split(" ")[0] || "there";
  const result = await sendMail({
    to: user.email,
    subject,
    template,
    text:
      `Hello ${first},\n\nWe have opened a Vesopa Software portal account for ${user.email}.\n` +
      `Set your password here (the link works once and expires in ${days} days):\n${link}\n\n` +
      `After that, sign in at ${config.baseUrl}/portal\n` + vesopaSignInText(user.email),
    html: layout({
      heading: heading || `Welcome, ${first}`,
      lines: [
        `We have opened a Vesopa Software portal account for <b>${esc(user.email)}</b>.`,
        ...lines,
        `Choose your own password with the button below. The link works once and expires in ${days} days; ` +
          `after that, use “Forgotten your password?” on the sign-in page to get a new one.`,
        ...[vesopaSignInLine(user.email)].filter(Boolean),
      ],
      cta: { label: "Set your password", href: link },
    }),
  });
  return { link, expires, mail: result };
}
