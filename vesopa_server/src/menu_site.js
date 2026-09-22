/**
 * menu.vesopa.com -- the public page for Vesopa Menu, and its editor.
 *
 *   /               what a venue gets, The Vesopa Kitchen's menu as the live
 *                   demo, how it is set up, the plans and prices, a quote
 *   /admin          the plans, prices and links, for info@vesopasoftware.com
 *                   (Continue with Vesopa; MENU_SITE_ADMINS lists who)
 *
 * Every venue's menu lives one path down (menu.vesopa.com/<venue>); this is
 * the page at the top. It used to be a single sentence saying what the
 * address was for, which told a venue nothing about what they could have.
 *
 * THE VESOPA KITCHEN IS A DEMONSTRATION. Its menu at /vesopakitchen is the one
 * EPOS buyers are shown; what is on it is sample data and the page says so.
 * The same venue's kitchen screen is the Vesopa Kitchen app in the Microsoft
 * Store, so the page links both halves: the menu a table scans and the
 * screen its orders land on.
 *
 * PRICES (set 2026-09-17, editable at /admin). UK order-at-table products for
 * independents run from about GBP 20 to GBP 100 a month, often plus a
 * percentage of every order; kitchen display screens GBP 15-40 a screen.
 * Vesopa's plans are flat, per venue, with no cut of orders, because the
 * orders go through the venue's own till and card machine.
 *
 * Served only on MENU_HOST; on any other host these routes step aside. The
 * quote is a mailto with the plan in the subject, the same as the loyalty
 * page: a venue wants a person to answer, and a form that files a ticket is
 * not that.
 */
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const idtoken = require('./vesopa_idtoken');
const { MENU_HOST, hostOf } = require('./menu_host');
const { CSS, ICON, esc, pounds, adminPage, cookieOptions, readCookie, money } = require('./loyalty_site');

