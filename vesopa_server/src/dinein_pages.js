const express = require('express');

/**
 * The page a customer's phone actually loads.
 *
 * WHY IT IS A SERVER-RENDERED SHELL AND NOT AN APP
 *
 * This document is opened by somebody who has just pointed a camera at a card,
 * on a phone, on pub wifi, while the person opposite them is talking. Whatever
 * arrives has one job: put a legible menu in front of them before they lose
 * interest. So it is a single self-contained document — no framework, no build,
 * no second round trip for a bundle — and the menu itself is fetched once as
 * JSON and drawn.
 *
 * WHAT IT LOOKS LIKE, AND WHY
 *
 * The pattern every food app has converged on, because it works on a thumb:
 *
 *   * A banner with the venue's name and where you are sitting.
 *   * A row of section tabs that scrolls sideways, sticky under the header.
 *   * Long-scrolling sections underneath, and the tab highlights itself as you
 *     pass each heading — the scroll drives the tabs, not only the other way
 *     round. That is the detail that makes it feel like an app rather than a
 *     web page, and it is fifteen lines of IntersectionObserver.
 *   * A basket bar pinned to the bottom that only exists once something is in
 *     it, so an empty screen is all menu.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not ask anybody to sign in, install anything, or accept anything. The
 * name and number are one optional line at the end. A customer who wants to eat
 * should be able to get from a camera to a placed order without typing a single
 * character, and that is the whole test this page is written against.
 */
/**
 * The host that is nothing but menus.
 *
 * `menu.vesopaepos.com` serves the dine-in pages and nothing else, which is
 * what lets a venue's own address sit at the root of it —
 * `menu.vesopaepos.com/vesopakitchen`. That is the address a venue wants to
 * print, and it cannot collide with anything, because there is nothing else on
 * that host to collide with.
 *
 * It has to be a host check and not just a route, because the same application
 * also serves the back office, where `/products` and `/dashboard` are pages of
 * a single-page app. A bare `/:slug` route without this would swallow every one
 * of them.
 */
const MENU_HOST = (process.env.MENU_HOST || 'menu.vesopaepos.com')
  .trim()
  .toLowerCase();

/** The host this request arrived on, as the customer typed it. */
function hostOf(req) {
  const raw = req.headers['x-forwarded-host'] || req.headers.host || '';
  // A proxy may append; the first is the one the browser asked for. The port
  // is stripped because `menu.vesopaepos.com:443` is the same host.
  return String(raw).split(',')[0].trim().toLowerCase().split(':')[0];
}

/** Whether this request came in on the menu host. */
function onMenuHost(req) {
  const host = hostOf(req);
  return host === MENU_HOST || host === 'www.' + MENU_HOST;
}

/**
 * Everything the head of the document needs, resolved before it is rendered.
 *
 * WHY THIS IS SERVER-SIDE
 *
 * The body of this page is fetched as JSON, which is right: it is the part that
 * changes, and drawing it client-side is what makes the page arrive fast on pub
 * wifi. The head is not. A title, a description and a share card have to be in
 * the document as it leaves the server, because the things that read them —
 * WhatsApp, Messenger, iMessage, a search engine, the browser tab before the
 * fetch lands — do not run JavaScript.
 *
 * Without this the tab said "Menu", and a venue pasting their own link into a
 * WhatsApp group got a grey rectangle with no name on it. Which is the first
 * thing a customer sees of a venue that has just printed cards.
 */
async function metaFor(pool, { table, slug }) {
  const fallback = {
    name: 'Vesopa',
    tagline: 'Order from your table',
    accent: '#A5C715',
    image: null,
    icon: null,
    table: null,
  };
  if (!pool) return fallback;

  try {
    let row = null;
    if (table) {
      const [[found]] = await pool.query(
        'SELECT v.*, o.name AS office_name, t.name AS table_name,' +
          '       t.label AS table_label, t.table_number' +
          '  FROM floor_tables t' +
          '  JOIN dinein_venue v ON v.office_id = t.office_id' +
          '  LEFT JOIN offices o ON o.id = v.office_id' +
          ' WHERE t.public_id = ?',
        [table]
      );
      row = found;
    } else if (slug) {
      const [[found]] = await pool.query(
        'SELECT v.*, o.name AS office_name, NULL AS table_name,' +
          '       NULL AS table_label, NULL AS table_number' +
          '  FROM dinein_venue v' +
          '  LEFT JOIN offices o ON o.id = v.office_id' +
          ' WHERE v.slug = ?',
        [String(slug).toLowerCase()]
      );
      row = found;
    }
    if (!row || !row.is_published) return fallback;

    const tableName =
      (row.table_name || '').trim() ||
      (row.table_label || '').trim() ||
      (row.table_number != null ? 'Table ' + row.table_number : '');

    return {
      name: (row.display_name || row.office_name || 'Menu').trim(),
      tagline: (row.tagline || '').trim() || 'See the menu and order from your table',
      accent: row.accent_colour || '#A5C715',
      image: row.banner_url || row.logo_url || null,
      icon: row.logo_url || null,
      table: tableName || null,
    };
  } catch {
    // A page that cannot reach the database still has to render — the menu
    // itself is fetched separately and will report its own trouble.
    return fallback;
  }
}

