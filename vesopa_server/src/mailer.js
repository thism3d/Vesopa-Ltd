/**
 * Outbound mail for the back office.
 *
 * Same transport shape as vesopa_web/src/mailer.js — the mailbox on 465
 * SSL/TLS is already verified working there, so this deliberately does not
 * invent a second way of connecting. The SMTP_* variables can be copied
 * straight across from the web app's .env.
 */

const nodemailer = require('nodemailer');

const FROM_NAME = process.env.MAIL_FROM_NAME || 'Vesopa EPOS';
const FROM = process.env.MAIL_FROM || 'support@vesopaepos.com';

/**
 * More than one mailbox.
 *
 * `support@` is right for a password reset from the back office, which is a
 * message to a colleague about their own account. It is wrong for a sign-in
 * code sent to somebody sitting in a pub, who has never heard of Vesopa support
 * and whose mail client will file a first message from an address like that
 * next to the invoices.
 *
 * So `menu@` sends the codes. Two transports rather than one with a rewritten
 * From, because SPF and DMARC check the envelope against the authenticated
 * sender, and a From that does not match the mailbox that sent it is the
 * shortest route into a spam folder.
 *
 * Keyed by name; an unknown name falls back to the default, so a caller can
 * always ask and nothing breaks if the second mailbox is not configured.
 */
const transports = new Map();

let transport = null;

/**
 * Built lazily so the server still boots — and every till keeps selling — when
 * SMTP is unconfigured. Only password reset depends on mail; nothing else in
 * the back office should fall over because a mailbox is unreachable.
 */
function getTransport() {
  if (transport) return transport;
  if (!process.env.SMTP_HOST || !process.env.SMTP_PASSWORD) return null;

  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  return transport;
}

/**
 * The transport for a named mailbox, or the default when it has none.
 *
 * Falls back deliberately: a venue whose MENU_SMTP_* are unset should still be
 * able to send sign-in codes, from support@, rather than not send them.
 */
function accountTransport(name) {
  if (!name || name === 'default') return getTransport();
  if (transports.has(name)) return transports.get(name);

  const prefix = name.toUpperCase();
  const user = process.env[`${prefix}_SMTP_USER`];
  const pass = process.env[`${prefix}_SMTP_PASSWORD`];
  if (!user || !pass || !process.env.SMTP_HOST) {
    transports.set(name, null);
    return null;
  }
  const tx = nodemailer.createTransport({
    host: process.env[`${prefix}_SMTP_HOST`] || process.env.SMTP_HOST,
    port: Number(process.env[`${prefix}_SMTP_PORT`] || process.env.SMTP_PORT) || 465,
    secure: String(process.env[`${prefix}_SMTP_SECURE`] || process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user, pass },
  });
  transports.set(name, tx);
  return tx;
}

/** True when mail can actually be sent, so callers can log the difference. */
function mailEnabled() {
  return getTransport() !== null;
}

/**
 * Send an HTML mail. Resolves either way and never throws — the reset route
 * answers the same regardless, so a bounce must not turn into a 500 that tells
 * the caller something about the address.
 *
 * `attachments` is nodemailer's own shape, `{ filename, content, contentType }`,
 * and is what carries a scheduled report. Passed straight through rather than
 * wrapped: the one caller that uses it is building a PDF in memory, and
 * inventing a second vocabulary for "a file with a name" would only be
 * something to translate back again.
 */
async function sendMail({ to, subject, html, text, attachments, account }) {
  // A named mailbox where one is asked for and configured, the default
  // otherwise — see the note on `transports` above.
  const named = account ? accountTransport(account) : null;
  const tx = named || getTransport();
  if (!tx) {
    console.warn(`[mail] SMTP not configured — skipped "${subject}" to ${to}`);
    return false;
  }

  const prefix = account ? account.toUpperCase() : '';
  const fromAddress = named
    ? (process.env[`${prefix}_MAIL_FROM`] || process.env[`${prefix}_SMTP_USER`])
    : FROM;
  const fromName = named
    ? (process.env[`${prefix}_MAIL_FROM_NAME`] || FROM_NAME)
    : FROM_NAME;

  try {
    await tx.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to,
      subject,
      html,
      ...(text ? { text } : {}),
      ...(attachments && attachments.length ? { attachments } : {}),
    });
    return true;
  } catch (e) {
    console.error(`[mail] failed to send "${subject}":`, e.message);
    return false;
  }
}

/**
 * Handshake once at boot and say plainly what happened.
 *
 * Without this, an unset SMTP_PASSWORD and a wrong SMTP_PASSWORD look
 * identical from the outside: "Forgot password" keeps answering its reassuring
 * "check your inbox" and nothing ever arrives. Only ever logs.
 */
async function verifyMail() {
  const tx = getTransport();
  if (!tx) {
    console.warn(
      '[mail] DISABLED — SMTP_HOST and/or SMTP_PASSWORD are unset. ' +
        'Password reset emails will NOT be sent.'
    );
    return false;
  }

  try {
    await tx.verify();
    console.log(`[mail] ready — ${process.env.SMTP_USER} via ${process.env.SMTP_HOST}`);
    return true;
  } catch (e) {
    console.error(`[mail] SMTP configured but the connection failed: ${e.message}`);
    return false;
  }
}

module.exports = { sendMail, verifyMail, mailEnabled };
