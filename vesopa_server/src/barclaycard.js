/**
 * Barclaycard Smartpay Fuse for a venue (2026-10-20): back office settings
 * and keys, and what the menu asks to take a card with it. The API itself is
 * in barclaycard_client.js; the menu's checkout page is in dinein.js.
 *
 * Off for every venue until a manager saves keys and turns it on. Sandbox
 * first, like Teya. When on, the menu takes cards with Barclaycard ahead of
 * Teya and Dojo; the tills' card machines are not affected.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');

const bc = require('./barclaycard_client');
const { requireAuth, requireTerminal } = require('./auth');
const { attachAccess, requirePermission } = require('./permissions');
const { seal, unseal } = require('./express_kiosk');

const missing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');
const DEFAULTS = { enabled: 0, environment: 'sandbox' };

async function settingsFor(db, office) {
  try {
    const [[row]] = await db.query('SELECT * FROM epos_barclaycard_settings WHERE office = ?', [office]);
    return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
  } catch (e) {
    if (missing(e)) return { ...DEFAULTS };
    throw e;
  }
}

async function keysFor(db, office, env) {
  try {
    const [[row]] = await db.query('SELECT * FROM epos_barclaycard_keys WHERE office = ? AND environment = ?', [office, bc.cleanEnv(env)]);
    return row || null;
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** The signing credentials for a venue in an environment, or null. */
async function credsFor(db, office, env) {
  const k = await keysFor(db, office, env);
  if (!k) return null;
  const secret = unseal(k.secret_enc);
  if (!secret) return null;
  return { env: bc.cleanEnv(env), merchantId: k.merchant_id, keyId: k.key_id, secret };
}

/** How the venue's menu takes cards with Barclaycard, or null when it does not. */
async function onlineFor(db, office) {
  const s = await settingsFor(db, office);
  if (!Number(s.enabled)) return null;
  const creds = await credsFor(db, office, s.environment);
  return creds ? { env: creds.env, creds } : null;
}

/** Whether the venue's tills take cards with Barclaycard (on the customer's phone), or null. */
async function tillFor(db, office) {
  const s = await settingsFor(db, office);
  if (!Number(s.till_enabled)) return null;
  const creds = await credsFor(db, office, s.environment);
  return creds ? { env: creds.env, creds } : null;
}

/** The https origin the visitor is on, through a reverse proxy too. */
function originOf(req) {
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return `https://${host}`;
}

/**
 * A Barclaycard card form for [amountMinor], allowed on the page the visitor
 * is on: the signed session and what is in it. Throws BarclaycardError.
 */
async function cardSession(creds, req, amountMinor, reference) {
  // complete: the form authenticates the cardholder (3-D Secure) and takes
  // the payment itself; reference ties that payment to this order.
  const jwt = await bc.captureContext(creds, { targetOrigins: [originOf(req)], amountMinor, reference, complete: true });
  const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
  const data = (payload.ctx && payload.ctx[0] && payload.ctx[0].data) || {};
  if (!data.clientLibrary) throw new bc.BarclaycardError(502, 'NO_LIBRARY', 'Barclaycard sent no card form.');
  return { jwt, lib: data.clientLibrary, integrity: data.clientLibraryIntegrity || '', allowed: data.allowedPaymentTypes || ['PANENTRY'], complete: !!data.completeMandate };
}

/**
 * Take a card from what the payment page sent: { complete } when the form
 * authenticated and paid by itself (3-D Secure), { token } when it only
 * tokenised the card (the server then pays). Barclaycard's record is the
 * proof either way: the amount and our reference must match it.
 *
 * Answers { ok, paymentId, cardLast4, cardBrand, authCode } when paid,
 * { ok: false, pending: true, paymentId } while Barclaycard's record is not
 * there yet, or { ok: false, message } with a sentence for the customer.
 * A payment that must not stand (soft decline, security code mismatch) is
 * voided or reversed here before it answers.
 */
