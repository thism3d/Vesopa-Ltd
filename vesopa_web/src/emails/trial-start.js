/**
 * Sent to somebody who typed their email into "Start your 30-day free trial"
 * on the download page: the three steps and the Store links, so the way in is
 * in their inbox as well as on the page they were looking at.
 *
 * Plain, table-based HTML like the other mails here — it has to read in
 * Outlook — with the brand green and nothing that needs an image to load.
 */
const { SITE_URL } = require('../config');
const { esc } = require('./notification');

const STORE = {
  epos: 'https://apps.microsoft.com/detail/9PDMNJXNFZCW',
  kitchen: 'https://apps.microsoft.com/detail/9P29NN3R5PGS',
  display: 'https://apps.microsoft.com/detail/9P8JCLQ5M3SQ',
  express: 'https://apps.microsoft.com/detail/9N5W5VLP2948',
  loyalty: 'https://apps.microsoft.com/detail/9N6VWPJ25VPH',
};

function renderTrialStart({ email }) {
  const link = (href, text) => `<a href="${esc(href)}" style="color:#6e8a0e;font-weight:600;text-decoration:none">${esc(text)}</a>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your Vesopa EPOS trial</title></head>
<body style="margin:0;background:#f4f6ef;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6ef"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
  <tr><td style="background:#0e1108;padding:22px 28px"><img src="${esc(SITE_URL)}/assets/logo/vesopa_logo_on_dark.png" alt="Vesopa" height="20" style="height:20px;width:auto"></td></tr>
  <tr><td style="padding:28px 28px 8px">
    <p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6e8a0e;font-weight:700">Your 30-day free trial</p>
    <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25">Three steps and you are ringing up.</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#333">No card, no contract. Your trial starts the first time you sign in, and this is the address to sign in with: <b>${esc(email)}</b>.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:15px;line-height:1.55;color:#222">
      <tr><td style="padding:10px 0;border-top:1px solid #e6e8df"><b>1. Get Vesopa EPOS from the Microsoft Store.</b><br>${link(STORE.epos, 'Open the Store listing')} &mdash; it installs like any Store app and updates itself.</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #e6e8df"><b>2. Open it and press Continue with Vesopa.</b><br>Sign in with this email address. Your first 30 days are free.</td></tr>
      <tr><td style="padding:10px 0;border-top:1px solid #e6e8df;border-bottom:1px solid #e6e8df"><b>3. Add what your counter needs</b> from the same Store:<br>
        ${link(STORE.kitchen, 'Vesopa Kitchen')} &middot; ${link(STORE.display, 'Customer Display')} &middot; ${link(STORE.express, 'Express kiosk')} &middot; ${link(STORE.loyalty, 'The Vesopa Kitchen (loyalty demo)')}</td></tr>
    </table>
    <p style="margin:20px 0 0"><a href="${esc(STORE.epos)}" style="display:inline-block;background:#a5c715;color:#10130a;font-weight:800;padding:13px 22px;border-radius:11px;text-decoration:none">Get Vesopa EPOS</a></p>
    <p style="margin:22px 0 0;font-size:14px;line-height:1.55;color:#555">Products, prices, staff and reports live in the Back Office at ${link('https://backoffice.vesopaepos.com', 'backoffice.vesopaepos.com')} &mdash; the same sign-in. Stuck on anything? Reply to this email; a person reads it.</p>
  </td></tr>
  <tr><td style="padding:16px 28px 24px;font-size:12px;color:#888">Vesopa EPOS Ltd &middot; 1 High Street, Pontardawe, Swansea SA8 4HU &middot; ${link(SITE_URL, 'vesopaepos.com')}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = { renderTrialStart, STORE };
