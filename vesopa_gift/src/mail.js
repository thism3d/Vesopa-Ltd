/**
 * Sending mail, from the venue.
 *
 * One mailbox -- the customer-facing one the menu and the loyalty app already
 * send from -- with the VENUE's name in the From line and the venue's own
 * address as Reply-To. Somebody who opens a voucher from "The Vesopa Kitchen"
 * and presses reply should reach The Vesopa Kitchen, not Vesopa.
 *
 * The From ADDRESS stays the authenticated mailbox, never the venue's: SPF and
 * DMARC check it against the server that sent it, and a From that does not
 * match is the shortest route into a spam folder.
 */

const nodemailer = require('nodemailer');
const config = require('./config');

let transport = null;
function getTransport() {
  if (transport) return transport;
  // Tests: every message written to a folder as JSON instead of being sent, so
  // an end-to-end run can read what a buyer would have received.
  if (process.env.MAIL_CAPTURE_DIR) {
    const fs = require('fs');
    const path = require('path');
    const dir = process.env.MAIL_CAPTURE_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const json = nodemailer.createTransport({ jsonTransport: true });
    transport = {
      verify: async () => true,
      sendMail: async (m) => {
        const info = await json.sendMail(m);
        const out = { ...JSON.parse(info.message), envelope: info.envelope };
        fs.writeFileSync(path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(out));
        return info;
      },
    };
    return transport;
  }
  if (!config.MAIL.host || !config.MAIL.password) return null;
  transport = nodemailer.createTransport({
    host: config.MAIL.host,
    port: config.MAIL.port,
    secure: config.MAIL.secure,
    auth: { user: config.MAIL.user, pass: config.MAIL.password },
  });
  return transport;
}

function mailEnabled() {
  return getTransport() !== null;
}

/**
 * Send, and THROW when it did not go. Unlike the back office's password reset,
 * a voucher that silently failed to send is money somebody paid for and never
 * received -- the caller records the failure and tries again later.
 */
async function send({ to, subject, html, text, attachments, fromName, replyTo }) {
  const tx = getTransport();
  if (!tx) throw new Error('mail is not configured on this server');
  const name = String(fromName || 'Vesopa Gift').replace(/["\r\n]/g, '').slice(0, 80);
  await tx.sendMail({
    from: `"${name}" <${config.MAIL.from}>`,
    to,
    subject,
    html,
    text,
    ...(replyTo ? { replyTo } : {}),
    ...(attachments && attachments.length ? { attachments } : {}),
  });
  return true;
}

async function verify() {
  const tx = getTransport();
  if (!tx) {
    console.warn('[mail] DISABLED: SMTP_HOST or SMTP_PASSWORD is unset. Vouchers will wait unsent.');
    return false;
  }
  try {
    await tx.verify();
    console.log(`[mail] ready: ${config.MAIL.user} via ${config.MAIL.host}`);
    return true;
  } catch (e) {
    console.error(`[mail] configured but the connection failed: ${e.message}`);
    return false;
  }
}

module.exports = { send, verify, mailEnabled };
