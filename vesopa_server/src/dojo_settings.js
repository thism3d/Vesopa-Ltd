/**
 * Dojo card settings per venue, and the card log every till reports to.
 *
 * Dojo accreditation (test sheet, 9 Oct 2026):
 *
 *   * "Identifying Headers": the software house id is Vesopa's own, SL942X04,
 *     fixed and sent on every request. The reseller id is free text; blank is
 *     sent as the software house id.
 *   * "Incorrect authorization credentials": Save makes an API call, and a 401
 *     reads "API key is incorrect" there and then. A card machine named here
 *     must be on the account and switched on, or nothing is saved.
 *
 * The till fetches its venue's settings over its own terminal token (the key
 * has to reach the till: the till talks to Dojo itself). The back office only
 * ever sees the last four characters again.
 */

const crypto = require('crypto');
const express = require('express');

const { requireTerminal } = require('./auth');
const { attachAccess, requirePermission } = require('./permissions');
const { requireAuth } = require('./auth');
const { seal, unseal } = require('./express_kiosk');

const BASE = (process.env.DOJO_BASE_URL || 'https://api.dojo.tech').replace(/\/+$/, '');
const VERSION = process.env.DOJO_API_VERSION || '2024-02-05';

/** Vesopa's software house id, issued by Dojo. Not a venue setting. */
const SOFTWARE_HOUSE_ID = process.env.DOJO_SOFTWARE_HOUSE_ID || 'SL942X04';

/**
 * Dojo's public sandbox key, which every venue may use for testing (owner,
 * 9 Oct 2026). A venue with nothing saved is on this.
 */
const PUBLIC_SANDBOX_KEY =
  'sk_sandbox_c8oLGaI__msxsXbpBDpdtwJEz_eIhfQoKHmedqgZPCdBx59zpKZLSk8OPLT0cZolbeuYJSBvzDVVsYvtpo5RkQ';

const RESULT_SECONDS = [5, 10, 15];

function cleanSeconds(v) {
  const n = Number(v);
  if (n >= 15) return 15;
  if (n >= 10) return 10;
  return 5;
}

function cleanId(v, max = 64) {
  return String(v ?? '').trim().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max);
}

/** The partner ids every call carries. */
function partnerHeaders(resellerId) {
  const reseller = cleanId(resellerId) || SOFTWARE_HOUSE_ID;
  return { 'software-house-id': SOFTWARE_HOUSE_ID, 'reseller-id': reseller };
}

/**
 * Check a key (and a card machine) against Dojo, the way the till's Save does.
 * Returns { ok, message, terminals, terminal }.
 */
