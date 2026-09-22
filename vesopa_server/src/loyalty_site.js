/**
 * loyalty.vesopa.com -- the public page for Vesopa's white-label loyalty app,
 * and its editor.
 *
 *   /               what a venue gets, The Vesopa Kitchen as the live demo,
 *                   how an app is published, the plans and prices
 *   /admin          the plans, prices and links, for info@vesopasoftware.com
 *                   (Continue with Vesopa; LOYALTY_SITE_ADMINS lists who)
 *
 * THE VESOPA KITCHEN IS A DEMONSTRATION. It is the venue EPOS buyers are shown
 * so they can see what their own app would be; everything on its card is
 * sample data, and the page says so.
 *
 * PRICES (set 2026-09-17, editable at /admin). UK loyalty apps for small venues
 * run from about £25 to £100 a month (Stamp Me £25-£42, branded apps from
 * about $49-$149 a month); enterprise white-label runs £100-£500+ a month with
 * setup fees in the thousands. Vesopa's plans sit at the independent end of
 * that, with the store publishing done for the venue.
 *
 * Served only on LOYALTY_HOST; on any other host these routes step aside.
 */

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const idtoken = require('./vesopa_idtoken');
const { LOYALTY_HOST } = require('./loyalty_host');
const { privacyPage } = require('./loyalty_privacy');
const { supportPage } = require('./loyalty_support');