function dineinPageRoutes({ pool } = {}) {
  const router = express.Router();

  /**
   * A table's menu, reached from the printed card.
   *
   * The id travels in the path and is read back by the page from its own URL,
   * so the document is identical for every table and can be cached as one thing
   * while the data behind it is not.
   */
  router.get('/t/:publicId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const meta = await metaFor(pool, { table: req.params.publicId });
    res.type('html').send(page({ table: req.params.publicId, slug: null, meta }));
  });

  /** The same menu at the venue's own address, with nothing to order onto. */
  router.get('/m/:slug', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const meta = await metaFor(pool, { slug: req.params.slug });
    res.type('html').send(page({ table: null, slug: req.params.slug, meta }));
  });

  /** Where an order has got to. */
  router.get('/o/:publicId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(statusPage(req.params.publicId));
  });

  /**
   * The venue's own address, at the root of the menu host.
   *
   * `menu.vesopaepos.com/vesopakitchen`. Guarded by the host, and by the shape
   * of a slug, so that on every other host this route does nothing at all and
   * the back office's own routing is untouched.
   *
   * Registered last, after /t/, /m/ and /o/, so those three keep their meaning
   * on this host too — a table code is still `menu.vesopaepos.com/t/<code>`.
   */
  router.get('/:slug', async (req, res, next) => {
    if (!onMenuHost(req)) return next();
    const slug = String(req.params.slug || '').toLowerCase();
    // Only what a slug can actually be. Anything else — a file, a dotted path,
    // something with a capital in it — is not a venue and is left alone.
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) return next();

    res.setHeader('Cache-Control', 'no-store');
    const meta = await metaFor(pool, { slug });
    res.type('html').send(page({ table: null, slug, meta }));
  });

  /**
   * The root of the menu host.
   *
   * Somebody has typed the domain without a venue on the end of it, which
   * happens when a card is read out loud or half-remembered. It says what the
   * address is for rather than 404ing at them.
   */
  router.get('/', (req, res, next) => {
    if (!onMenuHost(req)) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(landingPage());
  });

  return router;
}

/**
 * The address this page should be known by.
 *
 * One canonical per thing, so a menu reached at /vesopakitchen and at
 * /m/vesopakitchen is one page to a search engine rather than two competing
 * copies of the same venue.
 */
function canonicalFor({ table, slug }) {
  const base = (process.env.PUBLIC_BASE_URL || 'https://' + MENU_HOST)
    .trim()
    .replace(/\/+$/, '');
  if (table) return base + '/t/' + table;
  if (slug) return base + '/' + String(slug).toLowerCase();
  return base;
}

/**
 * The icon in the tab, and on a phone's home screen.
 *
 * The venue's own logo when they have uploaded one — it is their venue and
 * their customer. Vesopa's mark when they have not, because the alternative is
 * the browser's blank page glyph, which reads as a site that is half-built.
 *
 * `sizes="any"` on the fallback because it is an SVG-shaped PNG that scales;
 * the venue's is declared without sizes so the browser picks it up whatever
 * shape they uploaded.
 */
function iconTags(m) {
  if (m.icon) {
    return `<link rel="icon" href="${esc(m.icon)}">
` +
           `<link rel="apple-touch-icon" href="${esc(m.icon)}">`;
  }
  const mark = 'https://backoffice.vesopaepos.com/assets/vesopa_logo.png';
  return `<link rel="icon" href="${mark}" sizes="any">
` +
         `<link rel="apple-touch-icon" href="${mark}">`;
}

/**
 * What the bare menu domain says.
 *
 * Deliberately not a venue directory. The venues on this platform are separate
 * businesses, and a page listing all of them puts every one of them next to
 * their competitors on an address they are printing on their own tables.
 */
function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Vesopa menus</title>
<style>${STYLE}
.plain{max-width:520px;margin:0 auto;padding:64px 24px;text-align:center}
.plain h1{font-size:24px;margin:0 0 10px}
.plain p{color:var(--ink-soft);margin:0 0 8px}
.plain code{background:var(--sunken);padding:2px 8px;border-radius:6px;font-size:14px}
</style>
</head>
<body>
<div class="plain">
  <h1>Vesopa menus</h1>
  <p>This address serves the menu for a particular venue.</p>
  <p>Scan the code on your table, or use the link your venue gave you — it looks
     like <code>${esc(MENU_HOST)}/their-name</code>.</p>