const ADMINS = String(process.env.MENU_SITE_ADMINS || process.env.LOYALTY_SITE_ADMINS || 'info@vesopasoftware.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const COOKIE = '__Host-vesopa_menu_admin';
const FLOW_COOKIE = '__Host-vesopa_menu_flow';

const DEFAULTS = {
  contact_email: 'info@vesopasoftware.com',
  currency_note: 'Prices in pounds sterling, excluding VAT. Monthly, no long contract: cancel with 30 days\u2019 notice. No percentage of your orders, ever.',
  demo_slug: 'vesopakitchen',
  kitchen_store_url: 'https://apps.microsoft.com/detail/9P29NN3R5PGS',
  plans: [
    {
      name: 'Menu',
      tagline: 'Your menu on every phone that scans the code.',
      monthly_pence: 1900,
      setup_pence: 0,
      highlight: false,
      features: [
        'Your menu at menu.vesopa.com/yourvenue',
        'Live from your Vesopa till \u2014 change a price once, everywhere',
        'Photos, descriptions, allergens and dietary marks',
        'Search, categories and what is popular',
        'A QR code for every table, window and card',
        'Opens in any browser, nothing to install',
      ],
    },
    {
      name: 'Order at the table',
      tagline: 'Customers order and pay from their seat; the kitchen gets the ticket.',
      monthly_pence: 3900,
      setup_pence: 0,
      highlight: true,
      features: [
        'Everything in Menu',
        'Order from the table, with sizes, extras and special instructions',
        'Pay by card on the phone, or run a tab and pay at the till',
        'Orders arrive on the till and the Vesopa Kitchen screen',
        'Table codes, service calls and \u201cthe kitchen is closed\u201d handled',
        'Order status on the customer\u2019s phone',
      ],
    },
    {
      name: 'Own domain',
      tagline: 'The same menu at menu.yourvenue.com, in your brand.',
      monthly_pence: 5900,
      setup_pence: 9900,
      highlight: false,
      features: [
        'Everything in Order at the table',
        'Your own address with its certificate, set up by us',
        'Your logo, colours and fonts throughout',
        'Up to three venues under one back office',
        'Priority support',
      ],
    },
  ],
};

async function readContent(pool) {
  try {
    const [[row]] = await pool.query("SELECT content FROM menu_site_settings WHERE id = 'main'");
    if (!row) return DEFAULTS;
    const saved = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
    return { ...DEFAULTS, ...saved, plans: Array.isArray(saved.plans) && saved.plans.length ? saved.plans : DEFAULTS.plans };
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') console.warn('[menu_site] content unreadable, using defaults:', e.message);
    return DEFAULTS;
  }
}

const MORE_ICON = {
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/></svg>',
  order: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6h15l-1.5 9h-12z"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M6 6L5 3H2"/></svg>',
  pay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  kitchen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></svg>',
  allergen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>',
};

function landing(content) {
  const c = content;
  const demo = `/${encodeURIComponent(c.demo_slug)}`;
  const mail = (subject) => `mailto:${encodeURIComponent(c.contact_email)}?subject=${encodeURIComponent(subject)}`;
  const quote = mail('A QR menu for my venue \u2014 quote please');
  const plans = c.plans.map((p) => `
      <article class="plan${p.highlight ? ' is-highlight' : ''}">
        ${p.highlight ? '<span class="badge">Most popular</span>' : ''}
        <h3>${esc(p.name)}</h3>
        <p class="tagline">${esc(p.tagline)}</p>
        <div class="price">${esc(pounds(p.monthly_pence))}<small> /month</small></div>
        <p class="setup">${Number(p.setup_pence) > 0 ? `+ ${esc(pounds(p.setup_pence))} one-off setup` : 'No setup fee'}</p>
        <ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="btn ${p.highlight ? 'btn-lime' : 'btn-ghost'}" href="${esc(mail(`Vesopa Menu \u2014 ${p.name} plan, quote please`))}">Get a quote for ${esc(p.name)}</a>
      </article>`).join('');
  const title = 'Vesopa Menu \u2014 the QR menu your tables scan, ordering straight to the kitchen';
  const description = 'A QR code menu for restaurants, caf\u00e9s, pubs and takeaways on Vesopa EPOS: live from the till, order and pay at the table, tickets on the Vesopa Kitchen screen. Flat monthly price, no cut of orders.';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://${esc(MENU_HOST)}/">
<meta name="theme-color" content="#0D0D0C">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vesopa Menu">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="https://${esc(MENU_HOST)}/">
<meta property="og:image" content="https://${esc(MENU_HOST)}/assets/menu-site/kitchen-board.jpg">
<meta property="og:locale" content="en_GB">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Montserrat:wght@700;800&display=swap">
<style>${CSS}
.hero .phone{max-width:340px}
.shots.menu-shots{grid-template-columns:repeat(3,1fr)}
.shots.menu-shots img{border-radius:22px}
.kitchen-shot{margin-top:28px;border-radius:22px;border:1px solid #E5E5DE;overflow:hidden}
.kitchen-shot img{display:block;width:100%}
.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media (max-width:760px){.two{grid-template-columns:1fr}}
</style>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Vesopa Menu',
    description,
    brand: { '@type': 'Organization', name: 'Vesopa Software Limited' },
    offers: c.plans.map((p) => ({ '@type': 'Offer', name: p.name, price: (Number(p.monthly_pence) / 100).toFixed(2), priceCurrency: 'GBP' })),
  }).replace(/</g, '\\u003c')}</script>
</head>
<body>
<header class="nav"><div class="wrap">
  <a class="brand" href="/" aria-label="Vesopa Menu"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa" width="140" height="22"><span>Menu</span></a>
  <nav aria-label="Sections"><a href="#demo">Demo</a><a href="#features">Features</a><a href="#kitchen">Kitchen</a><a href="#how">How it works</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></nav>
  <a class="btn btn-lime" href="#pricing">Get a quote</a>
</div></header>
<main>
<section class="hero"><div class="wrap">
  <div>
    <span class="eyebrow">QR menu &amp; order at table for Vesopa EPOS</span>
    <h1>The menu your tables scan. <span class="hl">Orders straight to the kitchen.</span></h1>
    <p class="lead">One QR code on every table. Customers browse the menu on their own phone, order and pay from their seat, and the ticket lands on the till and the kitchen screen \u2014 live from the same catalogue your till already runs.</p>
    <div class="cta">
      <a class="btn btn-lime" href="${esc(demo)}">Open the demo menu</a>
      <a class="btn btn-ghost" href="#pricing">See pricing</a>
    </div>
  </div>
  <div class="phone"><img src="/assets/menu-site/phone-menu.jpg" alt="The Vesopa Kitchen demo menu on a phone" width="720" height="1558"></div>