const ADMINS = String(process.env.LOYALTY_SITE_ADMINS || 'info@vesopasoftware.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const COOKIE = '__Host-vesopa_loyalty_admin';
const FLOW_COOKIE = '__Host-vesopa_loyalty_flow';

const DEFAULTS = {
  contact_email: 'info@vesopasoftware.com',
  currency_note: 'Prices in pounds sterling, excluding VAT. Monthly, no long contract: cancel with 30 days\u2019 notice.',
  demo_slug: 'thevesopakitchen',
  demo_play_url: 'https://play.google.com/store/apps/details?id=com.vesopaepos.thevesopakitchen',
  demo_microsoft_url: 'https://apps.microsoft.com/detail/9N6VWPJ25VPH',
  plans: [
    {
      name: 'Web app',
      tagline: 'Your loyalty app in every browser, at your own address.',
      monthly_pence: 2900,
      setup_pence: 0,
      highlight: false,
      features: [
        'Your app at loyalty.vesopa.com/yourvenue',
        'Your name, logo, colours and fonts',
        'Digital card scanned at your Vesopa EPOS till',
        'Points, tiers and visit history',
        'News and offers with browser notifications',
        'Adds to the home screen on iPhone and Android',
      ],
    },
    {
      name: 'Store app',
      tagline: 'Your own app on Google Play and the Microsoft Store.',
      monthly_pence: 5900,
      setup_pence: 19900,
      highlight: true,
      features: [
        'Everything in Web app',
        'Published on Google Play and the Microsoft Store under your venue\u2019s name',
        'Phone and Windows notifications',
        'Store listing, screenshots and updates done for you',
        'Member photos and membership renewals',
        'In-app account deletion, as the stores require',
      ],
    },
    {
      name: 'Group',
      tagline: 'Several venues, each with its own app.',
      monthly_pence: 9900,
      setup_pence: 29900,
      highlight: false,
      features: [
        'Everything in Store app',
        'An app for each of up to three venues',
        'Offers sent when members are nearby',
        'Priority support',
        'A quarterly review of your offers and results',
      ],
    },
  ],
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pounds(pence) {
  const n = Number(pence) || 0;
  return n % 100 === 0 ? `£${n / 100}` : `£${(n / 100).toFixed(2)}`;
}

function hostOf(req) {
  return String(req.headers.host || '').split(':')[0].toLowerCase();
}

async function readContent(pool) {
  try {
    const [[row]] = await pool.query("SELECT content FROM loyalty_site_settings WHERE id = 'main'");
    if (!row) return DEFAULTS;
    const saved = JSON.parse(row.content);
    return { ...DEFAULTS, ...saved, plans: Array.isArray(saved.plans) && saved.plans.length ? saved.plans : DEFAULTS.plans };
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') console.warn('[loyalty_site] content unreadable, using defaults:', e.message);
    return DEFAULTS;
  }
}

// ---------------------------------------------------------------------------
// The public page
// ---------------------------------------------------------------------------

const CSS = `
:root{--lime:#A5C715;--lime-dark:#8CAA10;--ink:#0D0D0C;--ink-2:#161615;--line:#2A2A28;--text:#F4F4EF;--muted:#B9B9B1;--paper:#F6F6F1;--paper-ink:#141413;--paper-muted:#5A5A55;--radius:18px}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--ink);color:var(--text);font:400 16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}img{max-width:100%;height:auto;display:block}
.wrap{width:100%;max-width:1160px;margin:0 auto;padding:0 20px}
h1,h2,h3{font-family:Montserrat,Inter,system-ui,sans-serif;letter-spacing:-.02em;line-height:1.1;margin:0}
.hl{color:var(--lime)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 22px;border-radius:12px;font-weight:700;text-decoration:none;border:1px solid transparent;transition:transform .15s,background .15s}
.btn:hover{transform:translateY(-1px)}
.btn-lime{background:var(--lime);color:#111}.btn-lime:hover{background:#B5D526}
.btn-ghost{border-color:var(--line);color:var(--text);background:rgba(255,255,255,.03)}.btn-ghost:hover{background:rgba(255,255,255,.08)}
.btn-dark{background:#111;color:#fff}
header.nav{position:sticky;top:0;z-index:20;background:rgba(13,13,12,.82);backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid rgba(255,255,255,.06)}
.nav .wrap{display:flex;align-items:center;gap:28px;min-height:68px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none}
.brand img{height:22px;width:auto}
.brand span{font:700 11px/1 Inter,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);border-left:1px solid var(--line);padding-left:12px}
.nav nav{display:flex;gap:22px;margin-left:auto}
.nav nav a{text-decoration:none;color:var(--muted);font-weight:600;font-size:15px}.nav nav a:hover{color:var(--text)}
.nav .btn{min-height:40px;padding:0 16px;white-space:nowrap}
@media (max-width:480px){.brand span{display:none}.nav .wrap{gap:12px}}
@media (max-width:860px){.nav nav{display:none}.nav .btn{margin-left:auto}}
.hero{position:relative;overflow:hidden;padding:72px 0 40px}
.hero:before{content:"";position:absolute;inset:auto -20% -40% 30%;height:620px;background:radial-gradient(closest-side,rgba(165,199,21,.25),transparent);pointer-events:none}
.hero .wrap{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;align-items:center;position:relative}
.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid rgba(165,199,21,.35);border-radius:999px;color:var(--lime);font:700 12px/1 Inter,sans-serif;letter-spacing:.12em;text-transform:uppercase}
.eyebrow:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--lime)}
.hero h1{font-size:clamp(38px,5.4vw,64px);font-weight:800;margin:18px 0 18px}
.hero p.lead{font-size:clamp(17px,1.6vw,20px);color:var(--muted);max-width:40ch;margin:0 0 28px}
.cta{display:flex;flex-wrap:wrap;gap:12px}
.hero .phone{justify-self:center;max-width:360px;filter:drop-shadow(0 40px 60px rgba(0,0,0,.6))}
.hero .phone img{border-radius:28px}
@media (max-width:860px){.hero{padding-top:44px}.hero .wrap{grid-template-columns:1fr}.hero .phone{max-width:300px}}
section{padding:72px 0}
.section-head{max-width:720px;margin:0 0 36px}
.section-head h2{font-size:clamp(30px,3.6vw,44px);font-weight:800;margin-bottom:12px}
.section-head p{color:var(--muted);font-size:18px;margin:0}
.demo{background:var(--paper);color:var(--paper-ink)}
.demo .section-head p{color:var(--paper-muted)}
.demo-card{display:grid;grid-template-columns:auto 1fr;gap:34px;align-items:center;background:#fff;border:1px solid #E5E5DE;border-radius:24px;padding:30px;box-shadow:0 20px 50px rgba(0,0,0,.06)}
.demo-card .tile{width:128px;height:128px;border-radius:29px;background:var(--lime);display:grid;place-items:center;box-shadow:0 14px 30px rgba(165,199,21,.35)}
.demo-card .tile img{width:84px}
.demo-card h3{font-size:28px;font-weight:800;margin-bottom:8px}
.demo-card p{color:var(--paper-muted);margin:0 0 18px}
.demo-card .tag{display:inline-block;background:#111;color:#fff;border-radius:999px;padding:4px 10px;font:700 11px/1.4 Inter,sans-serif;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px}
.demo .btn-ghost{border-color:#D9D9D2;color:var(--paper-ink);background:#fff}.demo .btn-ghost:hover{background:#F0F0EA}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:28px}
.shots img{border-radius:22px;border:1px solid #E5E5DE}
@media (max-width:760px){.demo-card{grid-template-columns:1fr}.shots{grid-template-columns:repeat(3,minmax(160px,1fr));overflow-x:auto}}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
@media (max-width:900px){.grid3{grid-template-columns:1fr 1fr}}@media (max-width:600px){.grid3{grid-template-columns:1fr}}
.feature{background:var(--ink-2);border:1px solid var(--line);border-radius:var(--radius);padding:24px}
.feature .icon{width:44px;height:44px;border-radius:12px;background:rgba(165,199,21,.14);color:var(--lime);display:grid;place-items:center;margin-bottom:16px}
.feature .icon svg{width:22px;height:22px}
.feature h3{font-size:19px;font-weight:700;margin-bottom:8px}
.feature p{margin:0;color:var(--muted);font-size:15.5px}
.steps{counter-reset:s;display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
@media (max-width:900px){.steps{grid-template-columns:1fr 1fr}}@media (max-width:600px){.steps{grid-template-columns:1fr}}
.step{position:relative;padding:24px;border-radius:var(--radius);border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.03),transparent)}
.step:before{counter-increment:s;content:counter(s);display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--lime);color:#111;font:800 16px/1 Montserrat,sans-serif;margin-bottom:14px}
.step h3{font-size:18px;font-weight:700;margin-bottom:6px}.step p{margin:0;color:var(--muted);font-size:15px}
.pricing .plans{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;align-items:stretch}
@media (max-width:900px){.pricing .plans{grid-template-columns:1fr}}
.plan{position:relative;display:flex;flex-direction:column;background:var(--ink-2);border:1px solid var(--line);border-radius:22px;padding:28px}
.plan.is-highlight{border-color:var(--lime);box-shadow:0 0 0 1px var(--lime),0 30px 60px rgba(165,199,21,.12)}
.plan .badge{position:absolute;top:-12px;left:28px;background:var(--lime);color:#111;border-radius:999px;padding:4px 12px;font:800 11px/1.4 Inter,sans-serif;letter-spacing:.1em;text-transform:uppercase}
.plan h3{font-size:22px;font-weight:800}
.plan .tagline{color:var(--muted);margin:6px 0 20px;min-height:48px}
.plan .price{font:800 44px/1 Montserrat,sans-serif;letter-spacing:-.03em}
.plan .price small{font:600 16px/1 Inter,sans-serif;color:var(--muted);letter-spacing:0}
.plan .setup{color:var(--muted);margin:8px 0 22px;font-size:15px}
.plan ul{list-style:none;margin:0 0 26px;padding:0;display:grid;gap:10px;flex:1}
.plan li{position:relative;padding-left:28px;font-size:15.5px}
.plan li:before{content:"";position:absolute;left:0;top:4px;width:18px;height:18px;border-radius:6px;background:rgba(165,199,21,.16) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23A5C715' stroke-width='3'%3E%3Cpath d='M5 12l5 5L20 7'/%3E%3C/svg%3E") center/12px no-repeat}
.note{color:var(--muted);font-size:14px;margin-top:18px}
.faq{display:grid;gap:12px;max-width:860px}
.faq details{background:var(--ink-2);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.faq summary{cursor:pointer;font-weight:700;list-style:none;display:flex;justify-content:space-between;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary:after{content:"+";color:var(--lime);font-size:22px;line-height:1}
.faq details[open] summary:after{content:"\\2212"}
.faq p{color:var(--muted);margin:12px 0 0}
.closing{text-align:center;background:radial-gradient(60% 120% at 50% 100%,rgba(165,199,21,.22),transparent),var(--ink)}
.closing h2{font-size:clamp(30px,4vw,48px);font-weight:800;margin-bottom:14px}
.closing p{color:var(--muted);font-size:18px;margin:0 auto 28px;max-width:52ch}
.closing .cta{justify-content:center}
footer{border-top:1px solid var(--line);padding:30px 0;color:var(--muted);font-size:14px}
footer .wrap{display:flex;flex-wrap:wrap;gap:14px 26px;align-items:center;justify-content:space-between}
footer nav{display:flex;flex-wrap:wrap;gap:18px}footer a{text-decoration:none}footer a:hover{color:var(--text)}
`;

const ICON = {
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4"/></svg>',
  points: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 6.5 7 .8-5.2 4.8 1.4 7-6.2-3.6-6.2 3.6 1.4-7L2 9.3l7-.8z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M16 7l3 3M14 9l2 2"/></svg>',
  brush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l-5.5 5.5a2.1 2.1 0 003 3L12 14M14.5 3.5l6 6L12 18l-6-6z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>',
};

function landing(content) {
  const c = content;
  const demo = `/${encodeURIComponent(c.demo_slug)}/`;
  const mail = `mailto:${encodeURIComponent(c.contact_email)}?subject=${encodeURIComponent('A loyalty app for my venue')}`;
  const plans = c.plans.map((p) => `
      <article class="plan${p.highlight ? ' is-highlight' : ''}">
        ${p.highlight ? '<span class="badge">Most popular</span>' : ''}
        <h3>${esc(p.name)}</h3>
        <p class="tagline">${esc(p.tagline)}</p>
        <div class="price">${esc(pounds(p.monthly_pence))}<small> /month</small></div>
        <p class="setup">${Number(p.setup_pence) > 0 ? `+ ${esc(pounds(p.setup_pence))} one-off setup` : 'No setup fee'}</p>
        <ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="btn ${p.highlight ? 'btn-lime' : 'btn-ghost'}" href="${esc(mail)}">Start with ${esc(p.name)}</a>
      </article>`).join('');

  const title = 'Vesopa Loyalty \u2014 your venue\u2019s own loyalty app';
  const description = 'A branded loyalty app for restaurants, caf\u00e9s, pubs and clubs on Vesopa EPOS: a card scanned at the till, points, news and offers, published to Google Play, the Microsoft Store and the web under your venue\u2019s name.';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://${esc(LOYALTY_HOST)}/">
<meta name="theme-color" content="#0D0D0C">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vesopa Loyalty">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="https://${esc(LOYALTY_HOST)}/">
<meta property="og:image" content="https://${esc(LOYALTY_HOST)}/assets/loyalty-site/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:locale" content="en_GB">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://${esc(LOYALTY_HOST)}/assets/loyalty-site/og.png">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/loyalty-site/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Montserrat:wght@700;800&display=swap">
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Vesopa Loyalty',
    description,
    brand: { '@type': 'Organization', name: 'Vesopa Software Limited' },
    offers: c.plans.map((p) => ({ '@type': 'Offer', name: p.name, price: (Number(p.monthly_pence) / 100).toFixed(2), priceCurrency: 'GBP' })),
  }).replace(/</g, '\\u003c')}</script>
