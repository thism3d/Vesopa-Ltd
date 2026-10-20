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

const express = require('express');

const bc = require('./barclaycard_client');
const { requireAuth } = require('./auth');
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

function barclaycardRoutes({ pool, secret }) {
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
      if (enabled && !(await credsFor(pool, office, environment))) {
        return res.status(409).json({ error: `Save the ${environment} keys first, then turn Barclaycard on.` });
      }
      await pool.execute(
        `INSERT INTO epos_barclaycard_settings (office, enabled, environment, updated_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), environment = VALUES(environment), updated_by = VALUES(updated_by)`,
        [office, enabled, environment, req.user.email || null]
      );
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
      await pool.execute('UPDATE epos_barclaycard_settings SET enabled = 0 WHERE office = ? AND environment = ?', [office, env]);
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

  return router;
}

module.exports = { barclaycardRoutes, settingsFor, credsFor, onlineFor };