async function takeCard(creds, { token, complete, reference, amountMinor, billTo }) {
  if (complete) {
    const r = await bc.completedPayment(creds, complete);
    if (!r) return { ok: false, message: 'The payment could not be confirmed. Nothing was charged; please try again.' };
    if (r.pending) return { ok: false, pending: true, paymentId: r.id };
    if (r.amountMinor !== amountMinor || (reference && r.reference && r.reference !== String(reference).slice(0, 50))) {
      console.error('[barclaycard] completed payment does not match', r.id, r.amountMinor, amountMinor, r.reference, reference);
      if (r.approved) { try { await bc.undo(creds, r.id, { reference: String(reference || r.id), amountMinor: r.amountMinor }); } catch (_) {} }
      return { ok: false, message: 'That payment was for a different order, so it has been given back. Please try again.' };
    }
    if (r.soft) { try { await bc.undo(creds, r.id, { reference: String(reference), amountMinor }); } catch (_) {} }
    if (!r.approved) return { ok: false, message: r.message };
    return { ok: true, paymentId: r.id, cardLast4: r.cardLast4, cardBrand: r.cardBrand, authCode: r.approvalCode };
  }
  if (!token) return { ok: false, message: 'The card form gave no payment.' };
  const p = await bc.pay(creds, { reference, amountMinor, transientToken: token, billTo });
  const o = bc.outcomeOf(p);
  if (o.soft && p.id) { try { await bc.undo(creds, p.id, { reference: String(reference), amountMinor }); } catch (_) {} }
  if (!o.approved) return { ok: false, message: o.message };
  const card = (p.paymentInformation && (p.paymentInformation.card || p.paymentInformation.tokenizedCard)) || {};
  const acct = (p.paymentAccountInformation && p.paymentAccountInformation.card) || {};
  return {
    ok: true,
    paymentId: String(p.id),
    cardLast4: String(card.suffix || '').slice(-4) || null,
    cardBrand: String(acct.brandName || acct.type || card.type || '').slice(0, 32) || null,
    authCode: o.approvalCode,
  };
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pounds = (minor) => (Number(minor) / 100).toFixed(2);

/**
 * The payment page (2026-10-21): the card form is open the moment the page
 * is, with no "pay by card" button to press first, and Apple Pay / Google Pay
 * buttons above it when the venue's Barclaycard account offers them. Used by
 * the menu (dinein.js) and by a till's pay-on-your-phone QR code.
 *
 * The page POSTs Barclaycard's one-time token to [postUrl], which answers
 * { ok, redirect? } or { error }. A token answers once: Try again loads a
 * fresh form. Nothing here loops.
 */
function renderCardPage(res, { session, venue, title, detail, amountMinor, env, postUrl, backUrl, backLabel = 'Back' }) {
  const libOrigin = new URL(session.lib).origin;
  const wallets = session.allowed.filter((t) => t === 'APPLEPAY' || t === 'GOOGLEPAY');
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', `default-src 'self' ${libOrigin} https://*.cybersource.com https://pay.google.com https://*.google.com https://*.gstatic.com https://applepay.cdn-apple.com; script-src 'self' 'unsafe-inline' ${libOrigin} https://pay.google.com https://*.gstatic.com https://applepay.cdn-apple.com; style-src 'self' 'unsafe-inline' ${libOrigin}; img-src * data:; frame-src *; connect-src *`);
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#16181d">
<title>Pay £${pounds(amountMinor)} · ${esc(venue || 'Vesopa')}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:linear-gradient(180deg,#16181d 0,#16181d 210px,#f4f5f7 210px);color:#16181d;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:center}
.wrap{width:100%;max-width:460px;padding:20px 16px 32px}
.top{color:#fff;padding:6px 4px 18px}
.venue{font-weight:700;font-size:15px;opacity:.85}
.amt{font-size:40px;font-weight:800;letter-spacing:-.5px;margin:6px 0 2px}
.sub{font-size:14px;opacity:.75}
.card{background:#fff;border-radius:20px;box-shadow:0 10px 34px rgba(16,19,26,.12);padding:18px}
.test{display:inline-block;background:#fff4d6;color:#8a5300;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;margin-bottom:10px}
.wallets{display:grid;gap:10px;margin-bottom:12px}
.wallets button{height:52px;border:0;border-radius:12px;background:#000;color:#fff;font-size:17px;font-weight:600;cursor:pointer}
.or{display:flex;align-items:center;gap:10px;color:#8b93a1;font-size:13px;margin:4px 0 12px}.or:before,.or:after{content:"";flex:1;height:1px;background:#e6e8ec}
#form{min-height:330px}
#msg{margin-top:12px;font-size:14px;color:#5c6470;min-height:20px}#msg.err{color:#b42318;font-weight:600}#msg.ok{color:#1d7a46;font-weight:700}
#again{display:none;margin-top:12px;width:100%;height:48px;border:0;border-radius:12px;background:#16181d;color:#fff;font-weight:700;font-size:16px;cursor:pointer}
.done{text-align:center;padding:28px 6px}.done .tick{width:72px;height:72px;border-radius:50%;background:#e8f6ee;color:#1d7a46;display:grid;place-items:center;font-size:40px;margin:0 auto 12px}
.foot{margin-top:14px;text-align:center;font-size:13px;color:#6b7280}.foot a{color:#374151}
.lock{display:flex;justify-content:center;gap:6px;align-items:center;margin-top:10px;font-size:12px;color:#8b93a1}
</style>
<script src="${esc(session.lib)}"${session.integrity ? ` integrity="${esc(session.integrity)}" crossorigin="anonymous"` : ''}></script>
</head><body><div class="wrap">
<div class="top"><div class="venue">${esc(venue || '')}</div><div class="amt">£${pounds(amountMinor)}</div><div class="sub">${esc(title || '')}${detail ? ' · ' + esc(detail) : ''}</div></div>
<main class="card" id="card">
${env === 'live' ? '' : '<span class="test">TEST PAYMENT · no real money</span>'}
${wallets.length ? `<div class="wallets">${wallets.map((w) => `<button type="button" data-w="${w}">${w === 'APPLEPAY' ? 'Pay with Apple Pay' : 'Pay with Google Pay'}</button>`).join('')}</div><div class="or">or pay by card</div>` : ''}
<div id="form"></div>
<div id="msg">Loading the secure card form…</div>
<button id="again" type="button">Try again</button>
<div class="lock">&#128274; Card details go straight to Barclaycard</div>
</main>
${backUrl ? `<div class="foot"><a href="${esc(backUrl)}">${esc(backLabel)}</a></div>` : ''}
</div>
<script>
(function () {
  var msg = document.getElementById('msg'), again = document.getElementById('again');
  var busy = false;
  function say(t, cls) { msg.textContent = t || ''; msg.className = cls || ''; }
  function stop(t) { say(t, 'err'); again.style.display = 'block'; busy = false; }
  again.onclick = function () { location.reload(); };
  function done(text) {
    document.getElementById('card').innerHTML = '<div class="done"><div class="tick">&#10003;</div><div style="font-size:22px;font-weight:800">Paid</div><div style="color:#5c6470;margin-top:6px">' + text + '</div></div>';
  }
  async function send(payload) {
    if (busy) return; busy = true;
    say('Confirming the payment…');
    try {
      var r = await fetch(${JSON.stringify(postUrl)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      var j = await r.json().catch(function () { return {}; });
      if (r.ok && j.ok) {
        if (j.redirect) { say('Paid. Thank you.', 'ok'); location.replace(j.redirect); return; }
        done(j.message || 'Thank you. You can close this page.');
        return;
      }
      if (j.redirect && r.status !== 402) { location.replace(j.redirect); return; }
      stop((j.error || 'The payment did not go through.') + ' Nothing was charged.');
    } catch (e) { stop('The payment could not be confirmed. Ask a member of staff before trying again.'); }
  }
  // The form checks the card with the bank (3-D Secure, the bank's own
  // screen when it asks for one) and takes the payment; or, on an older
  // session, hands back a token the server pays with.
  async function pay(token) {
    if (!${session.complete ? 'true' : 'false'}) return send({ token: token });
    say('Checking the card with your bank…');
    var result;
    try { result = await up.complete(token); }
    catch (e) {
      fetch(${JSON.stringify(postUrl)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ declined: String((e && (e.reason || e.message)) || 'declined').slice(0, 80) }) }).catch(function () {});
      stop('The card was declined, or the bank check was not finished. Nothing was charged.');
      return;
    }
    send({ complete: result });
  }
  var up;
  (async function () {
    try {
      var accept = await Accept(${JSON.stringify(session.jwt)});
      up = await accept.unifiedPayments(false);
      window.__up = up;
    } catch (e) { stop('The card form could not be loaded. Press Try again.'); return; }
    document.querySelectorAll('[data-w]').forEach(function (b) {
      b.onclick = async function () {
        try { pay(await up.createTrigger(b.getAttribute('data-w')).show()); }
        catch (e) { say('That wallet could not be used here. Pay by card below.', 'err'); }
      };
    });
    try {
      // Straight to the card form: no button to press first.
      var shown = up.createTrigger('PANENTRY', { containers: { paymentScreen: '#form' } }).show();
      say('');
      pay(await shown);
    } catch (e) { stop('The card form was closed or could not be shown. Press Try again.'); }
  })();
})();
</script></body></html>`);
}

/** A page with one sentence, in the same look, for a payment that is over. */
function renderNotice(res, { venue, title, text, ok }) {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#16181d;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.c{max-width:420px;margin:16px;padding:28px;border-radius:20px;background:#fff;box-shadow:0 10px 34px rgba(16,19,26,.12);text-align:center}
.i{width:68px;height:68px;border-radius:50%;margin:0 auto 12px;display:grid;place-items:center;font-size:36px;background:${ok ? '#e8f6ee;color:#1d7a46' : '#fdecea;color:#b42318'}}
h1{font-size:22px;margin:0 0 6px}p{margin:0;color:#5c6470}</style></head>
<body><div class="c"><div class="i">${ok ? '&#10003;' : '!'}</div><div style="font-weight:700;color:#5c6470;font-size:14px">${esc(venue || '')}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></div></body></html>`);
}

const settleVerifyingRef = { fn: null };

function barclaycardRoutes({ pool, secret, broadcast = () => {} }) {
  const router = express.Router();
  const auth = requireAuth(secret);
  const attach = attachAccess({ pool });
  const guard = (key) => [auth, attach, requirePermission(key)];

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  const fail = (res, e, next) => {
    if (e instanceof bc.BarclaycardError) return res.status(e.status >= 400 && e.status < 500 ? 409 : 502).json({ error: e.message });
    if (e && e.expose) return res.status(e.status || 400).json({ error: e.message });
    return next(e);
  };

  async function view(office) {
    const s = await settingsFor(pool, office);
    const keyView = async (env) => {
      const k = await keysFor(pool, office, env);
      return k ? { merchant_id: k.merchant_id, key_id_hint: `…${String(k.key_id).slice(-6)}`, checked_at: k.checked_at } : null;
    };
    return {
      enabled: !!Number(s.enabled),
      till_enabled: !!Number(s.till_enabled),
      environment: bc.cleanEnv(s.environment),
      keys: { sandbox: await keyView('sandbox'), live: await keyView('live') },
    };
  }

  router.get('/barclaycard', guard('commerce.tender'), async (req, res, next) => {
    try { res.json(await view(await tenantEmail(req))); } catch (e) { fail(res, e, next); }
  });

  /** Turn the menu's Barclaycard payments on or off, and choose sandbox or live. */
  router.put('/barclaycard', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const cur = await settingsFor(pool, office);
      const b = req.body || {};
      const enabled = b.enabled === undefined ? Number(cur.enabled) : (b.enabled ? 1 : 0);
      const environment = bc.cleanEnv(b.environment === undefined ? cur.environment : b.environment);
      if ((enabled || Number(cur.till_enabled)) && !(await credsFor(pool, office, environment))) {
        return res.status(409).json({ error: `Save the ${environment} keys first: Barclaycard is in use, and would stop working without them.` });
      }
      await pool.execute(
        `INSERT INTO epos_barclaycard_settings (office, enabled, environment, updated_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), environment = VALUES(environment), updated_by = VALUES(updated_by)`,
        [office, enabled, environment, req.user.email || null]
      );
      broadcast({ type: 'barclaycard-settings' }, { office });
      res.json(await view(office));
    } catch (e) { fail(res, e, next); }
  });

  /**
   * Save the venue's keys for an environment. Checked with Barclaycard before
   * they are kept (a capture context, which moves no money), so a typo is
   * found now rather than by a customer at a table.
   */
  router.put('/barclaycard/keys/:env', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const env = bc.cleanEnv(req.params.env);
      const b = req.body || {};
      const prev = await credsFor(pool, office, env);
      const creds = {
        env,
        merchantId: String(b.merchant_id || (prev && prev.merchantId) || '').trim().slice(0, 128),
        keyId: String(b.key_id || (prev && prev.keyId) || '').trim().slice(0, 128),
        secret: String(b.secret || (prev && prev.secret) || '').trim(),
      };
      if (!creds.merchantId || !creds.keyId || !creds.secret) {
        return res.status(400).json({ error: 'Enter the Organization ID, the Key and the Shared secret key from the Smartpay Fuse Business Center.' });
      }
      try {
        await bc.captureContext(creds, { targetOrigins: ['https://menu.vesopa.com'], amountMinor: 100 });
      } catch (e) {
        if (e instanceof bc.BarclaycardError && (e.status === 401 || e.status === 403)) {
          return res.status(409).json({ error: `Barclaycard refused these ${env} keys. Check the Organization ID, Key and Shared secret, and that they are ${env === 'live' ? 'live' : 'sandbox (test)'} keys.` });
        }
        throw e;
      }
      const sealed = seal(creds.secret);
      if (!sealed) return res.status(503).json({ error: 'This server cannot store payment credentials yet: EXPRESS_SECRET_KEY is not set.' });
      await pool.execute(
        `INSERT INTO epos_barclaycard_keys (office, environment, merchant_id, key_id, secret_enc, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE merchant_id = VALUES(merchant_id), key_id = VALUES(key_id), secret_enc = VALUES(secret_enc), updated_by = VALUES(updated_by)`,
        [office, env, creds.merchantId, creds.keyId, sealed, req.user.email || null]
      );
      res.json({ ...(await view(office)), message: `Saved. Barclaycard accepted the ${env} keys.` });
    } catch (e) { fail(res, e, next); }
  });

  router.delete('/barclaycard/keys/:env', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const env = bc.cleanEnv(req.params.env);
      await pool.execute('DELETE FROM epos_barclaycard_keys WHERE office = ? AND environment = ?', [office, env]);
      // Keys gone in the environment in use: the menu goes back to Teya or Dojo.
      await pool.execute('UPDATE epos_barclaycard_settings SET enabled = 0, till_enabled = 0 WHERE office = ? AND environment = ?', [office, env]);
      broadcast({ type: 'barclaycard-settings' }, { office });
      res.json(await view(office));
    } catch (e) { fail(res, e, next); }
  });

  /**
   * A sandbox test from the back office: a £1.00 payment on Barclaycard's
   * test Visa, then its void. Proves the keys end to end; no real money.
   */
  router.post('/barclaycard/test', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const creds = await credsFor(pool, office, 'sandbox');
      if (!creds) return res.status(409).json({ error: 'Save the sandbox keys first.' });
      const ref = `vesopa-test-${Date.now().toString(36)}`;
      const p = await bc.pay(creds, {
        reference: ref,
        amountMinor: 100,
        card: { number: '4111111111111111', expirationMonth: '12', expirationYear: String(new Date().getFullYear() + 3), securityCode: '123' },
        billTo: { name: 'Vesopa Test', email: req.user.email },
      });
      if (!bc.approved(p)) return res.status(409).json({ error: `The test payment was not approved (${p.status}).`, status: p.status });
      let voided = false;
      try { voided = (await bc.voidPayment(creds, p.id, { reference: ref + '-void' })).status === 'VOIDED'; } catch (_) { /* reported below */ }
      await pool.execute('UPDATE epos_barclaycard_keys SET checked_at = NOW() WHERE office = ? AND environment = ?', [office, 'sandbox']);
      res.json({ ok: true, payment_id: p.id, status: p.status, voided, message: `Test payment of £1.00 ${p.status.toLowerCase()}${voided ? ' and voided' : ''}. Barclaycard is working.` });
    } catch (e) { fail(res, e, next); }
  });

  // ---- One switch per venue: who takes the tills' and the menu's cards ----------

  const teyaVenue = () => require('./teya');

  async function teyaRow(office) {
    return teyaVenue().settingsFor(pool, office);
  }

  async function providersView(office) {
    const b = await settingsFor(pool, office);
    const t = await teyaRow(office);
    const tEnv = String(t.environment || 'sandbox') === 'live' ? 'live' : 'sandbox';
    const conn = await teyaVenue().connectionFor(pool, office, tEnv);
    const bcReady = !!(await credsFor(pool, office, b.environment));
    const tills = Number(b.till_enabled) && bcReady ? 'barclays'
      : Number(t.enabled) && t.card_provider === 'teya' ? 'teya' : 'dojo';
    const online = Number(b.enabled) && bcReady ? 'barclays'
      : Number(t.enabled) && t.online_provider === 'teya' ? 'teya' : 'dojo';
    return {
      tills,
      online,
      environments: { teya: tEnv, barclays: bc.cleanEnv(b.environment) },
      available: {
        tills: { dojo: true, teya: !!(conn && conn.m2m_client_id), barclays: bcReady },
        online: { dojo: true, teya: !!(conn && conn.online_client_id), barclays: bcReady },
      },
      why: {
        teya_tills: conn && conn.m2m_client_id ? null : 'Connect Teya and choose its store first (Teya tab).',
        teya_online: conn && conn.online_client_id ? null : 'Connect Teya online payments first (Teya tab).',
        barclays: bcReady ? null : 'Save the Barclaycard keys first (Barclaycard tab).',
      },
    };
  }

  router.get('/payment-providers', guard('commerce.tender'), async (req, res, next) => {
    try { res.json(await providersView(await tenantEmail(req))); } catch (e) { fail(res, e, next); }
  });

  /**
   * Switch who takes the cards, in one tap: { tills: 'dojo'|'teya'|'barclays' }
   * and/or { online: ... }. Written into each acquirer's own settings, so
   * everything that already reads them (the tills, the menu) follows at once.
   */
  router.put('/payment-providers', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const ok = new Set(['dojo', 'teya', 'barclays']);
      const view = await providersView(office);
      for (const k of ['tills', 'online']) {
        if (b[k] === undefined) continue;
        if (!ok.has(b[k])) return res.status(400).json({ error: 'Choose Dojo, Teya or Barclaycard.' });
        if (!view.available[k][b[k]]) {
          return res.status(409).json({ error: b[k] === 'barclays' ? view.why.barclays : k === 'tills' ? view.why.teya_tills : view.why.teya_online });
        }
      }
      const who = req.user.email || null;
      const bset = async (col, v) => pool.execute(
        `INSERT INTO epos_barclaycard_settings (office, ${col}, updated_by) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE ${col} = VALUES(${col}), updated_by = VALUES(updated_by)`, [office, v, who]);
      const tset = async (col, v) => pool.execute(
        `INSERT INTO epos_teya_settings (office, enabled, ${col}, updated_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE ${v === 'teya' ? 'enabled = 1, ' : ''}${col} = VALUES(${col}), updated_by = VALUES(updated_by)`,
        [office, v === 'teya' ? 1 : 0, v, who]);
      if (b.tills !== undefined) {
        await bset('till_enabled', b.tills === 'barclays' ? 1 : 0);
        await tset('card_provider', b.tills === 'teya' ? 'teya' : 'dojo');
      }
      if (b.online !== undefined) {
        await bset('enabled', b.online === 'barclays' ? 1 : 0);
        await tset('online_provider', b.online === 'teya' ? 'teya' : 'dojo');
      }
      broadcast({ type: 'teya-settings' }, { office });
      broadcast({ type: 'dojo-settings' }, { office });
      broadcast({ type: 'barclaycard-settings' }, { office });
      res.json(await providersView(office));
    } catch (e) { fail(res, e, next); }
  });

  // ---- The tills: pay on the customer's phone ------------------------------------

  const PAY_MINUTES = 15;

  async function payRow(id) {
    const [[row]] = await pool.query('SELECT * FROM epos_barclaycard_payments WHERE id = ?', [String(id).slice(0, 32)]);
    return row || null;
  }

  function payView(row) {
    const status = row.status;
    const paid = status === 'paid';
    const final = paid || status === 'cancelled' || status === 'expired';
    return {
      id: row.id,
      status: paid ? 'SUCCESSFUL' : status === 'processing' || status === 'verifying' ? 'IN_PROGRESS' : final ? 'CANCELLED' : 'NEW',
      progress: status === 'processing' || status === 'verifying' ? 'CARD_PRESENTED' : row.opened_at ? 'WAITING_FOR_CARD_ENTRY' : null,
      reason: status === 'expired' ? 'EXPIRED' : null,
      final,
      outcome: paid ? 'approved' : final ? 'cancelled' : 'pending',
      message: paid ? 'Paid'
        : status === 'processing' ? 'Taking the payment…'
        : status === 'verifying' ? 'Paid on the phone; confirming with Barclaycard…'
        : status === 'expired' ? 'The payment page timed out. No money was taken.'
        : status === 'cancelled' ? 'Cancelled. No money was taken.'
        : row.message || (row.opened_at ? 'The customer has the payment page open.' : 'Waiting for the customer to scan the code.'),
      gateway_payment_id: row.payment_id || null,
      card_last4: row.card_last4 || null,
      card_brand: row.card_brand || null,
      auth_code: row.auth_code || null,
      tip_minor: 0,
      amount_minor: row.amount_minor,
      environment: row.environment,
    };
  }

  /** Whether this till takes cards with Barclaycard, and where. */
  router.get('/till/barclaycard/config', requireTerminal(secret), async (req, res, next) => {
    try {
      const t = await tillFor(pool, req.office);
      res.json({ enabled: !!t, environment: t ? t.env : bc.cleanEnv((await settingsFor(pool, req.office)).environment) });
    } catch (e) { fail(res, e, next); }
  });

  /** Start a payment: answers the page the till shows as a QR code. */
  router.post('/till/barclaycard/payments', requireTerminal(secret), async (req, res, next) => {
    try {
      const t = await tillFor(pool, req.office);
      if (!t) return res.status(409).json({ error: 'This venue\'s tills do not take cards with Barclaycard. Choose it in the back office, Card Payments.' });
      const b = req.body || {};
      const amount = Math.round(Number(b.amount_minor));
      if (!(amount > 0) || amount > 10000000) return res.status(400).json({ error: 'That amount cannot be taken.' });
      const id = crypto.randomBytes(16).toString('hex');
      const till = String(b.till_name || (req.terminal && req.terminal.jti) || '').slice(0, 128) || null;
      await pool.execute(
        `INSERT INTO epos_barclaycard_payments (id, office, environment, till, order_id, reference, amount_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, req.office, t.env, till, b.order_id ? String(b.order_id).slice(0, 64) : null,
          String(b.reference || `vesopa-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64), amount]
      );
      res.status(201).json({ id, url: `${originOf(req)}/api/public/barclaycard/pay/${id}`, environment: t.env, status: 'NEW' });
    } catch (e) { fail(res, e, next); }
  });

  /** Where a payment is, waiting up to `wait` seconds (max 25) for it to move. */
  router.get('/till/barclaycard/payments/:id', requireTerminal(secret), async (req, res, next) => {
    try {
      const wait = Math.max(0, Math.min(25, Number(req.query.wait) || 0)) * 1000;
      const until = Date.now() + wait;
      let row = await payRow(req.params.id);
      if (!row || row.office !== req.office) return res.status(404).json({ error: 'No such payment.' });
      if (row.status === 'verifying' && settleVerifyingRef.fn) row = await settleVerifyingRef.fn(row);
      const seen = `${row.status}|${row.opened_at}|${row.message}`;
      while (Date.now() < until && `${row.status}|${row.opened_at}|${row.message}` === seen && (row.status === 'pending' || row.status === 'processing' || row.status === 'verifying')) {
        await new Promise((r) => setTimeout(r, 1000));
        row = await payRow(req.params.id);
      }
      if (row.status === 'pending' && Date.now() - new Date(row.created_at).getTime() > PAY_MINUTES * 60000) {
        await pool.execute("UPDATE epos_barclaycard_payments SET status = 'expired' WHERE id = ? AND status = 'pending'", [row.id]);
        row = await payRow(row.id);
      }
      res.json(payView(row));
    } catch (e) { fail(res, e, next); }
  });

  router.post('/till/barclaycard/payments/:id/cancel', requireTerminal(secret), async (req, res, next) => {
    try {
      const row = await payRow(req.params.id);
      if (!row || row.office !== req.office) return res.status(404).json({ error: 'No such payment.' });
      const [r] = await pool.execute("UPDATE epos_barclaycard_payments SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [row.id]);
      if (r.affectedRows) return res.json({ ok: true, message: 'Cancelled. The payment page no longer takes payment.' });
      const now = await payRow(row.id);
      res.json({ ok: false, status: now.status, message: now.status === 'processing' ? 'Too late to cancel: the customer is paying now. Wait for the result.'
        : now.status === 'verifying' ? 'The customer has paid on their phone; the till is confirming it with Barclaycard. Wait for the result.'
        : 'This payment has already finished.' });
    } catch (e) { fail(res, e, next); }
  });

  /** Refund a Barclaycard payment back to its card. */
  router.post('/till/barclaycard/refunds', requireTerminal(secret), async (req, res, next) => {
    try {
      const b = req.body || {};
      const pid = String(b.gateway_payment_id || '').trim().slice(0, 64);
      const amount = Math.round(Number(b.amount_minor));
      if (!pid) return res.status(400).json({ error: 'This sale has no Barclaycard payment to refund.' });
      if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount to refund.' });
      const [[orig]] = await pool.query('SELECT * FROM epos_barclaycard_payments WHERE office = ? AND (payment_id = ? OR id = ?) LIMIT 1', [req.office, pid, pid]);
      if (orig && amount > orig.amount_minor - orig.refunded_minor) {
        return res.status(400).json({ error: `Only £${pounds(orig.amount_minor - orig.refunded_minor)} of this payment is left to refund.` });
      }
      const env = orig ? orig.environment : bc.cleanEnv((await settingsFor(pool, req.office)).environment);
      const creds = await credsFor(pool, req.office, env);
      if (!creds) return res.status(409).json({ error: 'Barclaycard is no longer set up for this venue.' });
      const r = await bc.refund(creds, (orig && orig.payment_id) || pid, { reference: `vesopa-refund-${Date.now().toString(36)}`, amountMinor: amount });
      if (orig) await pool.execute('UPDATE epos_barclaycard_payments SET refunded_minor = refunded_minor + ? WHERE id = ?', [amount, orig.id]);
      res.json({ ok: true, status: r.status, refund_id: r.id || null, message: 'Refunded to the card.' });
    } catch (e) { fail(res, e, next); }
  });

  // ---- The customer's side of a till payment (public) ----------------------------

  async function venueName(office) {
    const [[v]] = await pool.query(
      `SELECT COALESCE(NULLIF(d.display_name, ''), o.name) AS name FROM offices o
         LEFT JOIN dinein_venue d ON d.office_id = o.id WHERE o.contact_email = ? LIMIT 1`, [office]
    ).catch(() => [[null]]);
    return (v && v.name) || '';
  }

  router.get('/public/barclaycard/pay/:id', async (req, res, next) => {
    try {
      const row = await payRow(req.params.id);
      if (!row) return renderNotice(res, { title: 'Payment not found', text: 'This payment code is not valid. Ask a member of staff.', ok: false });
      const venue = await venueName(row.office);
      if (row.status === 'paid') return renderNotice(res, { venue, title: 'Paid', text: `£${pounds(row.amount_minor)} has been paid. Thank you.`, ok: true });
      const old = Date.now() - new Date(row.created_at).getTime() > PAY_MINUTES * 60000;
      if (row.status !== 'pending' || old) {
        return renderNotice(res, { venue, title: 'This payment has closed', text: 'Nothing was charged. Ask a member of staff for a new code.', ok: false });
      }
      const creds = await credsFor(pool, row.office, row.environment);
      if (!creds) return renderNotice(res, { venue, title: 'Card payments are not available', text: 'Please pay at the till.', ok: false });
      const session = await cardSession(creds, req, row.amount_minor, row.reference || `till-${row.id}`);
      await pool.execute('UPDATE epos_barclaycard_payments SET opened_at = COALESCE(opened_at, NOW()) WHERE id = ?', [row.id]);
      broadcast({ type: 'barclaycard-payment', id: row.id }, { office: row.office });
      renderCardPage(res, { session, venue, title: 'Pay at the till', amountMinor: row.amount_minor, env: row.environment, postUrl: `/api/public/barclaycard/pay/${row.id}` });
    } catch (e) {
      if (e instanceof bc.BarclaycardError) return renderNotice(res, { title: 'Card payments are not available just now', text: 'Please pay at the till, or ask a member of staff.', ok: false });
      next(e);
    }
  });

  /** Paid: record it and tell the till. */
  async function markPaid(row, t) {
    await pool.execute(
      "UPDATE epos_barclaycard_payments SET status = 'paid', payment_id = ?, card_last4 = ?, card_brand = ?, auth_code = ?, message = NULL, paid_at = NOW() WHERE id = ?",
      [String(t.paymentId).slice(0, 64), t.cardLast4 || null, t.cardBrand ? String(t.cardBrand).slice(0, 32) : null, t.authCode ? String(t.authCode).slice(0, 32) : null, row.id]
    );
    broadcast({ type: 'barclaycard-payment', id: row.id }, { office: row.office });
  }

  /** A payment the form took whose record had not appeared yet: look again. */
  async function settleVerifying(row) {
    if (row.status !== 'verifying' || !row.payment_id) return row;
    const creds = await credsFor(pool, row.office, row.environment);
    if (!creds) return row;
    try {
      const r = await bc.completedPayment(creds, row.payment_id, { tries: 1 });
      if (!r || r.pending) {
        // Barclaycard has no such payment after five minutes: it was not
        // taken (or the answer was not genuine). Open again, and say so.
        if (Date.now() - new Date(row.updated_at).getTime() > 5 * 60000) {
          await pool.execute("UPDATE epos_barclaycard_payments SET status = 'pending', payment_id = NULL, message = ? WHERE id = ? AND status = 'verifying'",
            ['Barclaycard could not confirm a payment. Ask the customer to check their banking app before paying again.', row.id]);
          broadcast({ type: 'barclaycard-payment', id: row.id }, { office: row.office });
        }
        return payRow(row.id);
      }
      if (r && !r.pending) {
        if (r.approved && r.amountMinor === row.amount_minor) {
          await markPaid(row, { paymentId: r.id, cardLast4: r.cardLast4, cardBrand: r.cardBrand, authCode: r.approvalCode });
        } else {
          if (r.soft) { try { await bc.undo(creds, r.id, { reference: row.reference || row.id, amountMinor: row.amount_minor }); } catch (_) {} }
          await pool.execute("UPDATE epos_barclaycard_payments SET status = 'pending', payment_id = NULL, message = ? WHERE id = ? AND status = 'verifying'", [r.message, row.id]);
          broadcast({ type: 'barclaycard-payment', id: row.id }, { office: row.office });
        }
      }
    } catch (e) { console.error('[barclaycard] verify', row.id, e.message); }
    return payRow(row.id);
  }
  settleVerifyingRef.fn = settleVerifying;

  router.post('/public/barclaycard/pay/:id', express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const b = req.body || {};
      const row = await payRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'No such payment.' });
      if (row.status === 'paid') return res.json({ ok: true, message: 'Already paid. Thank you.' });
      if (b.declined) {
        // The form says the bank said no (or the check was not finished).
        if (row.status === 'pending') {
          await pool.execute('UPDATE epos_barclaycard_payments SET message = ? WHERE id = ?', ['The card was declined. The customer can try another card.', row.id]);
          broadcast({ type: 'barclaycard-payment', id: row.id }, { office: row.office });
        }
        return res.json({ ok: false });
      }
      if (row.status !== 'pending') return res.status(409).json({ error: 'This payment has closed. Ask a member of staff for a new code.' });
      const creds = await credsFor(pool, row.office, row.environment);
      if (!creds) return res.status(409).json({ error: 'Card payments are not available. Please pay at the till.' });
      const [claim] = await pool.execute("UPDATE epos_barclaycard_payments SET status = 'processing', message = NULL WHERE id = ? AND status = 'pending'", [row.id]);
      if (!claim.affectedRows) return res.status(409).json({ error: 'This payment is already being taken. Wait a moment.' });
      broadcast({ type: 'barclaycard-payment', id: row.id }, { office: row.office });
      let t;
      try {
        t = await takeCard(creds, { token: b.token ? String(b.token).slice(0, 20000) : null, complete: b.complete || null, reference: row.reference || `till-${row.id}`, amountMinor: row.amount_minor, billTo: { name: 'Till Customer' } });
      } catch (e) {
        console.error('[barclaycard] till payment', row.id, e.message);
        t = { ok: false, message: 'Barclaycard did not answer. Please try again.' };
      }
      if (t.pending) {
        await pool.execute("UPDATE epos_barclaycard_payments SET status = 'verifying', payment_id = ? WHERE id = ?", [String(t.paymentId).slice(0, 64), row.id]);
        broadcast({ type: 'barclaycard-payment', id: row.id }, { office: row.office });
        return res.json({ ok: true, message: 'Payment received. The till is confirming it with Barclaycard.' });
      }
      if (!t.ok) {
        await pool.execute("UPDATE epos_barclaycard_payments SET status = 'pending', message = ? WHERE id = ? AND status = 'processing'",
          [`${t.message} The customer can try again.`.slice(0, 255), row.id]);
        broadcast({ type: 'barclaycard-payment', id: row.id }, { office: row.office });
        return res.status(402).json({ error: t.message });
      }
      await markPaid(row, t);
      res.json({ ok: true, message: `£${pounds(row.amount_minor)} paid. Thank you, you can close this page.` });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { barclaycardRoutes, settingsFor, credsFor, onlineFor, tillFor, cardSession, renderCardPage, renderNotice, takeCard };
