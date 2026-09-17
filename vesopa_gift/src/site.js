/**
 * gift.vesopa.com -- the public page for Vesopa Gift.
 *
 *   /             what a venue gets, The Vesopa Kitchen's shop as the live
 *                 demo, how it is set up, the plans and prices, a quote
 *   /sitemap.xml, /robots.txt
 *
 * Every venue's shop lives one path down (gift.vesopa.com/<venue>); this is
 * the page at the top. It used to answer "There is nothing here", which told
 * a venue that had heard of the product nothing about what it was or how to
 * get it -- the same gap loyalty.vesopa.com and menu.vesopa.com closed.
 *
 * THE VESOPA KITCHEN IS A DEMONSTRATION. Its shop at /vesopa-kitchen takes
 * sandbox payments only, and the page says so: a visitor can go through to
 * the pay page and nothing is charged.
 *
 * PRICES (set 2026-09-17, editable at /admin/website by the owner). The UK
 * voucher platforms an independent venue would otherwise use charge either a
 * cut of every voucher (typically 5-10%) or a per-site subscription in the
 * GBP 30-80 a month range, with tickets often a separate product on a
 * per-ticket fee. Vesopa's plans are flat, per venue, with no cut of what is
 * sold: the money goes through the venue's own Dojo account, not through us,
 * so zero commission is true by construction rather than a promise.
 *
 * The editor is in the staff console (admin.js, /admin/website): the owner is
 * already signed in there with a role Vesopa Auth gave them, so the page
 * needs no sign-in of its own. What it saves is one JSON row.
 *
 * Served only on BASE_URL's host. A venue's own domain and the retired
 * gift.vesopaepos.com (which 301s here) never see this page.
 */

const express = require('express');
const config = require('./config');
const db = require('./db');
const { money, parseMoney } = require('./util');

const HOST = config.BASE_URL.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();

const DEFAULTS = {
  contact_email: 'info@vesopasoftware.com',
  currency_note: 'Prices in pounds sterling, excluding VAT. Monthly, no long contract: cancel with 30 days\u2019 notice. No percentage of what you sell, ever.',
  demo_slug: 'vesopa-kitchen',
  plans: [
    {
      name: 'Vouchers',
      tagline: 'Gift vouchers sold online, spent at your till.',
      monthly_pence: 2900,
      setup_pence: 0,
      highlight: false,
      features: [
        'Your shop at gift.vesopa.com/yourvenue',
        'Vouchers for any amount, and experiences at a set price',
        'Emailed on the day the buyer chooses, or printed and handed over',
        'Apple Wallet and Google Wallet passes',
        'Redeemed at the Vesopa till by QR code or typed code',
        'Paid into your own Dojo account \u2014 no commission',
        'A balance page for the customer, a console for you',
      ],
    },
    {
      name: 'Vouchers & tickets',
      tagline: 'Everything in Vouchers, plus events with tickets and a door scanner.',
      monthly_pence: 4900,
      setup_pence: 0,
      highlight: true,
      features: [
        'Everything in Vouchers',
        'Events, tastings and classes with their own tickets',
        'Ticket types, prices and capacity per event',
        'A door page on any phone that scans the QR on each ticket',
        'A reminder to every guest the day before',
        'Refunds, resends and a guest list in the console',
      ],
    },
    {
      name: 'Own domain',
      tagline: 'The same shop at vouchers.yourvenue.co.uk, in your brand.',
      monthly_pence: 7900,
      setup_pence: 9900,
      highlight: false,
      features: [
        'Everything in Vouchers & tickets',
        'Your own address with its certificate, set up by us',
        'Your logo, colours, banner and fonts throughout',
        'Up to three venues under one console',
        'Priority support',
      ],
    },
  ],
};

async function readContent() {
  try {
    const row = await db.one("SELECT content FROM gift_site_settings WHERE id = 'main'");
    if (!row) return DEFAULTS;
    const saved = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
    return { ...DEFAULTS, ...saved, plans: Array.isArray(saved.plans) && saved.plans.length ? saved.plans : DEFAULTS.plans };
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') console.warn('[site] content unreadable, using defaults:', e.message);
    return DEFAULTS;
  }
}

