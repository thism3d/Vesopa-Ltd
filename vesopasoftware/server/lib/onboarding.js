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
import { config } from "./config.js";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export const WELCOME_LINK_DAYS = 7;

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
      `After that, sign in at ${config.baseUrl}/portal`,
    html: layout({
      heading: heading || `Welcome, ${first}`,
      lines: [
        `We have opened a Vesopa Software portal account for <b>${esc(user.email)}</b>.`,
        ...lines,
        `Choose your own password with the button below. The link works once and expires in ${days} days; ` +
          `after that, use “Forgotten your password?” on the sign-in page to get a new one.`,
      ],
      cta: { label: "Set your password", href: link },
    }),
  });
  return { link, expires, mail: result };
}