</div></section>
<section class="demo" id="demo"><div class="wrap">
  <div class="section-head">
    <h2>Scan The Vesopa Kitchen\u2019s menu</h2>
    <p>Our demonstration venue. It is exactly what your customers would see, with your dishes, prices and photos instead of ours.</p>
  </div>
  <div class="demo-card">
    <div class="tile"><img src="/assets/loyalty-site/mark-white.svg" alt="" width="84" height="60"></div>
    <div>
      <span class="tag">Demo \u00b7 sample data</span>
      <h3>The Vesopa Kitchen</h3>
      <p>Open the menu as a customer would. Add a dish, choose a size, write a note for the kitchen \u2014 nothing is cooked, and nothing is charged.</p>
      <div class="cta">
        <a class="btn btn-dark" href="${esc(demo)}">Open the demo menu</a>
        ${c.kitchen_store_url ? `<a class="btn btn-ghost" href="${esc(c.kitchen_store_url)}" rel="noopener">The kitchen screen it orders to</a>` : ''}
      </div>
    </div>
  </div>
  <div class="shots menu-shots">
    <img src="/assets/menu-site/phone-menu.jpg" alt="The menu, with categories and search" width="720" height="1558" loading="lazy">
    <img src="/assets/menu-site/phone-menu-2.jpg" alt="Dishes with photos and prices" width="720" height="1558" loading="lazy">
    <img src="/assets/menu-site/phone-item.jpg" alt="A dish opened, with special instructions and Add to order" width="720" height="1558" loading="lazy">
  </div>
</div></section>
<section id="features"><div class="wrap">
  <div class="section-head"><h2>Everything a QR menu should do</h2><p>Built into Vesopa EPOS, so the menu is your till\u2019s catalogue and never drifts from it.</p></div>
  <div class="grid3">
    <div class="feature"><div class="icon">${MORE_ICON.qr}</div><h3>A code on every table</h3><p>Print a QR code per table, window or card. Scanning it opens your menu; a table code opens it for that table.</p></div>
    <div class="feature"><div class="icon">${MORE_ICON.live}</div><h3>Live from the till</h3><p>Change a price, run out of a dish or add a special in the back office and the menu changes at once.</p></div>
    <div class="feature"><div class="icon">${MORE_ICON.order}</div><h3>Order from the seat</h3><p>Sizes, extras, special instructions and \u201cif it is not available\u201d choices, exactly as a waiter would take them.</p></div>
    <div class="feature"><div class="icon">${MORE_ICON.pay}</div><h3>Pay on the phone or at the till</h3><p>Card on the phone, or a tab settled at the counter \u2014 through your own card machine, with no cut taken.</p></div>
    <div class="feature"><div class="icon">${MORE_ICON.kitchen}</div><h3>Tickets on the kitchen screen</h3><p>Orders land on the till and the Vesopa Kitchen screen with the table number, timed from the moment they arrive.</p></div>
    <div class="feature"><div class="icon">${MORE_ICON.allergen}</div><h3>Allergens and dietary marks</h3><p>The fourteen allergens, vegetarian, vegan and more, shown on every dish, from the same record your till prints.</p></div>
  </div>
</div></section>
<section class="demo" id="kitchen"><div class="wrap">
  <div class="section-head"><h2>The kitchen screen it orders to</h2><p>Vesopa Kitchen replaces the kitchen printer. A table\u2019s order appears the moment it is placed; tap each item as it is cooked and the ticket clears itself.</p></div>
  <div class="two">
    <div class="kitchen-shot"><img src="/assets/menu-site/kitchen-board.jpg" alt="The Vesopa Kitchen screen with open tickets" width="1273" height="857" loading="lazy"></div>
    <div class="kitchen-shot"><img src="/assets/menu-site/kitchen-board-2.jpg" alt="Tickets colour by how long they have waited" width="1271" height="799" loading="lazy"></div>
  </div>
  <div class="cta" style="margin-top:22px">
    ${c.kitchen_store_url ? `<a class="btn btn-dark" href="${esc(c.kitchen_store_url)}" rel="noopener">Get Vesopa Kitchen from the Microsoft Store</a>` : ''}
    <a class="btn btn-ghost" href="https://vesopaepos.com/download" rel="noopener">All five Vesopa apps</a>
  </div>