</div>
</body>
</html>`;
}

/**
 * Escape a value on its way into the document.
 *
 * Only ever used on ids that came out of our own URL, but used anyway: the day
 * somebody puts a venue name through here it must already be safe, and a helper
 * added later is a helper somebody forgets to call.
 */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{
  --accent:#A5C715; --on-accent:#10130A;
  --ink:#14161A; --ink-soft:#63696F; --line:#E6E8E3;
  --page:#FFFFFF; --card:#FFFFFF; --sunken:#F4F5F1;
  --radius:14px;
}
@media (prefers-color-scheme: dark){
  :root{
    --ink:#F2F4F0; --ink-soft:#9AA0A6; --line:#2C3038;
    --page:#101216; --card:#181B21; --sunken:#14161A;
  }
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--page); color:var(--ink);
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
  /* Room for the basket bar, which is fixed and would otherwise sit on the
     last item on the menu — the one somebody is trying to read. */
  padding-bottom:96px;
}
img{max-width:100%;display:block}
button{font:inherit;cursor:pointer}

/* THE HERO.
 *
 * The venue's own photograph, full width, with its name on it — not a 172px
 * strip with the name in a white box underneath. A room is the first thing a
 * customer should see of the place they are sitting in, and a strip of it is a
 * decoration where a photograph is an introduction.
 *
 * It fades and drifts as the page scrolls, so it hands the screen over to the
 * menu rather than being scrolled past. The fade is driven from JavaScript
 * through a custom property; the transform is on the picture alone, so the
 * words stay put while the room moves behind them.
 */
.hero{
  position:relative;
  height:clamp(240px, 42vw, 380px);
  overflow:hidden;
  background:
    linear-gradient(135deg,
      color-mix(in srgb, var(--accent) 82%, #000 0%) 0%,
      color-mix(in srgb, var(--accent) 45%, var(--page)) 100%);
  --fade:1;
}
.hero.no-image{height:clamp(170px, 26vw, 240px)}

.hero-img{position:absolute;inset:-8% 0;will-change:transform}
.hero-img img{
  width:100%;height:100%;object-fit:cover;display:block;
  opacity:var(--fade);
}

/* Dark at the bottom so white type is legible over any photograph, and a touch
   at the top so a phone's status bar has something to sit on. */
.hero::after{
  content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(180deg,
    rgba(0,0,0,.34) 0%, rgba(0,0,0,0) 34%,
    rgba(0,0,0,.30) 62%, rgba(0,0,0,.72) 100%);
  opacity:var(--fade);
}

.hero-body{
  position:absolute;left:0;right:0;bottom:0;z-index:2;
  padding:0 16px 20px;
  display:flex;gap:14px;align-items:flex-end;
  max-width:680px;margin:0 auto;
  opacity:var(--fade);
}
.hero h1{
  margin:0;font-size:clamp(23px,5.6vw,31px);line-height:1.12;
  letter-spacing:-.02em;color:#fff;
  text-shadow:0 2px 14px rgba(0,0,0,.45);
}
.hero .tag{
  margin:3px 0 0;font-size:14px;color:rgba(255,255,255,.88);
  text-shadow:0 1px 8px rgba(0,0,0,.4);
}
.logo{
  width:62px;height:62px;border-radius:16px;flex:0 0 auto;
  background:var(--card);border:2px solid var(--card);
  box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden;
  display:grid;place-items:center;font-size:24px;font-weight:800;
  color:var(--accent);padding:7px
}
/* Contain, not cover. A venue's logo is as likely to be a wide wordmark as a
   square badge, and cover on a wordmark crops out the middle two letters and
   presents those as the brand. */
.logo img{width:100%;height:100%;object-fit:contain}

.where{
  margin:14px auto 0;max-width:648px;padding:11px 14px;
  border-radius:var(--radius);
  background:var(--sunken);display:flex;align-items:center;gap:10px;
  font-size:14px;font-weight:600
}
.where .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:0 0 auto}
.where.warn{background:#FFF3CD;color:#5C4813}
@media (prefers-color-scheme: dark){ .where.warn{background:#3A3009;color:#F6E7B4} }

.meta{display:flex;flex-wrap:wrap;gap:8px;margin:10px auto 0;
       max-width:648px;padding:0}
.meta a,.meta span{
  font-size:13px;color:var(--ink-soft);text-decoration:none;
  border:1px solid var(--line);border-radius:999px;padding:6px 12px
}

.notice{
  margin:14px auto 0;max-width:648px;padding:12px 14px;
  border-radius:var(--radius);
  border:1px dashed var(--line);font-size:14px;color:var(--ink-soft)
}

/* The sideways tab strip. Sticky, so it is reachable from anywhere in a long
   menu without scrolling back to the top. */
/* Sticky, and full-bleed on purpose: the strip scrolls sideways, and a strip
   that stopped at the column edge would hide its own overflow behind a margin.
   The buttons inside it are held to the column. */
.tabs{
  position:sticky;top:0;z-index:20;margin-top:18px;
  background:var(--page);border-bottom:1px solid var(--line);
  display:flex;gap:8px;overflow-x:auto;padding:10px 16px;
  scrollbar-width:none;-webkit-overflow-scrolling:touch;
  scroll-padding-inline:16px;
}
@media (min-width:712px){
  .tabs{justify-content:center}
}
.tabs::-webkit-scrollbar{display:none}
.tabs button{
  flex:0 0 auto;border:1px solid var(--line);background:var(--card);
  color:var(--ink);border-radius:999px;padding:9px 16px;
  font-size:14.5px;font-weight:600;white-space:nowrap;transition:.15s
}
.tabs button[aria-current="true"]{
  background:var(--accent);color:var(--on-accent);border-color:var(--accent)
}

/* A MENU IS A COLUMN, NOT A SPREADSHEET.
 *
 * Everything below the banner is held to a readable width and centred. Without
 * this the page filled whatever it was given: on a 1280px laptop the dish name
 * sat at the far left and its "+" at the far right with two feet of nothing
 * between them, and the description ran to a line length nobody reads. A menu
 * has the shape it has on paper for a reason.
 *
 * The banner is deliberately outside it, so a venue's photograph still runs
 * edge to edge on a wide screen. */
.col{max-width:680px;margin:0 auto}

section{padding:24px 16px 4px;scroll-margin-top:72px}
section h2{margin:0 0 2px;font-size:20px;letter-spacing:-.01em}
section .blurb{margin:0 0 6px;color:var(--ink-soft);font-size:14px}

.item{
  display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--line);
  align-items:flex-start
}
.item:last-child{border-bottom:0}
.item .body{flex:1 1 auto;min-width:0}
.item h3{margin:0 0 3px;font-size:16px;font-weight:650;line-height:1.3}
.item p{margin:0;color:var(--ink-soft);font-size:14px}

/* The price sits with the dish; the button sits alone.
 *
 * They were briefly stacked together on the right, which centred the *pair*
 * against the row and left the button itself fifteen pixels low on every line
 * down the page. The column is narrow enough now that the price does not need
 * to chase the button to be read with it — so the price goes back under the
 * description where a menu puts it, and the button gets the right-hand column
 * to itself and the exact middle of the row. */
.item .end{
  flex:0 0 auto;align-self:stretch;
  display:flex;align-items:center;justify-content:flex-end;
  padding-left:10px
}
.item .price{
  display:block;margin-top:6px;
  font-weight:700;font-size:15px;white-space:nowrap
}
.item .thumb{
  width:84px;height:84px;border-radius:12px;flex:0 0 auto;
  background:var(--sunken);overflow:hidden
}
.item .thumb img{width:100%;height:100%;object-fit:cover}
/* A dish with no photograph still holds the space one would take.
 *
 * Without this the name of a dish with a picture started 100px further in than
 * the name of the one under it, and a list where half the items have pictures —
 * which is most lists — read as two lists interleaved. Invisible rather than a
 * grey tile: twenty empty tiles down a page is worse than a straight edge. */
.item .thumb.none{background:none}
.item.gone{opacity:.55}
.item .gone-tag{
  display:inline-block;margin-top:6px;font-size:12px;font-weight:700;
  color:#B3261E;text-transform:uppercase;letter-spacing:.04em
}

/* The plus is drawn, not typed.
 *
 * As a text glyph it sits on a baseline with its own ascender and side
 * bearings, so it is never quite in the middle of a circle however the line
 * height is set — it reads a pixel or two high, on every row, all the way down
 * the page. Two rules through the centre cannot be off centre. */
.add{
  border:0;border-radius:999px;background:var(--accent);color:var(--on-accent);
  width:40px;height:40px;flex:0 0 auto;position:relative;
  /* font-size:0 is the guard, not the mechanism. The glyph is gone from the
     markup, but a phone holding a cached copy of the shell would otherwise draw
     a 16px "+" off-centre underneath these two rules and the button would read
     as a smudge. currentColor is untouched — the rules below are painted with
     it. */
  font-size:0;line-height:0;
  transition:transform .12s ease
}
.add:active{transform:scale(.92)}
.add::before,.add::after{
  content:"";position:absolute;top:50%;left:50%;
  background:currentColor;border-radius:1px;
}
.add::before{width:15px;height:2.5px;transform:translate(-50%,-50%)}
.add::after{width:2.5px;height:15px;transform:translate(-50%,-50%)}
.add[disabled]{background:var(--sunken);color:var(--ink-soft)}
.qty{display:flex;align-items:center;gap:10px}
.qty button{
  width:34px;height:34px;border-radius:999px;border:1px solid var(--line);
  background:var(--card);color:var(--ink);font-size:18px;line-height:1
}
.qty b{min-width:18px;text-align:center;font-size:16px}

.basket{
  position:fixed;left:0;right:0;bottom:0;z-index:40;
  padding:12px 16px calc(12px + env(safe-area-inset-bottom));
  background:var(--card);border-top:1px solid var(--line);
  box-shadow:0 -8px 28px rgba(0,0,0,.14);
  transform:translateY(140%);transition:transform .22s cubic-bezier(.2,.8,.3,1)
}
.basket.up{transform:none}
.basket button{
  width:100%;max-width:648px;margin:0 auto;
  border:0;border-radius:14px;background:var(--accent);
  color:var(--on-accent);padding:16px;font-size:16.5px;font-weight:750;
  display:flex;justify-content:space-between;align-items:center;gap:12px
}

dialog{
  border:0;border-radius:20px 20px 0 0;padding:0;width:100%;max-width:560px;
  margin:auto auto 0;background:var(--card);color:var(--ink)
}
dialog::backdrop{background:rgba(0,0,0,.5)}
.sheet{padding:20px 18px calc(20px + env(safe-area-inset-bottom))}
.sheet h2{margin:0 0 4px;font-size:19px}
.sheet .row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;font-size:15px}
.sheet .row.total{border-top:1px solid var(--line);margin-top:6px;padding-top:12px;font-weight:750;font-size:17px}
.sheet label{display:block;margin:14px 0 5px;font-size:13px;font-weight:650;color:var(--ink-soft)}
.sheet input,.sheet textarea{
  width:100%;padding:13px;border-radius:12px;border:1px solid var(--line);
  background:var(--sunken);color:var(--ink);font:inherit
}
.sheet .send{
  width:100%;margin-top:18px;border:0;border-radius:14px;background:var(--accent);
  color:var(--on-accent);padding:16px;font-size:16.5px;font-weight:750
}
.sheet .send[disabled]{opacity:.55}
.sheet .shut{
  width:100%;margin-top:10px;border:0;background:none;color:var(--ink-soft);
  padding:10px;font-size:14.5px
}
.err{margin-top:12px;color:#B3261E;font-size:14px;font-weight:600}

.state{padding:60px 24px;text-align:center;color:var(--ink-soft)}
.state h2{color:var(--ink);font-size:20px;margin:0 0 8px}

.track{padding:26px 18px;max-width:560px;margin:0 auto}
.step{display:flex;gap:14px;padding:14px 0;align-items:flex-start}
.step .pip{
  width:26px;height:26px;border-radius:999px;flex:0 0 auto;
  border:2px solid var(--line);display:grid;place-items:center;
  font-size:13px;font-weight:800;color:var(--ink-soft)
}
.step.done .pip{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.step.now .pip{border-color:var(--accent);color:var(--accent)}
.step h3{margin:1px 0 2px;font-size:16px}
.step p{margin:0;color:var(--ink-soft);font-size:14px}
`;

