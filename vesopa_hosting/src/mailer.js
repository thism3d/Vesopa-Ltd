/**
 * Outbound mail.
 *
 * Every account action a customer takes here is confirmed by email — sign-up,
 * verification, password reset, order, provisioning, ticket reply. The account
 * *is* the email address, so mail is not a nicety on this site.
 *
 * Built lazily so the site boots and serves every page with SMTP unconfigured.
 * Sends resolve either way: a bounced notification must never fail an action
 * the customer has already completed and been told succeeded.
 */

const nodemailer = require('nodemailer');
const { SITE_URL, BRAND, CONTACT } = require('./config');

const FROM_NAME = process.env.MAIL_FROM_NAME || 'Vesopa Cloud';
const FROM = process.env.MAIL_FROM || 'hosting@vesopaepos.com';
const DEFAULT_TO = process.env.MAIL_TO || FROM;

let transport = null;

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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One shell for every email we send.
 *
 * Table-based and inline-styled on purpose: Outlook and Gmail between them
 * strip <style> blocks, flexbox and CSS variables, so a mail built like the
 * website arrives as a column of unstyled text.
 *
 * The lime is used as a rule and a button fill only, never as text — it is
 * 1.9:1 on white, which is unreadable, and email clients do not honour the
 * media queries that would let it adapt.
 */
function shell({ title, intro, bodyHtml, ctaText, ctaUrl, footNote }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f0;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(17,17,17,.07);">

        <tr><td style="background:${BRAND.ink};padding:22px 30px;">
          <span style="font-size:21px;font-weight:800;letter-spacing:-.5px;color:#ffffff;">vesopa</span><span style="color:${BRAND.lime};font-size:21px;font-weight:800;">.</span>
          <span style="font-size:12px;color:#b8bcae;letter-spacing:.14em;text-transform:uppercase;margin-left:8px;">Hosting</span>
        </td></tr>
        <tr><td style="height:4px;background:${BRAND.lime};font-size:0;line-height:0;">&nbsp;</td></tr>

        <tr><td style="padding:32px 30px 8px;">
          <h1 style="margin:0 0 10px;font-size:22px;line-height:1.25;color:#111111;font-weight:800;">${escapeHtml(title)}</h1>
          ${intro ? `<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#4a4c41;">${intro}</p>` : ''}
        </td></tr>

        ${bodyHtml ? `<tr><td style="padding:0 30px;">${bodyHtml}</td></tr>` : ''}

        ${
          ctaText && ctaUrl
            ? `<tr><td style="padding:22px 30px 6px;">
                 <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${BRAND.lime};border-radius:9px;">
                   <a href="${ctaUrl}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:800;color:${BRAND.on_lime};text-decoration:none;">${escapeHtml(ctaText)}</a>
                 </td></tr></table>
                 <p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#787a6e;">
                   If the button does not work, paste this into your browser:<br>
                   <span style="color:${BRAND.lime_ink};word-break:break-all;">${ctaUrl}</span>
                 </p>
               </td></tr>`
            : ''
        }

        ${
          footNote
            ? `<tr><td style="padding:20px 30px 0;">
                 <p style="margin:0;font-size:13px;line-height:1.6;color:#787a6e;">${footNote}</p>
               </td></tr>`
            : ''
        }

        <tr><td style="padding:26px 30px 30px;">
          <div style="border-top:1px solid #e1e3da;padding-top:16px;">
            <p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:#787a6e;">
              ${escapeHtml(CONTACT.company)} · ${escapeHtml(CONTACT.address_line1)}, ${escapeHtml(CONTACT.address_line2)}
            </p>
            <p style="margin:0;font-size:12px;line-height:1.6;color:#787a6e;">
              <a href="${SITE_URL}" style="color:${BRAND.lime_ink};text-decoration:none;">hosting.vesopaepos.com</a>
              &nbsp;·&nbsp; <a href="mailto:${CONTACT.support_email}" style="color:${BRAND.lime_ink};text-decoration:none;">${CONTACT.support_email}</a>
            </p>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** A simple label/value table for order and account details inside an email. */
function detailTable(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3da;border-radius:10px;overflow:hidden;">
    ${rows
      .map(
        ([label, value], i) => `<tr style="background:${i % 2 ? '#ffffff' : '#fafbf6'};">
        <td style="padding:11px 14px;font-size:13px;color:#787a6e;width:42%;">${escapeHtml(label)}</td>
        <td style="padding:11px 14px;font-size:13px;color:#111111;font-weight:600;">${value}</td>
      </tr>`,
      )
      .join('')}
  </table>`;
}

async function sendMail({ to, subject, html, replyTo, text }) {
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
      text: text || undefined,
      replyTo: replyTo || undefined,
    });
    return true;
  } catch (err) {
    console.error(`[mail] failed "${subject}" to ${to || DEFAULT_TO}:`, err.message);
    return false;
  }
}

/** Logged once at boot so a broken SMTP config is visible before a customer finds it. */
async function verifyMail() {
  const tx = getTransport();
  if (!tx) {
    console.warn('[mail] SMTP not configured — account emails will not be sent.');
    return false;
  }
  try {
    await tx.verify();
    console.log('[mail] SMTP ready.');
    return true;
  } catch (err) {
    console.error('[mail] SMTP verify failed:', err.message);
    return false;
  }
}

module.exports = { sendMail, verifyMail, shell, detailTable, escapeHtml, DEFAULT_TO };