async function verifyDojo({ key, resellerId, terminalId, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${BASE}/terminals`, {
      headers: {
        Authorization: 'Basic ' + key,
        version: VERSION,
        Accept: 'application/json',
        ...partnerHeaders(resellerId),
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, message: 'Could not reach Dojo to check the settings. Try again.' };
  }
  if (res.status === 401) {
    return { ok: false, message: 'API key is incorrect. Please check the API key.' };
  }
  if (res.status === 403) {
    return { ok: false, message: 'Dojo refused the software house or reseller id (HTTP 403).' };
  }
  if (!res.ok) {
    return { ok: false, message: `Dojo did not accept these settings (HTTP ${res.status}).` };
  }
  const list = await res.json().catch(() => []);
  const terminals = (Array.isArray(list) ? list : []).map((t) => ({
    id: t.id,
    tid: (t.properties && t.properties.tid) || '',
    status: t.status || '',
  }));
  const tid = cleanId(terminalId);
  if (!tid) {
    return { ok: true, terminals, message: 'API key accepted.' };
  }
  const match = terminals.find((t) => t.id === tid || t.tid === tid);
  if (!match) {
    return { ok: false, terminals, message: `API key accepted, but card machine ${tid} is not on this Dojo account.` };
  }
  if (!['available', 'busy'].includes(match.status.toLowerCase())) {
    return { ok: false, terminals, terminal: match, message: `Card machine ${match.tid || match.id} is ${match.status}. Switch it on and connect it, then save again.` };
  }
  return { ok: true, terminals, terminal: match, message: `Connected: card machine ${match.tid || match.id} is ${match.status.toLowerCase()}.` };
}

function isSandboxKey(key) {
  return String(key || '').startsWith('sk_sandbox_');
}

/** What the back office shows. Never the key. */
function publicView(row) {
  const own = row && row.api_key_enc;
  return {
    software_house_id: SOFTWARE_HOUSE_ID,
    configured: Boolean(own),
    key_source: own ? 'venue' : 'public_sandbox',
    key_hint: own ? row.key_hint : PUBLIC_SANDBOX_KEY.slice(-4),
    environment: own ? row.environment : 'sandbox',
    reseller_id: (row && row.reseller_id) || '',
    reseller_sent: cleanId(row && row.reseller_id) || SOFTWARE_HOUSE_ID,
    terminal_id: (row && row.terminal_id) || '',
    result_seconds: row ? cleanSeconds(row.result_seconds) : 5,
    updated_at: row ? row.updated_at : null,
    updated_by: row ? row.updated_by : null,
  };
}

/** A stable id for one till record, so a re-send is not a second row. */
function eventId(office, e) {
  return crypto
    .createHash('sha1')
    .update([office, e.at, e.kind, e.outcome, e.intent_id || '', e.session_id || '', e.amount_minor].join('|'))
    .digest('hex');
}

function toMysql(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 19).replace('T', ' ')
    : d.toISOString().slice(0, 19).replace('T', ' ');
}

function str(v, max) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).slice(0, max);
}

function dojoSettingsRoutes({ pool, broadcast, secret, fetchImpl }) {
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

  async function rowFor(office) {
    const [[row]] = await pool.query('SELECT * FROM epos_dojo_settings WHERE office = ?', [office]);
    return row || null;
  }

  // ---- Back office ----------------------------------------------------------

  router.get('/dojo-settings', guard('commerce.tender'), async (req, res, next) => {
    try {
      res.json(publicView(await rowFor(await tenantEmail(req))));
    } catch (e) { next(e); }
  });

  /**
   * Check without saving: the key typed (or the one already saved) against
   * Dojo, and the card machines on the account for the picker.
   */
  router.post('/dojo-settings/test', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const row = await rowFor(office);
      const typed = String((req.body && req.body.api_key) || '').trim();
      const key = typed || (row && row.api_key_enc ? unseal(row.api_key_enc) : PUBLIC_SANDBOX_KEY);
      const result = await verifyDojo({
        key,
        resellerId: req.body && req.body.reseller_id,
        terminalId: req.body && req.body.terminal_id,
        fetchImpl,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.put('/dojo-settings', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const row = await rowFor(office);
      const body = req.body || {};

      if (body.reset) {
        await pool.execute('DELETE FROM epos_dojo_settings WHERE office = ?', [office]);
        broadcast({ type: 'dojo-settings' }, { office });
        return res.json({ ...publicView(null), message: 'Back on the public Dojo sandbox key.' });
      }

      const typed = String(body.api_key || '').trim();
      if (typed && !/^sk_(sandbox|live)_[A-Za-z0-9_-]{16,}$/.test(typed)) {
        return res.status(400).json({ error: 'That does not look like a Dojo secret key. It starts sk_live_ (or sk_sandbox_ for testing).' });
      }
      const key = typed
        || (row && row.api_key_enc ? unseal(row.api_key_enc) : null)
        || (body.use_public_sandbox ? PUBLIC_SANDBOX_KEY : null);
      if (!key) {
        return res.status(400).json({ error: 'Enter the venue\'s Dojo secret key, or use the public sandbox key.' });
      }

      const resellerId = cleanId(body.reseller_id);
      const terminalId = cleanId(body.terminal_id);
      const check = await verifyDojo({ key, resellerId, terminalId, fetchImpl });
      if (!check.ok) return res.status(400).json({ error: check.message, terminals: check.terminals || [] });

      const sealed = seal(key);
      if (!sealed) {
        return res.status(503).json({ error: 'This server cannot store a card key yet: EXPRESS_SECRET_KEY is not set.' });
      }
      await pool.execute(
        `INSERT INTO epos_dojo_settings
           (office, api_key_enc, key_hint, environment, reseller_id, terminal_id, result_seconds, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE api_key_enc = VALUES(api_key_enc), key_hint = VALUES(key_hint),
           environment = VALUES(environment), reseller_id = VALUES(reseller_id),
           terminal_id = VALUES(terminal_id), result_seconds = VALUES(result_seconds),
           updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
        [
          office, sealed, key.slice(-4), isSandboxKey(key) ? 'sandbox' : 'live',
          resellerId || null, (check.terminal && check.terminal.id) || null,
          cleanSeconds(body.result_seconds), req.user.email || null,
        ]
      );
      // Every till in the venue picks the change up.
      broadcast({ type: 'dojo-settings' }, { office });
      res.json({ ...publicView(await rowFor(office)), message: check.message });
    } catch (e) { next(e); }
  });

  /** The venue's card log, newest first. */
  router.get('/card-transactions', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
      const params = [office, days];
      let extra = '';
      if (req.query.outcome) { extra += ' AND outcome = ?'; params.push(String(req.query.outcome)); }
      if (req.query.kind) { extra += ' AND kind = ?'; params.push(String(req.query.kind)); }
      const [rows] = await pool.query(
        `SELECT id, terminal, at, kind, outcome, amount_minor, intent_id, session_id, dojo_status,
                message, order_id, terminal_id, software_house_id, reseller_id, auth_code,
                card_last4, card_type, staff, receipt_lines
           FROM epos_card_transactions
          WHERE office = ? AND at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)${extra}
          ORDER BY at DESC LIMIT 1000`,
        params
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  // ---- Till -----------------------------------------------------------------

  /** The venue's settings for a till, key included, over the till's token. */
  router.get('/till/dojo-settings', requireTerminal(secret), async (req, res, next) => {
    try {
      const row = await rowFor(req.office);
      const view = publicView(row);
      res.json({
        configured: view.configured,
        api_key: row && row.api_key_enc ? unseal(row.api_key_enc) : null,
        environment: view.environment,
        software_house_id: SOFTWARE_HOUSE_ID,
        reseller_id: view.reseller_id,
        terminal_id: view.terminal_id,
        result_seconds: view.result_seconds,
        updated_at: row ? new Date(row.updated_at).toISOString() : null,
      });
    } catch (e) { next(e); }
  });

  /** Card events from a till: every sale, refund and check, whatever happened. */
  router.post('/till/card-transactions', requireTerminal(secret), async (req, res, next) => {
    try {
      const events = Array.isArray(req.body && req.body.events) ? req.body.events.slice(0, 100) : [];
      let stored = 0;
      for (const e of events) {
        if (!e || typeof e !== 'object') continue;
        const [r] = await pool.execute(
          `INSERT IGNORE INTO epos_card_transactions
             (id, office, terminal, at, kind, outcome, amount_minor, intent_id, session_id, dojo_status,
              message, order_id, terminal_id, software_house_id, reseller_id, auth_code, card_last4,
              card_type, staff, receipt_lines)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            eventId(req.office, e), req.office, str(e.terminal_name, 128) || str(req.terminal && req.terminal.jti, 128),
            toMysql(e.at), str(e.kind, 24) || 'sale', str(e.outcome, 24) || 'unknown',
            Number.isFinite(Number(e.amount_minor)) ? Math.round(Number(e.amount_minor)) : 0,
            str(e.intent_id, 64), str(e.session_id, 64), str(e.status, 48), str(e.message, 500),
            str(e.order_id, 64), str(e.terminal_id, 64), str(e.software_house_id, 64),
            str(e.reseller_id, 64), str(e.auth_code, 32), str(e.card_last4, 4), str(e.card_type, 32),
            str(e.staff, 128),
            JSON.stringify(Array.isArray(e.receipt_lines) ? e.receipt_lines.slice(0, 80).map((l) => String(l).slice(0, 80)) : []),
          ]
        );
        stored += r.affectedRows;
      }
      if (stored) broadcast({ type: 'card-transactions' }, { office: req.office });
      res.json({ stored });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = {
  dojoSettingsRoutes,
  verifyDojo,
  publicView,
  eventId,
  SOFTWARE_HOUSE_ID,
  PUBLIC_SANDBOX_KEY,
  RESULT_SECONDS,
};