</div></section>
<section id="how"><div class="wrap">
  <div class="section-head"><h2>How your menu goes live</h2><p>Nothing to retype. Your till already has the menu.</p></div>
  <div class="steps">
    <div class="step"><h3>Switch it on</h3><p>In your Vesopa back office, under Dine-in. Your menu is live at menu.vesopa.com/yourvenue within the minute.</p></div>
    <div class="step"><h3>Add the photos</h3><p>A picture per dish, allergens and descriptions, in the same back office. Whatever you skip still works.</p></div>
    <div class="step"><h3>Print the codes</h3><p>Table cards and a window code, printed from the back office \u2014 or we print and post them to you.</p></div>
    <div class="step"><h3>Take the first order</h3><p>It appears on the till and the kitchen screen like any other. Your staff change nothing.</p></div>
  </div>
</div></section>
<section class="pricing" id="pricing"><div class="wrap">
  <div class="section-head"><h2>Simple pricing</h2><p>One flat price per venue, and none of your orders taken as commission.</p></div>
  <div class="plans">${plans}</div>
  <p class="note">${esc(c.currency_note)} Requires Vesopa EPOS at the venue; the kitchen screen is the Vesopa Kitchen app, included with every till.</p>
</div></section>
<section id="faq"><div class="wrap">
  <div class="section-head"><h2>Questions</h2></div>
  <div class="faq">
    <details><summary>Do I need Vesopa EPOS?</summary><p>Yes. The menu is your till\u2019s catalogue and the orders go to the till and the kitchen screen. That is what keeps it accurate with nothing to retype.</p></details>
    <details><summary>Do you take a percentage of orders?</summary><p>No. Payment goes through your own card machine or the customer\u2019s phone straight to you. The price is the monthly fee and nothing else.</p></details>
    <details><summary>Does it work without an app?</summary><p>Yes. The menu opens in the phone\u2019s browser from the QR code. Nothing to install, nothing to sign up for to look at a menu.</p></details>
    <details><summary>Can I keep my kitchen printers?</summary><p>Yes. Every station can be paper, screen or both. A venue that never opens the Vesopa Kitchen app prints as it always did.</p></details>
    <details><summary>What if we have our own domain?</summary><p>The Own domain plan puts the menu at menu.yourvenue.com with its certificate, set up by us. The menu.vesopa.com address keeps working too.</p></details>
    <details><summary>How long does it take?</summary><p>The menu can be live the same day you switch it on. Own domains usually take a day for the certificate.</p></details>
  </div>
</div></section>
<section class="closing"><div class="wrap">
  <h2>Put the menu in their hands</h2>
  <p>Tell us about your venue and we will set up your menu so you can scan it yourself before you decide.</p>
  <div class="cta"><a class="btn btn-lime" href="${esc(quote)}">Get a quote</a><a class="btn btn-ghost" href="${esc(demo)}">Open the demo menu</a></div>
</div></section>
</main>

<footer><div class="wrap">
  <span>\u00a9 ${new Date().getFullYear()} Vesopa Software Limited, registered in Wales, company number 17362206.</span>
  <nav aria-label="Legal"><a href="https://auth.vesopa.com/privacy">Privacy</a><a href="https://auth.vesopa.com/terms">Terms</a><a href="https://loyalty.vesopa.com">Loyalty</a><a href="https://vesopaepos.com">Vesopa EPOS</a><a href="${esc(quote)}">Contact</a></nav>
</div></footer>
</body>
</html>`;
}

function secret() {
  return String(process.env.JWT_SECRET || '');
}
function adminFrom(req) {
  try {
    const claims = jwt.verify(readCookie(req, COOKIE), secret(), { audience: 'menu-site-admin' });
    return ADMINS.includes(String(claims.email || '').toLowerCase()) ? claims : null;
  } catch {
    return null;
  }
}

function editor(content, admin, notice) {
  const plan = (p, i) => `
  <div class="card">
    <h2>Plan ${i + 1}</h2>
    <div class="row">
      <div class="field"><label>Name</label><input type="text" name="plan_${i}_name" value="${esc(p.name)}" maxlength="40" required></div>
      <div class="field"><label>One-line description</label><input type="text" name="plan_${i}_tagline" value="${esc(p.tagline)}" maxlength="90"></div>
    </div>
    <div class="row">
      <div class="field"><label>Monthly price (\u00a3, excluding VAT)</label><input type="number" name="plan_${i}_monthly" value="${(Number(p.monthly_pence) / 100).toFixed(2)}" min="0" step="0.01" required></div>
      <div class="field"><label>One-off setup (\u00a3, 0 for none)</label><input type="number" name="plan_${i}_setup" value="${(Number(p.setup_pence) / 100).toFixed(2)}" min="0" step="0.01" required></div>
    </div>
    <div class="field"><label>What is included (one per line)</label><textarea name="plan_${i}_features">${esc((p.features || []).join('\n'))}</textarea></div>
    <label class="check"><input type="radio" name="highlight" value="${i}" ${p.highlight ? 'checked' : ''}> Mark as \u201cMost popular\u201d</label>
  </div>`;
  return adminPage('Edit the menu website', `
