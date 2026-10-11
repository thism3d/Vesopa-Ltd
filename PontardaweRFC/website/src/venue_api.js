/**
 * The club's menu and events, from its Vesopa EPOS back office (MENU_API).
 *
 * Read here on the server and kept in memory, so a page is drawn with the menu
 * and the tickets already in it: nothing for the visitor to wait for
 * (2026-10-11, "zero loading"). Refreshed every two minutes, and again in the
 * background whenever a page asks for a copy older than that; if the back
 * office is unreachable the last good copy is kept.
 *
 * Ticket purchases go through the server too (POST /tickets/buy in
 * server.js), so the buying form works without any script at all.
 */
'use strict';

const API = (process.env.MENU_API || 'https://menu.vesopa.com').replace(/\/+$/, '');
const SLUG = process.env.MENU_SLUG || 'pontardawe-rfc';
const EVERY = 2 * 60 * 1000;

const cache = {
  menu: { data: null, at: 0, busy: null },
  events: { data: null, at: 0, busy: null },
};

const URLS = {
  menu: () => `${API}/api/public/dinein/venue/${encodeURIComponent(SLUG)}`,
  events: () => `${API}/api/public/events/${encodeURIComponent(SLUG)}`,
};

async function call(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': 'pontardawerfc.com' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function refresh(key) {
  const c = cache[key];
  if (c.busy) return c.busy;
  c.busy = call(URLS[key]())
    .then((r) => {
      // A 404 is an answer (nothing published yet), not a failure to keep the old copy for.
      if (r.ok) c.data = r.data;
      else if (r.status === 404) c.data = null;
      c.at = Date.now();
    })
    .catch((e) => console.error(`venue ${key}:`, String(e.message || e).slice(0, 200)))
    .finally(() => { c.busy = null; });
  return c.busy;
}

/** The last copy, at once; a fresh one is fetched behind it when this one is old. */
function get(key) {
  const c = cache[key];
  if (Date.now() - c.at > EVERY) refresh(key);
  return c.data;
}

let timer = null;
function start() {
  if (timer || process.env.VENUE_API_OFF) return;
  refresh('menu');
  refresh('events');
  timer = setInterval(() => { refresh('menu'); refresh('events'); }, EVERY);
  timer.unref();
}

/** Upcoming events with tickets, as the back office publishes them. */
function events() {
  const d = get('events');
  return (d && Array.isArray(d.events)) ? d.events : [];
}

/** The menu as the order page reads it, or null. */
function menu() {
  return get('menu');
}

function checkout(body) {
  return call(`${API}/api/public/events/${encodeURIComponent(SLUG)}/checkout`, { method: 'POST', body });
}

function order(publicId) {
  return call(`${API}/api/public/events/${encodeURIComponent(SLUG)}/orders/${encodeURIComponent(publicId)}`);
}

function ticketQr(code) {
  return `${API}/api/public/events/ticket/${encodeURIComponent(code)}.svg`;
}

/** For tests. */
function set(key, data) {
  cache[key] = { data, at: Date.now(), busy: null };
}

module.exports = { start, events, menu, checkout, order, ticketQr, set, refresh, API, SLUG };