/**
 * The menu document.
 *
 * `table` and `slug` are baked in rather than parsed out of `location` by the
 * script, so the page knows what it is before a single byte of JavaScript runs
 * and a mis-routed URL fails here rather than three functions in.
 */
function page({ table, slug, meta }) {
  const m = meta || {};
  const name = m.name || 'Menu';
  // The venue first, Vesopa after. A customer looking at a tab, a share card or
  // a search result is looking for the place they are sitting in — the platform
  // that runs the till is the footnote, not the headline.
  const title = m.table ? `${name} — ${m.table}` : `${name} — Menu`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="${esc(m.accent || '#A5C715')}">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · Vesopa</title>
<meta name="description" content="${esc(m.tagline || '')}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${esc(canonicalFor({ table, slug }))}">

${iconTags(m)}

<meta property="og:type" content="restaurant.menu">
<meta property="og:site_name" content="Vesopa">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(m.tagline || '')}">
<meta property="og:url" content="${esc(canonicalFor({ table, slug }))}">
${m.image ? `<meta property="og:image" content="${esc(m.image)}">` : ''}
<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(m.tagline || '')}">
${m.image ? `<meta name="twitter:image" content="${esc(m.image)}">` : ''}

<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${esc(name)}">
<meta name="format-detection" content="telephone=no">
<style>${STYLE}</style>
</head>
<body>
<div id="app"><div class="state"><h2>Loading the menu…</h2><p>One moment.</p></div></div>