</head>
<body>
<header class="nav"><div class="wrap">
  <a class="brand" href="/" aria-label="Vesopa Loyalty"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa" width="140" height="22"><span>Loyalty</span></a>
  <nav aria-label="Sections"><a href="#demo">Demo</a><a href="#features">Features</a><a href="#how">How it works</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></nav>
  <a class="btn btn-lime" href="#pricing">Get your app</a>
</div></header>

<main>
<section class="hero"><div class="wrap">
  <div>
    <span class="eyebrow">White-label loyalty for Vesopa EPOS</span>
    <h1>Your venue\u2019s own <span class="hl">loyalty app</span>, under your name.</h1>
    <p class="lead">A card your customers show at the till, points that add up as they pay, and your news in their pocket \u2014 on Google Play, the Microsoft Store and the web.</p>
    <div class="cta">
      <a class="btn btn-lime" href="${esc(demo)}">Try the demo app</a>
      <a class="btn btn-ghost" href="#pricing">See pricing</a>
    </div>
  </div>
  <div class="phone"><img src="/assets/loyalty-site/phone-card.webp" alt="The Vesopa Kitchen demo app showing a member's card" width="720" height="1559"></div>
</div></section>

<section class="demo" id="demo"><div class="wrap">
  <div class="section-head">
    <h2>Meet The Vesopa Kitchen</h2>
    <p>Our demonstration venue. It is exactly what your customers would get, with your name, logo and colours instead of ours.</p>
  </div>
  <div class="demo-card">
    <div class="tile"><img src="/assets/loyalty-site/mark-white.svg" alt="" width="84" height="60"></div>
    <div>
      <span class="tag">Demo \u00b7 sample data</span>
      <h3>The Vesopa Kitchen</h3>
      <p>Open the web app, or install it from the stores. The members, visits and news in it are sample data, so you can see a busy loyalty scheme at work.</p>
      <div class="cta">
        <a class="btn btn-dark" href="${esc(demo)}">Open the web app</a>
        ${c.demo_play_url ? `<a class="btn btn-ghost" href="${esc(c.demo_play_url)}" rel="noopener">Google Play</a>` : ''}
        ${c.demo_microsoft_url ? `<a class="btn btn-ghost" href="${esc(c.demo_microsoft_url)}" rel="noopener">Microsoft Store</a>` : ''}
      </div>
    </div>
  </div>
  <div class="shots">
    <img src="/assets/loyalty-site/shot-visit.webp" alt="A visit opened to show what was spent and earned" width="540" height="1169" loading="lazy">
    <img src="/assets/loyalty-site/shot-news.webp" alt="News and offers from the venue" width="540" height="1169" loading="lazy">
    <img src="/assets/loyalty-site/shot-account.webp" alt="The member's account and membership" width="540" height="1169" loading="lazy">
  </div>
