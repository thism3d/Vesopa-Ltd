/**
 * Real photographs for Studio sites: Pexels first, Unsplash second.
 *
 * The designer writes `data-photo="fresh sourdough on a bakery counter"` on an
 * art or photo tile; the browser asks here for a picture for each; this finds
 * one, and the browser drops it into the tile. The emoji that tile already
 * carried is what shows until then, and what stays if nothing is found, so a
 * section is never blank while it waits.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TWO, AND NOT "IMAGES FROM THE WEB"
 * ---------------------------------------------------------------------------
 * The site goes live under the CUSTOMER's name, on their domain, selling
 * their business. A photo lifted from a search result is somebody else's
 * copyright published by them, and the letter that follows is addressed to
 * them. Pexels and Unsplash license their libraries for commercial use without
 * payment, which is the only kind of stock a website builder can hand out.
 *
 * ---------------------------------------------------------------------------
 * WHY PEXELS FIRST — MEASURED, NOT PREFERRED
 * ---------------------------------------------------------------------------
 * On 2026-09-18 the keys answered with these limits:
 *
 *   Pexels     25,000 requests a month
 *   Unsplash   50 requests an HOUR — Unsplash's demo tier, until they approve
 *              the application for production (5,000 an hour)
 *
 * Fifty searches an hour across every customer is a handful of sites. So
 * Pexels is asked first and Unsplash only when Pexels has nothing, and every
 * answer is cached by query — the same "barber shop interior" asked by twenty
 * customers is one request, not twenty.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE LICENCES ASK OF US
 * ---------------------------------------------------------------------------
 * Both are written into what comes back, so the browser cannot forget them:
 *
 *   - HOTLINK, do not re-host. Unsplash requires the image URLs it returns to
 *     be used as they are, and Pexels allows it. So the published site points
 *     at their CDN, and nothing is copied to ours.
 *   - CREDIT the photographer and the library, with links. Every result
 *     carries the words and the two URLs; the browser puts a small credit on
 *     the photo.
 *   - UNSPLASH COUNTS DOWNLOADS. When a photo is actually used, its
 *     `download_location` must be requested. Done here, server-side, when a
 *     result is handed out — the key never reaches the browser.
 *
 * The keys live in the server's .env and in .env.claude-tools on the
 * development machine, never in the repository, which is public.
 */

const config = require('../config');

const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY || '';
const UTM = 'utm_source=vesopa_studio&utm_medium=referral';