<div class="basket" id="basketBar">
  <button id="basketBtn" type="button">
    <span id="basketCount">0 items</span>
    <span id="basketTotal">£0.00</span>
  </button>
</div>

<dialog id="checkout"><div class="sheet" id="checkoutBody"></div></dialog>

<script>
(function(){
  "use strict";
  var TABLE = ${table ? `"${esc(table)}"` : 'null'};
  var SLUG  = ${slug ? `"${esc(slug)}"` : 'null'};

  var data = null;
  // item id -> quantity. Notes live alongside so the same dish ordered twice
  // with different instructions stays two lines.
  var basket = Object.create(null);

  var app = document.getElementById('app');
  var bar = document.getElementById('basketBar');
  var dlg = document.getElementById('checkout');

  function money(minor){ return '£' + (minor/100).toFixed(2); }

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function load(){
    var url = TABLE
      ? '/api/public/dinein/table/' + encodeURIComponent(TABLE)
      : '/api/public/dinein/venue/' + encodeURIComponent(SLUG);
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
      .then(function(res){
        if (!res.ok) return fail(res.body && res.body.error);
        data = res.body;
        draw();
      })
      .catch(function(){
        fail('We could not reach the kitchen. Check your signal and try again.');
      });
  }

  function fail(message){
    app.innerHTML =
      '<div class="state"><h2>' + esc(message || 'This menu is not available.') +
      '</h2><p>Please ask a member of staff.</p></div>';
  }

  function draw(){
    var v = data.venue;
    document.title = v.name || 'Menu';
    if (v.accent) {
      document.documentElement.style.setProperty('--accent', v.accent);
      // Pick legible ink for whatever colour the venue chose. A venue that
      // sets a pale yellow accent would otherwise get white-on-yellow buttons.
      document.documentElement.style.setProperty('--on-accent', inkOn(v.accent));
    }

    var html = '';

    // The venue's room, full width, with its name on it. The name lives on the
    // photograph rather than under it — a strip of a room is a decoration, a
    // photograph of one is an introduction.
    html += '<header class="hero' + (v.banner_url ? '' : ' no-image') + '" id="hero">' +
      (v.banner_url
        ? '<div class="hero-img" id="heroImg"><img src="' + esc(v.banner_url) +
          '" alt="" fetchpriority="high"></div>'
        : '') +
      '<div class="hero-body">' +
        '<div class="logo">' +
          (v.logo_url
            ? '<img src="' + esc(v.logo_url) + '" alt="">'
            : esc((v.name || '?').trim().charAt(0).toUpperCase())) +
        '</div>' +
        '<div><h1>' + esc(v.name) + '</h1>' +
        (v.tagline ? '<p class="tag">' + esc(v.tagline) + '</p>' : '') +
        '</div>' +
      '</div>' +
    '</header>';

    if (data.table) {
      html += data.table.ordering
        ? '<div class="where"><span class="dot"></span>You are at ' +
            esc(data.table.name) +
            (data.table.room ? ' · ' + esc(data.table.room) : '') + '</div>'
        : '<div class="where warn">This table is not taking orders from phones — ' +
            'please order at the bar.</div>';
    } else {
      html += '<div class="where">Viewing the menu. Scan the code on your table to order.</div>';
    }

    var meta = '';
    if (v.phone) meta += '<a href="tel:' + esc(v.phone) + '">' + esc(v.phone) + '</a>';
    if (v.address) meta += '<span>' + esc(v.address) + '</span>';
    if (v.map_url) meta += '<a href="' + esc(v.map_url) + '" target="_blank" rel="noopener">Find us</a>';
    if (meta) html += '<div class="meta">' + meta + '</div>';

    if (v.notice) html += '<div class="notice">' + esc(v.notice) + '</div>';

    var sections = (data.sections || []).filter(function(s){
      return s.items && s.items.length;
    });

    if (!sections.length) {
      html += '<div class="state"><h2>Nothing on the menu yet</h2>' +
              '<p>Please ask a member of staff.</p></div>';
      app.innerHTML = html;
      return;
    }

    html += '<nav class="tabs" id="tabs">';
    sections.forEach(function(s, i){
      html += '<button type="button" data-go="sec' + s.id + '"' +
              (i === 0 ? ' aria-current="true"' : '') + '>' + esc(s.name) + '</button>';
    });
    html += '</nav>';

    html += '<div class="col">';
    sections.forEach(function(s){
      html += '<section id="sec' + s.id + '" data-sec="' + s.id + '">' +
              '<h2>' + esc(s.name) + '</h2>' +
              (s.blurb ? '<p class="blurb">' + esc(s.blurb) + '</p>' : '');
      s.items.forEach(function(it){
        html += itemHtml(it);
      });
      html += '</section>';
    });
    html += '</div>';

    app.innerHTML = html;
    wireTabs(sections);
    wireHero();
    app.addEventListener('click', onTap);
    paintBasket();
  }

  function itemHtml(it){
    var can = it.available && canOrder();
    // Price and control in one right-hand column. Apart, a customer's eye had
    // to cross the row to connect what a thing costs with how to order it.
    return '<div class="item' + (it.available ? '' : ' gone') + '" data-item="' + it.id + '">' +
      (it.image_url
        ? '<div class="thumb"><img src="' + esc(it.image_url) + '" alt="" loading="lazy"></div>'
        : '<div class="thumb none"></div>') +
      '<div class="body">' +
        '<h3>' + esc(it.name) + '</h3>' +
        (it.description ? '<p>' + esc(it.description) + '</p>' : '') +
        (it.available ? '' : '<span class="gone-tag">Sold out</span>') +
        '<span class="price">' + money(it.price_minor) + '</span>' +
      '</div>' +
      '<div class="end">' + (can ? controlsHtml(it.id) : '') + '</div>' +
    '</div>';
  }

  function controlsHtml(id){
    var qty = basket[id] ? basket[id].qty : 0;
    if (!qty) {
      return '<button class="add" type="button" data-add="' + id + '" ' +
             'aria-label="Add"></button>';
    }
    return '<div class="qty">' +
      '<button type="button" data-less="' + id + '" aria-label="One fewer">−</button>' +
      '<b>' + qty + '</b>' +
      '<button type="button" data-add="' + id + '" aria-label="One more">+</button>' +
    '</div>';
  }

  function canOrder(){
    return !!(data && data.table && data.table.ordering && data.venue.ordering_open);
  }

  function onTap(e){
    var add = e.target.closest('[data-add]');
    var less = e.target.closest('[data-less]');
    if (!add && !less) return;
    var id = Number((add || less).getAttribute(add ? 'data-add' : 'data-less'));
    var entry = basket[id] || (basket[id] = { qty: 0 });
    entry.qty += add ? 1 : -1;
    if (entry.qty <= 0) delete basket[id];
    redrawItem(id);
    paintBasket();
  }

  /** Redraw one row rather than the menu. Redrawing all of it loses the scroll
      position, which on a long menu throws somebody back to the starters. */
  function redrawItem(id){
    var row = app.querySelector('[data-item="' + id + '"]');
    if (!row) return;
    // Into the end column, not onto the row. Appended to the row it would land
    // beside the price instead of under it, and the layout would come apart the
    // first time somebody added something.
    var end = row.querySelector('.end');
    if (!end) return;
    var old = end.querySelector('.add, .qty');
    var holder = document.createElement('div');
    holder.innerHTML = controlsHtml(id);
    var fresh = holder.firstChild;
    if (old && fresh) end.replaceChild(fresh, old);
    else if (fresh) end.appendChild(fresh);
  }

  function eachChosen(fn){
    Object.keys(basket).forEach(function(id){
      var item = find(Number(id));
      if (item) fn(item, basket[id].qty);
    });
  }

  function find(id){
    var hit = null;
    (data.sections || []).forEach(function(s){
      (s.items || []).forEach(function(it){ if (it.id === id) hit = it; });
    });
    return hit;
  }

  function totals(){
    var count = 0, sum = 0;
    eachChosen(function(item, qty){ count += qty; sum += item.price_minor * qty; });
    return { count: count, sum: sum };
  }

  function paintBasket(){
    var t = totals();
    document.getElementById('basketCount').textContent =
      t.count + (t.count === 1 ? ' item' : ' items');
    document.getElementById('basketTotal').textContent = money(t.sum);
    bar.classList.toggle('up', t.count > 0);
  }

  document.getElementById('basketBtn').addEventListener('click', openCheckout);

  function openCheckout(){
    var v = data.venue;
    var t = totals();
    var rows = '';
    eachChosen(function(item, qty){
      rows += '<div class="row"><span>' + qty + ' × ' + esc(item.name) + '</span>' +
              '<span>' + money(item.price_minor * qty) + '</span></div>';
    });

    document.getElementById('checkoutBody').innerHTML =
      '<h2>Your order</h2>' +
      '<p class="tag" style="margin:0 0 10px;color:var(--ink-soft);font-size:14px">' +
        esc(data.table ? data.table.name : '') + '</p>' +
      rows +
      '<div class="row total"><span>Total</span><span>' + money(t.sum) + '</span></div>' +
      '<label for="cname">Your name' + (v.require_name ? '' : ' (optional)') + '</label>' +
      '<input id="cname" autocomplete="name" enterkeyhint="next">' +
      '<label for="cphone">Phone' + (v.require_phone ? '' : ' (optional)') + '</label>' +
      '<input id="cphone" type="tel" autocomplete="tel" enterkeyhint="next">' +
      '<label for="cnote">Anything the kitchen should know? (optional)</label>' +
      '<textarea id="cnote" rows="2" placeholder="Allergies, no onions…"></textarea>' +
      '<div class="err" id="cerr" hidden></div>' +
      '<button class="send" id="csend" type="button">Send to the kitchen</button>' +
      '<button class="shut" id="cshut" type="button">Keep looking</button>';

    document.getElementById('cshut').addEventListener('click', function(){ dlg.close(); });
    document.getElementById('csend').addEventListener('click', send);
    dlg.showModal();
  }

  function send(){
    var btn = document.getElementById('csend');
    var err = document.getElementById('cerr');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    err.hidden = true;

    var lines = [];
    eachChosen(function(item, qty){ lines.push({ item_id: item.id, qty: qty }); });

    fetch('/api/public/dinein/table/' + encodeURIComponent(TABLE) + '/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lines: lines,
        name: document.getElementById('cname').value,
        phone: document.getElementById('cphone').value,
        note: document.getElementById('cnote').value
      })
    })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
      .then(function(res){
        if (!res.ok) {
          err.textContent = res.body && res.body.error
            ? res.body.error
            : 'That did not go through. Please try again.';
          err.hidden = false;
          btn.disabled = false;
          btn.textContent = 'Send to the kitchen';
          return;
        }
        location.href = '/o/' + res.body.public_id;
      })
      .catch(function(){
        err.textContent = 'We could not reach the kitchen. Check your signal.';
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Send to the kitchen';
      });
  }

  /**
   * The hero hands the screen over as you scroll.
   *
   * It fades out across its own height and the picture drifts up at a third of
   * the scroll speed, so the room recedes rather than being yanked off the top.
   * Everything is written to one custom property and one transform, both read
   * inside a requestAnimationFrame — a scroll handler that touches layout on
   * every event is what makes a page feel heavy on the phone this is for.
   *
   * Honours "reduce motion": the fade stays, because it is what hands the
   * screen over, and the parallax goes, because it is the part that moves.
   */
  function wireHero(){
    var hero = document.getElementById('hero');
    if (!hero) return;
    var img = document.getElementById('heroImg');
    var still = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var ticking = false;

    function paint(){
      ticking = false;
      var h = hero.offsetHeight || 1;
      var y = window.scrollY || window.pageYOffset || 0;
      // Never quite to nothing: a hero that vanishes entirely leaves a hard
      // edge where the photograph was.
      var fade = Math.max(0, 1 - (y / h) * 1.15);
      hero.style.setProperty('--fade', fade.toFixed(3));
      if (img && !still) {
        img.style.transform = 'translate3d(0,' + (y * 0.32).toFixed(1) + 'px,0)';
      }
    }

    window.addEventListener('scroll', function(){
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(paint);
    }, { passive: true });
    paint();
  }

  /**
   * Tabs and scroll, kept in step in both directions.
   *
   * Tapping a tab scrolls to its section; scrolling past a heading lights its
   * tab and slides the strip so the live tab is always visible. Without the
   * second half the strip silently goes wrong on a long menu, which is worse
   * than having no tabs at all.
   */
  function wireTabs(sections){
    var tabs = document.getElementById('tabs');
    if (!tabs) return;

    tabs.addEventListener('click', function(e){
      var btn = e.target.closest('[data-go]');
      if (!btn) return;
      var target = document.getElementById(btn.getAttribute('data-go'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    if (!('IntersectionObserver' in window)) return;
    var seen = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (!entry.isIntersecting) return;
        var id = entry.target.id;
        Array.prototype.forEach.call(tabs.children, function(btn){
          var live = btn.getAttribute('data-go') === id;
          if (live) {
            btn.setAttribute('aria-current', 'true');
            btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          } else {
            btn.removeAttribute('aria-current');
          }
        });
      });
    }, {
      // A band just under the sticky strip. Without the negative top the
      // heading counts as visible while it is still behind the tabs.
      rootMargin: '-64px 0px -70% 0px',
      threshold: 0
    });
    sections.forEach(function(s){
      var el = document.getElementById('sec' + s.id);
      if (el) seen.observe(el);
    });
  }

  /** Black or white, whichever is readable on the venue's accent colour. */
  function inkOn(hex){
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return '#10130A';
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    // Rec. 709 luma. Anything bright takes dark ink.
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150 ? '#10130A' : '#FFFFFF';
  }

  load();
})();
</script>
</body>
</html>`;
}

/**
 * The page a customer lands on after ordering.
 *
 * It exists because the alternative is a customer staring at a menu wondering
 * whether the tap did anything. It polls rather than holding a socket open: a
 * phone that has gone to sleep in a pocket drops a socket and reconnecting it
 * is more code than asking every few seconds, and nothing here is urgent to the
 * second.
 */
function statusPage(publicId) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#A5C715">
<title>Your order</title>
<style>${STYLE}</style>
</head>
<body>
<div class="track" id="track"><div class="state"><h2>Checking…</h2></div></div>
<script>
(function(){
  "use strict";
  var ID = "${esc(publicId)}";
  var track = document.getElementById('track');

  function money(minor){ return '£' + (minor/100).toFixed(2); }
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  var STEPS = [
    { key:'placed',   title:'Sent',     line:'The till has your order.' },
    { key:'accepted', title:'Accepted', line:'The kitchen is making it.' },
    { key:'ready',    title:'Ready',    line:'It is up and on its way over.' },
    { key:'served',   title:'Served',   line:'Enjoy your meal.' }
  ];

  function draw(order){
    if (order.status === 'rejected' || order.status === 'cancelled') {
      track.innerHTML =
        '<div class="state"><h2>' +
        (order.status === 'rejected' ? 'The kitchen could not take this order' : 'Order cancelled') +
        '</h2><p>' + esc(order.status_note || 'Please speak to a member of staff.') +
        '</p></div>';
      return;
    }

    var at = STEPS.findIndex(function(s){ return s.key === order.status; });
    var html = '<h1 style="font-size:22px;margin:0 0 2px">Your order</h1>' +
      '<p style="color:var(--ink-soft);margin:0 0 18px">' +
      esc(order.table_label || '') + ' · ' + money(order.total_minor) + '</p>';

    STEPS.forEach(function(s, i){
      var cls = i < at ? 'done' : (i === at ? 'now' : '');
      html += '<div class="step ' + cls + '">' +
        '<div class="pip">' + (i < at ? '✓' : (i + 1)) + '</div>' +
        '<div><h3>' + esc(s.title) + '</h3><p>' + esc(s.line) + '</p></div></div>';
    });

    html += '<div style="margin-top:22px;border-top:1px solid var(--line);padding-top:14px">';
    (order.lines || []).forEach(function(l){
      html += '<div class="row" style="display:flex;justify-content:space-between;padding:7px 0">' +
        '<span>' + l.qty + ' × ' + esc(l.name) + '</span>' +
        '<span>' + money(l.unit_price_minor * l.qty) + '</span></div>';
    });
    html += '</div>';

    // Only while nobody has picked it up. Once a clerk has accepted it the
    // kitchen may already have it, and withdrawing it is a conversation.
    if (order.status === 'placed') {
      html += '<button class="shut" id="cancel" type="button" ' +
        'style="width:100%;margin-top:18px;border:1px solid var(--line);' +
        'border-radius:14px;background:none;color:var(--ink-soft);padding:14px">' +
        'Cancel this order</button>';
    }

    track.innerHTML = html;
    var btn = document.getElementById('cancel');
    if (btn) btn.addEventListener('click', function(){
      btn.disabled = true;
      fetch('/api/public/dinein/order/' + ID + '/cancel', { method: 'POST' })
        .then(poll)
        .catch(function(){ btn.disabled = false; });
    });
  }

  function poll(){
    fetch('/api/public/dinein/order/' + ID)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(order){
        if (order) draw(order);
      })
      .catch(function(){});
  }

  poll();
  setInterval(poll, 6000);
})();
</script>
</body>
</html>`;
}

module.exports = { dineinPageRoutes };