/** The editor's form, read back into content. Unusable values keep what was there. */
function contentFromForm(body, current) {
  const plans = current.plans.map((p, i) => {
    const monthly = parseMoney(body[`plan_${i}_monthly`]);
    const setup = parseMoney(body[`plan_${i}_setup`]);
    return {
      name: String(body[`plan_${i}_name`] || p.name).trim().slice(0, 40) || p.name,
      tagline: String(body[`plan_${i}_tagline`] || '').trim().slice(0, 100),
      monthly_pence: Number.isNaN(monthly) ? p.monthly_pence : monthly,
      setup_pence: Number.isNaN(setup) ? p.setup_pence : setup,
      highlight: String(body.highlight) === String(i),
      features: String(body[`plan_${i}_features`] || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12),
    };
  });
  const slug = String(body.demo_slug || '').trim().toLowerCase();
  return {
    ...current,
    plans,
    currency_note: String(body.currency_note || '').trim().slice(0, 220) || DEFAULTS.currency_note,
    contact_email: String(body.contact_email || '').trim().slice(0, 190) || DEFAULTS.contact_email,
    demo_slug: /^[a-z0-9][a-z0-9-]{1,63}$/.test(slug) ? slug : current.demo_slug,
  };
}

async function saveContent(content, by) {
  await db.run(
    `INSERT INTO gift_site_settings (id, content, updated_by) VALUES ('main', ?, ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content), updated_by = VALUES(updated_by)`,
    [JSON.stringify(content), by],
  );
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICON = {
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="8" width="18" height="4"/><path d="M5 12v8h14v-8M12 8v12M12 8c-2-4-6-3-6-1s3 1 6 1zm0 0c2-4 6-3 6-1s-3 1-6 1z"/></svg>',
  till: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 8h4M7 12h10"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8a2 2 0 0 0 0 4v5h18v-5a2 2 0 0 0 0-4V5H3z"/><path d="M14 5v12" stroke-dasharray="2 2.5"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h14v4"/><rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="16" cy="13" r="1.5"/></svg>',
  pound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M14.5 8.5a2.5 2.5 0 0 0-5 0V14l-1.5 2h7M8 12h5"/></svg>',
};

function landing(c) {
  const demo = `/${encodeURIComponent(c.demo_slug)}`;
  const mail = (subject) => `mailto:${encodeURIComponent(c.contact_email)}?subject=${encodeURIComponent(subject)}`;
  const quote = mail('Gift vouchers for my venue \u2014 quote please');
  const plans = c.plans.map((p) => `
      <article class="plan${p.highlight ? ' is-highlight' : ''}">
        ${p.highlight ? '<span class="badge">Most popular</span>' : ''}
        <h3>${esc(p.name)}</h3>
        <p class="tagline">${esc(p.tagline)}</p>
        <div class="price">${esc(money(p.monthly_pence))}<small> /month</small></div>
        <p class="setup">${Number(p.setup_pence) > 0 ? `+ ${esc(money(p.setup_pence))} one-off setup` : 'No setup fee'}</p>
        <ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="btn ${p.highlight ? 'btn-lime' : 'btn-ghost'}" href="${esc(mail(`Vesopa Gift \u2014 ${p.name} plan, quote please`))}">Get a quote for ${esc(p.name)}</a>
      </article>`).join('');
  const title = 'Vesopa Gift \u2014 gift vouchers and tickets, sold online, spent at your till';
  const description = 'A white-label voucher and ticket shop for restaurants, caf\u00e9s, pubs and venues on Vesopa EPOS: vouchers for any amount, experiences, event tickets with a door scanner, paid straight into your own account. Flat monthly price, no commission.';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://${esc(HOST)}/">
<meta name="theme-color" content="#0D0D0C">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vesopa Gift">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="https://${esc(HOST)}/">
<meta property="og:image" content="https://${esc(HOST)}/img/site/desktop-shop.jpg">
<meta property="og:locale" content="en_GB">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/img/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${esc(c.css)}">
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Vesopa Gift',
    description,
    brand: { '@type': 'Organization', name: 'Vesopa Software Limited' },
    offers: c.plans.map((p) => ({ '@type': 'Offer', name: p.name, price: (Number(p.monthly_pence) / 100).toFixed(2), priceCurrency: 'GBP' })),
  }).replace(/</g, '\\u003c')}</script>
</head>
<body>
<header class="nav"><div class="wrap">
  <a class="brand" href="/" aria-label="Vesopa Gift"><img src="/img/site/vesopa-logo-on-dark.png" alt="Vesopa" width="140" height="22"><span>Gift</span></a>
  <nav aria-label="Sections"><a href="#demo">Demo</a><a href="#features">Features</a><a href="#till">At the till</a><a href="#how">How it works</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></nav>
  <a class="btn btn-lime" href="#pricing">Get a quote</a>
