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
async function sendMail({ to, subject, html, text, attachments }) {
  const tx = getTransport();
  if (!tx) {
    console.warn(`[mail] SMTP not configured — skipped "${subject}" to ${to}`);
    return false;
  }

  try {
    await tx.sendMail({
      from: `"${FROM_NAME}" <${FROM}>`,
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