<div class="top"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa"><span>Menu website \u00b7 ${esc(admin.email)}</span>
<form method="post" action="/admin/logout"><button class="btn btn-quiet" type="submit">Sign out</button></form></div>
<main>
  <h1>The menu website</h1>
  <p class="lead">What <a href="/" target="_blank" rel="noopener">${esc(MENU_HOST)}</a> shows. Saving changes the live page straight away.</p>
  ${notice === 'saved' ? '<div class="ok">Saved. The page shows the new prices now.</div>' : ''}
  ${notice && notice !== 'saved' ? `<div class="bad">${esc(notice)}</div>` : ''}
  <form method="post" action="/admin">
    <input type="hidden" name="csrf" value="${esc(admin.csrf)}">
    ${content.plans.map(plan).join('')}
    <div class="card"><h2>Around the prices</h2>
      <div class="field"><label>Note under the plans</label><input type="text" name="currency_note" value="${esc(content.currency_note)}" maxlength="200"></div>
      <div class="field"><label>Where \u201cGet a quote\u201d emails go</label><input type="email" name="contact_email" value="${esc(content.contact_email)}" maxlength="190" required></div>
    </div>
    <div class="card"><h2>The demo</h2>
      <div class="row">
        <div class="field"><label>Demo venue (its menu address, after the slash)</label><input type="text" name="demo_slug" value="${esc(content.demo_slug)}" maxlength="64" pattern="[a-z0-9][a-z0-9-]*" required></div>
        <div class="field"><label>Vesopa Kitchen on the Microsoft Store</label><input type="url" name="kitchen_store_url" value="${esc(content.kitchen_store_url)}" maxlength="300"><p class="hint">Leave empty to hide the button.</p></div>
      </div>
    </div>
    <button class="btn btn-lime" type="submit">Save and publish</button>
  </form>
