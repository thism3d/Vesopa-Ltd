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
 * The venue that owns the hostname this request arrived on, or null.
 *
 * A venue can point a domain of its own at this server — menu.theirpub.co.uk —
 * and print that on its cards instead of ours. On that hostname there is only
 * ever one venue, so the slug is not needed and `/` is its menu.
 *
 * Two things this does not do:
 *
 *   * It does not trust the Host header for anything but a lookup. The name has
 *     to already be in the column, claimed by exactly one venue, and the unique
 *     index is what makes that true — a header saying `menu.someoneelse.co.uk`
 *     finds their row or finds nothing.
 *   * It does not answer for an unpublished venue. A domain pointed here before
 *     the menu was ready gets the same nothing as any other unknown host.
 *
 * The first time a hostname actually arrives, it is marked verified. That is
 * the only honest test of a DNS record: not that somebody typed it into a form,
 * but that a request for it reached this server. Until then, printed cards keep
 * using the Vesopa address — a card printed against a domain whose DNS was
 * never pointed here is a table that cannot order.
 */
/** Whether a slug is a published venue. The row, not the shape of the path. */
async function venueExists(pool, slug) {
  if (!pool) return false;
  try {
    const [[row]] = await pool.query(
      'SELECT 1 AS ok FROM dinein_venue WHERE slug = ? AND is_published = 1',
      [String(slug || '').toLowerCase()]
    );
    return !!row;
  } catch {
    // A database that is away is not evidence the venue is gone. Render the
    // page and let it report its own trouble, rather than telling a customer
    // standing at a table that their venue does not exist.
    return true;
  }
}

async function venueForHost(pool, req) {
  if (!pool) return null;
  const host = hostOf(req);
  if (!host || host === MENU_HOST || host === 'www.' + MENU_HOST) return null;

  const names = host.startsWith('www.') ? [host, host.slice(4)] : [host, 'www.' + host];
  try {
    const [[row]] = await pool.query(
      'SELECT office_id, slug, custom_domain, domain_verified FROM dinein_venue' +
        ' WHERE custom_domain IN (?, ?) AND is_published = 1 LIMIT 1',
      names
    );
    if (!row) return null;
    if (!row.domain_verified) {
      // Seen for real. Not awaited by the render — a page must not wait on a
      // bookkeeping write — and failing it changes nothing but the flag.
      pool.execute(
        'UPDATE dinein_venue SET domain_verified = 1, domain_checked_at = NOW()' +
          ' WHERE office_id = ?',
        [row.office_id]
      ).catch(() => {});
    }
    return row;
  } catch {
    return null;
  }
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
  /**
   * The root of a venue's own domain.
   *
   * Registered before the slug route below, because on a custom domain `/` is
   * the menu rather than a directory of them — there is only one venue on that
   * hostname and asking somebody to type its name after its own address is
   * asking them to say it twice.
   */
  router.get('/', async (req, res, next) => {
    const owner = await venueForHost(pool, req);
    if (!owner || !owner.slug) return next();
    res.setHeader('Cache-Control', 'no-store');
    const meta = await metaFor(pool, { slug: owner.slug });
    res.type('html').send(page({ table: null, slug: owner.slug, meta }));
  });

  router.get('/:slug', async (req, res, next) => {
    // The menu host, or a venue's own domain. On the latter a slug still works,
    // so a link already printed or sent keeps resolving after a venue moves to
    // its own address.
    if (!onMenuHost(req) && !(await venueForHost(pool, req))) return next();
    const slug = String(req.params.slug || '').toLowerCase();
    // Only what a slug can actually be. Anything else — a file, a dotted path,
    // something with a capital in it — is not a venue and is left alone.
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) return next();

    // An address that is not a venue is not a page.
    //
    // Every slug-shaped path answered 200 with a menu shell that then said
    // "this menu is not available" — so /dashboard, /products and any other
    // word were each a real page as far as a crawler was concerned, and an
    // infinite number of them were indexable. The shape of the path is not
    // evidence that a venue exists; the row is.
    const known = await venueExists(pool, slug);
    res.setHeader('Cache-Control', 'no-store');
    if (!known) return next();

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
  /* Money that has come down is its own colour, and it is not the venue's
     accent: an accent is used for buttons a customer is meant to press, and a
     saving is not a button. Kept as a token so a venue whose brand is close to
     this red can move it. */
  --offer:#D81B60;
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

/* The same line, but there is something to do about it. A button, so it is
   reachable by keyboard and announced as pressable, and full width so a thumb
   does not have to find it. */
.where.pick{
  border:1px dashed var(--line);
  color:var(--ink);text-align:left;cursor:pointer;
  font:inherit;font-size:14px;font-weight:600;
  transition:background .16s ease, border-color .16s ease
}
.where.pick:hover{border-color:var(--accent)}
.where.pick:active{transform:scale(.995)}

/* ---- The floor plan ---------------------------------------------------- */

.totable{
  display:flex;align-items:center;gap:10px;
  margin:0 0 10px;color:var(--ink-soft);font-size:14px
}
.totable button{
  margin-left:auto;padding:6px 12px;border-radius:999px;
  border:1px solid var(--line);background:transparent;color:var(--ink);
  font:inherit;font-size:13px;font-weight:700;cursor:pointer
}
.totable button:active{transform:scale(.96)}

.floor-say{margin:0 0 12px;color:var(--ink-soft);font-size:14px;line-height:1.5}
.floor-wait,.floor-empty{
  margin:24px 0;text-align:center;color:var(--ink-soft);font-size:14px
}

/* Rooms. Scrolls sideways rather than wrapping: a venue with five rooms should
   not push the plan itself off the bottom of a phone. */
.floor-tabs{
  display:flex;gap:8px;overflow-x:auto;margin:0 0 12px;padding-bottom:2px;
  scrollbar-width:none
}
.floor-tabs::-webkit-scrollbar{display:none}
.floor-tabs button{
  flex:0 0 auto;padding:8px 14px;border-radius:999px;
  border:1px solid var(--line);background:var(--card);color:var(--ink-soft);
  font:inherit;font-size:14px;font-weight:600;cursor:pointer
}
.floor-tabs button.on{
  background:var(--accent);border-color:var(--accent);color:var(--on-accent)
}

/* The room. Positioned children inside a box that keeps the plan's own
   proportions, so a long narrow room stays long and narrow. */
.floor{
  position:relative;width:100%;border-radius:var(--radius);
  background:var(--sunken);border:1px solid var(--line);
  overflow:hidden
}
/* A room whose own shape has been drawn does not need a box drawn round it as
   well — the walls are the boundary, and a rectangle behind an L makes the L
   look like a mistake. */
.floor.shaped{background:transparent;border-color:transparent}
.fwalls{
  position:absolute;inset:0;width:100%;height:100%;
  pointer-events:none
}
.fwalls polygon{
  fill:var(--sunken);
  stroke:var(--ink-soft);
  stroke-width:.6;
  stroke-linejoin:round;
  vector-effect:non-scaling-stroke;
  opacity:.85
}

.fseat{
  position:absolute;box-sizing:border-box;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:2px;padding:2px;
  border:2px solid var(--accent);border-radius:8px;
  background:var(--card);color:var(--ink);
  font:inherit;font-size:12px;font-weight:700;line-height:1.1;
  cursor:pointer;overflow:hidden;
  transition:transform .14s ease, box-shadow .14s ease
}
.fseat.round{border-radius:50%}
.fseat:active{transform:scale(.94)}
.fseat:focus-visible{outline:3px solid var(--accent);outline-offset:2px}

/* In use. Still pressable, and deliberately not greyed into looking disabled:
   the table somebody is sitting at is the likeliest one they will pick, and a
   second round belongs on the bill that is already open. */
.fseat.busy{
  border-style:dashed;border-color:var(--ink-soft);color:var(--ink-soft);
  background:repeating-linear-gradient(
    45deg, var(--sunken), var(--sunken) 5px, transparent 5px, transparent 10px)
}
.fseat.picked{box-shadow:0 0 0 3px var(--accent)}

.fname{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fseats{font-weight:600;font-size:10px;opacity:.7}

.floor-key{
  display:flex;align-items:center;gap:6px;margin:12px 0 0;
  color:var(--ink-soft);font-size:13px;font-weight:600
}
.floor-key .k{
  width:14px;height:14px;border-radius:4px;border:2px solid var(--accent);
  display:inline-block
}
.floor-key .k.busy{border-style:dashed;border-color:var(--ink-soft);margin-left:10px}
.floor-key .floor-count{margin-left:auto;font-weight:700;color:var(--ink)}

/* A plan drawn for a desktop grid, read on a phone. Below this width the seats
   get too small to hit before they get too small to read, so the whole plan is
   given more height to work with. */
@media (max-width:420px){
  .fseat{font-size:11px}
  .fseats{display:none}
}

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
/* The week is folded, always. A customer wants "are you open", which the
   summary already answers; the seven rows are for the one person in ten who
   wants to know about Tuesday, and they can open it. */
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

/* ---------------------------------------------------------------------------
   SIGNING IN
   --------------------------------------------------------------------------- */

/* Email or phone. Email is pressed to start with, because most people know
   their own address and not everybody has signal in a cellar. */
.chan{display:flex;gap:8px;margin:4px 0 2px}
.chan button{
  flex:1;border:1px solid var(--line);border-radius:12px;background:var(--card);
  color:var(--ink-soft);padding:11px;font-size:14px;font-weight:600;cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:7px
}
.chan button[aria-pressed="true"]{
  border-color:var(--accent);color:var(--ink);
  background:color-mix(in srgb, var(--accent) 16%, var(--card))
}
.chan svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.9;
          stroke-linecap:round;stroke-linejoin:round}

/* The country, and then the number. One control that reads as one field. */
.telrow{display:flex;gap:8px;align-items:stretch}
.telrow .cc{
  position:relative;flex:0 0 auto;display:flex;align-items:center;gap:6px;
  border:1px solid var(--line);border-radius:12px;background:var(--card);
  padding:0 10px;font-size:16px;cursor:pointer
}
.telrow .cc select{
  position:absolute;inset:0;width:100%;height:100%;
  opacity:0;cursor:pointer;font-size:16px
}
.telrow .cc .flag{font-size:19px;line-height:1}
.telrow .cc .dial{font-variant-numeric:tabular-nums}
.telrow .cc .chev{width:13px;height:13px;stroke:currentColor;fill:none;
                  stroke-width:2;stroke-linecap:round;stroke-linejoin:round;opacity:.6}
.telrow input{flex:1;min-width:0}

/* The code itself: big, spaced, and numeric so a phone shows the number pad. */
.codebox{
  width:100%;box-sizing:border-box;text-align:center;
  font-size:30px;font-weight:700;letter-spacing:.36em;
  padding:16px 10px 16px 22px;   /* the tracking pushes the last digit right */
  border:1px solid var(--line);border-radius:14px;
  background:var(--card);color:var(--ink);font-variant-numeric:tabular-nums
}
.codebox:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent)}
.sent-to{margin:0 0 4px;color:var(--ink-soft);font-size:14px;line-height:1.5}
.sent-to b{color:var(--ink)}
.resend{
  display:block;margin:14px auto 0;background:none;border:0;padding:6px;
  color:var(--accent);font:inherit;font-weight:650;cursor:pointer;
  text-decoration:underline
}
.resend[disabled]{color:var(--ink-soft);text-decoration:none;cursor:default}

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

