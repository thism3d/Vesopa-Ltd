#!/usr/bin/env node
/**
 * The 30-day free trial mail (2026-10-18) to everyone whose demo request is
 * still waiting on approval, one message per person, sent as
 * "Muzahid Islam, Vesopa Developer" <muzahid@vesopa.com> through Auth's SMTP
 * settings, the same road as the Dojo invitations.
 *
 *   node tool/invite/trial/send-trial.js                      # lists who would get it
 *   node tool/invite/trial/send-trial.js --send --only info@vesopa.com   # one copy: that person if on the list, else a test with the first person's text
 *   node tool/invite/trial/send-trial.js --send               # everyone, one at a time
 *
 * Reads demo_request from the website's database (read only, changes nothing).
 * Each address it sends to is written to sent.log next to this file, and a
 * re-run skips those, so a run that stops half way can be started again.
 */
const fs = require('fs');
const path = require('path');

const FROM_ADDR = 'muzahid@vesopa.com';
const FROM = `"Muzahid Islam, Vesopa Developer" <${FROM_ADDR}>`;
const SUBJECT = 'Your 30-day free trial of Vesopa EPOS';
const SITE = 'https://vesopaepos.com';
const LOG = path.join(__dirname, 'sent.log');

const STORE = {
  epos: 'https://apps.microsoft.com/detail/9PDMNJXNFZCW',
  kitchen: 'https://apps.microsoft.com/detail/9P29NN3R5PGS',
  display: 'https://apps.microsoft.com/detail/9P8JCLQ5M3SQ',
  express: 'https://apps.microsoft.com/detail/9N5W5VLP2948',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = (name) => (String(name || '').trim().split(/\s+/)[0] || '').replace(/^./, (c) => c.toUpperCase());

function html({ name, email, business }) {
  const link = (href, text) => `<a href="${esc(href)}" style="color:#6e8a0e;font-weight:600;text-decoration:none">${esc(text)}</a>`;
  const hi = first(name) ? `Hi ${esc(first(name))},` : 'Hello,';
  const biz = business ? ` for ${esc(business)}` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your Vesopa EPOS trial</title></head>
<body style="margin:0;background:#f4f6ef;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6ef"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
  <tr><td style="background:#0e1108;padding:22px 28px"><img src="${SITE}/assets/logo/vesopa_logo_on_dark.png" alt="Vesopa" height="20" style="height:20px;width:auto"></td></tr>
  <tr><td style="padding:28px 28px 8px">
    <p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6e8a0e;font-weight:700">Your 30-day free trial</p>
    <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25">Thank you for asking about Vesopa EPOS.</h1>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#333">${hi}</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#333">Thanks for your demo request${biz}. The quickest way to see it is to try it: you can use Vesopa EPOS free for 30 days. No card, no contract. Your trial starts the first time you sign in, with this address: <b>${esc(email)}</b>.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:15px;line-height:1.55;color:#222">
      <tr><td style="padding:10px 0;border-top:1px solid #e6e8df"><b>1. Get Vesopa EPOS from the Microsoft Store.</b><br>${link(STORE.epos, 'Open the Store listing')} &mdash; it installs like any Store app and updates itself.</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #e6e8df"><b>2. Open it and press Continue with Vesopa.</b><br>Sign in with this email address. Your first 30 days are free.</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #e6e8df;border-bottom:1px solid #e6e8df"><b>3. Add what your counter needs</b> from the same Store:<br>
        ${link(STORE.kitchen, 'Vesopa Kitchen')} &middot; ${link(STORE.display, 'Customer Display')} &middot; ${link(STORE.express, 'Express kiosk')}</td></tr>
    </table>
    <p style="margin:20px 0 0"><a href="${STORE.epos}" style="display:inline-block;background:#a5c715;color:#10130a;font-weight:800;padding:13px 22px;border-radius:11px;text-decoration:none">Start my free trial</a></p>
    <p style="margin:22px 0 0;font-size:14px;line-height:1.55;color:#555">Products, prices, staff and reports live in the Back Office at ${link('https://backoffice.vesopaepos.com', 'backoffice.vesopaepos.com')} &mdash; the same sign-in. If you would rather we walk you through it, or you have any questions, just reply to this email and I will get back to you.</p>
    <p style="margin:18px 0 0;font-size:15px;line-height:1.55;color:#222">Kind regards,<br><b>Muzahid Islam</b><br><span style="color:#666">Vesopa Developer &middot; ${link('mailto:' + FROM_ADDR, FROM_ADDR)}</span></p>
  </td></tr>
  <tr><td style="padding:16px 28px 24px;font-size:12px;color:#888">Vesopa EPOS Ltd &middot; 1 High Street, Pontardawe, Swansea SA8 4HU &middot; ${link(SITE, 'vesopaepos.com')}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function text({ name, email, business }) {
  return `${first(name) ? `Hi ${first(name)},` : 'Hello,'}

Thanks for your demo request${business ? ` for ${business}` : ''}. You can use Vesopa EPOS free for 30 days. No card, no contract. Your trial starts the first time you sign in, with this address: ${email}.

1. Get Vesopa EPOS from the Microsoft Store: ${STORE.epos}
2. Open it and press Continue with Vesopa. Sign in with this email address.
3. Add what your counter needs: Vesopa Kitchen ${STORE.kitchen} , Customer Display ${STORE.display} , Express kiosk ${STORE.express}

The Back Office is at https://backoffice.vesopaepos.com with the same sign-in. Any questions, just reply to this email.

Kind regards,
Muzahid Islam
Vesopa Developer, ${FROM_ADDR}

Vesopa EPOS Ltd, 1 High Street, Pontardawe, Swansea SA8 4HU, vesopaepos.com
`;
}

function findEnv(names, test) {
  const { execSync } = require('child_process');
  for (const n of names) {
    const out = execSync(`ls ${n} 2>/dev/null || true`, { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const f of out) {
      const env = require('dotenv').parse(fs.readFileSync(f));
      if (test(env)) return { file: f, env };
    }
  }
  return null;
}

async function main() {
  const send = process.argv.includes('--send');
  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt > -1 ? process.argv[onlyAt + 1] : null;
  if (onlyAt > -1 && !/^[^@\s]+@[^@\s]+$/.test(only || '')) throw new Error('--only needs an address');

  const web = findEnv([process.env.WEB_ENV || '', '/home/*/web/vesopaepos.com/private/nodeapp/.env', '/home/*/web/www.vesopaepos.com/private/nodeapp/.env'].filter(Boolean),
    (e) => e.DB_USER && e.DB_PASSWORD);
  if (!web) throw new Error('website settings not found (set WEB_ENV to its .env)');
  const mysql = require('mysql2/promise');
  const db = await mysql.createConnection({
    host: web.env.DB_HOST || '127.0.0.1', port: Number(web.env.DB_PORT || 3306),
    user: web.env.DB_USER, password: web.env.DB_PASSWORD, database: web.env.DB_NAME || 'vesopa_eposdb',
  });
  const [rows] = await db.query(
    `SELECT name, email, business_name FROM demo_request WHERE approved = 'N' ORDER BY timeadded DESC`);
  await db.end();

  const seen = new Set();
  const people = [];
  for (const r of rows) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    people.push({ name: String(r.name || '').trim(), email, business: String(r.business_name || '').trim() });
  }
  const done = new Set(fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').map((l) => l.split('\t')[1]).filter(Boolean) : []);

  console.log(`${rows.length} waiting requests, ${people.length} distinct addresses (settings: ${web.file})`);
  people.forEach((p, i) => console.log(`${String(i + 1).padStart(2)}. ${p.name} | ${p.business} | ${p.email}${done.has(p.email) ? '  (already sent)' : ''}`));
  if (!send) { console.log('\nDry run. Add --send (with --only <addr> for a test copy).'); return; }

  const a = require('dotenv').parse(fs.readFileSync(process.env.AUTH_ENV || '/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp/.env'));
  const nodemailer = require('nodemailer');
  const tx = nodemailer.createTransport({
    host: a.SMTP_HOST || 'localhost', port: Number(a.SMTP_PORT || 587),
    secure: /^(1|true|yes)$/i.test(a.SMTP_SECURE || ''),
    auth: a.SMTP_USER ? { user: a.SMTP_USER, pass: a.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 60000,
  });
  console.log(`\nusing Auth's mail server ${a.SMTP_HOST || 'localhost'}:${a.SMTP_PORT || 587}`);

  const targets = only ? [{ ...(people.find((p) => p.email === only.toLowerCase()) || people[0]), to: only }] : people.filter((p) => !done.has(p.email)).map((p) => ({ ...p, to: p.email }));
  let ok = 0;
  for (const p of targets) {
    try {
      const info = await tx.sendMail({
        from: FROM, replyTo: FROM_ADDR, to: p.to, subject: SUBJECT,
        html: html(p), text: text(p), envelope: { from: FROM_ADDR, to: [p.to] },
      });
      ok++;
      console.log(`sent to ${p.to}: ${info.response}`);
      if (p.to.toLowerCase() === p.email) fs.appendFileSync(LOG, `${new Date().toISOString()}\t${p.email}\n`);
    } catch (e) {
      console.log(`FAILED ${p.to}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(`\n${ok} of ${targets.length} sent.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