</main>`);
}

function menuSiteRoutes({ pool }) {
  const router = express.Router();
  const onSite = (req) => MENU_HOST && hostOf(req) === MENU_HOST;
  const form = express.urlencoded({ extended: false, limit: '64kb' });

  router.get('/', async (req, res, next) => {
    if (!onSite(req)) return next();
    try {
      res.set('Cache-Control', 'public, max-age=60');
      res.type('html').send(landing(await readContent(pool)));
    } catch (e) {
      next(e);
    }
  });
  router.get('/sitemap.xml', (req, res, next) => {
    if (!onSite(req)) return next();
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${MENU_HOST}/</loc></url></urlset>\n`);
  });
  router.get('/robots.txt', (req, res, next) => {
    if (!onSite(req)) return next();
    res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /t/\nAllow: /\nSitemap: https://${MENU_HOST}/sitemap.xml\n`);
  });

  router.get('/admin', async (req, res, next) => {
    if (!onSite(req)) return next();
    try {
      const admin = adminFrom(req);
      res.set('Cache-Control', 'no-store');
      if (!admin) {
        return res.type('html').send(adminPage('Sign in', `
<div class="top"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa"><span>Menu website</span></div>
<main><h1>Edit the menu website</h1><p class="lead">For Vesopa staff. Sign in with your Vesopa account.</p>
${req.query.error ? `<div class="bad">${esc(String(req.query.error).slice(0, 200))}</div>` : ''}
<a class="btn btn-dark" href="/admin/login">Continue with Vesopa</a></main>`, 'Vesopa Menu'));
      }
      res.type('html').send(editor(await readContent(pool), admin, String(req.query.notice || '')));
    } catch (e) {
      next(e);
    }
  });
  router.get('/admin/login', (req, res, next) => {
    if (!onSite(req)) return next();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const flow = jwt.sign({ verifier, state }, secret(), { expiresIn: '10m', audience: 'menu-site-flow' });
    res.cookie(FLOW_COOKIE, flow, cookieOptions(10 * 60 * 1000));
    const url = new URL(`${idtoken.issuer()}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: idtoken.clientId(),
      redirect_uri: `https://${MENU_HOST}/admin/callback`,
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    res.redirect(302, url.toString());
  });
  router.get('/admin/callback', async (req, res, next) => {
    if (!onSite(req)) return next();
    const fail = (message) => res.redirect(302, `/admin?error=${encodeURIComponent(message)}`);
    try {
      let flow;
      try {
        flow = jwt.verify(readCookie(req, FLOW_COOKIE), secret(), { audience: 'menu-site-flow' });
      } catch {
        return fail('That sign-in took too long. Please try again.');
      }
      res.clearCookie(FLOW_COOKIE, cookieOptions(0));
      if (req.query.error) return fail('Sign-in was cancelled.');
      if (String(req.query.state || '') !== flow.state) return fail('That sign-in could not be matched. Please try again.');
      const idToken = await idtoken.exchangeCode({
        code: String(req.query.code || ''),
        verifier: flow.verifier,
        redirectUri: `https://${MENU_HOST}/admin/callback`,
      });
      const claims = idToken ? await idtoken.verify(idToken) : null;
      const email = String((claims && claims.email) || '').toLowerCase();
      if (!claims || !claims.email_verified) return fail('That sign-in could not be accepted.');
      if (!ADMINS.includes(email)) return fail(`${email} cannot edit this website.`);
      const session = jwt.sign({ email, sub: claims.sub, csrf: crypto.randomBytes(18).toString('base64url') },
        secret(), { expiresIn: '8h', audience: 'menu-site-admin' });
      res.cookie(COOKIE, session, cookieOptions(8 * 60 * 60 * 1000));
      console.log(`[menu_site] ${email} signed in to the editor`);
      res.redirect(302, '/admin');
    } catch (e) {
      next(e);
    }
  });
  router.post('/admin/logout', (req, res, next) => {
    if (!onSite(req)) return next();
    res.clearCookie(COOKIE, cookieOptions(0));
    res.redirect(302, '/admin');
  });
  router.post('/admin', form, async (req, res, next) => {
    if (!onSite(req)) return next();
    try {
      const admin = adminFrom(req);
      if (!admin) return res.redirect(302, '/admin');
      if (String(req.body.csrf || '') !== admin.csrf) return res.redirect(302, '/admin?notice=That%20form%20had%20expired.%20Nothing%20was%20saved.');
      const current = await readContent(pool);
      const plans = current.plans.map((p, i) => {
        const monthly = money(req.body[`plan_${i}_monthly`]);
        const setup = money(req.body[`plan_${i}_setup`]);
        return {
          name: String(req.body[`plan_${i}_name`] || p.name).trim().slice(0, 40) || p.name,
          tagline: String(req.body[`plan_${i}_tagline`] || '').trim().slice(0, 90),
          monthly_pence: monthly === null ? p.monthly_pence : monthly,
          setup_pence: setup === null ? p.setup_pence : setup,
          highlight: String(req.body.highlight) === String(i),
          features: String(req.body[`plan_${i}_features`] || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12),
        };
      });
      const slug = String(req.body.demo_slug || '').trim().toLowerCase();
      const content = {
        ...current,
        plans,
        currency_note: String(req.body.currency_note || '').trim().slice(0, 200) || DEFAULTS.currency_note,
        contact_email: String(req.body.contact_email || '').trim().slice(0, 190) || DEFAULTS.contact_email,
        demo_slug: /^[a-z0-9][a-z0-9-]{1,63}$/.test(slug) ? slug : current.demo_slug,
        kitchen_store_url: String(req.body.kitchen_store_url || '').trim().slice(0, 300),
      };
      await pool.query(
        `INSERT INTO menu_site_settings (id, content, updated_by) VALUES ('main', ?, ?)
         ON DUPLICATE KEY UPDATE content = VALUES(content), updated_by = VALUES(updated_by)`,
        [JSON.stringify(content), admin.email],
      );
      console.log(`[menu_site] ${admin.email} saved the website`);
      res.redirect(302, '/admin?notice=saved');
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { menuSiteRoutes, DEFAULTS };