</div></section>

<section id="features"><div class="wrap">
  <div class="section-head"><h2>Everything a loyalty scheme needs</h2><p>Built into Vesopa EPOS, so points go on at the till with nothing extra to run.</p></div>
  <div class="grid3">
    <div class="feature"><div class="icon">${ICON.card}</div><h3>A card at the till</h3><p>Members show a code; the till scans it and adds points as they pay. The screen brightens so it scans first time.</p></div>
    <div class="feature"><div class="icon">${ICON.points}</div><h3>Points and tiers</h3><p>Every visit listed with what was spent and earned. Tiers reward your regulars automatically.</p></div>
    <div class="feature"><div class="icon">${ICON.bell}</div><h3>News and offers</h3><p>Send offers from your back office. They arrive as notifications and stay in the app to read later.</p></div>
    <div class="feature"><div class="icon">${ICON.brush}</div><h3>Your brand throughout</h3><p>Your name on the store listing and home screen, with your logo, colours and fonts in every screen.</p></div>
    <div class="feature"><div class="icon">${ICON.key}</div><h3>No passwords to forget</h3><p>Members join with a code by email or text, or Continue with Vesopa. Passkeys and passwords if they prefer.</p></div>
    <div class="feature"><div class="icon">${ICON.shield}</div><h3>Privacy built in</h3><p>Members can delete their account and data in the app or on the web, as Google Play and UK GDPR require.</p></div>
  </div>
