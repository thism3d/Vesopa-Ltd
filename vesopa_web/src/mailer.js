/**
 * Outbound mail.
 *
 * Enquiry notifications must never block the visitor: the PHP site sent the mail
 * synchronously inside the form handler, so an SMTP timeout showed the customer
 * a hung page for a submission that had in fact been saved. Here the row is
 * committed first and the mail is fired afterwards, with failures logged rather
 * than surfaced.
 */

const nodemailer = require('nodemailer');

const FROM_NAME = process.env.MAIL_FROM_NAME || 'Vesopa EPOS';
const FROM = process.env.MAIL_FROM || 'support@vesopaepos.com';
const DEFAULT_TO = process.env.MAIL_TO || 'support@vesopaepos.com';

let transport = null;

/**
 * Built lazily so the site still boots (and serves every page) when SMTP is
 * unconfigured — useful locally, where nobody wants a mail server running.
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
 * Send an HTML mail. Resolves either way — callers are fire-and-forget and a
 * bounced notification must not fail a form the customer already submitted.
 *
 * @param {object} o
 * @param {string} [o.to]      defaults to the support inbox
 * @param {string} o.subject
 * @param {string} o.html
 * @param {string} [o.replyTo] so support can reply straight to the enquirer
 */
async function sendMail({ to, subject, html, replyTo }) {
  const tx = getTransport();
  if (!tx) {
    console.warn(`[mail] SMTP not configured — skipped "${subject}" to ${to || DEFAULT_TO}`);
    return false;
  }

  try {
    await tx.sendMail({
      from: `"${FROM_NAME}" <${FROM}>`,
      to: to || DEFAULT_TO,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    return true;
  } catch (e) {
    console.error(`[mail] failed to send "${subject}":`, e.message);
    return false;
  }
}

/**
 * Handshake with the SMTP server once at boot and say plainly what happened.
 *
 * Without this, an unset SMTP_PASSWORD and a wrong SMTP_PASSWORD look identical
 * from the outside: enquiries keep saving, the customer keeps seeing the
 * confirmation page, and nothing arrives in the support inbox until somebody
 * notices the silence. Only ever logs — a mail server that is down must not
 * stop the site from serving pages.
 */
async function verifyMail() {
  const tx = getTransport();
  if (!tx) {
    console.warn(
      '[mail] DISABLED — SMTP_HOST and/or SMTP_PASSWORD are unset. ' +
        'Enquiries will still be saved, but no notification or approval email will be sent.'
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

module.exports = { sendMail, verifyMail, DEFAULT_TO };