/* ===========================================================================
   OFFERS, POPULAR DISHES AND PROMOTIONS
   =========================================================================== */

/* An offer, on the dish it applies to. The old price stays visible: a price
   with nothing to compare it against is just a price. */
.money{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:6px}
.money .was{
  color:var(--ink-soft);text-decoration:line-through;
  font-size:14px;font-weight:500
}
.money .now{font-weight:700;font-size:15px;color:var(--offer)}
.money .flat{font-weight:700;font-size:15px}
.offer-line{
  display:block;margin-top:3px;font-size:13px;font-weight:600;color:var(--offer)
}

/* The venue's offer, said once at the top. */
.offerbox{
  margin:14px auto 0;max-width:648px;
  /* Centred. An offer is an announcement, not a form field, and left-aligning
     it against a page whose headings are centred made it read as a stray row. */
  display:flex;align-items:center;justify-content:center;text-align:center;
  gap:12px;
  padding:13px 15px;border-radius:var(--radius);
  background:color-mix(in srgb, var(--offer) 10%, var(--card));
  border:1px solid color-mix(in srgb, var(--offer) 32%, var(--line));
}
.offerbox .mark{
  width:34px;height:34px;border-radius:50%;flex:0 0 auto;
  display:grid;place-items:center;background:var(--offer);color:#fff
}
.offerbox .mark svg{width:19px;height:19px;stroke:currentColor;fill:none;
  stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.offerbox b{display:block;font-size:15px}
.offerbox span{color:var(--ink-soft);font-size:13.5px}

/* Promotions: what the venue wants to say, which is a different thing from
   what it wants to charge. Sideways, because there may be three and none of
   them is worth a screen. */
.promos{
  display:flex;gap:12px;overflow-x:auto;padding:16px 16px 4px;
  scrollbar-width:none;-webkit-overflow-scrolling:touch;
  scroll-snap-type:x mandatory;
}
.promos::-webkit-scrollbar{display:none}
.promo{
  flex:0 0 78%;max-width:320px;scroll-snap-align:start;
  border:1px solid var(--line);border-radius:var(--radius);
  background:var(--card);overflow:hidden
}
.promo img{width:100%;height:104px;object-fit:cover}
.promo .t{padding:12px 14px}
.promo h4{margin:0 0 3px;font-size:15px}
.promo p{margin:0;color:var(--ink-soft);font-size:13.5px;line-height:1.45}
.promo .until{
  display:inline-block;margin-top:8px;font-size:12px;font-weight:600;
  color:var(--offer)
}
@media (min-width:720px){
  /* In the column with everything else. It used to be given 1120px of its own
     while the offer band above it and the search below were 676 — so two cards
     that fitted comfortably sat left of centre in a box nothing else shared,
     and read as having come loose from the page.

     A safe centre and not a plain one: a row that scrolls sideways and is
     centred puts its overflow half off each end, and the half off the left end
     cannot be scrolled back to. The safe keyword falls back to packing from the
     start the moment the content is too wide, which is exactly when centring
     stops being a good idea. */
  .promos{justify-content:safe center}
  .promo{flex:0 0 300px}
}

/* Popular: a grid of pictures rather than a list of rows, because these are
   the dishes the venue wants somebody to look at rather than read. */
.pop-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:16px 14px;
  padding:4px 0 8px
}
@media (min-width:720px){
  .pop-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
}
.pcard{position:relative;min-width:0}
.pcard .shot{
  position:relative;border-radius:var(--radius);overflow:hidden;
  background:var(--sunken);aspect-ratio:1/1
}
.pcard .shot img{width:100%;height:100%;object-fit:cover}
.pcard .shot .none{
  width:100%;height:100%;display:grid;place-items:center;
  color:var(--ink-soft);font-size:26px;font-weight:700;opacity:.35
}
.pcard .add{position:absolute;right:8px;bottom:8px;box-shadow:0 4px 14px rgba(0,0,0,.22)}
.pcard h3{margin:9px 0 0;font-size:15px;font-weight:650;line-height:1.3}
.pcard .money{margin-top:4px}
.pcard.gone{opacity:.55}

/* A dish that has sold out keeps its button, and the button says so. Removing
   it makes the row look broken; a button that answers reads as a kitchen that
   has run out. */