</div></section>

<section id="how"><div class="wrap">
  <div class="section-head"><h2>How your app gets published</h2><p>We do the store work. You give us your brand and choose your offers.</p></div>
  <div class="steps">
    <div class="step"><h3>Tell us about your venue</h3><p>Your name, logo and colours, and how you want points to work.</p></div>
    <div class="step"><h3>We set it up</h3><p>Your app is switched on in your Vesopa back office, at loyalty.vesopa.com/yourvenue.</p></div>
    <div class="step"><h3>We publish it</h3><p>We prepare your listing and screenshots and publish to Google Play and the Microsoft Store.</p></div>
    <div class="step"><h3>Invite your customers</h3><p>Share your link and QR code at the till, on tables and online. Points start with the next visit.</p></div>
  </div>
</div></section>

<section class="pricing" id="pricing"><div class="wrap">
  <div class="section-head"><h2>Simple pricing</h2><p>One monthly price per venue. Store publishing and updates are included.</p></div>
  <div class="plans">${plans}</div>
  <p class="note">${esc(c.currency_note)} Requires Vesopa EPOS at the venue.</p>
</div></section>

<section id="faq"><div class="wrap">
  <div class="section-head"><h2>Questions</h2></div>
  <div class="faq">
    <details><summary>Do I need Vesopa EPOS?</summary><p>Yes. Points are added and spent at the Vesopa EPOS till, and your offers and members are managed in the same back office.</p></details>
    <details><summary>Whose name is on the app?</summary><p>Yours. Your app is listed on Google Play and the Microsoft Store under your venue\u2019s name, with your logo and colours.</p></details>
    <details><summary>What about iPhone customers?</summary><p>They use your web app at loyalty.vesopa.com/yourvenue, which they can add to their home screen like any other app.</p></details>
    <details><summary>How long does it take?</summary><p>The web app can be live the same day. Store apps usually take one to two weeks, most of it the stores\u2019 own review.</p></details>
    <details><summary>Who owns the customer data?</summary><p>You do. Vesopa Software Limited processes it on your behalf, and members can ask for their data to be deleted at any time.</p></details>
  </div>
