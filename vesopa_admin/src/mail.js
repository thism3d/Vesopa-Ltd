/**
 * Mail. The owner chose "Owner and venue": a daily summary to the owner, and
 * the venue is told when something is added, paused or removed. Through the
 * box's relay; a server with no SMTP_HOST logs what it would have sent.
 */
const nodemailer = require('nodemailer');
const config = require('./config');

let transport = null;
function mailer() {
  if (!config.MAIL.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.MAIL.host,
      port: config.MAIL.port,
      secure: config.MAIL.secure,
      ...(config.MAIL.user ? { auth: { user: config.MAIL.user, pass: config.MAIL.password } } : {}),
    });
  }
  return transport;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f2;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d2118">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<div style="font-weight:800;font-size:18px;letter-spacing:.2px;margin-bottom:18px">vesopa<span style="color:#8cc63f">.</span></div>
<div style="background:#fff;border-radius:14px;padding:24px 22px;border:1px solid #e3e6dc">
<h1 style="font-size:19px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}</div>
<p style="color:#6b7262;font-size:12px;margin-top:16px">Vesopa Software Ltd</p></div></body></html>`;
}

async function send({ to, subject, html, text }) {
  const t = mailer();
  if (!t) {
    console.log(`[mail] (not configured) to ${to}: ${subject}`);
    return { sent: false };
  }
  try {
    await t.sendMail({ from: config.MAIL.from, to, subject, html, text });
    return { sent: true };
  } catch (e) {
    console.warn(`[mail] to ${to} failed: ${e.message}`);
    return { sent: false, error: e.message };
  }
}

/** The venue's email when something it has is added, paused, resumed or removed. */
function venueChange({ venueName, label, action, until }) {
  const when = until
    ? new Date(until).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null;
  const lines = {
    add: `${label} has been added to ${venueName}. It is ready to use now.`,
    resume: `${label} is running again at ${venueName}. Nothing was lost while it was paused.`,
    pause: `${label} has been paused for ${venueName}. It keeps working until ${when}, then it stops until it is resumed. Nothing is deleted.`,
    remove: `${label} is being removed from ${venueName}. It keeps working until ${when}, then it stops and comes off your invoice. Your data is kept.`,
  };
  const line = lines[action] || `${label} has changed at ${venueName}.`;
  const subject = {
    add: `${label} added`, resume: `${label} resumed`, pause: `${label} paused`, remove: `${label} removed`,
  }[action] || `${label} changed`;
  return {
    subject: `${subject} – ${venueName}`,
    html: shell(subject, `<p>${esc(line)}</p><p>If this is not what you expected, reply to this email or call Vesopa and we will sort it out.</p>`),
    text: `${line}\n\nIf this is not what you expected, reply to this email or call Vesopa.`,
  };
}

module.exports = { send, shell, esc, venueChange };