/** True when at least one library is configured. Nothing else is shown without one. */
function available() {
  return Boolean(PEXELS_KEY || UNSPLASH_KEY);
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------
/*
 * Query -> the list of results for it, for a day. In memory, deliberately:
 * a restart empties it and costs a few requests, and in exchange there is no
 * table to migrate and no stale photographer credit sitting in a database
 * after a photo is withdrawn. Capped, so it cannot grow for ever.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 800;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.results;
}

function cacheSet(key, results) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // oldest first
  cache.set(key, { at: Date.now(), results });
}

/** The same words however they were typed: "Bakery  Bread" and "bakery bread" share one entry. */
function normaliseQuery(q) {
  return String(q || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ---------------------------------------------------------------------------
// The two libraries
// ---------------------------------------------------------------------------
async function getJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`${res.status} from ${new URL(url).host}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pexels, shaped as ours. */
async function searchPexels(query, orientation) {
  if (!PEXELS_KEY) return [];
  const params = new URLSearchParams({ query, per_page: '10' });
  if (orientation) params.set('orientation', orientation);
  const data = await getJson(`https://api.pexels.com/v1/search?${params}`, { Authorization: PEXELS_KEY });
  return (data.photos || []).map((p) => ({
    id: `pexels:${p.id}`,
    source: 'Pexels',
    // large2x is 940 wide at 2x: sharp in a hero on a retina screen and a
    // fraction of the original's weight, which is several megabytes.
    url: (p.src && (p.src.large2x || p.src.large || p.src.original)) || '',
    width: p.width,
    height: p.height,
    alt: String(p.alt || query).slice(0, 180),
    credit: p.photographer || 'Pexels',
    creditUrl: p.photographer_url || 'https://www.pexels.com',
    sourceUrl: p.url || 'https://www.pexels.com',
    avg: p.avg_color || '',
  })).filter((r) => r.url.startsWith('https://'));
}

/** Unsplash, shaped as ours. */
async function searchUnsplash(query, orientation) {
  if (!UNSPLASH_KEY) return [];
  const params = new URLSearchParams({ query, per_page: '10', content_filter: 'high' });
  if (orientation) params.set('orientation', orientation === 'square' ? 'squarish' : orientation);
  const data = await getJson(`https://api.unsplash.com/search/photos?${params}`, {
    Authorization: `Client-ID ${UNSPLASH_KEY}`,
    'Accept-Version': 'v1',
  });
  return (data.results || []).map((p) => ({
    id: `unsplash:${p.id}`,
    source: 'Unsplash',
    // `regular` is 1080 wide, and the URL must be used as returned: hotlinking
    // is a condition of the licence, not a choice.
    url: (p.urls && p.urls.regular) || '',
    width: p.width,
    height: p.height,
    alt: String(p.alt_description || p.description || query).slice(0, 180),
    credit: (p.user && p.user.name) || 'Unsplash',
    creditUrl: `${(p.user && p.user.links && p.user.links.html) || 'https://unsplash.com'}?${UTM}`,
    sourceUrl: `https://unsplash.com/?${UTM}`,
    downloadLocation: (p.links && p.links.download_location) || '',
    avg: p.color || '',
  })).filter((r) => r.url.startsWith('https://'));
}

/**
 * Tell Unsplash a photo was used. Their API guidelines require it, and an
 * application that never does it is one they decline to promote out of the
 * demo tier. Fire and forget: a failed count must never cost the customer
 * their picture.
 */
function countUnsplashUse(result) {
  if (!UNSPLASH_KEY || !result || !result.downloadLocation) return;
  fetch(result.downloadLocation, {
    headers: { Authorization: `Client-ID ${UNSPLASH_KEY}`, 'Accept-Version': 'v1' },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Finding pictures for a page
// ---------------------------------------------------------------------------
async function resultsFor(query, orientation) {
  const key = `${orientation || 'any'}|${query}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let results = [];
  try {
    results = await searchPexels(query, orientation);
  } catch (err) {
    console.error('[studio photos] pexels:', err.message);
  }
  if (!results.length) {
    try {
      results = await searchUnsplash(query, orientation);
    } catch (err) {
      // 403 here is the demo tier's fifty an hour running out, which is
      // expected on a busy afternoon and not worth more than a line.
      console.error('[studio photos] unsplash:', err.message);
    }
  }
  // An empty answer is cached too, for less time, so a query that finds
  // nothing is not asked again on every section of every site.
  cacheSet(key, results);
  return results;
}

/**
 * One photo per request, none repeated on the same page.
 *
 * @param {Array<{query:string, orientation?:string}>} wanted
 * @param {string[]} exclude  photo ids already on the page
 * @returns {Promise<Array<object|null>>}  in the same order as `wanted`
 */
async function pick(wanted, exclude = []) {
  const used = new Set(exclude);
  const out = [];
  for (const w of wanted) {
    const query = normaliseQuery(w.query);
    if (!query) { out.push(null); continue; }
    const orientation = ['landscape', 'portrait', 'square'].includes(w.orientation) ? w.orientation : '';
    // eslint-disable-next-line no-await-in-loop -- a page has a handful of these at most
    const results = await resultsFor(query, orientation);
    const chosen = results.find((r) => !used.has(r.id)) || null;
    if (chosen) {
      used.add(chosen.id);
      if (chosen.source === 'Unsplash') countUnsplashUse(chosen);
    }
    out.push(chosen && {
      id: chosen.id,
      source: chosen.source,
      url: chosen.url,
      alt: chosen.alt,
      credit: chosen.credit,
      creditUrl: chosen.creditUrl,
      sourceUrl: chosen.sourceUrl,
      avg: chosen.avg,
    });
  }
  return out;
}

module.exports = { available, pick, normaliseQuery };
// `config` is required for its side effect of loading .env before the keys
// above are read, which matters when this is required on its own in a script.
void config;
