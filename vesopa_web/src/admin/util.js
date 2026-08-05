/**
 * Shared helpers for the admin screens.
 *
 * Two things live here that are easy to get wrong in a dozen places instead of
 * one: money (always minor units until the moment it is printed) and dates
 * (always YYYY-MM-DD in the database, never a Date crossing a timezone).
 */

const { pool } = require('../db');

// ---- Money ----------------------------------------------------------------
//
// Everything in the database is pence. A `£` never appears without going
// through here, and a price never reaches the database without going through
// toMinor, so a 0.1 + 0.2 = 0.30000000000000004 can't be stored.

function money(minor, currency = 'GBP') {
  const symbol = { GBP: '£', USD: '$', EUR: '€' }[currency] || '';
  const n = Number(minor || 0) / 100;
  return (
    symbol +
    n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/** "£1,234" — for dashboard tiles, where the pennies are noise. */
function moneyShort(minor, currency = 'GBP') {
  const symbol = { GBP: '£', USD: '$', EUR: '€' }[currency] || '';
  return symbol + Math.round(Number(minor || 0) / 100).toLocaleString('en-GB');
}

/** "80.00" -> 8000. Rounds, so a stray third decimal cannot creep in. */
function toMinor(value) {
  const n = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 8000 -> "80.00", for populating a form input. */
function fromMinor(minor) {
  return (Number(minor || 0) / 100).toFixed(2);
}

// ---- Dates ----------------------------------------------------------------

/** MySQL DATE columns come back as Date in some drivers and string in others. */
function isoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Local parts, not toISOString(): a date stored as 2026-07-29 in a UTC+1
  // session would come back as the 28th.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A full timestamp for a <time datetime="…"> attribute.
 *
 * The blog templates printed the raw column value there, which serialises as
 * "Wed Jul 29 2026 14:30:00 GMT+0100 (…)" — not a date a parser accepts, so
 * the machine-readable half of the tag said nothing. This is the ISO 8601 form
 * with the offset, so search engines and readers get the real publication
 * instant while the visible text stays "29 July 2026".
 */
function isoDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function formatDate(value) {
  const iso = isoDate(value);
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });
  return `${d} ${month} ${y}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Whole days from today to `value`. Negative once it is in the past. */
function daysUntil(value) {
  const iso = isoDate(value);
  if (!iso) return null;
  const target = Date.parse(`${iso}T00:00:00Z`);
  const today = new Date();
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - now) / 86400000);
}

/** Add whole months, clamping the day so 31 Jan + 1 month is 28/29 Feb. */
function addMonths(value, months) {
  const iso = isoDate(value) || isoDate(new Date());
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + Number(months || 0), 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return isoDate(target);
}

function today() {
  return isoDate(new Date());
}

// ---- Subscription state ---------------------------------------------------

/**
 * How an office's term is doing.
 *
 * Deliberately advisory. An expired term never disables anything — the till
 * keeps trading and the back office keeps working. All this produces is a
 * label and a place in the chase queue, because a shop whose card expired on a
 * Friday should not lose its tills over the weekend.
 */
const EXPIRING_WINDOW_DAYS = 21;

function subscriptionState(office) {
  if (office.status === 'archived') {
    return { key: 'archived', label: 'Archived', badge: 'muted', days: null };
  }
  if (office.status === 'paused') {
    return { key: 'paused', label: 'Paused', badge: 'muted', days: null };
  }

  const trialDays = daysUntil(office.trial_ends_on);
  if (office.trial_ends_on && trialDays !== null && trialDays >= 0) {
    return { key: 'trial', label: `Trial · ${trialDays}d left`, badge: 'info', days: trialDays };
  }

  const days = daysUntil(office.next_due_on);
  if (days === null) {
    return { key: 'unset', label: 'No renewal date', badge: 'warn', days: null };
  }
  if (days < 0) {
    return { key: 'overdue', label: `Overdue ${Math.abs(days)}d`, badge: 'danger', days };
  }
  if (days <= EXPIRING_WINDOW_DAYS) {
    return { key: 'due', label: `Due in ${days}d`, badge: 'warn', days };
  }
  return { key: 'active', label: 'Active', badge: 'ok', days };
}

// ---- Flash ----------------------------------------------------------------
//
// Carried in the query string rather than a session store: the panel has no
// session beyond the signed cookie, and adding one for two lines of text is
// not worth a second dependency. Always rendered with <%= %>, so a crafted
// ?err= is text on screen and nothing more.

function back(res, path, flash = {}) {
  const params = new URLSearchParams();
  for (const key of ['ok', 'err', 'warn']) {
    if (flash[key]) params.set(key, String(flash[key]).slice(0, 300));
  }
  const qs = params.toString();
  res.redirect(303, qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path);
}

function readFlash(req) {
  const take = (key) => {
    const value = req.query[key];
    return typeof value === 'string' ? value.slice(0, 300) : '';
  };
  return { ok: take('ok'), err: take('err'), warn: take('warn') };
}

// ---- Nav badge counts -----------------------------------------------------

/**
 * The three numbers in the sidebar.
 *
 * One query per page load for all of them, and a failure degrades to zeros
 * rather than 500-ing a screen whose actual data loaded fine.
 */
async function navCounts() {
  try {
    const [[row]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM demo_request WHERE approved = 'N') AS demos,
         (SELECT COUNT(*) FROM blog_posts WHERE status = 'draft')  AS drafts,
         (SELECT COUNT(*) FROM offices
           WHERE status = 'active'
             AND next_due_on IS NOT NULL
             AND next_due_on <= DATE_ADD(CURDATE(), INTERVAL ? DAY)) AS expiring`,
      [EXPIRING_WINDOW_DAYS]
    );
    return { demos: row.demos || 0, drafts: row.drafts || 0, expiring: row.expiring || 0 };
  } catch {
    return { demos: 0, drafts: 0, expiring: 0 };
  }
}

// ---- Text -----------------------------------------------------------------

function slugify(value, fallback = 'untitled') {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  return slug || fallback;
}

function str(value, max = 255) {
  return String(value ?? '').trim().slice(0, max);
}

function int(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bytes(size) {
  const n = Number(size || 0);
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

module.exports = {
  money,
  moneyShort,
  toMinor,
  fromMinor,
  isoDate,
  isoDateTime,
  formatDate,
  formatDateTime,
  daysUntil,
  addMonths,
  today,
  subscriptionState,
  EXPIRING_WINDOW_DAYS,
  back,
  readFlash,
  navCounts,
  slugify,
  str,
  int,
  bytes,
};
