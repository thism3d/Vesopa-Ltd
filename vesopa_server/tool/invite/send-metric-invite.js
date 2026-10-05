#!/usr/bin/env node
/**
 * The invitation to Metric Group UK's manager (2026-10-05).
 *
 *   node tool/invite/send-metric-invite.js --preview out.html   # look at it
 *   node tool/invite/send-metric-invite.js --send               # send it
 *
 * Owner, 2026-10-05: "Send invitation as well to Matt mail and cc to
 * info@vesopasoftware.com and info@vesopa.com proper html, design, images
 * attached (motion)". Run from the back office's folder so src/mailer.js finds
 * its SMTP settings in .env. The pictures are the files next to this one
 * (make them again with tool/make-invite-art.js and make_gif.py), sent inline
 * by cid so they show without the reader allowing remote images.
 *
 * Without --send it sends nothing.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const TO = 'Matt Hammond <m.hammond@metricgroup.co.uk>';
const CC = ['info@vesopasoftware.com', 'info@vesopa.com'];
const REPLY_TO = 'Vesopa Software <info@vesopasoftware.com>';
const SUBJECT = 'Welcome to Vesopa EPOS: Metric Group UK is ready';

const PICTURES = [
  { cid: 'hero@vesopa', file: 'metric-hero.gif', type: 'image/gif' },
  { cid: 'backoffice@vesopa', file: 'backoffice-memberships.png', type: 'image/png' },
  { cid: 'app@vesopa', file: 'metric-app.jpg', type: 'image/jpeg' },
];

const NAVY = '#0b1a6b';
const GREEN = '#5ad400';
const LIME = '#a5c715';
const INK = '#17141c';
const MUTED = '#5f5a68';
const FONT = "'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const APPS = [
  ['Vesopa back office', 'Members, plans, products, reports and settings.', 'https://backoffice.vesopaepos.com', 'backoffice.vesopaepos.com'],
  ['Metric Membership admin', 'Cars, sites, gates and cameras, as today.', 'https://metric.vesopa.com/admin', 'metric.vesopa.com/admin'],
  ['Vesopa EPOS till', 'Join, renew and greet members at the counter.', 'https://apps.microsoft.com/detail/9PDMNJXNFZCW', 'Microsoft Store'],
  ['Express kiosk', 'Members join or renew themselves, paid by card.', 'https://apps.microsoft.com/detail/9N5W5VLP2948', 'Microsoft Store'],
  ['Kitchen screen', 'Orders from the till and kiosk, as they come in.', 'https://apps.microsoft.com/detail/9P29NN3R5PGS', 'Microsoft Store'],
  ['Customer display', 'Shows the member their plan and renewal date.', 'https://apps.microsoft.com/detail/9P8JCLQ5M3SQ', 'Microsoft Store'],
];

function html(src) {
  const p = (text, extra = '') =>
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${INK};${extra}">${text}</p>`;
  const h2 = (text) =>
    `<h2 style="margin:8px 0 14px;font-family:${FONT};font-size:20px;line-height:1.3;font-weight:800;color:${NAVY};">${text}</h2>`;
  const tile = (title, body) => `
    <td valign="top" width="50%" style="padding:6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6ff;border-radius:14px;">
        <tr><td style="padding:18px 18px 16px;">
          <div style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:1.5px;color:#2f8f00;">✓ SWITCHED ON</div>
          <div style="margin:6px 0 6px;font-family:${FONT};font-size:18px;font-weight:800;color:${NAVY};">${title}</div>
          <div style="font-family:${FONT};font-size:14px;line-height:1.55;color:${MUTED};">${body}</div>
        </td></tr>
      </table>
    </td>`;
  const step = (n, text) => `
    <tr>
      <td valign="top" width="40" style="padding:0 0 14px;">
        <div style="width:28px;height:28px;border-radius:14px;background:${NAVY};color:#fff;font-family:${FONT};font-size:14px;font-weight:800;line-height:28px;text-align:center;">${n}</div>
      </td>
      <td valign="top" style="padding:3px 0 14px;font-family:${FONT};font-size:15px;line-height:1.55;color:${INK};">${text}</td>
    </tr>`;
  const app = ([name, what, href, label]) => `
    <tr>
      <td style="padding:12px 0;border-top:1px solid #e6e3ea;">
        <a href="${href}" style="font-family:${FONT};font-size:15px;font-weight:800;color:${NAVY};text-decoration:none;">${name}</a>
        <div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED};">${what}</div>
      </td>
      <td align="right" valign="middle" style="padding:12px 0 12px 12px;border-top:1px solid #e6e3ea;white-space:nowrap;">
        <a href="${href}" style="font-family:${FONT};font-size:13px;font-weight:700;color:#2f8f00;text-decoration:none;">${label} →</a>
      </td>
    </tr>`;
  const picture = (key, alt, caption) => `
    <img src="${src[key]}" width="552" alt="${alt}" style="display:block;width:100%;max-width:552px;height:auto;border:1px solid #e6e3ea;border-radius:12px;">
    <p style="margin:8px 0 26px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">${caption}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${SUBJECT}</title>
</head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your venue is set up, Memberships and Vehicle access are on, and Metric Membership is connected. Sign in with Continue with Vesopa.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:${NAVY};">
      <img src="${src.hero}" width="600" alt="Metric Group UK is live on Vesopa EPOS: a member's car arrives, the camera reads the plate and the barrier lifts." style="display:block;width:100%;max-width:600px;height:auto;border:0;">
    </td></tr>
    <tr><td style="padding:34px 24px 6px;">
      ${p('Hi Matt,')}
      ${p(`Welcome to Vesopa EPOS. <strong>Metric Group UK</strong> is now set up as a venue on your account, <a href="mailto:m.hammond@metricgroup.co.uk" style="color:${NAVY};">m.hammond@metricgroup.co.uk</a>, and Metric Membership is connected to it. Your members, your plans and your barriers carry on exactly as before.`)}
    </td></tr>
    <tr><td style="padding:0 18px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${tile('Memberships', 'Plans, members, approvals and renewals in one list. Your Metric plans are already in it.')}
        ${tile('Vehicle access', "Members' number plates open the barrier. Cars, sites, gates and cameras stay in Metric Membership.")}
      </tr></table>
    </td></tr>
    <tr><td style="padding:8px 24px 0;">
      ${h2('How it fits together')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${step(1, 'Members and plans live in <strong>Vesopa EPOS</strong>, so the till, the kiosk and the back office all read the same list.')}
        ${step(2, '<strong>Metric Membership</strong> picks up every change within five minutes and keeps its own copy, so a barrier never waits on the internet.')}
        ${step(3, 'Approve, suspend or renew a member in either place and the other follows.')}
      </table>
    </td></tr>
    <tr><td style="padding:10px 24px 0;">
      ${picture('backoffice', 'The Memberships page in the Vesopa back office', 'Back office, Memberships. Shown here with example members.')}
    </td></tr>
    <tr><td style="padding:0 24px 8px;">
      ${h2('Signing in')}
      ${p(`Open any of the applications below, press <strong>Continue with Vesopa</strong> and enter <strong>m.hammond@metricgroup.co.uk</strong>. We email you a one-time code, or you can use your Vesopa password if you have set one. It is the same account you already use for Metric Membership, so there is nothing new to remember.`)}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 30px;"><tr>
        <td style="border-radius:12px;background:${NAVY};">
          <a href="https://backoffice.vesopaepos.com" style="display:inline-block;padding:15px 28px;font-family:${FONT};font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">Open your back office&nbsp;&nbsp;<span style="color:${GREEN};">→</span></a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:0 24px 10px;">
      ${h2('Your applications')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:26px;">
        ${APPS.map(app).join('')}
      </table>
      ${picture('app', 'The Metric Membership app sign-in screen', 'Your members keep using the Metric Membership app. Their car is their pass.')}
    </td></tr>
    <tr><td style="padding:0 24px 34px;">
      ${p('Any questions at all, just reply to this email and it comes straight to us.')}
      ${p(`Kind regards,<br><strong>The Vesopa team</strong><br><span style="color:${MUTED};">Vesopa Software Ltd</span>`, 'margin:0;')}
    </td></tr>
    <tr><td style="background:#f6f5f9;padding:18px 24px;border-top:4px solid ${LIME};">
      <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">You are receiving this because Metric Group UK was set up on Vesopa EPOS for you. Copied to info@vesopasoftware.com and info@vesopa.com.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

const TEXT = `Hi Matt,

Welcome to Vesopa EPOS. Metric Group UK is now set up as a venue on your account (m.hammond@metricgroup.co.uk), and Metric Membership is connected to it. Your members, plans and barriers carry on as before.

Switched on: Memberships, and Vehicle access.

How it fits together:
1. Members and plans live in Vesopa EPOS, so the till, kiosk and back office read the same list.
2. Metric Membership picks up every change within five minutes and keeps its own copy, so a barrier never waits on the internet.
3. Approve, suspend or renew a member in either place and the other follows.

Signing in: press Continue with Vesopa and enter m.hammond@metricgroup.co.uk. We email you a one-time code, or use your Vesopa password if you have set one.

Your applications:
${APPS.map(([n, w, h]) => `- ${n}: ${h}`).join('\n')}

Any questions, just reply to this email.

The Vesopa team
Vesopa Software Ltd
`;

async function main() {
  const previewAt = process.argv.indexOf('--preview');
  if (previewAt >= 0) {
    const out = path.resolve(process.argv[previewAt + 1] || 'metric-invite.html');
    const rel = (f) => path.relative(path.dirname(out), path.join(__dirname, f)).split(path.sep).join('/');
    fs.writeFileSync(out, html({ hero: rel('metric-hero.gif'), backoffice: rel('backoffice-memberships.png'), app: rel('metric-app.jpg') }));
    console.log(`preview written to ${out}`);
    return;
  }
  const attachments = PICTURES.map((x) => ({
    filename: x.file,
    content: fs.readFileSync(path.join(__dirname, x.file)),
    contentType: x.type,
    cid: x.cid,
  }));
  const body = html({ hero: 'cid:hero@vesopa', backoffice: 'cid:backoffice@vesopa', app: 'cid:app@vesopa' });
  if (!process.argv.includes('--send')) {
    console.log(`would send "${SUBJECT}" to ${TO}, cc ${CC.join(', ')} (${Math.round(body.length / 1024)} KB of HTML, ${attachments.length} pictures). Add --send.`);
    return;
  }
  const { sendMail } = require('../../src/mailer');
  const ok = await sendMail({ to: TO, cc: CC, replyTo: REPLY_TO, subject: SUBJECT, html: body, text: TEXT, attachments });
  if (!ok) throw new Error('the mail server did not take it (see the [mail] line above)');
  console.log(`sent "${SUBJECT}" to ${TO}, cc ${CC.join(', ')}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
