/**
 * Sending mail, and the one message that matters most: the sign-in code.
 *
 * A SIGN-IN CODE IS THE MOST TIME-CRITICAL EMAIL A COMPANY SENDS. Somebody is
 * sitting looking at a form waiting for it. If it lands in spam, or takes two
 * minutes, or renders as a wall of unstyled text they cannot find the digits
 * in, they give up and the account is lost. So:
 *
 *   * both a plain-text and an HTML part, always — a text-only message from a
 *     domain that usually sends HTML scores worse, and an HTML-only one is
 *     unreadable in a client that refuses HTML
 *   * a 600px table layout with inline CSS, because email clients in 2026 still
 *     do not reliably support flexbox, grid, or a <style> block
 *   * a forced light background: dark-mode clients invert unpredictably, and a
 *     transparent logo on an inverted ground disappears
 *   * the code large and monospaced, and repeated in the subject line, so it
 *     can be read from a notification without opening anything
 *   * the registered company details in the footer, which the Companies Act
 *     2006 requires on UK business email and which also helps deliverability
 */

const nodemailer = require('nodemailer');
const config = require('./config');

let transport = null;

function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
    // The mail server is on this machine. A long timeout here would mean a
    // sign-in request hanging on a dead local service.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transport;
}

/** Escape anything that reaches an HTML template. */
function escape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FOOT_TEXT =
  'Vesopa Software Ltd, registered in Wales, company number 17362206. ' +
  'Baglan, Port Talbot, SA12 7AX.';

/**
 * The shell every message shares.
 *
 * `bgcolor` on the table as well as CSS: Outlook ignores the style attribute on
 * a table often enough that the belt-and-braces version is the only one that
 * renders the same everywhere.
 */
function wrap(title, bodyHtml) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f4" style="background:#f4f4f4;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"
         style="width:600px;max-width:100%;background:#ffffff;border-radius:12px;border:1px solid #e3e3e3;">
    <tr><td style="padding:28px 32px 8px;">
      <img src="${config.issuer}/brand/email-logo.png" width="180" height="43" alt="Vesopa"
           style="display:block;border:0;height:auto;">
    </td></tr>
    <tr><td style="padding:8px 32px 28px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:1.55;color:#000000;">
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:18px 32px 26px;border-top:1px solid #e3e3e3;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;line-height:1.5;color:#55595c;">
      ${escape(FOOT_TEXT)}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

async function send({ to, subject, html, text }) {
  const mail = {
    from: config.mail.from,
    replyTo: config.mail.replyTo,
    to,
    subject,
    text,
    html,
    headers: {
      // Tells well-behaved mail systems not to auto-reply, and marks the
      // message as transactional rather than bulk.
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
    },
  };
  const info = await getTransport().sendMail(mail);
  return info;
}

/**
 * The sign-in code.
 *
 * `purposeLine` changes with why the code was sent — signing in, verifying a
 * new address, confirming a deletion. It matters that these read differently:
 * a person who receives "here is your code to sign in" when they did not ask to
 * sign in has just been told that somebody else is trying, which is the whole
 * point of sending it to them.
 */
async function sendCode({ to, code, purpose = 'login', minutes = 10 }) {
  const lines = {
    login: 'Use this code to sign in to your Vesopa account.',
    register: 'Use this code to finish creating your Vesopa account.',
    verify_email: 'Use this code to confirm this email address.',
    link_identity: 'Use this code to add this email address to your Vesopa account.',
    recovery: 'Use this code to get back into your Vesopa account.',
    step_up: 'Use this code to confirm it is you.',
    change_password: 'Use this code to change your password.',
    delete_account: 'Use this code to confirm you want to delete your Vesopa account.',
  };
  const lead = lines[purpose] || lines.login;

  const html = wrap(
    'Your Vesopa code',
    `<p style="margin:0 0 18px;">${escape(lead)}</p>
     <p style="margin:0 0 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
               font-size:34px;font-weight:700;letter-spacing:7px;color:#000000;">${escape(code)}</p>
     <p style="margin:0 0 20px;font-size:14px;color:#55595c;">
       This code expires in ${minutes} minutes and can be used once.
     </p>
     <p style="margin:0;font-size:14px;color:#55595c;">
       If you did not ask for this, you can ignore this email — nobody can get in
       without the code. If it keeps happening, tell us at
       <a href="mailto:security@vesopa.com" style="color:#000000;">security@vesopa.com</a>.
     </p>`,
  );

  const text = [
    lead,
    '',
    `    ${code}`,
    '',
    `This code expires in ${minutes} minutes and can be used once.`,
    '',
    'If you did not ask for this, you can ignore this email — nobody can get in',
    'without the code. If it keeps happening, tell us at security@vesopa.com.',
    '',
    FOOT_TEXT,
  ].join('\n');

  // The code in the subject line, so it is readable from a lock screen without
  // opening anything. Every large provider does this now, and people expect it.
  return send({ to, subject: `Your Vesopa code: ${code}`, html, text });
}

/**
 * Told, not asked: somebody signed in from a new device.
 *
 * Notification is what makes the rest of the system honest. A link, an unlink,
 * a password change and a new device are all things a person must hear about,
 * because the ones they did not do are the only warning they will get.
 */
async function sendSecurityNotice({ to, heading, body, when, ip, device }) {
  const html = wrap(
    heading,
    `<p style="margin:0 0 14px;font-size:19px;font-weight:650;">${escape(heading)}</p>
     <p style="margin:0 0 16px;">${escape(body)}</p>
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;font-size:14px;color:#55595c;">
       <tr><td style="padding:2px 16px 2px 0;">When</td><td>${escape(when)}</td></tr>
       <tr><td style="padding:2px 16px 2px 0;">Device</td><td>${escape(device || 'Unknown')}</td></tr>
       <tr><td style="padding:2px 16px 2px 0;">IP address</td><td>${escape(ip || 'Unknown')}</td></tr>
     </table>
     <p style="margin:0;font-size:14px;color:#55595c;">
       If this was you, there is nothing to do. If it was not, change your password
       and remove the device at
       <a href="${config.issuer}/account/devices" style="color:#000000;">${config.issuer}/account/devices</a>.
     </p>`,
  );

  const text = [
    heading,
    '',
    body,
    '',
    `When:   ${when}`,
    `Device: ${device || 'Unknown'}`,
    `IP:     ${ip || 'Unknown'}`,
    '',
    'If this was you, there is nothing to do. If it was not, change your',
    `password and remove the device at ${config.issuer}/account/devices`,
    '',
    FOOT_TEXT,
  ].join('\n');

  return send({ to, subject: `Vesopa security: ${heading}`, html, text });
}

/** Prove the mail path works without sending to a real person. */
async function verifyConnection() {
  return getTransport().verify();
}

module.exports = { send, sendCode, sendSecurityNotice, verifyConnection };
