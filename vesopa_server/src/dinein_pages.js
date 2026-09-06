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
 * menu.vesopaepos.com serves the dine-in pages and nothing else, which is
 * what lets a venue's own address sit at the root of it —
 * menu.vesopaepos.com/vesopakitchen. That is the address a venue wants to
 * print, and it cannot collide with anything, because there is nothing else on
 * that host to collide with.
 *
 * It has to be a host check and not just a route, because the same application
 * also serves the back office, where /products and /dashboard are pages of
 * a single-page app. A bare /:slug route without this would swallow every one
 * of them.
 */
const MENU_HOST = (process.env.MENU_HOST || 'menu.vesopaepos.com')
  .trim()
  .toLowerCase();

/** The host this request arrived on, as the customer typed it. */
function hostOf(req) {
  const raw = req.headers['x-forwarded-host'] || req.headers.host || '';
  // A proxy may append; the first is the one the browser asked for. The port
  // is stripped because menu.vesopaepos.com:443 is the same host.
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
   * menu.vesopaepos.com/vesopakitchen. Guarded by the host, and by the shape
   * of a slug, so that on every other host this route does nothing at all and
   * the back office's own routing is untouched.
   *
   * Registered last, after /t/, /m/ and /o/, so those three keep their meaning
   * on this host too — a table code is still menu.vesopaepos.com/t/<code>.
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
 * sizes="any" on the fallback because it is an SVG-shaped PNG that scales;
 * the venue's is declared without sizes so the browser picks it up whatever
 * shape they uploaded.
 */
/**
 * The icons for a venue's page.
 *
 * A tab icon is drawn into a square about sixteen pixels across, and whatever
 * is handed to it is squashed to fit. The fallback here used to be
 * vesopa_logo.png, which is 900x130 — the wordmark — so every venue that had
 * not uploaded a logo got eleven letters compressed into an illegible smear in
 * the tab, on the home screen and in the bookmark list. favicon.png is the
 * 512x512 mark and is the only one of the two that is an icon.
 *
 * A venue's own logo is still preferred when it has one, because it is theirs.
 * It is served relative so that it works on whichever host answered.
 */
function iconTags(m) {
  const mark = '/assets/favicon.png';
  const icon = m.icon || mark;
  return [
    `<link rel="icon" type="image/png" href="${esc(icon)}">`,
    `<link rel="apple-touch-icon" href="${esc(icon)}">`,
    // A shortcut saved to a home screen shows this, and a venue whose logo is
    // a wide wordmark is better served by the square mark there than by their
    // own name cropped to its middle two letters.
    `<link rel="mask-icon" href="${mark}" color="${esc(m.accent || '#A5C715')}">`,
  ].join('\n');
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
/* THE LOGO TILE IS ALWAYS LIGHT.
 *
 * It was background:var(--card), which follows the theme — so in dark mode
 * the tile went near-black, and a logo drawn in dark ink on a transparent
 * background (which is what almost every venue uploads, and what the Vesopa
 * mark is) disappeared into it completely. Reported from an iPad in dark mode:
 * the tile was there and the logo inside it was not.
 *
 * A logo tile is a physical thing — a sign, a badge on a menu — and it does not
 * change colour with the room. Fixing the surface instead of the logo also
 * means it works for a venue whose logo is light-on-transparent, because the
 * one thing both kinds need is a light, opaque, predictable ground. */
.logo{
  width:62px;height:62px;border-radius:16px;flex:0 0 auto;
  background:#fff;border:2px solid #fff;
  box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden;
  display:grid;place-items:center;font-size:24px;font-weight:800;
  color:#10130A;padding:7px
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
/* Each chip leads with a mark of what it is, because a phone number, a street
   and a map link are three different actions and they were three identical
   grey pills. The icons are inline SVG — a menu on pub wifi should not wait on
   an icon font to find out what its own buttons do. */
.meta a,.meta span{display:inline-flex;align-items:center;gap:7px}
.meta svg{width:15px;height:15px;flex:0 0 auto;stroke:currentColor;
          fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;
          opacity:.75}
.meta a,.meta span{
  font-size:13px;color:var(--ink-soft);text-decoration:none;
  border:1px solid var(--line);border-radius:999px;padding:6px 12px
}

/* WHEN THE KITCHEN IS SHUT.
 *
 * After the venue's own description and before the menu itself, as asked: it
 * is a fact about the place, so it belongs with the other facts about the
 * place, and a customer should meet it before they meet the food rather than
 * after they have chosen a pudding. */
.shutbox{
  margin:14px auto 0;max-width:648px;
  border-radius:var(--radius);overflow:hidden;
  border:1px solid color-mix(in srgb, #B3261E 34%, var(--line));
  background:color-mix(in srgb, #B3261E 9%, var(--card));
}
.shutbox .head{
  display:flex;align-items:center;gap:10px;
  padding:13px 15px;font-weight:700;color:#B3261E;
}
.shutbox .head svg{width:18px;height:18px;stroke:currentColor;fill:none;
                   stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.shutbox p{margin:0;padding:0 15px 13px;color:var(--ink-soft);font-size:14px;line-height:1.5}

/* The week, folded away. A customer wants "are you open"; the seven rows are
   for the one person in ten who wants to know about Tuesday. */
.hoursbox{margin:14px auto 0;max-width:648px}
.hoursbox summary{
  list-style:none;cursor:pointer;padding:11px 15px;
  border:1px solid var(--line);border-radius:var(--radius);
  display:flex;align-items:center;gap:9px;font-size:14px;
  color:var(--ink-soft);background:var(--card);
}
.hoursbox summary::-webkit-details-marker{display:none}
.hoursbox summary svg{width:15px;height:15px;stroke:currentColor;fill:none;
                      stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;opacity:.75}
.hoursbox summary .now{font-weight:700;color:var(--ink)}
.hoursbox summary .chev{margin-left:auto;transition:transform .2s ease}
.hoursbox[open] summary .chev{transform:rotate(180deg)}
.hoursbox .week{
  border:1px solid var(--line);border-top:0;
  border-radius:0 0 var(--radius) var(--radius);
  padding:6px 15px 12px;background:var(--card);
}
.hoursbox .wk{display:flex;justify-content:space-between;gap:12px;
              padding:6px 0;font-size:14px}
.hoursbox .wk.today{font-weight:700}
.hoursbox .wk .shut{color:#B3261E}

/* ANYTHING THAT APPEARS, APPEARS. Every sheet and every message on this page
   arrives and leaves under its own animation, because something that is simply
   there on the next frame beside what you were already reading is easy to miss
   entirely — which on a phone in a dark pub means pressing the button twice. */
.pop{
  position:fixed;inset:0;z-index:80;display:flex;align-items:flex-end;
  justify-content:center;background:rgba(0,0,0,.45);
  opacity:0;transition:opacity .2s ease;
  padding:0 12px env(safe-area-inset-bottom,12px);
}
.pop.in{opacity:1}
.pop .sheet{
  width:100%;max-width:460px;background:var(--card);color:var(--ink);
  border-radius:20px 20px 14px 14px;padding:22px 20px 18px;
  box-shadow:0 -8px 40px rgba(0,0,0,.3);
  transform:translateY(16px) scale(.98);
  transition:transform .24s cubic-bezier(.2,.9,.3,1);
  margin-bottom:12px;
}
.pop.in .sheet{transform:none}
.pop h3{margin:0 0 8px;font-size:19px}
.pop p{margin:0 0 16px;color:var(--ink-soft);line-height:1.5}
.pop .acts{display:flex;gap:10px}
.pop .acts button{
  flex:1;border:0;border-radius:13px;padding:14px;font-size:15px;
  font-weight:650;cursor:pointer
}
.pop .acts .go{background:var(--accent);color:var(--on-accent)}
.pop .acts .no{background:var(--sunken);color:var(--ink)}

@media (prefers-reduced-motion:reduce){
  .pop,.pop .sheet{transition:none}
}

/* ===========================================================================
   THE TRACKER
   ===========================================================================
   Somebody watching this screen is waiting for food, and a page that does not
   move is a page they cannot tell is still working. So each stage has its own
   colour and its own motion: the one that is happening breathes, the ones that
   have happened are ticked and still, and the ones to come are grey.
   ------------------------------------------------------------------------ */
.tk-head{padding:26px 20px 6px;max-width:520px;margin:0 auto}
.tk-num{
  display:inline-flex;align-items:baseline;gap:8px;
  font-size:13px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-soft)
}
.tk-num b{font-size:26px;letter-spacing:-.01em;color:var(--ink)}
.tk-where{margin:8px 0 0;color:var(--ink-soft)}

/* The headline state, in the colour of that state. */
.tk-state{
  max-width:520px;margin:18px auto 0;padding:18px 20px;
  border-radius:18px;display:flex;gap:15px;align-items:center;
  background:color-mix(in srgb, var(--tk) 12%, var(--card));
  border:1px solid color-mix(in srgb, var(--tk) 34%, var(--line));
}
.tk-state .ring{
  width:52px;height:52px;border-radius:50%;flex:0 0 auto;
  display:grid;place-items:center;color:#fff;background:var(--tk);
  position:relative
}
.tk-state .ring svg{width:26px;height:26px;stroke:currentColor;fill:none;
  stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.tk-state h2{margin:0;font-size:19px}
.tk-state p{margin:3px 0 0;color:var(--ink-soft);font-size:14px}

/* Working: a soft pulse behind the mark. Not a spinner — nothing here is
   loading, something is being cooked. */
.tk-state.busy .ring::after{
  content:"";position:absolute;inset:-6px;border-radius:50%;
  border:2px solid var(--tk);opacity:.5;
  animation:tk-pulse 2.1s ease-out infinite;
}
@keyframes tk-pulse{
  0%{transform:scale(.92);opacity:.55}
  70%{transform:scale(1.22);opacity:0}
  100%{opacity:0}
}
/* Arriving: the tick draws itself once. */
.tk-state.done .ring svg path{
  stroke-dasharray:30;stroke-dashoffset:30;
  animation:tk-draw .5s .1s ease forwards;
}
@keyframes tk-draw{to{stroke-dashoffset:0}}
/* Refused: one shake, then still. Repeating it would be nagging. */
.tk-state.bad{animation:tk-shake .4s ease}
@keyframes tk-shake{
  20%{transform:translateX(-5px)} 40%{transform:translateX(5px)}
  60%{transform:translateX(-3px)} 80%{transform:translateX(3px)}
}

.tk-eta{
  max-width:520px;margin:12px auto 0;padding:13px 18px;
  border:1px dashed var(--line);border-radius:14px;
  display:flex;align-items:center;gap:10px;color:var(--ink-soft);font-size:14px
}
.tk-eta b{color:var(--ink);font-size:16px}
.tk-eta svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.9;
  stroke-linecap:round;stroke-linejoin:round;opacity:.8}

/* The rail of stages. */
.tk-rail{max-width:520px;margin:22px auto 0;padding:0 20px}
.tk-step{display:flex;gap:14px;padding:0 0 4px;position:relative}
.tk-step .pip{
  width:26px;height:26px;border-radius:50%;flex:0 0 auto;z-index:1;
  display:grid;place-items:center;font-size:12px;font-weight:700;
  background:var(--sunken);color:var(--ink-soft);
  transition:background .3s ease,color .3s ease
}
.tk-step.done .pip{background:var(--tk-done);color:#fff}
.tk-step.now .pip{background:var(--tk);color:#fff;transform:scale(1.12)}
/* The line between the pips, filled as far as the order has got. */
.tk-step::before{
  content:"";position:absolute;left:12.5px;top:24px;bottom:-4px;width:2px;
  background:var(--line)
}
.tk-step:last-child::before{display:none}
.tk-step.done::before{background:var(--tk-done)}
.tk-step .t{padding-bottom:20px}
.tk-step h3{margin:0;font-size:15px;font-weight:650}
.tk-step p{margin:2px 0 0;color:var(--ink-soft);font-size:13px}
.tk-step.todo h3,.tk-step.todo p{opacity:.5}

.tk-lines{max-width:520px;margin:6px auto 0;padding:16px 20px 0;
  border-top:1px solid var(--line)}
.tk-line{display:flex;justify-content:space-between;gap:14px;padding:7px 0}
.tk-foot{max-width:520px;margin:0 auto;padding:16px 20px 40px}
.tk-link{
  display:flex;gap:10px;align-items:center;width:100%;
  border:1px solid var(--line);border-radius:14px;background:var(--card);
  color:var(--ink-soft);padding:13px 15px;font-size:13px;cursor:pointer;
  text-align:left
}
.tk-link span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.tk-cancel{
  width:100%;margin-top:10px;border:1px solid var(--line);border-radius:14px;
  background:none;color:var(--ink-soft);padding:14px;cursor:pointer
}

@media (prefers-reduced-motion:reduce){
  .tk-state.busy .ring::after,.tk-state.done .ring svg path,.tk-state.bad{
    animation:none
  }
  .tk-state.done .ring svg path{stroke-dashoffset:0}
}

/* THE ACCOUNT STRIP, and the sheets it opens. */
.who{
  position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);right:12px;
  z-index:6;display:flex;gap:8px
}
.who button{
  border:0;border-radius:999px;cursor:pointer;
  background:rgba(0,0,0,.42);color:#fff;
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  display:inline-flex;align-items:center;gap:7px;
  padding:9px 14px;font-size:13px;font-weight:600;
  transition:background .15s ease,transform .12s ease
}
.who button:active{transform:scale(.96)}
.who svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.9;
         stroke-linecap:round;stroke-linejoin:round}

/* A sheet with a head: a title, and a way out that looks like a way out. */
.pop .sheet.tall{max-height:82vh;display:flex;flex-direction:column;padding-top:14px}
.pop .sheethead{
  display:flex;align-items:center;gap:10px;margin:0 0 14px;flex:0 0 auto
}
.pop .sheethead h3{margin:0;flex:1;font-size:18px}
.pop .icobtn{
  width:38px;height:38px;border-radius:999px;border:0;flex:0 0 auto;
  background:var(--sunken);color:var(--ink);cursor:pointer;
  display:grid;place-items:center;transition:transform .12s ease
}
.pop .icobtn:active{transform:scale(.92)}
.pop .icobtn svg{width:19px;height:19px;stroke:currentColor;fill:none;
                 stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pop .sheetbody{overflow:auto;-webkit-overflow-scrolling:touch;flex:1 1 auto}
.pop label{display:block;font-size:13px;color:var(--ink-soft);margin:12px 0 5px}
.pop input{
  width:100%;box-sizing:border-box;border:1px solid var(--line);
  border-radius:12px;padding:13px 14px;font-size:16px;   /* 16px: iOS zooms below it */
  background:var(--card);color:var(--ink)
}
.pop .err{
  margin:12px 0 0;padding:11px 13px;border-radius:12px;font-size:14px;
  background:color-mix(in srgb,#B3261E 12%,var(--card));color:#B3261E
}
.pop .swap{
  margin:14px 0 0;text-align:center;font-size:14px;color:var(--ink-soft)
}
.pop .swap button{
  background:none;border:0;padding:0;color:var(--accent);font:inherit;
  font-weight:650;cursor:pointer;text-decoration:underline
}

/* Order history rows. */
.hist{list-style:none;margin:0;padding:0}
.hist li{border-bottom:1px solid var(--line)}
.hist li:last-child{border-bottom:0}
.hist a{
  display:flex;align-items:center;gap:12px;padding:13px 2px;
  color:inherit;text-decoration:none
}
.hist .n{font-weight:700;min-width:52px}
.hist .m{flex:1;min-width:0}
.hist .m b{display:block;font-weight:600;font-size:15px}
.hist .m span{color:var(--ink-soft);font-size:13px}
.hist .tag{
  font-size:12px;font-weight:700;padding:4px 9px;border-radius:999px;
  background:var(--sunken);color:var(--ink-soft);white-space:nowrap
}
.hist .tag.live{background:color-mix(in srgb,var(--accent) 26%,var(--card));color:var(--ink)}

/* Guest or account, at checkout. Guest is chosen, always. */
.asme{display:flex;gap:8px;margin:14px 0 4px}
.asme button{
  flex:1;border:1px solid var(--line);border-radius:12px;background:var(--card);
  color:var(--ink-soft);padding:11px;font-size:14px;font-weight:600;cursor:pointer
}
.asme button[aria-pressed="true"]{
  border-color:var(--accent);color:var(--ink);
  background:color-mix(in srgb,var(--accent) 16%,var(--card))
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
/* scroll-padding-top is what makes a jump to a section land under the
   sticky strip rather than behind it, and it belongs on the scrolling element
   rather than on every target. */
html{scroll-behavior:smooth;scroll-padding-top:70px}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}

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

/* TWO OR THREE ACROSS, ONCE THERE IS ROOM FOR THEM.
 *
 * One dish per line is right on a phone and wasteful on a tablet: an iPad in
 * portrait showed four dishes on a screen that had room for nine, so ordering a
 * pudding meant scrolling past every main. The wrapper is a grid whose columns
 * are sized rather than counted, so the same rule gives two across on an iPad
 * in portrait and three on a laptop without either number being written down.
 *
 * The rows lose their dividing lines when they become cards — a border under
 * something that has a neighbour to its right reads as a mistake. */
.items{display:block}
@media (min-width:720px){
  .col{max-width:1120px}
  .items{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(320px,1fr));
    gap:6px 26px;
  }
  .items .item{border-bottom:1px solid var(--line)}
  /* :last-child only clears the final row's line in a single column. In a
     grid the last two or three items are all on the bottom row, and each of
     them needs it. */
  .items .item.last-row{border-bottom:0}
  section{padding-left:20px;padding-right:20px}
}

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
/* No spacer where there is no picture.
 *
 * An invisible 84px box was held in front of dishes that had no photograph, so
 * that their names lined up with the names of dishes that did. It made the
 * column of text tidy and it made every plain dish start a third of the way
 * across an otherwise empty row, which is what was reported: a name floating in
 * the middle of nothing.
 *
 * A dish with no picture now starts where the picture would have started. The
 * left edge of the row is the thing that is constant, and it is the edge the
 * eye actually runs down. */
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
 * table and slug are baked in rather than parsed out of location by the
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

  /* Inline, so a menu on pub wifi never waits on an icon font to find out what
     its own buttons do, and so they inherit the venue's colours for free. */
  var ICON = {
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5L16 12l4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.2 2 2 0 0 1 6.5 3z"/></svg>',
    pin:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-5.3 7-10.5a7 7 0 1 0-14 0C5 15.7 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.6"/></svg>',
    map:   '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.5 3.5 6v14.5L9 18l6 2.5 5.5-2.5V3.5L15 6z"/><path d="M9 3.5V18M15 6v14.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 2"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
    receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>'
  };

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
    // The title is set by the server, which knows the table as well as the
    // venue and puts them in the right order. Overwriting it here threw the
    // table name and the platform suffix away the moment the menu finished
    // loading, so a customer with four tabs open saw four identical ones.
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
      // Sitting on the photograph rather than under it: the top right of a
      // hero is the one place on this page nothing else wants, and it is where
      // a thumb already is on a phone held one-handed.
      '<div class="who" id="who"></div>' +
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
    if (v.phone) {
      meta += '<a href="tel:' + esc(v.phone) + '">' + ICON.phone +
              esc(v.phone) + '</a>';
    }
    if (v.address) meta += '<span>' + ICON.pin + esc(v.address) + '</span>';
    if (v.map_url) {
      meta += '<a href="' + esc(v.map_url) + '" target="_blank" rel="noopener">' +
              ICON.map + 'Find us</a>';
    }
    if (meta) html += '<div class="meta">' + meta + '</div>';

    if (v.notice) html += '<div class="notice">' + esc(v.notice) + '</div>';

    // The venue's hours, and — when it is shut — a plain statement of it,
    // after the description and before the menu.
    html += hoursHtml(v);

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
              (s.blurb ? '<p class="blurb">' + esc(s.blurb) + '</p>' : '') +
              '<div class="items">';
      s.items.forEach(function(it){
        html += itemHtml(it);
      });
      html += '</div></section>';
    });
    html += '</div>';

    app.innerHTML = html;
    wireTabs(sections);
    wireHero();
    markLastRow();
    paintWho();
    app.addEventListener('click', onTap);
    paintBasket();
  }

  /** Half past eleven, not 11:30, because that is how a sign says it. */
  function pretty(hhmm){
    // [0-9] rather than \d on purpose. This whole document is built inside a
    // template literal, and a template literal drops the backslash from an
    // unrecognised escape - so \d reaches the browser as a plain d, the
    // pattern matches nothing, every time renders as "11:00" instead of
    // "11am", and nothing anywhere reports an error.
    var m = /^([0-9]{2}):([0-9]{2})$/.exec(String(hhmm || ''));
    if (!m) return String(hhmm || '');
    var h = Number(m[1]);
    var suffix = h < 12 ? 'am' : 'pm';
    var hour = h % 12 === 0 ? 12 : h % 12;
    return m[2] === '00' ? hour + suffix : hour + '.' + m[2] + suffix;
  }

  var WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday',
                  'Saturday','Sunday'];

  function hoursHtml(v){
    var sched = v.schedule;
    if (!sched || !sched.enforced) return '';

    var html = '';

    if (!sched.open) {
      var line = v.closed_message
        || (sched.next
            ? 'We open ' + (sched.next.today ? 'today' : sched.next.day) +
              ' at ' + pretty(sched.next.at) + '.'
            : 'Please check back soon.');
      html += '<div class="shutbox">' +
        '<div class="head">' + ICON.clock + 'The kitchen is closed just now</div>' +
        '<p>' + esc(line) + ' You can still read the menu.</p>' +
      '</div>';
    }

    // The week, collapsed. Open only when the venue is shut, because that is
    // when somebody actually wants to know about Tuesday.
    var today = sched.today ? sched.today.day : '';
    var summary = sched.open && sched.today && !sched.today.closed
      ? '<span class="now">Open now</span> · until ' + pretty(sched.today.close)
      : '<span class="now">Closed</span>' +
        (sched.next ? ' · opens ' + (sched.next.today ? 'today' : sched.next.day) +
          ' at ' + pretty(sched.next.at) : '');

    html += '<details class="hoursbox"' + (sched.open ? '' : ' open') + '>' +
      '<summary>' + ICON.clock + summary +
        '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"' +
        ' stroke="currentColor" fill="none" stroke-width="2"' +
        ' stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
      '</summary><div class="week">';
    (sched.hours || []).forEach(function(d, i){
      html += '<div class="wk' + (WEEKDAYS[i] === today ? ' today' : '') + '">' +
        '<span>' + WEEKDAYS[i] + '</span>' +
        (d.closed
          ? '<span class="shut">Closed</span>'
          : '<span>' + pretty(d.open) + ' – ' + pretty(d.close) + '</span>') +
      '</div>';
    });
    html += '</div></details>';
    return html;
  }

  /**
   * A sheet that slides up, and goes away again.
   *
   * Returns a promise for whether the confirming button was pressed, so that a
   * caller can await an answer without a callback.
   */
  function pop(opts){
    return new Promise(function(resolve){
      var back = document.createElement('div');
      back.className = 'pop';
      back.innerHTML =
        '<div class="sheet" role="dialog" aria-modal="true">' +
          '<h3>' + esc(opts.title) + '</h3>' +
          '<p>' + esc(opts.body) + '</p>' +
          '<div class="acts">' +
            (opts.cancel ? '<button type="button" class="no">' + esc(opts.cancel) + '</button>' : '') +
            '<button type="button" class="go">' + esc(opts.ok || 'OK') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(back);
      requestAnimationFrame(function(){ back.classList.add('in'); });

      function done(answer){
        back.classList.remove('in');
        setTimeout(function(){ back.remove(); }, 260);
        resolve(answer);
      }
      var no = back.querySelector('.no');
      if (no) no.addEventListener('click', function(){ done(false); });
      back.querySelector('.go').addEventListener('click', function(){ done(true); });
      back.addEventListener('click', function(e){ if (e.target === back) done(false); });
    });
  }

  /** Whether the kitchen's own clock says it is taking orders. */
  function kitchenOpen(){
    var sched = data && data.venue && data.venue.schedule;
    return !sched || !sched.enforced || sched.open;
  }

  /** What to say when somebody presses Add and the kitchen is shut. */
  function shutMessage(){
    var v = (data && data.venue) || {};
    var sched = v.schedule || {};
    if (v.closed_message) return v.closed_message;
    if (sched.next) {
      return 'We start taking orders ' +
        (sched.next.today ? 'today' : 'on ' + sched.next.day) +
        ' at ' + pretty(sched.next.at) + '.';
    }
    return 'Please order at the bar, or ask a member of staff.';
  }

  // =========================================================================
  // WHO IS ORDERING
  // =========================================================================
  //
  // Nobody has to answer this. Guest is the default, it is preselected, and
  // every part of this page works without ever touching it. An account buys one
  // thing: the orders you placed, on whatever phone you are holding.

  var TOKEN_KEY = 'vesopa.dinein.token';
  var ACCT_KEY  = 'vesopa.dinein.account';
  var MINE_KEY  = 'vesopa.dinein.orders';

  /** localStorage that cannot throw. Private mode and locked-down browsers
   *  both make it throw on access, and a menu must not go blank over it. */
  function store(key, value){
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      if (value === null) { window.localStorage.removeItem(key); return null; }
      window.localStorage.setItem(key, value);
      return value;
    } catch (e) { return null; }
  }

  function token(){ return store(TOKEN_KEY) || null; }
  function account(){
    try { return JSON.parse(store(ACCT_KEY) || 'null'); } catch (e) { return null; }
  }

  /**
   * Orders placed on this phone, whether or not anybody signed in.
   *
   * A guest who closes the tab has otherwise lost the only link to the food
   * they are waiting for. Kept to the last twenty, oldest dropped.
   */
  function mine(){
    try { return JSON.parse(store(MINE_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function remember(order){
    var list = mine().filter(function(o){ return o.public_id !== order.public_id; });
    list.unshift(order);
    store(MINE_KEY, JSON.stringify(list.slice(0, 20)));
  }

  function paintWho(){
    var host = document.getElementById('who');
    if (!host) return;
    var acct = account();
    var seen = mine().length;
    var html = '';
    if (seen) {
      html += '<button type="button" data-mine>' + ICON.receipt + 'My orders</button>';
    }
    html += acct
      ? '<button type="button" data-acct>' + ICON.user + esc(firstName(acct)) + '</button>'
      : '<button type="button" data-signin>' + ICON.user + 'Sign in</button>';
    host.innerHTML = html;

    var m = host.querySelector('[data-mine]');
    if (m) m.addEventListener('click', showMine);
    var si = host.querySelector('[data-signin]');
    if (si) si.addEventListener('click', function(){ showAuth('login'); });
    var ac = host.querySelector('[data-acct]');
    if (ac) ac.addEventListener('click', showAccount);
  }

  function firstName(acct){
    var n = (acct && (acct.name || acct.email) || '').trim();
    if (!n) return 'Account';
    // A space or an @, spelled out. \s inside this template literal arrives as
    // a plain "s" and would split "Rhys" into "Rhy".
    return n.split(/[ @]/)[0].slice(0, 14);
  }

  /** A sheet with a head, a body and a way out. Returns the body element. */
  function sheet(title, opts){
    var back = document.createElement('div');
    back.className = 'pop';
    back.innerHTML =
      '<div class="sheet tall" role="dialog" aria-modal="true">' +
        '<div class="sheethead">' +
          ((opts && opts.back)
            ? '<button class="icobtn" data-back aria-label="Back">' + ICON.chev + '</button>'
            : '') +
          '<h3>' + esc(title) + '</h3>' +
          '<button class="icobtn" data-close aria-label="Close">' + ICON.x + '</button>' +
        '</div>' +
        '<div class="sheetbody"></div>' +
      '</div>';
    document.body.appendChild(back);
    requestAnimationFrame(function(){ back.classList.add('in'); });

    function shut(){
      back.classList.remove('in');
      setTimeout(function(){ back.remove(); }, 260);
    }
    back.querySelector('[data-close]').addEventListener('click', shut);
    var b = back.querySelector('[data-back]');
    if (b) b.addEventListener('click', function(){ shut(); if (opts.back) opts.back(); });
    back.addEventListener('click', function(e){ if (e.target === back) shut(); });

    var body = back.querySelector('.sheetbody');
    body.close = shut;
    return body;
  }

  function showAuth(mode, after){
    var join = mode === 'join';
    var body = sheet(join ? 'Create an account' : 'Sign in');
    body.innerHTML =
      '<p style="margin:0;color:var(--ink-soft);font-size:14px;line-height:1.5">' +
        'Only so you can see what you have ordered here before. You never need ' +
        'one to order.</p>' +
      (join ? '<label for="aname">Your name (optional)</label>' +
              '<input id="aname" autocomplete="name">' : '') +
      '<label for="aemail">Email</label>' +
      '<input id="aemail" type="email" autocomplete="email" inputmode="email">' +
      '<label for="apass">Password</label>' +
      '<input id="apass" type="password" autocomplete="' +
        (join ? 'new-password' : 'current-password') + '">' +
      '<div class="err" id="aerr" hidden></div>' +
      '<button class="send" id="ago" type="button" style="margin-top:16px">' +
        (join ? 'Create account' : 'Sign in') + '</button>' +
      '<p class="swap">' + (join ? 'Already have one? ' : 'No account yet? ') +
        '<button type="button" id="aswap">' +
        (join ? 'Sign in' : 'Create one') + '</button></p>';

    document.getElementById('aswap').addEventListener('click', function(){
      body.close();
      setTimeout(function(){ showAuth(join ? 'login' : 'join', after); }, 200);
    });

    document.getElementById('ago').addEventListener('click', function(){
      var btn = document.getElementById('ago');
      var err = document.getElementById('aerr');
      err.hidden = true;
      btn.disabled = true;
      var was = btn.textContent;
      btn.textContent = 'Just a moment…';

      var payload = {
        email: document.getElementById('aemail').value,
        password: document.getElementById('apass').value
      };
      if (TABLE) payload.table = TABLE; else payload.slug = SLUG;
      if (join) payload.name = (document.getElementById('aname') || {}).value || '';

      fetch('/api/public/dinein/account/' + (join ? 'register' : 'login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
        .then(function(res){
          if (!res.ok) {
            err.textContent = (res.body && res.body.error) || 'That did not work.';
            err.hidden = false;
            btn.disabled = false;
            btn.textContent = was;
            return;
          }
          store(TOKEN_KEY, res.body.token);
          store(ACCT_KEY, JSON.stringify(res.body.account || {}));
          paintWho();
          body.close();
          if (after) after();
        })
        .catch(function(){
          err.textContent = 'We could not reach the kitchen. Check your signal.';
          err.hidden = false;
          btn.disabled = false;
          btn.textContent = was;
        });
    });
  }

  function showAccount(){
    var acct = account() || {};
    var body = sheet('Your account');
    body.innerHTML =
      '<p style="margin:0 0 4px;font-size:15px"><b>' + esc(acct.email || '') + '</b></p>' +
      '<p style="margin:0;color:var(--ink-soft);font-size:14px">' +
        'Your orders here are kept against this account.</p>' +
      '<button class="send" id="seeorders" type="button" style="margin-top:18px">' +
        'See my orders</button>' +
      '<button class="shut" id="signout" type="button">Sign out</button>';
    document.getElementById('seeorders').addEventListener('click', function(){
      body.close();
      setTimeout(showMine, 200);
    });
    document.getElementById('signout').addEventListener('click', function(){
      store(TOKEN_KEY, null);
      store(ACCT_KEY, null);
      paintWho();
      body.close();
    });
  }

  var STATUS_WORD = {
    placed:'Sent', accepted:'Being made', ready:'Ready',
    served:'Served', rejected:'Not taken', cancelled:'Cancelled'
  };

  function showMine(){
    var body = sheet('Your orders');
    body.innerHTML = '<p style="color:var(--ink-soft)">Looking…</p>';

    var local = mine();

    function paint(list){
      if (!list.length) {
        body.innerHTML =
          '<p style="color:var(--ink-soft);line-height:1.55">Nothing yet. ' +
          'Anything you order here will show up on this list.</p>';
        return;
      }
      var html = '<ul class="hist">';
      list.forEach(function(o){
        var live = o.status === 'placed' || o.status === 'accepted' || o.status === 'ready';
        html += '<li><a href="/o/' + esc(o.public_id) + '">' +
          '<span class="n">#' + esc(o.number == null ? '' : o.number) + '</span>' +
          '<span class="m"><b>' + esc(o.table_label || 'Your order') + '</b>' +
          '<span>' + money(o.total_minor || 0) + '</span></span>' +
          '<span class="tag' + (live ? ' live' : '') + '">' +
            esc(STATUS_WORD[o.status] || o.status || '') + '</span>' +
        '</a></li>';
      });
      html += '</ul>';
      if (!token()) {
        html += '<p class="swap" style="margin-top:16px">Kept on this phone only. ' +
          '<button type="button" id="minejoin">Create an account</button> to keep them.</p>';
      }
      body.innerHTML = html;
      var j = document.getElementById('minejoin');
      if (j) j.addEventListener('click', function(){
        body.close();
        setTimeout(function(){ showAuth('join', showMine); }, 200);
      });
    }

    if (!token()) { paint(local); return; }

    fetch('/api/public/dinein/account/orders', {
      headers: { Authorization: 'Bearer ' + token() }
    })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        // The account's list where there is one, and this phone's where the
        // network is not answering. Never an empty screen when there is
        // something on the device that would have filled it.
        paint((d && d.orders && d.orders.length) ? d.orders : local);
      })
      .catch(function(){ paint(local); });
  }

  function itemHtml(it){
    // The controls are drawn whenever the venue takes orders at all, even
    // outside its hours. A button that is simply missing reads as a broken
    // page; a button that answers reads as a closed kitchen. Pressing one
    // outside hours says when they open — see onTap.
    var can = it.available && canOrder();
    // No placeholder box where there is no photograph — see the note on
    // .item .thumb in the stylesheet above.
    return '<div class="item' + (it.available ? '' : ' gone') + '" data-item="' + it.id + '">' +
      (it.image_url
        ? '<div class="thumb"><img src="' + esc(it.image_url) + '" alt="" loading="lazy"></div>'
        : '') +
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

    // Adding outside the venue's hours explains itself rather than doing
    // nothing. Taking things back out is always allowed: somebody emptying a
    // basket they filled before the kitchen shut should not be argued with.
    if (add && !kitchenOpen()) {
      pop({
        title: 'The kitchen is closed',
        body: shutMessage(),
        ok: 'I see'
      });
      return;
    }

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
      // Guest is pressed. Somebody with a basket ready to go should never have
      // to make an account to send it, and should not have to notice that they
      // could.
      (account()
        ? '<p class="muted" style="margin:14px 0 0;color:var(--ink-soft);font-size:14px">' +
            'Ordering as <b>' + esc(firstName(account())) + '</b>.</p>'
        : '<div class="asme">' +
            '<button type="button" data-as="guest" aria-pressed="true">Order as guest</button>' +
            '<button type="button" data-as="in" aria-pressed="false">Sign in first</button>' +
          '</div>') +
      '<div class="err" id="cerr" hidden></div>' +
      '<button class="send" id="csend" type="button">Send to the kitchen</button>' +
      '<button class="shut" id="cshut" type="button">Keep looking</button>';

    document.getElementById('cshut').addEventListener('click', function(){ dlg.close(); });
    document.getElementById('csend').addEventListener('click', send);

    var signIn = document.querySelector('[data-as="in"]');
    if (signIn) signIn.addEventListener('click', function(){
      dlg.close();
      // Straight back to the basket afterwards, with the account applied.
      setTimeout(function(){ showAuth('login', openCheckout); }, 200);
    });

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

    var headers = { 'Content-Type': 'application/json' };
    // Sent when there is one. The endpoint treats a missing, expired or
    // unreadable token as a guest rather than as an error, so nothing here
    // depends on it being valid.
    if (token()) headers.Authorization = 'Bearer ' + token();

    fetch('/api/public/dinein/table/' + encodeURIComponent(TABLE) + '/order', {
      method: 'POST',
      headers: headers,
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
        // Kept on the phone before we leave the page: a guest who closes the
        // tab has otherwise lost the only link to the food they are waiting for.
        remember({
          public_id: res.body.public_id,
          number: res.body.number || null,
          table_label: data.table ? data.table.name : null,
          total_minor: totals().sum,
          status: 'placed'
        });
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
  var reflow;
  window.addEventListener('resize', function(){
    clearTimeout(reflow);
    reflow = setTimeout(markLastRow, 150);
  });

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
            centreTab(tabs, btn);
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

  /**
   * Slide the strip so the live tab is in the middle of it.
   *
   * WHY NOT scrollIntoView
   *
   * This runs from an IntersectionObserver, which fires while the customer's
   * thumb is still on the glass. scrollIntoView scrolls every scrollable
   * ancestor that needs to move — including the page — and block:'nearest'
   * does not prevent that, it only decides where it stops. So each time a new
   * section came into view the browser started its own smooth scroll against
   * the one the customer was doing, and the page stalled. That is the "sticky
   * header makes me stop every time" reported from Android.
   *
   * Setting scrollLeft on the strip moves the strip and nothing else. There is
   * no ancestor walk and nothing for the page scroll to fight.
   */
  function centreTab(tabs, btn){
    var want = btn.offsetLeft - (tabs.clientWidth - btn.offsetWidth) / 2;
    var most = tabs.scrollWidth - tabs.clientWidth;
    want = Math.max(0, Math.min(want, most));
    // Two pixels is not worth an animation, and asking for one every time the
    // observer fires is its own kind of jitter.
    if (Math.abs(tabs.scrollLeft - want) < 4) return;
    if (tabs.scrollTo) tabs.scrollTo({ left: want, behavior: 'smooth' });
    else tabs.scrollLeft = want;
  }

  /**
   * Which items are on the bottom row of their grid, and so should not draw a
   * line under themselves. Measured rather than counted, because how many
   * columns there are depends on the width of the screen.
   */
  function markLastRow(){
    document.querySelectorAll('.items').forEach(function(grid){
      var kids = grid.querySelectorAll('.item');
      if (!kids.length) return;
      var last = kids[kids.length - 1].offsetTop;
      Array.prototype.forEach.call(kids, function(el){
        el.classList.toggle('last-row', el.offsetTop === last);
      });
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
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>Your order · Vesopa</title>
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="apple-touch-icon" href="/assets/favicon.png">
<style>${STYLE}</style>
</head>
<body>
<div class="track" id="track"><div class="state"><h2>Checking…</h2></div></div>
<script>
(function(){
  "use strict";
  var ID = "${esc(publicId)}";
  var track = document.getElementById('track');
  var ticker = null;

  function money(minor){ return '£' + (minor/100).toFixed(2); }
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  var I = {
    sent:  '<svg viewBox="0 0 24 24"><path d="m4 12 16-8-6 16-2.5-6.5z"/></svg>',
    pan:   '<svg viewBox="0 0 24 24"><path d="M4 13h13a3 3 0 0 1 0 6H8a4 4 0 0 1-4-4z"/><path d="M17 14h3"/><path d="M8 4v3M12 3v4"/></svg>',
    bell:  '<svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
    tick:  '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
    cross: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 2"/></svg>',
    link:  '<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex:0 0 auto;opacity:.7"><path d="M10 13a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 1 0-5.7-5.7L11 6.7"/><path d="M14 11a4 4 0 0 0-5.7-.4L5.7 13.2a4 4 0 1 0 5.7 5.7l1.6-1.6"/></svg>'
  };

  // Each stage carries its own colour, so the page is a different page at a
  // glance from across a table.
  var STEPS = [
    { key:'placed',   title:'Sent',     line:'The till has your order.',        tone:'#3B82F6', icon:I.sent, verb:'Waiting for the till' },
    { key:'accepted', title:'Accepted', line:'The kitchen is making it.',       tone:'#F59E0B', icon:I.pan,  verb:'Being made' },
    { key:'ready',    title:'Ready',    line:'It is up and on its way over.',   tone:'#8B5CF6', icon:I.bell, verb:'Ready' },
    { key:'served',   title:'Served',   line:'Enjoy your meal.',                tone:'#16A34A', icon:I.tick, verb:'Served' }
  ];

  function headline(order, at){
    if (order.status === 'rejected') {
      return { tone:'#B3261E', icon:I.cross, cls:'bad',
               title:'The kitchen could not take this',
               line: order.status_note || 'Please speak to a member of staff.' };
    }
    if (order.status === 'cancelled') {
      return { tone:'#6B7280', icon:I.cross, cls:'',
               title:'Order cancelled',
               line: order.status_note || 'Nothing has been sent to the kitchen.' };
    }
    var step = STEPS[at] || STEPS[0];
    return {
      tone: step.tone, icon: step.icon,
      cls: order.status === 'served' ? 'done' : 'busy',
      title: step.verb, line: step.line
    };
  }

  /** Minutes left of what the venue promised when it accepted. */
  function etaLeft(order){
    if (order.status !== 'accepted') return null;
    if (!order.eta_minutes || !order.accepted_at) return null;
    var from = new Date(String(order.accepted_at).replace(' ', 'T') + 'Z');
    if (isNaN(from.getTime())) return null;
    var due = from.getTime() + order.eta_minutes * 60000;
    return Math.round((due - Date.now()) / 60000);
  }

  function draw(order){
    if (ticker) { clearInterval(ticker); ticker = null; }

    var at = -1;
    STEPS.forEach(function(s, i){ if (s.key === order.status) at = i; });
    var head = headline(order, at);
    var over = order.status === 'rejected' || order.status === 'cancelled';

    var html = '<div class="tk-head">' +
      '<span class="tk-num">Order <b>#' + esc(order.number || '') + '</b></span>' +
      '<p class="tk-where">' + esc(order.table_label || '') +
        ' · ' + money(order.total_minor) + '</p>' +
    '</div>';

    html += '<div class="tk-state ' + head.cls + '" style="--tk:' + head.tone + '">' +
      '<div class="ring">' + head.icon + '</div>' +
      '<div><h2>' + esc(head.title) + '</h2>' +
      '<p>' + esc(head.line) + '</p></div>' +
    '</div>';

    var left = etaLeft(order);
    if (left !== null) {
      html += '<div class="tk-eta" id="eta">' + I.clock +
        (left > 0
          ? '<span>Usually about <b>' + left + ' min</b> from here.</span>'
          : '<span>It should be with you any moment.</span>') +
      '</div>';
    }

    if (!over) {
      html += '<div class="tk-rail">';
      STEPS.forEach(function(s, i){
        var cls = i < at ? 'done' : (i === at ? 'now' : 'todo');
        html += '<div class="tk-step ' + cls + '"' +
          ' style="--tk:' + s.tone + ';--tk-done:' + STEPS[3].tone + '">' +
          '<div class="pip">' + (i < at ? '✓' : (i + 1)) + '</div>' +
          '<div class="t"><h3>' + esc(s.title) + '</h3>' +
          '<p>' + esc(s.line) + '</p></div></div>';
      });
      html += '</div>';
    }

    html += '<div class="tk-lines">';
    (order.lines || []).forEach(function(l){
      html += '<div class="tk-line"><span>' + l.qty + ' × ' + esc(l.name) + '</span>' +
        '<span>' + money(l.unit_price_minor * l.qty) + '</span></div>';
    });
    html += '</div>';

    html += '<div class="tk-foot">' +
      '<button class="tk-link" type="button" id="share">' + I.link +
        '<span>' + esc(location.href) + '</span>' +
        '<b id="sharelabel" style="flex:0 0 auto;color:var(--accent)">Copy</b>' +
      '</button>';
    if (order.status === 'placed') {
      html += '<button class="tk-cancel" id="cancel" type="button">Cancel this order</button>';
    }
    html += '</div>';

    track.innerHTML = html;

    var share = document.getElementById('share');
    if (share) share.addEventListener('click', function(){
      var label = document.getElementById('sharelabel');
      // The share sheet where there is one, the clipboard where there is not.
      if (navigator.share) {
        navigator.share({ title: 'My order', url: location.href }).catch(function(){});
        return;
      }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(location.href).then(function(){
          if (label) { label.textContent = 'Copied'; setTimeout(function(){ label.textContent = 'Copy'; }, 1800); }
        }).catch(function(){});
      }
    });

    var btn = document.getElementById('cancel');
    if (btn) btn.addEventListener('click', function(){
      btn.disabled = true;
      fetch('/api/public/dinein/order/' + ID + '/cancel', { method: 'POST' })
        .then(poll)
        .catch(function(){ btn.disabled = false; });
    });

    // Count the promised wait down between polls, so the number moves even
    // though the server is only asked every few seconds.
    if (order.status === 'accepted' && left !== null) {
      ticker = setInterval(function(){
        var box = document.getElementById('eta');
        if (!box) return;
        var now = etaLeft(order);
        if (now === null) return;
        box.innerHTML = I.clock + (now > 0
          ? '<span>Usually about <b>' + now + ' min</b> from here.</span>'
          : '<span>It should be with you any moment.</span>');
      }, 30000);
    }
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
