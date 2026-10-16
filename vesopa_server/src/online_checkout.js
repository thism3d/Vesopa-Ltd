/**
 * Which Dojo key a venue's ONLINE payments use (2026-10-16).
 *
 * The owner: back office Card Payments gets two tabs, Pay at Counter and
 * Online checkout. Pay at Counter is the tills' card machines and stays
 * exactly as it was (epos_dojo_settings, often a Paymentsense Connect key that
 * can never take an online payment). Online checkout chooses the key the
 * online menu, match tickets, memberships and gift cards pay with:
 *
 *   demo     Dojo's sandbox (DOJO_ONLINE_DEMO_KEY). Test money only, and an
 *            order paid this way NEVER reaches the live till, kitchen or
 *            takings (dinein.js is_demo). The default once a venue opens the
 *            tab, and what a staging site for Dojo's go-live review uses.
 *   counter  the Pay at Counter key, when it is a Dojo key (sk_...)
 *   live     another live key of the venue's own, sealed like the others
 *
 * A venue that never opened the tab (online_mode NULL) keeps the old
 * behaviour exactly: memberships.js paymentKeyFor's kiosk key, or nothing.
 */
'use strict';

const { seal, unseal } = require('./express_kiosk');

const MODES = new Set(['demo', 'counter', 'live']);
const KEY_SHAPE = /^sk_(prod|sandbox)_[A-Za-z0-9_-]{20,}$/;

const missing = (e) => e && (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE');

/** The sandbox key demo payments use. Only ever a sandbox key. */
function demoKey() {
  const k = process.env.DOJO_ONLINE_DEMO_KEY || process.env.EXPRESS_DOJO_API_KEY || process.env.DOJO_API_KEY || '';
  return String(k).startsWith('sk_sandbox_') ? k : '';
}

async function readRow(db, office) {
  try {
    const [[row]] = await db.query(
      'SELECT platform, api_key_enc, environment, online_mode, online_key_enc, online_key_hint FROM epos_dojo_settings WHERE office = ?',
      [office]
    );
    return row || null;
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

function counterKey(row) {
  if (!row || row.platform === 'connect' || !row.api_key_enc) return null;
  const k = unseal(row.api_key_enc);
  return k && KEY_SHAPE.test(k) ? k : null;
}

/**
 * The key for this venue's online payments: a string, null for "configured
 * but nothing usable", or undefined for "not configured: carry on as before".
 */
async function onlineKeyFor(db, office) {
  const row = await readRow(db, office);
  if (!row || !MODES.has(row.online_mode)) return undefined;
  if (row.online_mode === 'demo') {
    // The venue's own sandbox key when it saved one ("PontardaweRFC Demo"),
    // else the shared demo key. Never a live key in demo mode.
    const own = row.online_key_enc ? unseal(row.online_key_enc) : null;
    if (own && own.startsWith('sk_sandbox_')) return own;
    return demoKey() || null;
  }
  if (row.online_mode === 'counter') return counterKey(row);
  const k = row.online_key_enc ? unseal(row.online_key_enc) : null;
  return k && k.startsWith('sk_prod_') ? k : null;
}

/** What the back office shows. Never a key, only its last four. */
async function publicView(db, office) {
  const row = await readRow(db, office);
  const counter = counterKey(row);
  const own = row && row.online_key_enc ? unseal(row.online_key_enc) : null;
  return {
    own_sandbox: !!(own && own.startsWith('sk_sandbox_')),
    mode: row && MODES.has(row.online_mode) ? row.online_mode : 'demo',
    configured: !!(row && MODES.has(row.online_mode)),
    live_hint: row && row.online_key_hint ? row.online_key_hint : null,
    counter_usable: !!counter,
    counter_live: !!counter && counter.startsWith('sk_prod_'),
    counter_platform: row && row.platform === 'connect' ? 'connect' : 'dojo',
    demo_available: !!demoKey(),
  };
}

/** Ask Dojo whether a key is accepted, without creating anything. */
async function checkKey(key) {
  try {
    const r = await fetch('https://api.dojo.tech/payment-intents/pi_vesopa_key_check', {
      headers: { Authorization: 'Basic ' + key, version: '2024-02-05', Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'Dojo did not accept that key.' };
    return { ok: true };
  } catch {
    return { ok: false, message: 'Dojo could not be reached to check the key. Try again.' };
  }
}

/**
 * Save the online checkout choice. Throws an Error with a sentence a manager
 * can read when the choice cannot work; nothing is saved then.
 */
async function save(db, office, body) {
  const mode = String((body && body.mode) || '');
  if (!MODES.has(mode)) throw Object.assign(new Error('Choose Demo, the Pay at Counter key, or another live key.'), { status: 400 });
  const row = await readRow(db, office);
  let sealed = null;
  let hint = null;

  if (mode === 'demo') {
    // Optionally the venue's own sandbox key; otherwise the shared one.
    const typed = String((body && body.api_key) || '').trim();
    if (typed) {
      if (!typed.startsWith('sk_sandbox_') || !KEY_SHAPE.test(typed)) {
        throw Object.assign(new Error('Demo takes a Dojo sandbox key (sk_sandbox_...).'), { status: 400 });
      }
      const checked = await checkKey(typed);
      if (!checked.ok) throw Object.assign(new Error(checked.message), { status: 400 });
      sealed = seal(typed);
      hint = typed.slice(-4);
    } else if (!demoKey() && !(row && row.online_key_enc && String(unseal(row.online_key_enc) || '').startsWith('sk_sandbox_'))) {
      throw Object.assign(new Error('The demo (sandbox) key is not set up on this server yet.'), { status: 409 });
    }
  }
  if (mode === 'counter' && !counterKey(row)) {
    throw Object.assign(new Error(row && row.platform === 'connect'
      ? 'The Pay at Counter key is a Paymentsense Connect key, which Dojo does not accept for online payments. Use another live key, or Demo.'
      : 'There is no Dojo key under Pay at Counter to use.'), { status: 409 });
  }
  if (mode === 'live') {
    const typed = String((body && body.api_key) || '').trim();
    if (typed) {
      if (!typed.startsWith('sk_prod_') || !KEY_SHAPE.test(typed)) throw Object.assign(new Error('A live key starts sk_prod_. For a sandbox key choose Demo.'), { status: 400 });
      const checked = await checkKey(typed);
      if (!checked.ok) throw Object.assign(new Error(checked.message), { status: 400 });
      sealed = seal(typed);
      if (!sealed) throw Object.assign(new Error('The server cannot seal keys (EXPRESS_SECRET_KEY is not set).'), { status: 500 });
      hint = typed.slice(-4);
    } else if (!(row && row.online_key_enc && String(unseal(row.online_key_enc) || '').startsWith('sk_prod_'))) {
      throw Object.assign(new Error('Paste the live key to use.'), { status: 400 });
    }
  }

  await db.query(
    `INSERT INTO epos_dojo_settings (office, online_mode, online_key_enc, online_key_hint)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE online_mode = VALUES(online_mode),
       online_key_enc = COALESCE(VALUES(online_key_enc), online_key_enc),
       online_key_hint = COALESCE(VALUES(online_key_hint), online_key_hint)`,
    [office, mode, sealed, hint]
  );
  return publicView(db, office);
}

module.exports = { onlineKeyFor, publicView, save, demoKey, MODES };