</div></header>
<main>
<section class="hero"><div class="wrap">
  <div>
    <span class="eyebrow">Gift vouchers &amp; tickets for Vesopa EPOS</span>
    <h1>Sell the gift of a night out. <span class="hl">Spent at your till.</span></h1>
    <p class="lead">A shop in your name where customers buy a voucher for any amount, an experience, or tickets to your next event \u2014 paid straight into your own account, emailed on the day they choose, and redeemed at your Vesopa till with a scan.</p>
    <div class="cta">
      <a class="btn btn-lime" href="${esc(demo)}">Open the demo shop</a>
      <a class="btn btn-ghost" href="#pricing">See pricing</a>
    </div>
  </div>
  <div class="phone"><img src="/img/site/phone-shop.jpg" alt="The Vesopa Kitchen\u2019s voucher shop on a phone" width="780" height="1688"></div>
</div></section>
<section class="demo" id="demo"><div class="wrap">
  <div class="section-head">
    <h2>Try The Vesopa Kitchen\u2019s shop</h2>
    <p>Our demonstration venue. It is exactly what your customers would see, with your name, colours and banner instead of ours.</p>
  </div>
  <div class="demo-card">
    <div class="tile"><img src="/img/site/mark-white.svg" alt="" width="84" height="60"></div>
    <div>
      <span class="tag">Demo \u00b7 test payments only</span>
      <h3>The Vesopa Kitchen</h3>
      <p>Pick a voucher, choose a design and a day to send it, and go as far as the pay page \u2014 it takes test cards only, so nothing is charged and nothing is sent.</p>
      <div class="cta">
        <a class="btn btn-dark" href="${esc(demo)}">Open the demo shop</a>
        <a class="btn btn-ghost" href="${esc(demo)}/balance">Check a balance</a>
      </div>
    </div>
  </div>
  <div class="shots gift-shots">
    <img src="/img/site/phone-shop.jpg" alt="The shop: a voucher for any amount, with the venue\u2019s branding" width="780" height="1688" loading="lazy">
    <img src="/img/site/phone-buy.jpg" alt="Buying an experience voucher: the design, the message and the day to send it" width="780" height="1688" loading="lazy">
    <img src="/img/site/phone-event.jpg" alt="An event with its ticket types and what is left" width="780" height="1688" loading="lazy">
    <img src="/img/site/phone-balance.jpg" alt="A customer checking what is left on a voucher" width="780" height="1688" loading="lazy">
  </div>
</div></section>
<section id="features"><div class="wrap">
  <div class="section-head"><h2>Everything a voucher shop should do</h2><p>Built for Vesopa EPOS, so a voucher sold online is a gift card your till already knows how to take.</p></div>
  <div class="grid3">
    <div class="feature"><div class="icon">${ICON.gift}</div><h3>Any amount, or an experience</h3><p>A \u00a320 voucher or \u00a3200; or \u201cSunday lunch for two\u201d at a set price. Your own designs, or ours.</p></div>
    <div class="feature"><div class="icon">${ICON.mail}</div><h3>Sent on the day they choose</h3><p>Emailed to the recipient on a birthday morning, or to the buyer to print and hand over. A gift message goes with it.</p></div>
    <div class="feature"><div class="icon">${ICON.till}</div><h3>Spent at the till</h3><p>Scan the QR or type the code on any Vesopa till. Part of the balance today, the rest next time; a refund puts it back.</p></div>
    <div class="feature"><div class="icon">${ICON.ticket}</div><h3>Tickets for your events</h3><p>Tastings, classes, a Christmas party: ticket types, prices and capacity, a guest list, and a phone at the door that scans them in.</p></div>
    <div class="feature"><div class="icon">${ICON.wallet}</div><h3>In their Wallet</h3><p>Every voucher can be added to Apple Wallet or Google Wallet, and the balance on the pass changes as it is spent.</p></div>
    <div class="feature"><div class="icon">${ICON.pound}</div><h3>Your money, straight to you</h3><p>Payments go through your own Dojo account by card, Apple Pay and Google Pay. We never hold your money and never take a cut.</p></div>
  </div>
</div></section>
<section class="demo" id="till"><div class="wrap">
  <div class="section-head"><h2>Sold online, spent at the counter</h2><p>The voucher is a gift card on your Vesopa till the moment it is paid for. Staff tender it like cash: scan, or type the code, and the balance comes off the bill.</p></div>
  <div class="wide-shot"><img src="/img/site/desktop-shop.jpg" alt="The Vesopa Kitchen\u2019s voucher shop on a desktop" width="2560" height="1700" loading="lazy"></div>
  <div class="cta gap-top">
    <a class="btn btn-dark" href="https://vesopaepos.com/download" rel="noopener">Get Vesopa EPOS</a>
    <a class="btn btn-ghost" href="https://menu.vesopa.com" rel="noopener">Vesopa Menu, the QR menu</a>
    <a class="btn btn-ghost" href="https://loyalty.vesopa.com" rel="noopener">Vesopa Loyalty</a>
  </div>