</div></section>

<section class="closing"><div class="wrap">
  <h2>Put your venue in your customers\u2019 pockets</h2>
  <p>Tell us about your venue and we will show you your app before you commit to anything.</p>
  <div class="cta"><a class="btn btn-lime" href="${esc(mail)}">Get your app</a><a class="btn btn-ghost" href="${esc(demo)}">Try the demo</a></div>
</div></section>
</main>

<footer><div class="wrap">
  <span>\u00a9 ${new Date().getFullYear()} Vesopa Software Limited, registered in Wales, company number 17362206.</span>
  <nav aria-label="Legal"><a href="/privacy">Privacy</a><a href="/support">Support</a><a href="https://auth.vesopa.com/terms">Terms</a><a href="https://auth.vesopa.com/delete-account">Delete your data</a><a href="${esc(mail)}">Contact</a></nav>
</div></footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

function secret() {
  return String(process.env.JWT_SECRET || '');
}

function cookieOptions(maxAge) {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge };
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return raw ? decodeURIComponent(raw.slice(name.length + 1)) : '';
}

function adminFrom(req) {
  try {
    const claims = jwt.verify(readCookie(req, COOKIE), secret(), { audience: 'loyalty-site-admin' });
    return ADMINS.includes(String(claims.email || '').toLowerCase()) ? claims : null;
  } catch {
    return null;
  }
}