.add.off{background:var(--sunken)}
.add.off::before,.add.off::after{background:var(--ink-soft)}
.gone-tag{
  display:inline-block;margin-top:6px;font-size:12px;font-weight:700;
  color:#B3261E;text-transform:uppercase;letter-spacing:.04em
}
.diet{
  display:inline-flex;align-items:center;gap:5px;margin-top:6px;
  padding:3px 8px;border-radius:999px;font-size:12px;font-weight:600;
  background:color-mix(in srgb, #2E7D32 12%, var(--card));color:#2E7D32
}

/* How far off the offer the basket is. Shown in the bar, because that is
   where somebody looks when they are deciding whether to stop. */
.basket .toward{
  display:flex;align-items:center;gap:9px;
  margin:0 auto 8px;max-width:648px;
  font-size:13px;color:var(--ink-soft)
}
.basket .toward .bar{
  flex:1;height:5px;border-radius:3px;background:var(--sunken);overflow:hidden
}
.basket .toward .bar i{
  display:block;height:100%;background:var(--offer);
  transition:width .35s cubic-bezier(.2,.8,.3,1)
}

.notice{
  margin:14px auto 0;max-width:648px;padding:12px 14px;
  border-radius:var(--radius);
  border:1px dashed var(--line);font-size:14px;color:var(--ink-soft)
}

/* ---- The column everything above the menu sits in ------------------------

   Each of these blocks set a max-width of 648px and auto margins for itself, which
   centres it on a wide screen and does nothing at all on a narrow one: below
   648px the box simply fills the viewport and its border is drawn against the
   edge of the glass. On a phone the whole page — the where-line, the phone
   number, the closing time, the offer — ran edge to edge with no gutter.

   Stated once, for all of them: never wider than the column, and never nearer
   the edge than 16px. A min() does both in one value, and border-box makes the
   number mean the outside of the box rather than the inside. */
.where,
.meta,
.notice,
.shutbox,
.hoursbox,
.offerbox,
.promos,
.finder,
.nohits{
  box-sizing:border-box;
  width:min(100% - 32px, 676px);
  max-width:none;
  margin-left:auto;
  margin-right:auto;
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
  position:sticky;top:var(--finder-h, 0px);z-index:20;margin-top:18px;
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
/* THE MENU KEEPS ITS MARGINS.
 *
 * The column ran to the edge of the phone on the narrowest screens, so a dish
 * name started and a price ended flush against the glass. 18 either side is
 * enough to read against without spending a ninth of a 360px screen on nothing.
 */
.col{max-width:680px;margin:0 auto;padding:0 4px}
section{padding-left:18px;padding-right:18px}

/* Looking for one thing.
 *
 * Above the tabs, because it answers the same question they do — where is the
 * thing I want — and somebody who knows what they want should not have to find
 * which section it lives in first. */
/* Sticky, and above the tabs in the stack.
 *
 * The tabs pin to the top of the window as you scroll; the search pins above
 * them, because a search finds a dish anywhere in the menu and a tab only takes
 * you to a section. So the order down the screen is the order of usefulness:
 * search, then sections, then food.
 *
 * The --finder-h property is written by the page once the bar is laid out, and
 * tabs are offset by it. Measured rather than assumed: the bar is one line of
 * 16px text on a phone and the same on a desktop, but a browser with a larger
 * default text size makes it taller, and a hard-coded offset would tuck the
 * tabs underneath it. */
.finder{
  position:sticky;top:0;z-index:22;
  /* No side padding. The bar sits in the same column as everything else and
     the box it draws is that column — measured on a phone, the field came out
     322px against 358 for the offer above it and the notice below, so the one
     control somebody types into was the narrowest thing on the page. The
     vertical padding stays; it is what lifts the bar off the content while it
     is pinned. */
  margin:16px auto 0;padding:8px 0;
  background:var(--page);
  transition:box-shadow .2s ease;
}
/* Only once it is actually pinned, so the shadow is a sign that something is
   floating over the page rather than a permanent border. */
.finder.stuck{
  box-shadow:0 6px 18px -14px rgba(0,0,0,.5)
}
.finder input{
  width:100%;box-sizing:border-box;
  border:1px solid var(--line);border-radius:999px;
  background:var(--card);color:var(--ink);
  padding:13px 42px 13px 42px;font-size:16px   /* 16px: iOS zooms below it */
}
.finder input:focus{
  outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 26%, transparent)
}
.finder .mag{
  position:absolute;left:16px;top:50%;transform:translateY(-50%);
  width:17px;height:17px;stroke:var(--ink-soft);fill:none;stroke-width:2;
  stroke-linecap:round;stroke-linejoin:round;pointer-events:none
}
.finder .clear{
  position:absolute;right:12px;top:50%;transform:translateY(-50%);
  width:26px;height:26px;border:0;border-radius:999px;cursor:pointer;
  background:var(--sunken);color:var(--ink-soft);display:none;
  align-items:center;justify-content:center;font-size:15px;line-height:1
}
.finder.has .clear{display:flex}

/* Finished searching.
 *
 * A search on a phone pins the bar to the top and puts a keyboard over the
 * bottom half of the screen, which leaves about a third of it to read results
 * in. This gives that back in one tap: the keyboard goes, and the page moves
 * down to where the results are, rather than leaving somebody to dismiss a
 * keyboard and then work out where they were.
 *
 * The text stays. The search is the reason the results are on screen, and
 * clearing it here would undo the thing the button is supposed to finish —
 * that is what the x is for. */
.finder .done{
  position:absolute;right:12px;top:50%;transform:translateY(-50%);
  height:30px;padding:0 12px;border:0;border-radius:999px;cursor:pointer;
  background:var(--accent);color:var(--on-accent);
  font:inherit;font-size:13.5px;font-weight:700;line-height:1;
  display:none;align-items:center
}
.finder.searching .done{display:flex}
/* Both cannot share the right edge. While the bar is in use the x moves in
   behind the button, which is also the moment it is least wanted: somebody
   typing is not usually trying to empty the box. */
.finder.searching .clear{right:70px}

/* What is left when a search matches nothing. */
.nohits{
  max-width:648px;margin:26px auto;padding:0 18px;text-align:center;
  color:var(--ink-soft)
}
.item.hid,.pcard.hid,section.hid,.promos.hid{display:none}

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
  /* :last-child only clears the final row's line in a single column. In a grid
     the last two or three items are all on the bottom row, and each of them
     needs it. */
  .items .item.last-row{border-bottom:0}
  section{padding-left:20px;padding-right:20px}
}

/* ---------------------------------------------------------------------------
   ONE DISH, AS A ROW
   ---------------------------------------------------------------------------
   Text on the left, picture on the right, button on the corner of the picture.
   Every row has its control in the same place whether or not there is a
   photograph, which is what makes a column of them scannable — and it is where
   a thumb already is on a phone held one-handed.
   --------------------------------------------------------------------------- */
.item{
  display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--line);
  align-items:flex-start
}
.item:last-child{border-bottom:0}
.item .body{flex:1 1 auto;min-width:0}
.item h3{margin:0 0 2px;font-size:16px;font-weight:650;line-height:1.3}
/* The description sits under the price, and stops before it becomes an essay:
   three lines is a description, six is a paragraph nobody reads standing up. */
.item p{
  margin:6px 0 0;color:var(--ink-soft);font-size:14px;line-height:1.45;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;
  overflow:hidden
}

/* The picture, and the button on the corner of it. */
.item .thumb{
  position:relative;
  width:104px;height:104px;border-radius:var(--radius);flex:0 0 auto;
  background:var(--sunken)
}
.item .thumb img{
  width:100%;height:100%;object-fit:cover;
  border-radius:var(--radius);display:block
}
/* Inside the picture, not hanging off it.
 *
 * At -8px the button sat outside its row, and on a screen where the column
 * reaches the edge of the page that is eight pixels of horizontal scroll on
 * every row - which is the whole document scrolling sideways, on a menu. */
.item .thumb .add{
  position:absolute;right:8px;bottom:8px;
  box-shadow:0 3px 12px rgba(0,0,0,.28)
}

/* No picture: the button takes the right-hand edge and centres against the
   row, which is what it did before there were pictures at all. */
.item .end{
  flex:0 0 auto;align-self:stretch;
  display:flex;align-items:center;justify-content:flex-end;
  padding-left:10px
}