</div></section>
<section id="how"><div class="wrap">
  <div class="section-head"><h2>How your shop goes live</h2><p>Your branding, your venue and your till are already in Vesopa. The shop is switched on, not built.</p></div>
  <div class="steps">
    <div class="step"><h3>Say yes</h3><p>Tell us which plan. We switch your shop on and name the person who runs it; they sign in with their Vesopa account.</p></div>
    <div class="step"><h3>Add your Dojo key</h3><p>In your back office, once. From then on every voucher and ticket is paid into your own account.</p></div>
    <div class="step"><h3>Choose what to sell</h3><p>Voucher designs, experiences at a set price, your first event. Your name, logo and colours come from your branding.</p></div>
    <div class="step"><h3>Share the link</h3><p>gift.vesopa.com/yourvenue on your website, your socials and a card by the till. The first voucher is spendable the moment it is paid.</p></div>
  </div>
</div></section>
<section class="pricing" id="pricing"><div class="wrap">
  <div class="section-head"><h2>Simple pricing</h2><p>One flat price per venue, and nothing taken from what you sell.</p></div>
  <div class="plans">${plans}</div>
  <p class="note">${esc(c.currency_note)} Requires Vesopa EPOS at the venue and a Dojo account for card payments.</p>
</div></section>
<section id="faq"><div class="wrap">
  <div class="section-head"><h2>Questions</h2></div>
  <div class="faq">
    <details><summary>Do I need Vesopa EPOS?</summary><p>Yes. A voucher sold in the shop is a gift card on your till, which is what lets staff take it with a scan and what keeps the balance right across every counter.</p></details>
    <details><summary>Do you take a percentage?</summary><p>No. The buyer pays your own Dojo account directly; the money never passes through us. The price is the monthly fee and nothing else.</p></details>
    <details><summary>Where does the money go, and when?</summary><p>Into your Dojo account on the same terms as your card machine. A voucher is money owed to the customer until it is spent, and your accountant will tell you how to show it; the console reports what is outstanding.</p></details>
    <details><summary>Can customers spend a voucher a bit at a time?</summary><p>Yes. The till takes what the bill needs and the rest stays on the voucher. A refund off a receipt puts the amount back.</p></details>
    <details><summary>How do tickets work at the door?</summary><p>Every ticket carries a QR code. Any phone opens the door page for the event, scans the code and marks the guest in; a scanned-twice ticket says so.</p></details>
    <details><summary>What if we have our own domain?</summary><p>The Own domain plan puts the shop at vouchers.yourvenue.co.uk with its certificate, set up by us. The gift.vesopa.com address keeps working too.</p></details>
    <details><summary>How long does it take?</summary><p>The shop can be live the day you say yes. Own domains usually take a day for the certificate.</p></details>
  </div>
</div></section>
<section class="closing"><div class="wrap">
  <h2>Sell the first voucher this week</h2>
  <p>Tell us about your venue and we will switch on your shop so you can buy a test voucher yourself before you decide.</p>
  <div class="cta"><a class="btn btn-lime" href="${esc(quote)}">Get a quote</a><a class="btn btn-ghost" href="${esc(demo)}">Open the demo shop</a></div>
</div></section>
</main>

<footer><div class="wrap">
  <span>\u00a9 ${new Date().getFullYear()} Vesopa Software Limited, registered in Wales, company number 17362206.</span>
  <nav aria-label="Legal"><a href="https://auth.vesopa.com/privacy">Privacy</a><a href="https://auth.vesopa.com/terms">Terms</a><a href="https://loyalty.vesopa.com">Loyalty</a><a href="https://menu.vesopa.com">Menu</a><a href="https://vesopaepos.com">Vesopa EPOS</a><a href="${esc(quote)}">Contact</a></nav>
</div></footer>
</body>
</html>`;
}

function onSite(req) {
  return String(req.hostname || '').toLowerCase() === HOST;
}

function siteRoutes({ asset }) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    if (!onSite(req)) return next();
    try {
      const content = await readContent();
      res.set('Cache-Control', 'public, max-age=60');
      res.type('html').send(landing({ ...content, css: asset('/css/site.css') }));
    } catch (e) {
      next(e);
    }
  });
  router.get('/sitemap.xml', (req, res, next) => {
    if (!onSite(req)) return next();
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${HOST}/</loc></url></urlset>\n`);
  });
  router.get('/robots.txt', (req, res, next) => {
    if (!onSite(req)) return next();
    res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /account\nDisallow: /v/\nDisallow: /t/\nAllow: /\nSitemap: https://${HOST}/sitemap.xml\n`);
  });
  return router;
}

module.exports = { siteRoutes, readContent, saveContent, contentFromForm, DEFAULTS, HOST };