// The editor's shell; menu_site.js borrows it, so the product name is a parameter.
function page(title, body, product = 'Vesopa Loyalty') {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} \u00b7 ${esc(product)}</title>
<link rel="icon" type="image/png" href="/assets/favicon.png">
<style>
body{margin:0;background:#F6F6F1;color:#141413;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.top{background:#0D0D0C;color:#fff;padding:14px 20px;display:flex;align-items:center;gap:14px}.top img{height:20px}.top span{color:#B9B9B1;font-size:13px}.top form{margin-left:auto}
main{max-width:980px;margin:0 auto;padding:28px 20px 60px}h1{font-size:26px;margin:0 0 6px}p.lead{color:#5A5A55;margin:0 0 22px}
.card{background:#fff;border:1px solid #E5E5DE;border-radius:14px;padding:20px;margin-bottom:16px}
.card h2{font-size:17px;margin:0 0 14px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.row{grid-template-columns:1fr}}
label{display:block;font-weight:600;font-size:13.5px;margin:0 0 4px}input[type=text],input[type=email],input[type=url],input[type=number],textarea{width:100%;box-sizing:border-box;border:1px solid #C9C9C2;border-radius:9px;padding:9px 11px;font:inherit;background:#fff}
textarea{min-height:130px}.field{margin-bottom:12px}.hint{color:#5A5A55;font-size:13px;margin:4px 0 0}
.btn{display:inline-flex;align-items:center;min-height:42px;padding:0 18px;border-radius:10px;border:0;font:700 15px system-ui,sans-serif;cursor:pointer;text-decoration:none}
.btn-lime{background:#A5C715;color:#111}.btn-quiet{background:transparent;border:1px solid #3a3a37;color:#fff}.btn-dark{background:#111;color:#fff}
.ok{background:#EEF6D2;border:1px solid #A5C715;border-radius:10px;padding:10px 14px;margin-bottom:16px}.bad{background:#FDECEB;border:1px solid #A3231C;color:#A3231C;border-radius:10px;padding:10px 14px;margin-bottom:16px}
.check{display:flex;gap:8px;align-items:center;font-weight:600}
</style></head><body>${body}</body></html>`;
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
      <div class="field"><label>Monthly price (£, excluding VAT)</label><input type="number" name="plan_${i}_monthly" value="${(Number(p.monthly_pence) / 100).toFixed(2)}" min="0" step="0.01" required></div>
      <div class="field"><label>One-off setup (£, 0 for none)</label><input type="number" name="plan_${i}_setup" value="${(Number(p.setup_pence) / 100).toFixed(2)}" min="0" step="0.01" required></div>
    </div>
    <div class="field"><label>What is included (one per line)</label><textarea name="plan_${i}_features">${esc((p.features || []).join('\n'))}</textarea></div>
    <label class="check"><input type="radio" name="highlight" value="${i}" ${p.highlight ? 'checked' : ''}> Mark as \u201cMost popular\u201d</label>
  </div>`;
  return page('Edit the loyalty website', `
<div class="top"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa"><span>Loyalty website \u00b7 ${esc(admin.email)}</span>
<form method="post" action="/admin/logout"><button class="btn btn-quiet" type="submit">Sign out</button></form></div>
<main>
  <h1>The loyalty website</h1>
  <p class="lead">What <a href="/" target="_blank" rel="noopener">loyalty.vesopa.com</a> shows. Saving changes the live page straight away.</p>
  ${notice === 'saved' ? '<div class="ok">Saved. The page shows the new prices now.</div>' : ''}
  ${notice && notice !== 'saved' ? `<div class="bad">${esc(notice)}</div>` : ''}
  <form method="post" action="/admin">
    <input type="hidden" name="csrf" value="${esc(admin.csrf)}">
    ${content.plans.map(plan).join('')}
    <div class="card"><h2>Around the prices</h2>
      <div class="field"><label>Note under the plans</label><input type="text" name="currency_note" value="${esc(content.currency_note)}" maxlength="200"></div>
      <div class="field"><label>Where \u201cGet your app\u201d emails go</label><input type="email" name="contact_email" value="${esc(content.contact_email)}" maxlength="190" required></div>
    </div>
    <div class="card"><h2>The demo</h2>
      <div class="row">
        <div class="field"><label>Google Play link</label><input type="url" name="demo_play_url" value="${esc(content.demo_play_url)}" maxlength="300"><p class="hint">Leave empty to hide the button.</p></div>
        <div class="field"><label>Microsoft Store link</label><input type="url" name="demo_microsoft_url" value="${esc(content.demo_microsoft_url)}" maxlength="300"></div>
      </div>
    </div>
    <button class="btn btn-lime" type="submit">Save and publish</button>
  </form>
</main>`);
}

function money(value) {
  const n = Math.round(Number(String(value || '0').replace(/[^0-9.]/g, '')) * 100);
  return Number.isFinite(n) && n >= 0 && n < 10000000 ? n : null;
}

function loyaltySiteRoutes({ pool }) {
  const router = express.Router();
  const onSite = (req) => LOYALTY_HOST && hostOf(req) === LOYALTY_HOST;
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

  router.get('/privacy', async (req, res, next) => {
    if (!onSite(req)) return next();
    try {
      const content = await readContent(pool);
      res.set('Cache-Control', 'public, max-age=300');
      res.type('html').send(privacyPage({ host: LOYALTY_HOST, demoSlug: content.demo_slug, contact: content.contact_email }));
    } catch (e) {
      next(e);
    }
  });

  router.get('/support', async (req, res, next) => {
    if (!onSite(req)) return next();
    try {
      const content = await readContent(pool);
      res.set('Cache-Control', 'public, max-age=300');
      res.type('html').send(supportPage({ host: LOYALTY_HOST, demoSlug: content.demo_slug, contact: content.contact_email }));
    } catch (e) {
      next(e);
    }
  });

  router.get('/sitemap.xml', (req, res, next) => {
    if (!onSite(req)) return next();
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${LOYALTY_HOST}/</loc></url><url><loc>https://${LOYALTY_HOST}/privacy</loc></url><url><loc>https://${LOYALTY_HOST}/support</loc></url><url><loc>https://${LOYALTY_HOST}/${DEFAULTS.demo_slug}/</loc></url></urlset>`);
  });

  router.get('/admin', async (req, res, next) => {
    if (!onSite(req)) return next();
    try {
      const admin = adminFrom(req);
      res.set('Cache-Control', 'no-store');
      if (!admin) {
        return res.type('html').send(page('Sign in', `
<div class="top"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa"><span>Loyalty website</span></div>
<main><h1>Edit the loyalty website</h1><p class="lead">For Vesopa staff. Sign in with your Vesopa account.</p>
${req.query.error ? `<div class="bad">${esc(String(req.query.error).slice(0, 200))}</div>` : ''}
<a class="btn btn-dark" href="/admin/login">Continue with Vesopa</a></main>`));
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
    const flow = jwt.sign({ verifier, state }, secret(), { expiresIn: '10m', audience: 'loyalty-site-flow' });
    res.cookie(FLOW_COOKIE, flow, cookieOptions(10 * 60 * 1000));
    const url = new URL(`${idtoken.issuer()}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: idtoken.clientId(),
      redirect_uri: `https://${LOYALTY_HOST}/admin/callback`,
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
        flow = jwt.verify(readCookie(req, FLOW_COOKIE), secret(), { audience: 'loyalty-site-flow' });
      } catch {
        return fail('That sign-in took too long. Please try again.');
      }
      res.clearCookie(FLOW_COOKIE, cookieOptions(0));
      if (req.query.error) return fail('Sign-in was cancelled.');
      if (String(req.query.state || '') !== flow.state) return fail('That sign-in could not be matched. Please try again.');
      const idToken = await idtoken.exchangeCode({
        code: String(req.query.code || ''),
        verifier: flow.verifier,
        redirectUri: `https://${LOYALTY_HOST}/admin/callback`,
      });
      const claims = idToken ? await idtoken.verify(idToken) : null;
      const email = String((claims && claims.email) || '').toLowerCase();
      if (!claims || !claims.email_verified) return fail('That sign-in could not be accepted.');
      if (!ADMINS.includes(email)) return fail(`${email} cannot edit this website.`);
      const session = jwt.sign({ email, sub: claims.sub, csrf: crypto.randomBytes(18).toString('base64url') },
        secret(), { expiresIn: '8h', audience: 'loyalty-site-admin' });
      res.cookie(COOKIE, session, cookieOptions(8 * 60 * 60 * 1000));
      console.log(`[loyalty_site] ${email} signed in to the editor`);
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
      const b = req.body || {};
      if (!b.csrf || b.csrf !== admin.csrf) return res.redirect(302, '/admin?notice=' + encodeURIComponent('The form had expired. Please save again.'));
      const current = await readContent(pool);
      const plans = [];
      for (let i = 0; i < current.plans.length; i += 1) {
        const monthly = money(b[`plan_${i}_monthly`]);
        const setup = money(b[`plan_${i}_setup`]);
        const name = String(b[`plan_${i}_name`] || '').trim().slice(0, 40);
        if (!name || monthly == null || setup == null) {
          return res.redirect(302, '/admin?notice=' + encodeURIComponent(`Plan ${i + 1} needs a name and prices written as numbers.`));
        }
        plans.push({
          name,
          tagline: String(b[`plan_${i}_tagline`] || '').trim().slice(0, 90),
          monthly_pence: monthly,
          setup_pence: setup,
          highlight: String(b.highlight) === String(i),
          features: String(b[`plan_${i}_features`] || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12).map((s) => s.slice(0, 120)),
        });
      }
      const email = String(b.contact_email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect(302, '/admin?notice=' + encodeURIComponent('The contact email is not right.'));
      const url = (v) => {
        const s = String(v || '').trim();
        return !s || /^https:\/\//.test(s) ? s.slice(0, 300) : null;
      };
      const play = url(b.demo_play_url);
      const microsoft = url(b.demo_microsoft_url);
      if (play == null || microsoft == null) return res.redirect(302, '/admin?notice=' + encodeURIComponent('Store links must start with https://'));
      const content = {
        ...current,
        plans,
        contact_email: email,
        currency_note: String(b.currency_note || '').trim().slice(0, 200),
        demo_play_url: play,
        demo_microsoft_url: microsoft,
      };
      await pool.execute(
        `INSERT INTO loyalty_site_settings (id, content, updated_by) VALUES ('main', ?, ?)
         ON DUPLICATE KEY UPDATE content = VALUES(content), updated_by = VALUES(updated_by)`,
        [JSON.stringify(content), admin.email]
      );
      console.log(`[loyalty_site] ${admin.email} saved the website`);
      res.redirect(302, '/admin?notice=saved');
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// The look and the small helpers are shared with menu.vesopa.com's page
// (src/menu_site.js) so the two products read as one family.
module.exports = { loyaltySiteRoutes, DEFAULTS, CSS, ICON, esc, pounds, adminPage: page, cookieOptions, readCookie, money };
