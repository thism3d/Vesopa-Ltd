/**
 * A venue, as Vesopa Gift knows it.
 *
 * Two halves. Who the venue IS -- its name, logo, colours, fonts, whether it can
 * take a card -- belongs to the back office and is cached here in brand_json.
 * How its SHOP is set up -- amounts, designs, terms, limits, the owner's switch
 * -- belongs here.
 *
 * The cache is refreshed in the background when it is older than ten minutes,
 * and never on the request path: a shop page must not wait on the back office,
 * and a venue that changes its logo sees it on its shop within ten minutes.
 */

const db = require('./db');
const epos = require('./epos');
const config = require('./config');

/** The four designs every shop starts with. Gemini's, in one style. */
const BUILTIN = [
  { key: 'celebrate', name: 'Celebrate' },
  { key: 'dinner', name: 'Dinner for two' },
  { key: 'thanks', name: 'Thank you' },
  { key: 'winter', name: 'Winter' },
];

const STALE_MS = 10 * 60 * 1000;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const RESERVED = new Set(['admin', 'v', 't', 'u', 'img', 'css', 'js', 'vendor', 'health', 'favicon.ico', 'robots.txt', 'api']);

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return s || 'venue';
}

function validSlug(slug) {
  return SLUG.test(String(slug || '')) && !RESERVED.has(String(slug));
}

function parseBrand(row) {
  if (!row || !row.brand_json) return null;
  try { return JSON.parse(row.brand_json); } catch { return null; }
}

/** The shape every template reads, with safe defaults for a venue with nothing set. */
function brandOf(row) {
  const b = parseBrand(row) || {};
  const brand = b.brand || {};
  const colours = brand.colours || {};
  const primary = /^#[0-9a-f]{6}$/i.test(String(colours.primary || '')) ? colours.primary : '#1f2a24';
  return {
    name: brand.name || row.name || 'Gift vouchers',
    logo: brand.logo || null,
    icon: brand.icon || brand.logo || null,
    hero: brand.hero || null,
    primary,
    fonts: brand.fonts || {},
    address: brand.address || null,
    links: brand.links || {},
    payments: b.payments || { source: 'none' },
    wallet: b.wallet || { apple: false, google: false },
  };
}

async function refreshBrand(officeId) {
  const v = await epos.venue(officeId);
  await db.run(
    'UPDATE gift_venues SET name = ?, brand_json = ?, brand_at = UTC_TIMESTAMP() WHERE office_id = ?',
    [String(v.brand && v.brand.name ? v.brand.name : v.name).slice(0, 160), JSON.stringify(v), officeId]
  );
  return v;
}

const refreshing = new Set();
function refreshSoon(row) {
  if (!row || refreshing.has(row.office_id)) return;
  const at = row.brand_at ? new Date(row.brand_at).getTime() : 0;
  if (Date.now() - at < STALE_MS) return;
  refreshing.add(row.office_id);
  refreshBrand(row.office_id)
    .catch((e) => console.warn(`[venues] could not refresh ${row.office_id}: ${e.message}`))
    .finally(() => refreshing.delete(row.office_id));
}

async function get(officeId) {
  return db.one('SELECT * FROM gift_venues WHERE office_id = ?', [Number(officeId)]);
}

/** A shop, by the address a buyer typed. Only a switched-on venue has one. */
async function bySlug(slug) {
  if (!validSlug(slug)) return null;
  const row = await db.one('SELECT * FROM gift_venues WHERE slug = ? AND enabled = 1', [String(slug)]);
  refreshSoon(row);
  return row;
}

async function byDomain(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  if (!h) return null;
  const row = await db.one('SELECT * FROM gift_venues WHERE custom_domain = ? AND enabled = 1', [h]);
  refreshSoon(row);
  return row;
}

/**
 * Make sure a venue has a row, the first time the owner opens it.
 *
 * Off, with the four starting designs, and a slug taken from its name -- with a
 * number on the end if another venue already has that name.
 */
async function ensure(eposVenue) {
  const existing = await get(eposVenue.id);
  if (existing) return existing;
  const base = slugify(eposVenue.brand && eposVenue.brand.name ? eposVenue.brand.name : eposVenue.name);
  let slug = validSlug(base) ? base : `venue-${eposVenue.id}`;
  for (let i = 2; await db.one('SELECT 1 AS x FROM gift_venues WHERE slug = ?', [slug]); i++) {
    slug = `${base}-${i}`.slice(0, 60);
  }
  await db.run(
    `INSERT IGNORE INTO gift_venues (office_id, slug, name, brand_json, brand_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
    [eposVenue.id, slug, String(eposVenue.name).slice(0, 160), JSON.stringify(eposVenue)]
  );
  const designs = await db.one('SELECT COUNT(*) AS n FROM gift_designs WHERE office_id = ?', [eposVenue.id]);
  if (!designs.n) {
    let sort = 0;
    for (const d of BUILTIN) {
      await db.run(
        'INSERT INTO gift_designs (office_id, name, image, on_sale, sort) VALUES (?, ?, ?, 1, ?)',
        [eposVenue.id, d.name, `builtin:${d.key}`, sort++]
      );
    }
  }
  return get(eposVenue.id);
}

function designUrl(design) {
  if (!design) return `${config.BASE_URL}/img/designs/celebrate.jpg`;
  const img = String(design.image || '');
  if (img.startsWith('builtin:')) return `${config.BASE_URL}/img/designs/${img.slice(8)}.jpg`;
  return `${config.BASE_URL}/u/${design.office_id}/${encodeURIComponent(img)}`;
}

/** The file on disk behind a design, for the PDF and the email attachment. */
function designFile(design) {
  const path = require('path');
  const img = String((design && design.image) || 'builtin:celebrate');
  if (img.startsWith('builtin:')) {
    return path.join(__dirname, '..', 'public', 'img', 'designs', `${img.slice(8).replace(/[^a-z0-9-]/g, '')}.jpg`);
  }
  return path.join(config.UPLOADS_DIR, String(design.office_id), path.basename(img));
}

async function designs(officeId, { onSale = true } = {}) {
  return db.all(
    `SELECT * FROM gift_designs WHERE office_id = ? ${onSale ? 'AND on_sale = 1' : ''} ORDER BY sort, id`,
    [officeId]
  );
}

async function design(officeId, id) {
  return db.one('SELECT * FROM gift_designs WHERE office_id = ? AND id = ?', [officeId, Number(id)]);
}

function amountsOf(row) {
  return String(row.amounts || '')
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 8);
}

/** Can this venue take a card at all? A shop without a way to be paid says so. */
function canTakePayments(row) {
  const b = brandOf(row);
  return b.payments && b.payments.source && b.payments.source !== 'none';
}

module.exports = {
  BUILTIN, slugify, validSlug, brandOf, refreshBrand, get, bySlug, byDomain, ensure,
  designUrl, designFile, designs, design, amountsOf, canTakePayments,
};