@media (max-width:400px){
  /* A 104px picture and a 40px button leave under 200px for a dish name on the
     narrowest phones still in service. */
  .item .thumb{width:88px;height:88px}
}
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
  <!-- How far off the offer the basket is. Above the button rather than inside
       it: it is a fact about the basket, not a thing to press. -->
  <div class="toward" id="toward"></div>
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
    tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12.4V4.6a1 1 0 0 1 1-1h7.8a1 1 0 0 1 .7.3l7 7a1 1 0 0 1 0 1.4l-7.8 7.8a1 1 0 0 1-1.4 0l-7-7a1 1 0 0 1-.3-.7z"/><circle cx="8" cy="8" r="1.4"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
    receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m3.6 7 8.4 6 8.4-6"/></svg>'
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
        // Somebody who arrived without scanning may still be sitting in the
        // room. Fetching the floor now — after the menu is on screen, so it
        // costs nobody a moment — is what lets the line under the hero offer to
        // ask, instead of telling them to go and find a code.
        if (!TABLE && SLUG) {
          loadFloor().then(function(floor){ if (floor.tables.length) draw(); });
        }
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
    applyTheme(v);

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
      // Two ways to be here without a table, and they want different words. A
      // venue with a floor of its own can be sat at, so the line is an offer; a
      // venue without one can only be read.
      html += (FLOOR && FLOOR.tables.length)
        ? '<button type="button" class="where pick" id="pickTable">' +
            '<span class="dot"></span>Tap to say which table you are at' +
          '</button>'
        : '<div class="where">Viewing the menu. Scan the code on your table to order.</div>';
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

    // What is on, said once, before anybody has chosen anything.
    html += offerBoxHtml();
    html += promosHtml(v);

    var sections = (data.sections || []).filter(function(s){
      return s.items && s.items.length;
    });

    if (!sections.length) {
      html += '<div class="state"><h2>Nothing on the menu yet</h2>' +
              '<p>Please ask a member of staff.</p></div>';
      app.innerHTML = html;
      return;
    }

    // The dishes the venue wants looked at, as pictures, above the menu
    // proper. Not counted from orders: a "most ordered" list computed from a
    // menu that has been live a week is a list of whatever was at the top of
    // it. The venue knows what it wants to sell.
    // Two grids, and each is shown only if the venue wants it and has put
    // something in it. Featured leads: it is what the venue is choosing to
    // push, and Popular is what will be found anyway.
    var featured = [], popular = [];
    sections.forEach(function(sec){
      (sec.items || []).forEach(function(it){
        if (it.featured) featured.push(it);
        if (it.popular) popular.push(it);
      });
    });
    if (!v.show_featured) featured = [];
    if (!v.show_popular) popular = [];

    var grids = [];
    if (featured.length) {
      grids.push({ id: 'featured', title: v.featured_title || 'Featured',
                   blurb: 'What we would like you to try.', items: featured });
    }
    if (popular.length) {
      grids.push({ id: 'popular', title: v.popular_title || 'Popular',
                   blurb: 'What this kitchen is known for.', items: popular });
    }

    // The search, then the tabs, then anything the venue is pushing, then the
    // menu itself. The tabs come first because they are the map: a customer
    // scrolling past two grids of pictures to find out what sections exist has
    // been shown the shop window before the shop.
    html += '<div class="finder" id="finder">' +
      '<svg class="mag" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>' +
      '<input id="find" type="search" enterkeyhint="search" ' +
        'autocomplete="off" autocorrect="off" spellcheck="false" ' +
        'placeholder="Search the menu" aria-label="Search the menu">' +
      '<button class="clear" id="findClear" type="button" aria-label="Clear">×</button>' +
      '<button class="done" id="findDone" type="button">Done</button>' +
    '</div>';

    html += '<nav class="tabs" id="tabs">';
    grids.forEach(function(g, i){
      html += '<button type="button" data-go="sec' + g.id + '"' +
              (i === 0 ? ' aria-current="true"' : '') + '>' +
              esc(g.title) + '</button>';
    });
    sections.forEach(function(s, i){
      html += '<button type="button" data-go="sec' + s.id + '"' +
              (i === 0 && !grids.length ? ' aria-current="true"' : '') + '>' +
              esc(s.name) + '</button>';
    });
    html += '</nav>';

    html += '<div class="col">';

    // Featured and Popular sit inside the column, under the tabs, so the tabs
    // are the first thing under the venue's own details.
    grids.forEach(function(g){
      html += '<section id="sec' + g.id + '" data-sec="' + g.id + '">' +
        '<h2>' + esc(g.title) + '</h2>' +
        '<p class="blurb">' + esc(g.blurb) + '</p>' +
        '<div class="pop-grid">';
      g.items.slice(0, 8).forEach(function(it){ html += popCardHtml(it); });
      html += '</div></section>';
    });

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
    wireTabs(grids.map(function(g){ return { id: g.id }; }).concat(sections));
    wireFinder();
    wireHero();
    markLastRow();
    paintWho();
    app.addEventListener('click', onTap);
    paintBasket();
  }

  /**
   * Searching the menu.
   *
   * Everything is already in hand — the whole menu arrived in one response —
   * so this filters what is on the page rather than asking the server per
   * keystroke. On pub wifi a round trip per letter is slower than the list.
   *
   * Matches the name first and then the description, because somebody typing
   * "chips" wants Chips before they want everything that comes with chips.
   * Sections with nothing left in them are folded away, and so are the picture
   * grids: a Popular grid that still shows six things while the list below it
   * shows one is a page arguing with itself.
   */
  function wireFinder(){
    var box = document.getElementById('finder');
    var input = document.getElementById('find');
    if (!box || !input) return;

    function apply(){
      var q = input.value.trim().toLowerCase();
      box.classList.toggle('has', q.length > 0);

      var tabs = document.getElementById('tabs');
      var promos = document.querySelector('.promos');
      if (tabs) tabs.hidden = q.length > 0;
      if (promos) promos.classList.toggle('hid', q.length > 0);

      var hits = 0;
      document.querySelectorAll('.item, .pcard').forEach(function(el){
        if (!q) { el.classList.remove('hid'); return; }
        var name = (el.querySelector('h3') || {}).textContent || '';
        var desc = (el.querySelector('p') || {}).textContent || '';
        var on = (name + ' ' + desc).toLowerCase().indexOf(q) !== -1;
        el.classList.toggle('hid', !on);
        if (on && el.classList.contains('item')) hits += 1;
      });

      // A section with nothing left in it is a heading over a gap.
      document.querySelectorAll('.col section').forEach(function(sec){
        var live = sec.querySelectorAll('.item:not(.hid), .pcard:not(.hid)').length;
        sec.classList.toggle('hid', !!q && !live);
      });

      var none = document.getElementById('nohits');
      if (q && !document.querySelectorAll('.col section:not(.hid)').length) {
        if (!none) {
          none = document.createElement('p');
          none.id = 'nohits';
          none.className = 'nohits';
          document.querySelector('.col').appendChild(none);
        }
        none.textContent = 'Nothing on the menu matches “' + input.value.trim() + '”.';
      } else if (none) {
        none.remove();
      }
    }

    input.addEventListener('input', apply);
    input.addEventListener('search', apply);
    var clear = document.getElementById('findClear');
    if (clear) clear.addEventListener('click', function(){
      input.value = '';
      apply();
      input.focus();
    });

    // ---- The bar is sticky, and the tabs stick underneath it --------------
    //
    // Both are pinned, so the tabs have to know how tall the bar is or they
    // pin underneath it and half of them are never seen. Measured rather than
    // assumed: the same one line of text is taller in a browser set to a large
    // default size, and a hard-coded offset would be wrong on exactly the
    // devices where it matters most.
    function measure(){
      document.documentElement.style.setProperty(
        '--finder-h', Math.round(box.getBoundingClientRect().height) + 'px');
    }
    measure();
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(box);
    else window.addEventListener('resize', measure);

    // Whether it is currently pinned, so the shadow only appears when it is
    // genuinely floating over the page. A sentinel of its own rather than a
    // scroll handler: a scroll handler that reads layout on every frame is the
    // one thing guaranteed to make a long menu stutter on a cheap phone.
    var mark = document.createElement('div');
    mark.setAttribute('aria-hidden', 'true');
    mark.style.cssText = 'position:absolute;height:1px;width:1px;opacity:0';
    box.parentNode.insertBefore(mark, box);
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function(e){
        box.classList.toggle('stuck', !e[0].isIntersecting);
      }, { threshold: 1 }).observe(mark);
    }

    // ---- Using it takes the top of the screen ----------------------------
    //
    // Tapping the bar halfway down a menu leaves it halfway down the menu with
    // a keyboard over the bottom half of the screen — a search box in a letter
    // box. This carries the page up so the bar lands where it is going to pin
    // anyway, which reads as the bar rising to the top rather than the page
    // jumping.
    input.addEventListener('focus', function(){
      box.classList.add('searching');
      var to = window.pageYOffset + box.getBoundingClientRect().top;
      if (to <= 1) return;
      try {
        window.scrollTo({ top: to, behavior: 'smooth' });
      } catch (err) {
        // Older Safari takes two numbers and no options object.
        window.scrollTo(0, to);
      }
    });

    // ---- And gives it back -----------------------------------------------
    var done = document.getElementById('findDone');
    if (done) done.addEventListener('click', function(){
      box.classList.remove('searching');
      // The keyboard goes first. Scrolling while it is still up moves the page
      // under a viewport that is about to grow by half its height, and lands
      // somewhere nobody asked for.
      input.blur();
      var results = document.getElementById('nohits')
        || document.querySelector('.col section:not(.hid)')
        || document.getElementById('tabs');
      if (!results) return;
      setTimeout(function(){
        var to = window.pageYOffset + results.getBoundingClientRect().top
          - (parseInt(getComputedStyle(document.documentElement)
              .getPropertyValue('--finder-h'), 10) || 0) - 12;
        try {
          window.scrollTo({ top: Math.max(0, to), behavior: 'smooth' });
        } catch (err) {
          window.scrollTo(0, Math.max(0, to));
        }
      }, 60);
    });

    // Leaving the field without pressing Done is the same intention, but it
    // must not fight the button: a tap on Done blurs the input first, and
    // hiding the button on blur would move it out from under the finger.
    input.addEventListener('blur', function(){
      setTimeout(function(){
        if (document.activeElement !== input && !input.value.trim()) {
          box.classList.remove('searching');
        }
      }, 180);
    });
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

    // Folded, always. The summary line already answers "are you open"; the
    // seven rows are for somebody who wants to know about Tuesday, and they
    // can ask.
    html += '<details class="hoursbox">' +
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
    if (si) si.addEventListener('click', function(){ showSignIn(); });
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

  // =========================================================================
  // SIGNING IN WITH A CODE
  // =========================================================================
  //
  // Three steps, and the second and third are both skippable:
  //
  //   1. an address or a number,
  //   2. the code that arrives at it,
  //   3. a password, offered once, to somebody who has just proved who they
  //      are and has not got one.
  //
  // Nobody has to do any of it. Guest ordering is untouched and always will be.

  var GEO = null;

  /** The country list and which one to start on, fetched once. */
  function geo(){
    if (GEO) return Promise.resolve(GEO);
    return fetch('/api/public/dinein/geo')
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        GEO = d || { country: 'GB', countries: [
          { code: 'GB', dial: '44', name: 'United Kingdom', flag: '\uD83C\uDDEC\uD83C\uDDE7' }
        ], sms_countries: ['GB'] };
        return GEO;
      })
      .catch(function(){
        GEO = { country: 'GB', countries: [
          { code: 'GB', dial: '44', name: 'United Kingdom', flag: '\uD83C\uDDEC\uD83C\uDDE7' }
        ], sms_countries: ['GB'] };
        return GEO;
      });
  }

  function showSignIn(after){
    geo().then(function(g){ drawSignIn(g, after); });
  }

  function drawSignIn(g, after){
    var body = sheet('Sign in');
    var channel = 'email';          // email is pressed to start with, as asked
    var country = g.country || 'GB';

    function countryOf(code){
      var hit = null;
      (g.countries || []).forEach(function(c){ if (c.code === code) hit = c; });
      return hit || (g.countries || [])[0] || { code: 'GB', dial: '44', flag: '' };
    }

    function paint(){
      var c = countryOf(country);
      var smsHere = (g.sms_countries || []).indexOf(country) !== -1;
      body.innerHTML =
        '<p style="margin:0 0 14px;color:var(--ink-soft);font-size:14px;line-height:1.5">' +
          'We will send you a code. There is no password to remember, and you ' +
          'never need an account to order.</p>' +

        '<div class="chan">' +
          '<button type="button" data-ch="email" aria-pressed="' +
            (channel === 'email') + '">' + ICON.mail + 'Email</button>' +
          '<button type="button" data-ch="phone" aria-pressed="' +
            (channel === 'phone') + '">' + ICON.phone + 'Phone</button>' +
        '</div>' +

        (channel === 'email'
          ? '<label for="siEmail">Your email</label>' +
            '<input id="siEmail" type="email" inputmode="email" ' +
              'autocomplete="email" autocapitalize="off" spellcheck="false">'
          : '<label for="siTel">Your mobile number</label>' +
            '<div class="telrow">' +
              '<span class="cc">' +
                '<span class="flag">' + c.flag + '</span>' +
                '<span class="dial">+' + esc(c.dial) + '</span>' +
                '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true">' +
                  '<path d="m6 9 6 6 6-6"/></svg>' +
                '<select id="siCountry" aria-label="Country">' +
                  (g.countries || []).map(function(x){
                    return '<option value="' + x.code + '"' +
                      (x.code === country ? ' selected' : '') + '>' +
                      x.flag + ' ' + esc(x.name) + ' +' + esc(x.dial) + '</option>';
                  }).join('') +
                '</select>' +
              '</span>' +
              '<input id="siTel" type="tel" inputmode="tel" autocomplete="tel">' +
            '</div>' +
            (smsHere ? '' :
              '<p class="muted" style="margin:8px 0 0;color:var(--ink-soft);font-size:13px;' +
              'line-height:1.5">We can only text UK mobiles at the moment. ' +
              'For ' + esc(c.name) + ', please use your email address.</p>')
        ) +

        '<label for="siName">Your name (optional)</label>' +
        '<input id="siName" autocomplete="name">' +

        '<div class="err" id="siErr" hidden></div>' +
        '<button class="send" id="siGo" type="button" style="margin-top:16px">' +
          'Send me a code</button>';

      body.querySelectorAll('[data-ch]').forEach(function(b){
        b.addEventListener('click', function(){
          channel = b.getAttribute('data-ch');
          paint();
        });
      });
      var picker = document.getElementById('siCountry');
      if (picker) picker.addEventListener('change', function(){
        country = picker.value;
        // Keep what they have typed; only the flag and the prefix change.
        var typed = (document.getElementById('siTel') || {}).value || '';
        var name = (document.getElementById('siName') || {}).value || '';
        paint();
        if (document.getElementById('siTel')) document.getElementById('siTel').value = typed;
        if (document.getElementById('siName')) document.getElementById('siName').value = name;
      });
      document.getElementById('siGo').addEventListener('click', send);
    }

    function send(){
      var btn = document.getElementById('siGo');
      var err = document.getElementById('siErr');
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = 'Sending…';

      var payload = { channel: channel, country: country,
                      name: (document.getElementById('siName') || {}).value || '' };
      if (TABLE) payload.table = TABLE; else payload.slug = SLUG;
      if (channel === 'email') payload.email = document.getElementById('siEmail').value;
      else payload.phone = document.getElementById('siTel').value;

      fetch('/api/public/dinein/otp/send', {
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
            btn.textContent = 'Send me a code';
            // A number we cannot text is a reason to move them to email rather
            // than leave them pressing a button that will not work.
            if (res.body && res.body.use_email) { channel = 'email'; paint(); }
            return;
          }
          body.close();
          setTimeout(function(){
            showCode(res.body, payload, after);
          }, 200);
        })
        .catch(function(){
          err.textContent = 'We could not reach the kitchen. Check your signal.';
          err.hidden = false;
          btn.disabled = false;
          btn.textContent = 'Send me a code';
        });
    }

    paint();
  }

  function showCode(challenge, payload, after){
    var body = sheet('Enter your code', { back: function(){ showSignIn(after); } });
    var since = Date.now();

    body.innerHTML =
      '<p class="sent-to">We sent a code to <b>' + esc(challenge.masked) + '</b>. ' +
        'It works for ten minutes.</p>' +
      '<input class="codebox" id="siCode" inputmode="numeric" ' +
        'autocomplete="one-time-code" maxlength="6" placeholder="000000" ' +
        'aria-label="Your six-digit code">' +
      '<div class="err" id="siErr" hidden></div>' +
      '<button class="send" id="siCheck" type="button" style="margin-top:16px" disabled>' +
        'Sign me in</button>' +
      '<button class="resend" id="siAgain" type="button" disabled>' +
        'Send it again</button>';

    var input = document.getElementById('siCode');
    var go = document.getElementById('siCheck');
    var again = document.getElementById('siAgain');
    input.focus();

    // Six digits and nothing else, and it submits itself once it has them —
    // which is what somebody who has just read a code off a lock screen
    // expects, and one press fewer with a phone in one hand.
    input.addEventListener('input', function(){
      input.value = input.value.replace(/[^0-9]/g, '').slice(0, 6);
      go.disabled = input.value.length !== 6;
      if (input.value.length === 6) check();
    });
    go.addEventListener('click', check);

    // Not immediately: the commonest reason a code has not arrived is that it
    // has been four seconds.
    var wait = 30;
    var tick = setInterval(function(){
      wait -= 1;
      if (wait <= 0) {
        clearInterval(tick);
        again.disabled = false;
        again.textContent = 'Send it again';
      } else {
        again.textContent = 'Send it again in ' + wait + 's';
      }
    }, 1000);
    again.textContent = 'Send it again in ' + wait + 's';
    again.addEventListener('click', function(){
      if (again.disabled) return;
      clearInterval(tick);
      body.close();
      setTimeout(function(){ showSignIn(after); }, 200);
    });

    function check(){
      var err = document.getElementById('siErr');
      err.hidden = true;
      go.disabled = true;
      go.textContent = 'Checking…';

      fetch('/api/public/dinein/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge: challenge.challenge,
          code: input.value,
          name: payload.name,
          country: payload.country
        })
      })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
        .then(function(res){
          if (!res.ok) {
            err.textContent = (res.body && res.body.error) || 'That code is not right.';
            err.hidden = false;
            go.textContent = 'Sign me in';
            go.disabled = input.value.length !== 6;
            input.select();
            return;
          }
          clearInterval(tick);
          store(TOKEN_KEY, res.body.token);
          store(ACCT_KEY, JSON.stringify(res.body.account || {}));
          paintWho();
          body.close();
          setTimeout(function(){
            if (res.body.offer_password) showPasswordOffer(after);
            else if (after) after();
          }, 220);
        })
        .catch(function(){
          err.textContent = 'We could not reach the kitchen. Check your signal.';
          err.hidden = false;
          go.textContent = 'Sign me in';
          go.disabled = false;
        });
    }
  }

  /**
   * A password, offered once.
   *
   * Behind a press rather than a field on the screen: somebody who does not
   * want one should see a sentence and a way past it, not an empty box that
   * looks like it has to be filled in. Asked for after they are already signed
   * in, so refusing costs them nothing.
   */
  function showPasswordOffer(after){
    var body = sheet('You are in');
    var opened = false;

    function paint(){
      body.innerHTML =
        '<p style="margin:0 0 6px;color:var(--ink-soft);font-size:14px;line-height:1.55">' +
          'That is you signed in on this phone for the next month. ' +
          'A code will get you in again any time.</p>' +
        (opened
          ? '<label for="siPw">Choose a password</label>' +
            '<input id="siPw" type="password" autocomplete="new-password">' +
            '<p style="margin:8px 0 0;color:var(--ink-soft);font-size:13px">' +
              'Eight characters or more. Three words you will remember beats ' +
              'one word with a number after it.</p>' +
            '<div class="err" id="siErr" hidden></div>' +
            '<button class="send" id="siSave" type="button" style="margin-top:16px">' +
              'Save it</button>' +
            '<button class="shut" id="siSkip" type="button">Not now</button>'
          : '<button class="send" id="siOpen" type="button" style="margin-top:16px">' +
              'Set a password as well</button>' +
            '<button class="shut" id="siSkip" type="button">No thanks</button>');

      var open = document.getElementById('siOpen');
      if (open) open.addEventListener('click', function(){ opened = true; paint(); });

      var skip = document.getElementById('siSkip');
      if (skip) skip.addEventListener('click', function(){
        body.close();
        if (after) setTimeout(after, 200);
      });

      var save = document.getElementById('siSave');
      if (save) save.addEventListener('click', function(){
        var err = document.getElementById('siErr');
        var pw = document.getElementById('siPw').value;
        err.hidden = true;
        save.disabled = true;
        save.textContent = 'Saving…';
        fetch('/api/public/dinein/account/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     Authorization: 'Bearer ' + token() },
          body: JSON.stringify({ password: pw })
        })
          .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
          .then(function(res){
            if (!res.ok) {
              err.textContent = (res.body && res.body.error) || 'That did not work.';
              err.hidden = false;
              save.disabled = false;
              save.textContent = 'Save it';
              return;
            }
            var acct = account() || {};
            acct.has_password = true;
            store(ACCT_KEY, JSON.stringify(acct));
            body.close();
            if (after) setTimeout(after, 200);
          })
          .catch(function(){
            err.textContent = 'We could not reach the kitchen. Check your signal.';
            err.hidden = false;
            save.disabled = false;
            save.textContent = 'Save it';
          });
      });
    }
    paint();
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
        setTimeout(function(){ showSignIn(showMine); }, 200);
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

  /**
   * The venue's colours, not ours.
   *
   * Every value has already been checked server-side against a six-digit hex —
   * see cleanTheme in src/dinein.js — because these go straight into a style
   * declaration and anything that is not a colour is a way out of it.
   *
   * A venue that has chosen a page colour has chosen it for both schemes; the
   * dark-mode media query in the stylesheet is a default for venues that have
   * not, so an explicit choice sets the variables directly and wins.
   */
  function applyTheme(v){
    var t = v.theme || {};
    var root = document.documentElement.style;
    var accent = t.accent || v.accent;
    if (accent) {
      root.setProperty('--accent', accent);
      // Legible ink on whatever they chose. A venue setting a pale yellow
      // accent would otherwise get white on yellow.
      root.setProperty('--on-accent', t.onAccent || inkOn(accent));
    }
    if (t.page) root.setProperty('--page', t.page);
    if (t.card) root.setProperty('--card', t.card);
    if (t.ink) root.setProperty('--ink', t.ink);
    if (t.inkSoft) root.setProperty('--ink-soft', t.inkSoft);
    if (t.radius != null) root.setProperty('--radius', t.radius + 'px');
    if (t.font && t.font !== 'system') {
      root.setProperty('--font', FONTS[t.font] || FONTS.system);
      document.body.style.fontFamily = FONTS[t.font] || FONTS.system;
    }
    // A page colour a venue chose is theirs in both schemes; the sunken tone
    // has to follow it or a cream page gets grey wells in it.
    if (t.page) {
      root.setProperty('--sunken', mix(t.page, t.ink || '#14161A', 5));
      root.setProperty('--line', mix(t.page, t.ink || '#14161A', 12));
    }
  }

  var FONTS = {
    system: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    serif: 'Georgia,"Times New Roman",serif',
    rounded: 'ui-rounded,"SF Pro Rounded",system-ui,"Segoe UI",sans-serif',
    mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
  };

  /** percent of b, mixed into a. Both must be six-digit hex. */
  function mix(a, b, percent){
    function n(h){ return parseInt(h.slice(1), 16); }
    if (!/^#[0-9a-fA-F]{6}$/.test(a) || !/^#[0-9a-fA-F]{6}$/.test(b)) return a;
    var x = n(a), y = n(b), k = percent / 100, out = '#';
    for (var shift = 16; shift >= 0; shift -= 8) {
      var av = (x >> shift) & 255, bv = (y >> shift) & 255;
      var v = Math.round(av + (bv - av) * k);
      out += ('0' + v.toString(16)).slice(-2);
    }
    return out;
  }

  // =========================================================================
  // THE OFFER
  // =========================================================================
  //
  // The percentage is the venue's; the arithmetic below is only a display of
  // it. The server applies the discount again from its own copy when the order
  // is placed, so nothing here can decide what anybody pays — see the note on
  // discountFor in src/dinein.js.

  function offer(){
    return (data && data.venue && data.venue.offer) || null;
  }

  /** What a dish costs once the offer is on, in minor units. */
  function afterOffer(minor){
    var o = offer();
    if (!o) return minor;
    return minor - Math.floor((minor * o.percent) / 100);
  }

  /** How the venue's offer reads in a sentence. */
  function offerWords(){
    var o = offer();
    if (!o) return '';
    if (o.label) return o.label;
    return o.min_spend_minor
      ? o.percent + '% off with ' + money(o.min_spend_minor) + ' spend'
      : o.percent + '% off';
  }

  /** Price, struck through when there is something to strike. */
  function priceHtml(minor){
    var o = offer();
    if (!o) return '<span class="money"><span class="flat">' + money(minor) + '</span></span>';
    return '<span class="money">' +
      '<span class="now">' + money(afterOffer(minor)) + '</span>' +
      '<span class="was">' + money(minor) + '</span>' +
    '</span>' +
    '<span class="offer-line">' + esc(offerWords()) + '</span>';
  }

  function offerBoxHtml(){
    var o = offer();
    if (!o) return '';
    var line = o.min_spend_minor
      ? 'Spend ' + money(o.min_spend_minor) + ' and ' + o.percent +
        '% comes off the whole order.'
      : o.percent + '% comes off the whole order.';
    return '<div class="offerbox">' +
      '<span class="mark">' + ICON.tag + '</span>' +
      '<span><b>' + esc(offerWords()) + '</b>' +
      '<span>' + esc(line) + '</span></span>' +
    '</div>';
  }

  function promosHtml(v){
    var list = v.promotions || [];
    if (!list.length) return '';
    var html = '<div class="promos">';
    list.forEach(function(p){
      html += '<article class="promo">' +
        (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="" loading="lazy">' : '') +
        '<div class="t"><h4>' + esc(p.title) + '</h4>' +
        (p.body ? '<p>' + esc(p.body) + '</p>' : '') +
        (p.until ? '<span class="until">Until ' + esc(prettyDate(p.until)) + '</span>' : '') +
        '</div></article>';
    });
    return html + '</div>';
  }

  /** 2026-12-24 as "24 December", because that is how a sign says it. */
  function prettyDate(iso){
    var m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(iso || ''));
    if (!m) return String(iso || '');
    var months = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
    return Number(m[3]) + ' ' + months[Number(m[2]) - 1];
  }

  /**
   * One dish, as a row.
   *
   * READING ORDER
   *
   * Name, then price, then what is off it, then what is in it. The price is
   * second because it is the second question anybody asks, and because a price
   * printed under three lines of description cannot be scanned down a page —
   * which is the whole reason a menu is a column.
   *
   * The picture is on the right and the button sits on the corner of it, so
   * every row has its control in the same place whether or not there is a
   * photograph. Where there is none, the button takes the right-hand edge on
   * its own and is centred against the row.
   */
  function itemHtml(it){
    var shot = it.image_url
      ? '<div class="thumb">' +
          '<img src="' + esc(it.image_url) + '" alt="" loading="lazy">' +
          controlsHtml(it.id, it) +
        '</div>'
      : '<div class="end">' + controlsHtml(it.id, it) + '</div>';

    return '<div class="item' + (it.available ? '' : ' gone') +
             (it.image_url ? '' : ' bare') + '" data-item="' + it.id + '">' +
      '<div class="body">' +
        '<h3>' + esc(it.name) + '</h3>' +
        priceHtml(it.price_minor) +
        (it.description ? '<p>' + esc(it.description) + '</p>' : '') +
        (it.diet ? '<span class="diet">' + esc(it.diet) + '</span>' : '') +
        (it.available ? '' : '<span class="gone-tag">Currently unavailable</span>') +
      '</div>' +
      shot +
    '</div>';
  }

  /** One dish as a picture, for the Popular grid. */
  function popCardHtml(it){
    return '<div class="pcard' + (it.available ? '' : ' gone') +
             '" data-item="' + it.id + '">' +
      '<div class="shot">' +
        (it.image_url
          ? '<img src="' + esc(it.image_url) + '" alt="" loading="lazy">'
          : '<div class="none">' + esc((it.name || '?').charAt(0).toUpperCase()) + '</div>') +
        controlsHtml(it.id, it) +
      '</div>' +
      '<h3>' + esc(it.name) + '</h3>' +
      priceHtml(it.price_minor) +
      (it.available ? '' : '<span class="gone-tag">Sold out</span>') +
    '</div>';
  }

  /**
   * The plus, always.
   *
   * A button that disappears when a dish sells out or the kitchen shuts makes
   * the row look broken, and somebody presses where it used to be. A button
   * that is there and answers reads as a kitchen that has run out. What it says
   * is decided in onTap, which is the only place that knows why.
   */
  function controlsHtml(id, it){
    var out = it && it.available === false;
    var qty = basket[id] ? basket[id].qty : 0;
    if (!qty) {
      return '<button class="add' + (out ? ' off' : '') + '" type="button" ' +
             'data-add="' + id + '" aria-label="Add"></button>';
    }
    return '<div class="qty">' +
      '<button type="button" data-less="' + id + '" aria-label="One fewer">−</button>' +
      '<b>' + qty + '</b>' +
      '<button type="button" data-add="' + id + '" aria-label="One more">+</button>' +
    '</div>';
  }

  // =========================================================================
  // WHICH TABLE ARE YOU AT
  // =========================================================================
  //
  // Scanning the code on a table answers this without anybody being asked, and
  // that is still the way in. This is for the other arrival: a link off the
  // venue's website, or forwarded by a friend, which lands on the menu with no
  // table attached and — until now — no way to order at all.
  //
  // The question is asked once, at checkout, with a full basket in hand. Asking
  // it at the door would be asking somebody to commit to a seat before they had
  // decided whether they wanted anything.

  var FLOOR = null;         // rooms and tables, once fetched
  var floorWanted = null;   // the in-flight request, so two taps make one call

  function loadFloor(){
    if (FLOOR) return Promise.resolve(FLOOR);
    if (floorWanted) return floorWanted;
    floorWanted = fetch('/api/public/dinein/floor/' + encodeURIComponent(SLUG),
      { headers: { 'Accept': 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        floorWanted = null;
        FLOOR = j && j.tables ? j : { rooms: [], tables: [] };
        return FLOOR;
      })
      .catch(function(){
        floorWanted = null;
        // A floor we could not fetch is not a floor with no tables in it. FLOOR
        // is left null so the next tap tries again, rather than deciding for
        // good that this venue cannot be ordered from.
        return { rooms: [], tables: [] };
      });
    return floorWanted;
  }

  /** Just the occupancy again, for a plan that is already on screen. */
  function refreshFloor(){
    return fetch('/api/public/dinein/floor/' + encodeURIComponent(SLUG),
      { headers: { 'Accept': 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ if (j && j.tables) FLOOR = j; return FLOOR; })
      .catch(function(){ return FLOOR; });
  }

  /**
   * The plan, drawn the way the venue drew it.
   *
   * Positions come off the same rows the till reads, so the room on the phone
   * is the room on the floor and the corner table is in the corner. Everything
   * is scaled into a box rather than given fixed pixels: the plan was laid out
   * on a desktop grid and is being read on a phone held in one hand.
   */
  /**
   * What to write inside a seat.
   *
   * A seat on a plan is about forty pixels across on a phone, and "Table 4" in
   * it came out as "Ta..." — every table on the floor labelled identically and
   * none of them legible. On a plan of tables, the word "Table" is the one part
   * that carries no information: the number is the name. The full name stays on
   * the button as its accessible label, so a screen reader still says "Table 4"
   * and a long press still shows it.
   */
  function shortName(name){
    var text = String(name || '').trim();
    // A character class, not an escape. This whole page is one template
    // literal, so a backslash in it is eaten before the regex is ever built:
    // this read /^tables?s+/i on the served page and matched nothing, which is
    // why every seat still said "Table 2" and still truncated to "Tabl...".
    var bare = text.replace(/^tables?[ ]+/i, '');
    return bare.length && bare.length < text.length ? bare : text;
  }

  /**
   * The room's own shape, as a list of corners, or null.
   *
   * The venue draws this in the back office by walking the corners of the
   * actual room — an L round the bar, a bay at the front. It arrives as JSON
   * text and is parsed rather than trusted: a room saved before there was a
   * shape, or one whose shape was cleared, comes through as null and draws as
   * the plain box it always did.
   */
  function outlineOf(room){
    if (!room || !room.outline) return null;
    try {
      var pts = typeof room.outline === 'string'
        ? JSON.parse(room.outline)
        : room.outline;
      return (pts && pts.length >= 3) ? pts : null;
    } catch (e) {
      return null;
    }
  }

  function planHtml(room, tables){
    var mine = tables.filter(function(t){ return t.room_id === room.id; });
    if (!mine.length) {
      return '<p class="floor-empty">No tables in here take orders from phones.</p>';
    }

    var walls = outlineOf(room);

    // The extent of what is actually there, not the extent of the grid. A room
    // laid out as twelve by eight with four tables in one corner should fill
    // the screen with those four tables.
    //
    // The walls count towards it when the venue has drawn them. Without that,
    // an L-shaped room would be cropped to whichever part of it happens to have
    // tables in — and the shape a customer is looking for their own seat in is
    // the shape of the room they are sitting in.
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    mine.forEach(function(t){
      minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + (t.w || 1)); maxY = Math.max(maxY, t.y + (t.h || 1));
    });
    if (walls) {
      walls.forEach(function(p){
        minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
      });
    }
    var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);

    var html = '<div class="floor' + (walls ? ' shaped' : '') +
      '" style="aspect-ratio:' + w + '/' + h + '">';

    // The walls, behind the tables and taking no taps. Drawn in the same
    // fractions of the box the seats are, so the corner table is in the corner
    // of the actual corner.
    if (walls) {
      html += '<svg class="fwalls" viewBox="0 0 100 100" preserveAspectRatio="none"' +
        ' aria-hidden="true">' +
        '<polygon points="' + walls.map(function(p){
          return (((p[0] - minX) / w) * 100).toFixed(2) + ',' +
                 (((p[1] - minY) / h) * 100).toFixed(2);
        }).join(' ') + '" /></svg>';
    }
    mine.forEach(function(t){
      var left = ((t.x - minX) / w) * 100;
      var top = ((t.y - minY) / h) * 100;
      var wide = ((t.w || 1) / w) * 100;
      var high = ((t.h || 1) / h) * 100;
      html += '<button type="button" class="fseat' +
        (t.shape === 'circle' ? ' round' : '') +
        (t.busy ? ' busy' : '') +
        (TABLE === t.public_id ? ' picked' : '') + '"' +
        ' data-pick="' + esc(t.public_id) + '"' +
        ' style="left:' + left.toFixed(3) + '%;top:' + top.toFixed(3) + '%;' +
                'width:' + wide.toFixed(3) + '%;height:' + high.toFixed(3) + '%"' +
        ' aria-label="' + esc(t.name) + (t.busy ? ', in use' : ', free') + '">' +
        '<span class="fname">' + esc(shortName(t.name)) + '</span>' +
        (t.seats ? '<span class="fseats">' + t.seats + '</span>' : '') +
      '</button>';
    });
    return html + '</div>';
  }

  /**
   * Ask which table, and carry on afterwards.
   *
   * The callback runs only once a table has been chosen. Closing the sheet
   * is a real answer — somebody who is only reading the menu is allowed to put it down —
   * and it leaves the basket exactly as it was.
   */
  function askTable(after){
    var body = sheet('Which table are you at?', {});
    var timer = null;

    body.innerHTML = '<p class="floor-wait">Reading the floor…</p>';

    loadFloor().then(function(floor){
      if (!floor.tables.length) {
        body.innerHTML =
          '<p class="floor-empty">This venue is not taking orders from phones ' +
          'just now. Please order at the bar.</p>';
        return;
      }
      paint(floor);
      // The till moves while somebody is looking at this. A table that filled
      // up ten seconds ago should say so, and a plan that never changes is a
      // plan nobody trusts the second time they see it.
      timer = setInterval(function(){
        if (!body.isConnected) { clearInterval(timer); return; }
        refreshFloor().then(function(f){
          if (!f || !body.isConnected) return;
          // Only when the floor actually moved. Repainting on a timer regardless
          // would rebuild the plan under somebody's thumb every twelve seconds,
          // which is how a tap lands on the wrong table.
          var now = f.tables.map(function(t){
            return t.public_id + (t.busy ? '1' : '0');
          }).join(',');
          if (now === seen) return;
          seen = now;
          paint(f, true);
        });
      }, 12000);
    });

    // Stop polling the moment the sheet goes, however it goes.
    var shut = body.close;
    body.close = function(){ if (timer) clearInterval(timer); shut(); };

    var roomId = null;
    var seen = null;   // the floor as it was last drawn, to spot a real change

    function paint(floor, keepRoom){
      seen = floor.tables.map(function(t){
        return t.public_id + (t.busy ? '1' : '0');
      }).join(',');
      var rooms = floor.rooms.filter(function(r){
        return floor.tables.some(function(t){ return t.room_id === r.id; });
      });
      if (!keepRoom || roomId == null) roomId = rooms.length ? rooms[0].id : null;
      var room = rooms.filter(function(r){ return r.id === roomId; })[0] || rooms[0];

      var free = floor.tables.filter(function(t){ return !t.busy; }).length;

      body.innerHTML =
        '<p class="floor-say">Pick the table you are sitting at. The ones already ' +
          'in use are marked — if that is yours, choose it and your order joins ' +
          'the bill.</p>' +
        (rooms.length > 1
          ? '<div class="floor-tabs">' + rooms.map(function(r){
              return '<button type="button" data-room="' + r.id + '"' +
                (r.id === room.id ? ' class="on"' : '') + '>' + esc(r.name) + '</button>';
            }).join('') + '</div>'
          : '') +
        (room ? planHtml(room, floor.tables) : '') +
        '<p class="floor-key"><span class="k free"></span>Free' +
          '<span class="k busy"></span>In use' +
          '<span class="floor-count">' + free + ' free</span></p>';

      body.querySelectorAll('[data-room]').forEach(function(b){
        b.addEventListener('click', function(){
          roomId = Number(b.getAttribute('data-room'));
          paint(floor, true);
        });
      });
    }

    body.addEventListener('click', function(e){
      var seat = e.target.closest('[data-pick]');
      if (!seat) return;
      body.close();
      chooseTable(seat.getAttribute('data-pick'), after);
    });
  }

  /**
   * Take a chosen table on as if it had been scanned.
   *
   * The menu is re-read through the table's own endpoint rather than patched in
   * place, because that endpoint is what decides whether this table takes
   * orders at all — a table can be on the plan and switched off — and because
   * everything downstream already trusts the table that load() put on the page.
   *
   * The address bar comes along too. A phone that reloads, or a link passed
   * across the table, then lands exactly where scanning would have.
   */
  function chooseTable(publicId, after){
    fetch('/api/public/dinein/table/' + encodeURIComponent(publicId),
      { headers: { 'Accept': 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(fresh){
        if (!fresh || !fresh.table) {
          return pop({
            title: 'That table has gone',
            body: 'It is not taking orders any more. Please pick another, or ask ' +
                  'a member of staff.',
            ok: 'I see'
          });
        }
        TABLE = publicId;
        data = fresh;
        try {
          history.replaceState(null, '', '/t/' + encodeURIComponent(publicId));
        } catch (err) {
          // A history entry a browser will not write is not worth failing over.
        }
        draw();
        paintBasket();
        if (after) setTimeout(after, 60);
      })
      .catch(function(){
        pop({
          title: 'We could not reach the kitchen',
          body: 'Check your signal and try again.',
          ok: 'I see'
        });
      });
  }

  function canOrder(){
    if (!data || !data.venue.ordering_open) return false;
    if (data.table) return !!data.table.ordering;
    // No table yet, on a venue's own address. The basket can still be filled:
    // which table it goes to is a question worth asking once, at the end, with
    // something in hand — not a gate in front of a menu somebody is still
    // reading. Only offered where there is actually a floor to choose from.
    return !!(SLUG && FLOOR && FLOOR.tables.length);
  }

  function onTap(e){
    // The line under the hero, when there is no table yet. It is a button
    // rather than a notice because there is something to do about it.
    if (e.target.closest('#pickTable')) { askTable(null); return; }

    var add = e.target.closest('[data-add]');
    var less = e.target.closest('[data-less]');
    if (!add && !less) return;

    var itemId = Number((add || less).getAttribute(add ? 'data-add' : 'data-less'));

    // A dish that has sold out says so. Taking one back out is always allowed.
    if (add) {
      var dish = itemById(itemId);
      if (dish && dish.available === false) {
        pop({
          title: dish.name,
          body: 'Sorry — the kitchen has run out of this one today.',
          ok: 'I see'
        });
        return;
      }
      if (!canOrder()) {
        pop({
          title: 'Not taking orders',
          body: data && data.table
            ? 'This table is not taking orders from phones just now. Please order at the bar.'
            : 'Scan the code on your table to order.',
          ok: 'I see'
        });
        return;
      }
    }

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

    var id = itemId;
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

  /** The dish behind an id, wherever it sits. */
  function itemById(id){ return find(id); }

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

    // The figure on the bar is what they will actually pay.
    var o = offer();
    var off = (o && t.sum >= o.min_spend_minor)
      ? Math.floor((t.sum * o.percent) / 100) : 0;
    document.getElementById('basketTotal').textContent = money(t.sum - off);

    paintToward(t.sum, o, off);
    bar.classList.toggle('up', t.count > 0);
  }

  /**
   * How far off the offer the basket is.
   *
   * In the bar rather than at the top of the page, because this is a fact about
   * the basket and it changes every time somebody adds to it — and the bar is
   * where they are looking when they are deciding whether to stop.
   */
  function paintToward(sum, o, off){
    var host = document.getElementById('toward');
    if (!host) return;
    if (!o || !o.min_spend_minor) { host.innerHTML = ''; return; }

    if (off > 0) {
      host.innerHTML = '<span>' + esc(o.percent + '% off — you are saving ' +
        money(off)) + '</span>';
      return;
    }
    var needed = o.min_spend_minor - sum;
    var pct = Math.max(0, Math.min(100, Math.round((sum / o.min_spend_minor) * 100)));
    host.innerHTML =
      '<span>Add ' + money(needed) + ' for ' + o.percent + '% off</span>' +
      '<span class="bar"><i style="width:' + pct + '%"></i></span>';
  }

  document.getElementById('basketBtn').addEventListener('click', openCheckout);

  function openCheckout(){
    // The one place the question is asked. Not at the door, and not on every
    // tap of a plus — here, with a basket ready to send and a reason to answer.
    if (!TABLE) { askTable(openCheckout); return; }

    var v = data.venue;
    var t = totals();
    var rows = '';
    eachChosen(function(item, qty){
      rows += '<div class="row"><span>' + qty + ' × ' + esc(item.name) + '</span>' +
              '<span>' + money(item.price_minor * qty) + '</span></div>';
    });

    document.getElementById('checkoutBody').innerHTML =
      '<h2>Your order</h2>' +
      // Where it is going, and a way to say that is wrong. Somebody who moved
      // tables between filling the basket and sending it should not have to
      // start again to say so.
      '<p class="tag totable">' +
        '<span>' + esc(data.table ? data.table.name : '') + '</span>' +
        (SLUG ? '<button type="button" id="cwhere">Change</button>' : '') +
      '</p>' +
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

    var where = document.getElementById('cwhere');
    if (where) where.addEventListener('click', function(){
      dlg.close();
      // Back into the basket once a table has been chosen, so changing where
      // the food goes costs one tap and not a rebuilt order.
      setTimeout(function(){ askTable(openCheckout); }, 200);
    });
    document.getElementById('csend').addEventListener('click', send);

    var signIn = document.querySelector('[data-as="in"]');
    if (signIn) signIn.addEventListener('click', function(){
      dlg.close();
      // Straight back to the basket afterwards, with the account applied.
      setTimeout(function(){ showSignIn(openCheckout); }, 200);
    });

    dlg.showModal();
  }

  function send(){
    // Belt and braces. openCheckout will not open the sheet without a table, so
    // this cannot normally fire — but the endpoint is addressed by table, and
    // an order posted to nowhere is an order that vanishes.
    if (!TABLE) { askTable(openCheckout); return; }

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

/**
 * Whether this request arrived on an address that serves menus.
 *
 * The menu host, or a venue's own domain. Exported so server.js can keep the
 * back office bundle off those addresses without repeating the host rules —
 * two places deciding what counts as a menu host is two places to get it wrong.
 *
 * Asynchronous because a custom domain is a lookup. The menu host itself is
 * answered without touching the database, which is the common case.
 */
async function isMenuAddress(pool, req) {
  if (onMenuHost(req)) return true;
  return !!(await venueForHost(pool, req));
}

module.exports = { dineinPageRoutes, isMenuAddress, onMenuHost };
