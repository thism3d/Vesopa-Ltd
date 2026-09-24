/**
 * Small things every other file needs, in one place so they agree.
 */

const crypto = require('crypto');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** £12.50, £12 when there are no pence -- the way a menu prints a price. */
function money(minor, { always = false } = {}) {
  const n = Number(minor) || 0;
  const pounds = Math.floor(Math.abs(n) / 100);
  const pence = Math.abs(n) % 100;
  const sign = n < 0 ? '-' : '';
  const whole = pounds.toLocaleString('en-GB');
  if (!pence && !always) return `${sign}£${whole}`;
  return `${sign}£${whole}.${String(pence).padStart(2, '0')}`;
}

/**
 * "12.50", "£12.5", "12" -> pence. NaN for anything that is not a sum of money.
 * Rejects more than two decimals rather than rounding them, because a buyer who
 * typed £10.005 meant something and it was not a half-penny.
 */
function parseMoney(input) {
  const s = String(input ?? '').trim().replace(/^£/, '').replace(/,/g, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return NaN;
  const [pounds, pence = ''] = s.split('.');
  return Number(pounds) * 100 + Number(pence.padEnd(2, '0'));
}

/** A random id for a URL: lowercase letters and digits, no look-alikes. */
function publicId(length = 24) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

function token(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** A ticket code: two groups of four, the same alphabet as a gift card. */
function ticketCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[crypto.randomInt(alphabet.length)];
    if (i === 3) out += '-';
  }
  return out;
}

const ZONE = 'Europe/London';

/** Saturday 24 October, 9:00am -- in the venue's own time, whatever the server's. */
function when(date, { withTime = true, withYear = false, short = false } = {}) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('en-GB', {
    weekday: short ? 'short' : 'long',
    day: 'numeric',
    month: short ? 'short' : 'long',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: ZONE,
  });
  if (!withTime) return day;
  const time = d.toLocaleTimeString('en-GB', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: ZONE,
  }).replace(':00', '').replace(' ', '').toLowerCase();
  return `${day}, ${time}`;
}

/** "Today 10:42", "Yesterday 21:03", "11 Oct 18:52" -- for lists of recent things. */
function placed(date, now = new Date()) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZONE });
  const day = londonDate(d);
  const today = londonDate(now);
  // Yesterday by the calendar, not 24 hours back, which a clock change would skew.
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (day === today) return `Today ${time}`;
  if (day === yesterday) return `Yesterday ${time}`;
  const opts = { day: 'numeric', month: 'short', timeZone: ZONE };
  if (day.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
  return `${d.toLocaleDateString('en-GB', opts)} ${time}`;
}

/** 24 October 2027 */
function dateLong(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: ZONE });
}

/**
 * A local London date and time from a form ("2026-10-24", "09:00") as a UTC Date.
 *
 * Done by asking what offset London had at that moment rather than assuming
 * GMT, so a voucher scheduled for 9am in July arrives at 9am, not 10am.
 */
function londonToUtc(dateStr, timeStr = '09:00') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
  if (!m || !t) return null;
  const [, y, mo, d] = m.map(Number);
  const [, h, mi] = t.map(Number);
  if (h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (shown - guess));
}

/** YYYY-MM-DD in London, for a date input's value and for expiry dates. */
function londonDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  return parts;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isEmail = (s) => EMAIL.test(String(s || '').trim()) && String(s).length <= 190;

function clean(s, max) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

/** Readable ink for a background -- the same rule the loyalty emails use. */
function onColour(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150 ? '#10130a' : '#ffffff';
}

/** A darker version of a light brand colour, for text that has to be read. */
function inkOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#14161a';
  const n = parseInt(m[1], 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luma <= 150) return `#${m[1]}`;
  const k = 0.48;
  [r, g, b] = [r * k, g * k, b * k].map((v) => Math.round(v));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function initials(name) {
  const words = String(name || '').replace(/^the\s+/i, '').split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return letters || 'V';
}

module.exports = {
  esc, money, parseMoney, publicId, token, ticketCode, when, placed, dateLong,
  londonToUtc, londonDate, addMonths, isEmail, clean, onColour, inkOf, initials, ZONE,
};
