/**
 * Teya for a venue: back office settings, the tills' card machines, and the
 * menu's online checkout (2026-10-19). The API itself is in teya_client.js.
 *
 * The owner's rules:
 *
 *   * Dojo stays the default everywhere. Teya is off for every venue until a
 *     manager turns it on, and a venue with Teya off behaves exactly as it
 *     did before: no row, nothing changes.
 *   * Every venue starts on Teya's sandbox. Live is a switch per venue,
 *     available once Vesopa holds Teya's production credentials.
 *   * The tills' card machines and the menu's online payments are chosen
 *     separately (Dojo or Teya each), and each till picks its own Teya card
 *     machine.
 *
 * The tills never hold a Teya credential: they ask this server to send a
 * payment to their card machine and to say where it is.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');

const teya = require('./teya_client');
const { requireAuth, requireTerminal } = require('./auth');
const { attachAccess, requirePermission } = require('./permissions');
const { seal, unseal } = require('./express_kiosk');

const PROVIDERS = new Set(['dojo', 'teya']);

/**
 * Teya's Windows SDK app, from docs.teya.com/downloads, and the thumbprint of
 * Teya's signing certificate in the same zip (signing_cert.cer, CN=epos.teya.com,
 * valid to 2029-04-08). A new version means a new zip: both change together.
 */
const SDK_WINDOWS = {
  version: process.env.TEYA_SDK_WINDOWS_VERSION || '1.9.0',
  url: process.env.TEYA_SDK_WINDOWS_URL || 'https://cdn.teya.com/static/2bbd9f0b/teya-integrations-app-1.9.0.zip',
  thumbprint: process.env.TEYA_SDK_WINDOWS_THUMBPRINT || 'E6AB81F92407D2747FE621FD58A5DAF0F904330B',
};
const missing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

const DEFAULTS = { enabled: 0, environment: 'sandbox', card_provider: 'dojo', online_provider: 'dojo' };

async function settingsFor(db, office) {
  try {
    const [[row]] = await db.query('SELECT * FROM epos_teya_settings WHERE office = ?', [office]);
    return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
  } catch (e) {
    if (missing(e)) return { ...DEFAULTS };
    throw e;
  }
}

async function connectionFor(db, office, env) {
  try {
    const [[row]] = await db.query('SELECT * FROM epos_teya_connections WHERE office = ? AND environment = ?', [office, teya.cleanEnv(env)]);
    return row || null;
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

async function saveConnection(db, office, env, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const sets = cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
  await db.execute(
    `INSERT INTO epos_teya_connections (office, environment, ${cols.map((c) => `\`${c}\``).join(', ')})
     VALUES (?, ?, ${cols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${sets}`,
    [office, teya.cleanEnv(env), ...cols.map((c) => fields[c])]
  );
}

function sealOrThrow(v) {
  const s = seal(v);
  if (!s) throw new teya.TeyaError(503, 'NO_SEAL', 'This server cannot store payment credentials yet: EXPRESS_SECRET_KEY is not set.');
  return s;
}

const mysqlTime = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

// ---- A venue's own Teya app credentials -----------------------------------------

/**
 * The Device Code app credentials a venue saved in the back office for an
 * environment, or null (then Vesopa's own from the server .env are used).
 * This is how a venue goes live the day Teya gives it live credentials,
 * without anybody editing the server.
 */
async function ownApp(db, office, env) {
  try {
    const [[row]] = await db.query('SELECT * FROM epos_teya_apps WHERE office = ? AND environment = ?', [office, teya.cleanEnv(env)]);
    if (!row || !row.device_client_id || !row.device_secret_enc) return null;
    const secret = unseal(row.device_secret_enc);
    return secret ? { deviceId: row.device_client_id, deviceSecret: secret, pluginType: row.plugin_type || '' } : null;
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** The Teya machine the back office gave a till (by its permanent device id). */
async function assignedTerminal(db, office, env, terminal) {
  try {
    const jti = terminal && terminal.jti;
    if (!jti) return null;
    const [[row]] = await db.query(
      `SELECT a.terminal_id FROM bo_till_seats s
         JOIN epos_teya_till_terminals a ON a.office = s.office COLLATE utf8mb4_general_ci AND a.device_id = s.device_id COLLATE utf8mb4_general_ci AND a.environment = ?
        WHERE s.id = ? AND s.office = ? LIMIT 1`,
      [teya.cleanEnv(env), jti, office]
    );
    return row ? row.terminal_id : null;
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

// ---- Tokens ------------------------------------------------------------------

/**
 * The manager's Teya user token for a venue, refreshed when it is near its
 * end. Teya's refresh tokens are single use, so refreshes for one venue are
 * queued behind each other and the new refresh token is saved before anything
 * else uses it.
 */
const refreshing = new Map();
async function userToken(db, office, env) {
  const conn = await connectionFor(db, office, env);
  if (!conn || !conn.user_refresh_enc) {
    throw new teya.TeyaError(409, 'NOT_CONNECTED', 'Teya is not connected for this venue yet. Use Connect Teya first.');
  }
  if (conn.user_access_enc && conn.user_access_until && new Date(conn.user_access_until).getTime() > Date.now() + 60000) {
    const t = unseal(conn.user_access_enc);
    if (t) return t;
  }
  const key = `${office}|${teya.cleanEnv(env)}`;
  if (refreshing.has(key)) return refreshing.get(key);
  const p = (async () => {
    try {
      // Read again inside the queue: another refresh may have just finished.
      const fresh = await connectionFor(db, office, env);
      if (fresh.user_access_enc && fresh.user_access_until && new Date(fresh.user_access_until).getTime() > Date.now() + 60000) {
        const t = unseal(fresh.user_access_enc);
        if (t) return t;
      }
      const rt = unseal(fresh.user_refresh_enc);
      let tok;
      try {
        tok = await teya.refreshUser(env, rt, await ownApp(db, office, env));
      } catch (e) {
        if (e.status === 400 || e.status === 401) {
          throw new teya.TeyaError(409, 'RECONNECT', 'Teya has signed this venue out. Use Connect Teya again to approve Vesopa.');
        }
        throw e;
      }
      // Refresh at 80% of the token's life.
      const life = Math.max(120, Number(tok.expires_in) || 86400);
      await saveConnection(db, office, env, {
        user_access_enc: sealOrThrow(tok.access_token),
        user_access_until: mysqlTime(Date.now() + life * 800),
        ...(tok.refresh_token ? { user_refresh_enc: sealOrThrow(tok.refresh_token) } : {}),
      });
      return tok.access_token;
    } finally {
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, p);
  return p;
}

/** The store's own machine token, from registering Vesopa as its ePOS. */
async function machineToken(db, office, env, conn) {
  const c = conn || await connectionFor(db, office, env);
  if (!c || !c.m2m_client_id || !c.m2m_secret_enc) {
    throw new teya.TeyaError(409, 'NO_STORE', 'Choose the Teya store this venue takes payments in first.');
  }
  // The permissions Teya grants the store's ePOS registration, asked for by
  // name: a token asked for with none carries only default_access.
  return teya.clientToken(env, c.m2m_client_id, unseal(c.m2m_secret_enc), teya.POSLINK_SCOPE);
}

/**
 * The card machines in the venue's Teya store.
 *
 * Read with the manager's own Teya sign-in first: Teya answers that with the
 * store's machines, including none. The store's machine credentials are only
 * the fallback, because Teya refuses those (403) for a store with no machine
 * linked yet (sandbox, 2026-10-20), which read as "not allowed" when the truth
 * was "no machines".
 */
async function storeTerminals(db, office, env, conn) {
  const c = conn || await connectionFor(db, office, env);
  if (!c || !c.store_id) throw new teya.TeyaError(409, 'NO_STORE', 'Choose the Teya store this venue takes payments in first.');
  if (c.user_refresh_enc) {
    try {
      return await teya.listTerminals(env, await userToken(db, office, env), c.store_id);
    } catch (e) {
      if (!(e instanceof teya.TeyaError) || e.code === 'TEYA_UNREACHABLE' || e.code === 'TEYA_TIMEOUT') throw e;
      // Signed out or refused: try the store's own credentials below.
    }
  }
  try {
    return await teya.listTerminals(env, await machineToken(db, office, env, c), c.store_id);
  } catch (e) {
    if (e instanceof teya.TeyaError && e.status === 403) {
      throw new teya.TeyaError(409, 'NO_MACHINES', 'Teya has no card machine in this store yet. Add one in Teya Business (Devices), or sign the Teya test app into this store, then reload this page.');
    }
    throw e;
  }
}

/** The store's online-payments token. */
async function onlineToken(env, conn) {
  if (!conn || !conn.online_client_id || !conn.online_secret_enc) {
    throw new teya.TeyaError(409, 'NO_ONLINE', 'Teya online payments are not connected for this venue.');
  }
  return teya.clientToken(env, conn.online_client_id, unseal(conn.online_secret_enc), teya.ONLINE_SCOPE);
}

// ---- What the menu and the tills ask -----------------------------------------

/**
 * How a venue's menu takes card payments with Teya, or null when it does not
 * (Teya off, the menu on Dojo, or online payments not connected).
 */
async function onlineFor(db, office) {
  const s = await settingsFor(db, office);
  if (!Number(s.enabled) || s.online_provider !== 'teya') return null;
  const env = teya.cleanEnv(s.environment);
  const conn = await connectionFor(db, office, env);
  if (!conn || !conn.online_client_id) return null;
  return { env, storeId: conn.online_store_id, conn, token: () => onlineToken(env, conn) };
}

/** The same for an order already started in a given environment. */
async function onlineForEnv(db, office, env) {
  const conn = await connectionFor(db, office, env);
  if (!conn || !conn.online_client_id) return null;
  return { env: teya.cleanEnv(env), storeId: conn.online_store_id, conn, token: () => onlineToken(env, conn) };
}

/** The webhook key for a venue's online store in an environment. */
async function onlineWebhookKey(db, office, env) {
  const conn = await connectionFor(db, office, env);
  return conn && conn.online_webhook_key ? conn.online_webhook_key : null;
}

function terminalView(t) {
  return {
    id: t.terminal_id || t.id,
    name: t.terminal_name || t.name || '',
    serial: t.serial_number || '',
  };
}

/** A payment request as the till reads it. */
function paymentView(p) {
  const card = (p.metadata && p.metadata.payment_method_details && p.metadata.payment_method_details.card) || {};
  const details = (p.metadata && p.metadata.payment_method_details) || {};
  const status = p.status || 'NEW';
  let outcome = 'pending';
  if (status === 'SUCCESSFUL') outcome = 'approved';
  else if (status === 'CANCELLED') outcome = 'cancelled';
  else if (status === 'FAILED') outcome = /DECLINED/.test(p.status_reason || '') ? 'declined' : 'failed';
  return {
    id: p.payment_request_id || p.id,
    status,
    progress: p.progress_status || null,
    reason: p.status_reason || null,
    final: teya.FINAL.has(status),
    outcome,
    message: messageFor(status, p.progress_status, p.status_reason),
    gateway_payment_id: p.gateway_payment_id || null,
    card_last4: card.last4 || null,
    card_brand: card.brand || null,
    auth_code: details.authorisation_code || null,
    amount_minor: p.requested_amount ? Number(p.requested_amount.amount) : undefined,
    tip_minor: p.requested_amount ? Number(p.requested_amount.tip || 0) : undefined,
  };
}

const PROGRESS = {
  SENT_TO_PAYMENT_APP: 'Sent to the card machine…',
  WAITING_FOR_CARD_ENTRY: 'Present card',
  WAITING_FOR_CARD: 'Present card',
  CARD_ENTERED: 'Card read…',
  PIN_ENTRY: 'Enter PIN',
  WAITING_FOR_PIN: 'Enter PIN',
  PROCESSING: 'Processing…',
  AUTHORISING: 'Authorising…',
  WAITING_FOR_SIGNATURE: 'Signature needed on the card machine',
  PRINTING_RECEIPT: 'Printing receipt…',
};
const REASONS = {
  CANCELLED_BY_USER: 'Cancelled on the card machine.',
  CANCELLED_BY_EPOS: 'Cancelled from the till.',
  DECLINED_ONLINE: 'Card declined.',
  DECLINED_OFFLINE: 'Card declined.',
  DECLINED: 'Card declined.',
  TIMEOUT: 'The card machine timed out. No money was taken.',
  TERMINAL_UNREACHABLE: 'The card machine could not be reached. Check it is on, online and has the Teya app open.',
  TERMINAL_BUSY: 'The card machine is busy with another payment.',
  CARD_REMOVED: 'The card was removed too early.',
  INSUFFICIENT_FUNDS: 'Card declined: insufficient funds.',
};
function messageFor(status, progress, reason) {
  if (status === 'SUCCESSFUL') return 'Approved';
  if (status === 'CANCELLING') return 'Cancelling…';
  if (status === 'CANCELLED') return REASONS[reason] || 'Payment cancelled. No money was taken.';
  if (status === 'FAILED') return REASONS[reason] || `Payment failed${reason ? ` (${String(reason).toLowerCase().replace(/_/g, ' ')})` : ''}. No money was taken.`;
  return PROGRESS[progress] || (status === 'NEW' ? 'Sending to the card machine…' : 'Waiting for the card machine…');
}

function sendError(res, e, next) {
  if (e instanceof teya.TeyaError) {
    const status = e.status >= 400 && e.status < 600 ? (e.status === 401 ? 409 : e.status) : 502;
    return res.status(status).json({ ok: false, error: e.message, message: e.message, code: e.code });
  }
  return next(e);
}

// ---- Routes ------------------------------------------------------------------

function teyaRoutes({ pool, broadcast, secret, onOnlinePayment }) {
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

  function publicBase(req) {
    return String(process.env.TEYA_WEBHOOK_BASE || process.env.BACKOFFICE_URL || `https://${req.get('host')}`).replace(/\/+$/, '');
  }

  function tellTills(office) {
    broadcast({ type: 'teya-settings' }, { office });
    broadcast({ type: 'dojo-settings' }, { office });
  }

  async function view(office) {
    const s = await settingsFor(pool, office);
    const env = teya.cleanEnv(s.environment);
    const ownS = await ownApp(pool, office, 'sandbox');
    const ownL = await ownApp(pool, office, 'live');
    const appView = (own, e) => ({
      source: own ? 'venue' : (teya.available(e) ? 'vesopa' : 'none'),
      client_id_hint: own ? `…${own.deviceId.slice(-6)}` : null,
      plugin_type: own ? own.pluginType || null : null,
    });
    const out = {
      apps: { sandbox: appView(ownS, 'sandbox'), live: appView(ownL, 'live') },
      enabled: !!Number(s.enabled),
      environment: env,
      card_provider: PROVIDERS.has(s.card_provider) ? s.card_provider : 'dojo',
      online_provider: PROVIDERS.has(s.online_provider) ? s.online_provider : 'dojo',
      sandbox_available: teya.available('sandbox', ownS),
      live_available: teya.available('live', ownL),
      live_note: teya.available('live', ownL) ? null
        : 'Live needs Teya\'s live app credentials. Add them under App credentials below when Teya gives them to you.',
      updated_at: s.updated_at || null,
      updated_by: s.updated_by || null,
      connections: {},
    };
    for (const e of ['sandbox', 'live']) {
      const c = await connectionFor(pool, office, e);
      out.connections[e] = {
        card: {
          approved: !!(c && c.user_refresh_enc),
          user: (c && c.user_name) || null,
          store_id: (c && c.store_id) || null,
          store_name: (c && c.store_name) || null,
          ready: !!(c && c.m2m_client_id),
          default_terminal_id: (c && c.default_terminal_id) || null,
          connected_at: (c && c.connected_at) || null,
          connected_by: (c && c.connected_by) || null,
        },
        online: {
          ready: !!(c && c.online_client_id),
          store_id: (c && c.online_store_id) || null,
          connected_at: (c && c.online_connected_at) || null,
        },
      };
    }
    return out;
  }

  // ---- Back office: settings ---------------------------------------------------

  router.get('/teya-settings', guard('commerce.tender'), async (req, res, next) => {
    try {
      res.json(await view(await tenantEmail(req)));
    } catch (e) { sendError(res, e, next); }
  });

  router.put('/teya-settings', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const cur = await settingsFor(pool, office);
      const b = req.body || {};
      const next_ = {
        enabled: b.enabled === undefined ? Number(cur.enabled) : (b.enabled ? 1 : 0),
        environment: b.environment === undefined ? cur.environment : String(b.environment),
        card_provider: b.card_provider === undefined ? cur.card_provider : String(b.card_provider),
        online_provider: b.online_provider === undefined ? cur.online_provider : String(b.online_provider),
      };
      if (!teya.ENVS.has(next_.environment)) return res.status(400).json({ error: 'Choose Sandbox or Live.' });
      if (!PROVIDERS.has(next_.card_provider) || !PROVIDERS.has(next_.online_provider)) {
        return res.status(400).json({ error: 'Choose Dojo or Teya.' });
      }
      if (next_.environment === 'live' && !teya.available('live', await ownApp(pool, office, 'live'))) {
        return res.status(409).json({ error: 'Teya Live needs the live app credentials first. Add them under App credentials, then switch to Live.' });
      }
      // Teya off puts both back on Dojo, so nothing is left pointing at it.
      if (!next_.enabled) { next_.card_provider = 'dojo'; next_.online_provider = 'dojo'; }
      const conn = await connectionFor(pool, office, next_.environment);
      const envName = next_.environment === 'live' ? 'Teya Live' : 'the Teya sandbox';
      // Windows tills sign in to Teya themselves, in Teya's SDK app, so the
      // back office store link is not needed for them (it is what lists the
      // machines here, and what tills without the SDK use).
      if (next_.online_provider === 'teya' && !(conn && conn.online_client_id)) {
        return res.status(409).json({ error: `First connect Teya online payments on ${envName} (Online payments, below). Then the menu can use Teya.` });
      }
      await pool.execute(
        `INSERT INTO epos_teya_settings (office, enabled, environment, card_provider, online_provider, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), environment = VALUES(environment),
           card_provider = VALUES(card_provider), online_provider = VALUES(online_provider),
           updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
        [office, next_.enabled, next_.environment, next_.card_provider, next_.online_provider, req.user.email || null]
      );
      tellTills(office);
      res.json({ ...(await view(office)), message: 'Saved. Every till picks this up straight away.' });
    } catch (e) { sendError(res, e, next); }
  });

  // ---- Back office: approving Vesopa on Teya (QR code) -----------------------------

  const pending = new Map(); // id -> { office, env, device_code, until, interval }

  router.post('/teya/connect/start', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const env = teya.cleanEnv((req.body && req.body.environment) || (await settingsFor(pool, office)).environment);
      const own = await ownApp(pool, office, env);
      const d = await teya.startDevice(env, own);
      const id = crypto.randomBytes(16).toString('hex');
      for (const [k, v] of pending) if (v.until < Date.now()) pending.delete(k);
      pending.set(id, { office, env, own, device_code: d.device_code, until: Date.now() + (Number(d.expires_in) || 300) * 1000, by: req.user.email });
      res.json({
        id,
        environment: env,
        user_code: d.user_code,
        verification_url: d.verification_uri || d.verification_url,
        verification_url_complete: d.verification_uri_complete || d.verification_url_complete || null,
        qr_code: d.qr_code || null,
        expires_in: Number(d.expires_in) || 300,
        interval: Math.max(3, Number(d.interval) || 5),
      });
    } catch (e) { sendError(res, e, next); }
  });

  router.post('/teya/connect/poll', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const p = pending.get(String((req.body && req.body.id) || ''));
      if (!p || p.office !== office) return res.status(404).json({ error: 'That sign-in has finished or expired. Start again.' });
      if (p.until < Date.now()) {
        pending.delete(req.body.id);
        return res.status(410).json({ error: 'The QR code has expired. Start again for a new one.' });
      }
      const r = await teya.pollDevice(p.env, p.device_code, p.own);
      if (r.pending) return res.json({ pending: true });
      pending.delete(req.body.id);
      let name = null;
      try {
        const claims = JSON.parse(Buffer.from(String(r.id_token || r.access_token).split('.')[1], 'base64url').toString('utf8'));
        name = claims.email || claims.name || claims.preferred_username || null;
      } catch { /* not a JWT we can read */ }
      const life = Math.max(120, Number(r.expires_in) || 86400);
      await saveConnection(pool, office, p.env, {
        user_refresh_enc: sealOrThrow(r.refresh_token),
        user_access_enc: sealOrThrow(r.access_token),
        user_access_until: mysqlTime(Date.now() + life * 800),
        user_name: name ? String(name).slice(0, 255) : null,
        connected_by: p.by || null,
        connected_at: mysqlTime(Date.now()),
      });
      const stores = await teya.listStores(p.env, r.access_token);
      res.json({ done: true, environment: p.env, stores: stores.map((s) => ({ id: s.id, name: s.name || s.id, address: s.address || null })) });
    } catch (e) {
      if (e instanceof teya.TeyaError && (e.code === 'EXPIRED' || e.code === 'DENIED')) {
        pending.delete(req.body && req.body.id);
        return res.status(410).json({ error: e.message, code: e.code });
      }
      sendError(res, e, next);
    }
  });

  router.get('/teya/stores', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const env = teya.cleanEnv(req.query.environment || (await settingsFor(pool, office)).environment);
      const stores = await teya.listStores(env, await userToken(pool, office, env));
      res.json(stores.map((s) => ({ id: s.id, name: s.name || s.id, address: s.address || null })));
    } catch (e) { sendError(res, e, next); }
  });

  /** Register Vesopa as this venue's ePOS for one Teya store. */
  router.post('/teya/store', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const env = teya.cleanEnv(b.environment || (await settingsFor(pool, office)).environment);
      const storeId = String(b.store_id || '').trim();
      if (!/^[A-Za-z0-9-]{8,64}$/.test(storeId)) return res.status(400).json({ error: 'Choose a Teya store.' });
      const ut = await userToken(pool, office, env);
      const stores = await teya.listStores(env, ut);
      const store = stores.find((s) => s.id === storeId);
      if (!store) return res.status(404).json({ error: 'That store is not on this Teya account.' });
      // Idempotent at Teya on (partner, store, this id): connecting again
      // gives the same credentials back.
      const reg = await teya.registerEpos(env, ut, storeId, `vesopa-${crypto.createHash('sha1').update(office).digest('hex').slice(0, 16)}`);
      if (!reg.client_id || !reg.client_secret) throw new teya.TeyaError(502, 'NO_CREDENTIALS', 'Teya did not return credentials for this store. Try again.');
      const prev = await connectionFor(pool, office, env);
      if (prev && prev.m2m_client_id) teya.forgetToken(env, prev.m2m_client_id);
      await saveConnection(pool, office, env, {
        store_id: storeId,
        store_name: String(store.name || storeId).slice(0, 255),
        m2m_client_id: reg.client_id,
        m2m_secret_enc: sealOrThrow(reg.client_secret),
        default_terminal_id: prev && prev.store_id === storeId ? prev.default_terminal_id : null,
      });
      tellTills(office);
      // The store is connected whatever the machine list says.
      let terminals = [];
      let note = '';
      try {
        terminals = (await storeTerminals(pool, office, env)).map(terminalView);
        if (!terminals.length) note = ' Teya has no card machine in this store yet: add one in Teya Business (Devices), then reload this page.';
      } catch (e) {
        note = ` ${e.message}`;
      }
      res.json({ ok: true, store: { id: storeId, name: store.name }, terminals, message: `Connected to ${store.name || 'the store'} on ${env === 'live' ? 'Teya Live' : 'the Teya sandbox'}.${note}` });
    } catch (e) { sendError(res, e, next); }
  });

  router.get('/teya/terminals', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const env = teya.cleanEnv(req.query.environment || (await settingsFor(pool, office)).environment);
      res.json((await storeTerminals(pool, office, env)).map(terminalView));
    } catch (e) { sendError(res, e, next); }
  });

  router.put('/teya/default-terminal', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const env = teya.cleanEnv(b.environment || (await settingsFor(pool, office)).environment);
      const id = String(b.terminal_id || '').trim().slice(0, 64) || null;
      await saveConnection(pool, office, env, { default_terminal_id: id });
      tellTills(office);
      res.json({ ok: true, default_terminal_id: id });
    } catch (e) { sendError(res, e, next); }
  });

  /** Forget a connection: the card machines' or online payments'. */
  router.post('/teya/disconnect', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const env = teya.cleanEnv(b.environment || (await settingsFor(pool, office)).environment);
      const part = b.part === 'online' ? 'online' : 'card';
      const conn = await connectionFor(pool, office, env);
      if (part === 'online') {
        if (conn && conn.online_client_id) {
          try {
            await teya.deactivateRegistration(env, await onlineToken(env, conn));
          } catch (e) {
            console.error('[teya] deactivate online registration:', e.message);
          }
          teya.forgetToken(env, conn.online_client_id);
        }
        await saveConnection(pool, office, env, {
          online_store_id: null, online_client_id: null, online_secret_enc: null, online_webhook_key: null, online_connected_at: null,
        });
        await pool.execute("UPDATE epos_teya_settings SET online_provider = 'dojo' WHERE office = ? AND environment = ?", [office, env]);
      } else {
        if (conn && conn.m2m_client_id) teya.forgetToken(env, conn.m2m_client_id);
        await saveConnection(pool, office, env, {
          user_refresh_enc: null, user_access_enc: null, user_access_until: null, user_name: null,
          store_id: null, store_name: null, m2m_client_id: null, m2m_secret_enc: null, default_terminal_id: null,
        });
        await pool.execute("UPDATE epos_teya_settings SET card_provider = 'dojo' WHERE office = ? AND environment = ?", [office, env]);
      }
      tellTills(office);
      res.json({ ...(await view(office)), message: part === 'online' ? 'Teya online payments disconnected. The menu is back on Dojo.' : 'Teya card machines disconnected. The tills are back on Dojo.' });
    } catch (e) { sendError(res, e, next); }
  });

  // ---- Back office: app credentials ------------------------------------------------

  /** Save this venue's own Teya Device Code app credentials for an environment. */
  router.put('/teya/app', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const env = teya.cleanEnv(b.environment);
      if (b.reset) {
        await pool.execute('DELETE FROM epos_teya_apps WHERE office = ? AND environment = ?', [office, env]);
        return res.json({ ...(await view(office)), message: env === 'live' ? 'Live app credentials removed.' : 'Back on Vesopa\'s built-in sandbox app.' });
      }
      const id = String(b.client_id || '').trim();
      const typed = String(b.client_secret || '').trim();
      const pluginType = String(b.plugin_type || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 40);
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(id)) return res.status(400).json({ error: 'Enter the Device Code app\'s client ID from Teya (Developer, Applications).' });
      const prev = await ownApp(pool, office, env);
      const secretV = typed || (prev && prev.deviceId === id ? prev.deviceSecret : '');
      if (!secretV) return res.status(400).json({ error: 'Enter the client secret too.' });
      if (secretV.length < 8 || secretV.length > 512) return res.status(400).json({ error: 'That does not look like a Teya client secret.' });
      // Checked with Teya before anything is saved: a sign-in code is asked
      // for (and simply left to expire).
      try {
        await teya.startDevice(env, { deviceId: id, deviceSecret: secretV, pluginType });
      } catch (e) {
        return res.status(400).json({ error: `Teya did not accept these credentials on ${env === 'live' ? 'live' : 'the sandbox'} (${e.message}) Nothing was saved.` });
      }
      await pool.execute(
        `INSERT INTO epos_teya_apps (office, environment, device_client_id, device_secret_enc, plugin_type, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE device_client_id = VALUES(device_client_id), device_secret_enc = VALUES(device_secret_enc),
           plugin_type = VALUES(plugin_type), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
        [office, env, id, sealOrThrow(secretV), pluginType || null, req.user.email || null]
      );
      res.json({ ...(await view(office)), message: `Teya accepted the ${env === 'live' ? 'live' : 'sandbox'} credentials. Saved.` });
    } catch (e) { sendError(res, e, next); }
  });

  // ---- Back office: which Teya machine each till uses -------------------------------

  /** The venue's signed-in tills, and the Teya machine each one uses. */
  router.get('/teya/tills', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const env = teya.cleanEnv(req.query.environment || (await settingsFor(pool, office)).environment);
      const [rows] = await pool.query(
        `SELECT s.device_id, MAX(s.device_name) AS device_name, MAX(s.last_seen_at) AS last_seen_at, MAX(a.terminal_id) AS terminal_id
           FROM bo_till_seats s
           LEFT JOIN epos_teya_till_terminals a ON a.office = s.office COLLATE utf8mb4_general_ci AND a.device_id = s.device_id COLLATE utf8mb4_general_ci AND a.environment = ?
          WHERE s.office = ? AND s.released_at IS NULL AND s.device_id IS NOT NULL AND COALESCE(s.kind, 'till') = 'till'
          GROUP BY s.device_id ORDER BY device_name`,
        [env, office]
      ).catch((e) => (missing(e) ? [[]] : Promise.reject(e)));
      res.json(rows.map((r) => ({ device_id: r.device_id, name: r.device_name || 'Till', last_seen_at: r.last_seen_at, terminal_id: r.terminal_id || null })));
    } catch (e) { sendError(res, e, next); }
  });

  router.put('/teya/tills/:deviceId', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const env = teya.cleanEnv(b.environment || (await settingsFor(pool, office)).environment);
      const deviceId = String(req.params.deviceId).slice(0, 64);
      const terminalId = String(b.terminal_id || '').trim().slice(0, 64);
      if (!terminalId) {
        await pool.execute('DELETE FROM epos_teya_till_terminals WHERE office = ? AND environment = ? AND device_id = ?', [office, env, deviceId]);
      } else {
        await pool.execute(
          `INSERT INTO epos_teya_till_terminals (office, environment, device_id, terminal_id, updated_by) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE terminal_id = VALUES(terminal_id), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
          [office, env, deviceId, terminalId, req.user.email || null]
        );
      }
      tellTills(office);
      res.json({ ok: true, terminal_id: terminalId || null, message: terminalId ? 'Saved. That till uses this card machine now.' : 'That till uses the venue default now.' });
    } catch (e) { sendError(res, e, next); }
  });

  // ---- Back office: online payments --------------------------------------------------

  router.post('/teya/online/connect', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const env = teya.cleanEnv((req.body && req.body.environment) || (await settingsFor(pool, office)).environment);
      const own = await ownApp(pool, office, env);
      if (!teya.available(env, own)) {
        return res.status(409).json({ error: env === 'live' ? 'Teya Live needs the live app credentials first (App credentials, below).' : 'Teya is not set up yet: add the app credentials under App credentials.' });
      }
      const state = crypto.randomBytes(24).toString('hex');
      await saveConnection(pool, office, env, { online_state: state, online_state_until: mysqlTime(Date.now() + 60 * 60 * 1000) });
      const base = publicBase(req);
      res.json({
        url: teya.registrationUrl(env, {
          registrationWebhook: `${base}/api/teya/online/registration?env=${env}`,
          paymentsWebhook: `${base}/api/teya/online/payments?env=${env}`,
          state,
          version: '1.0.0',
        }, own),
        environment: env,
      });
    } catch (e) { sendError(res, e, next); }
  });

  /** A test payment from the back office, to prove a card machine (sandbox only). */
  router.post('/teya/test-payment', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const s = await settingsFor(pool, office);
      const env = teya.cleanEnv(s.environment);
      if (env !== 'sandbox') return res.status(409).json({ error: 'Test payments are for the sandbox. On live, take a real payment from a till.' });
      const conn = await connectionFor(pool, office, env);
      const tok = await machineToken(pool, office, env, conn);
      const terminalId = String((req.body && req.body.terminal_id) || conn.default_terminal_id || '').trim();
      if (!terminalId) return res.status(400).json({ error: 'Choose a card machine.' });
      const amount = Math.max(1, Math.min(100000, Math.round(Number(req.body && req.body.amount_minor) || 100)));
      const reference = `vesopa-test-${Date.now().toString(36)}`;
      const p = await teya.createPayment(env, tok, { storeId: conn.store_id, terminalId, amountMinor: amount, reference, eposInstanceId: 'backoffice' }, reference);
      await logPayment(office, env, 'Back office', { id: p.payment_request_id, terminalId, storeId: conn.store_id, amount, tip: 0, reference, kind: 'SALE' });
      res.json({ id: p.payment_request_id, status: p.status || 'NEW' });
    } catch (e) { sendError(res, e, next); }
  });

  router.get('/teya/test-payment/:id', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      res.json(await followAndLog(office, req.params.id, 15000));
    } catch (e) { sendError(res, e, next); }
  });

  router.post('/teya/test-payment/:id/cancel', guard('commerce.edit'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const row = await paymentRow(office, req.params.id);
      if (!row) return res.status(404).json({ error: 'No such payment.' });
      await teya.cancelPayment(row.environment, await machineToken(pool, office, row.environment), row.id);
      res.json({ ok: true, message: 'Asked the card machine to cancel.' });
    } catch (e) { sendError(res, e, next); }
  });

  /** The venue's Teya card machine payments, newest first. */
  router.get('/teya/payments', guard('commerce.tender'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT id, environment, till, terminal_id, kind, amount_minor, tip_minor, reference, order_id, status,
                progress, status_reason, gateway_payment_id, card_last4, card_brand, auth_code, refunded_minor,
                created_at, updated_at
           FROM epos_teya_payments WHERE office = ? ORDER BY created_at DESC LIMIT 200`,
        [office]
      ).catch((e) => (missing(e) ? [[]] : Promise.reject(e)));
      res.json(rows);
    } catch (e) { sendError(res, e, next); }
  });

  // ---- Payment log helpers -----------------------------------------------------------

  async function logPayment(office, env, till, { id, terminalId, storeId, amount, tip, reference, orderId, kind }) {
    await pool.execute(
      `INSERT IGNORE INTO epos_teya_payments
         (id, office, environment, till, terminal_id, store_id, kind, amount_minor, tip_minor, reference, order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, office, env, till ? String(till).slice(0, 128) : null, terminalId, storeId, kind || 'SALE', amount, tip || 0,
        String(reference).slice(0, 64), orderId ? String(orderId).slice(0, 64) : null]
    );
  }

  async function paymentRow(office, id) {
    const [[row]] = await pool.query('SELECT * FROM epos_teya_payments WHERE id = ? AND office = ?', [String(id).slice(0, 64), office]);
    return row || null;
  }

  async function followAndLog(office, id, waitMs) {
    const row = await paymentRow(office, id);
    if (!row) throw new teya.TeyaError(404, 'NOT_FOUND', 'No such payment.');
    if (teya.FINAL.has(row.status) && row.status !== 'NEW') {
      return {
        id: row.id, status: row.status, progress: row.progress, reason: row.status_reason, final: true,
        outcome: row.status === 'SUCCESSFUL' ? 'approved' : row.status === 'CANCELLED' ? 'cancelled' : /DECLINED/.test(row.status_reason || '') ? 'declined' : 'failed',
        message: messageFor(row.status, row.progress, row.status_reason),
        gateway_payment_id: row.gateway_payment_id, card_last4: row.card_last4, card_brand: row.card_brand,
        auth_code: row.auth_code, amount_minor: row.amount_minor, tip_minor: row.tip_minor,
      };
    }
    const tok = await machineToken(pool, office, row.environment);
    const p = await teya.followPayment(row.environment, tok, row.id, waitMs);
    const v = paymentView(p);
    await pool.execute(
      `UPDATE epos_teya_payments SET status = ?, progress = ?, status_reason = ?, gateway_payment_id = COALESCE(?, gateway_payment_id),
              card_last4 = COALESCE(?, card_last4), card_brand = COALESCE(?, card_brand), auth_code = COALESCE(?, auth_code),
              tip_minor = COALESCE(?, tip_minor)
        WHERE id = ?`,
      [v.status, v.progress ? String(v.progress).slice(0, 48) : null, v.reason ? String(v.reason).slice(0, 48) : null,
        v.gateway_payment_id, v.card_last4 ? String(v.card_last4).slice(-4) : null, v.card_brand ? String(v.card_brand).slice(0, 32) : null,
        v.auth_code ? String(v.auth_code).slice(0, 32) : null, Number.isFinite(v.tip_minor) ? v.tip_minor : null, row.id]
    );
    if (v.final) broadcast({ type: 'teya-payment', id: row.id, status: v.status }, { office });
    return v;
  }

  // ---- Teya's callbacks (public) -----------------------------------------------------------

  /** Teya posts a store's online-payment credentials here after the manager connects. */
  router.post('/teya/online/registration', async (req, res) => {
    const env = teya.cleanEnv(req.query.env);
    try {
      const pem = await teya.registrationKey(env);
      if (!teya.verifySignature(req.rawBody, req.get('x-teya-signature'), pem)) {
        console.warn('[teya] registration webhook with a bad signature refused');
        return res.status(401).json({ error: 'Bad signature.' });
      }
      const b = req.body || {};
      if (!b.state || !b.client_id || !b.client_secret) return res.status(400).json({ error: 'Incomplete registration.' });
      const [[conn]] = await pool.query(
        'SELECT * FROM epos_teya_connections WHERE online_state = ? AND environment = ? AND online_state_until > UTC_TIMESTAMP()',
        [String(b.state).slice(0, 64), env]
      );
      if (!conn) {
        console.warn('[teya] registration webhook with an unknown or expired state');
        return res.status(404).json({ error: 'Unknown registration.' });
      }
      // A store connecting again gets new credentials; the old ones are
      // switched off so only one set can take payments.
      if (conn.online_client_id && conn.online_client_id !== b.client_id) {
        try {
          await teya.deactivateRegistration(env, await onlineToken(env, conn));
        } catch (e) {
          console.error('[teya] could not deactivate the previous online registration:', e.message);
        }
        teya.forgetToken(env, conn.online_client_id);
      }
      await saveConnection(pool, conn.office, env, {
        online_store_id: b.store_id ? String(b.store_id).slice(0, 64) : null,
        online_client_id: String(b.client_id).slice(0, 128),
        online_secret_enc: sealOrThrow(b.client_secret),
        online_webhook_key: b.payment_webhook_public_key ? String(b.payment_webhook_public_key) : null,
        online_connected_at: mysqlTime(Date.now()),
        online_state: null,
        online_state_until: null,
      });
      broadcast({ type: 'teya-settings' }, { office: conn.office });
      console.log(`[teya] online payments connected for a venue on ${env}`);
      res.json({ ok: true });
    } catch (e) {
      console.error('[teya] registration webhook failed:', e.message);
      // A 5xx makes Teya retry.
      res.status(500).json({ error: 'Could not store the registration.' });
    }
  });

  /** Teya's payment.succeeded.v1 for a menu order. */
  router.post('/teya/online/payments', async (req, res) => {
    const env = teya.cleanEnv(req.query.env);
    try {
      const b = req.body || {};
      const data = b.data || {};
      if (!data.session_id) return res.json({ ok: true, ignored: true });
      const [[order]] = await pool.query(
        "SELECT o.id, ofc.contact_email AS office FROM dinein_orders o JOIN offices ofc ON ofc.id = o.office_id" +
          " WHERE o.dojo_intent_id = ? AND o.pay_provider = 'teya' LIMIT 1",
        [String(data.session_id).slice(0, 64)]
      ).catch((e) => (missing(e) ? [[null]] : Promise.reject(e)));
      if (!order) return res.json({ ok: true, ignored: true });
      const pem = await onlineWebhookKey(pool, order.office, env);
      if (!pem || !teya.verifySignature(req.rawBody, req.get('x-teya-signature'), pem)) {
        console.warn('[teya] payment webhook with a bad signature refused');
        return res.status(401).json({ error: 'Bad signature.' });
      }
      // The order is settled by reading the session from Teya, never from
      // the webhook's word alone.
      if (onOnlinePayment) await onOnlinePayment(order.id, data);
      res.json({ ok: true });
    } catch (e) {
      console.error('[teya] payment webhook failed:', e.message);
      res.status(500).json({ error: 'Could not process the payment.' });
    }
  });

  /** The web app's OAuth addresses on partner.teya.xyz. Sign-in is by QR code, so these only say so. */
  router.get('/teya/oauth/callback', (_req, res) => {
    res.type('html').send(brandedPage('Teya connected', 'You can close this window and carry on in the Vesopa back office.'));
  });
  router.all('/teya/oauth/logout', (_req, res) => res.status(200).json({ ok: true }));

  // ---- Till ------------------------------------------------------------------------------

  async function tillContext(req) {
    const s = await settingsFor(pool, req.office);
    const env = teya.cleanEnv(s.environment);
    if (!Number(s.enabled) || s.card_provider !== 'teya') {
      throw new teya.TeyaError(409, 'TEYA_OFF', 'This venue takes cards with Dojo. Teya is not switched on in the back office.');
    }
    const conn = await connectionFor(pool, req.office, env);
    if (!conn || !conn.m2m_client_id) throw new teya.TeyaError(409, 'NO_STORE', 'Teya is switched on but no Teya store is connected. Connect one in the back office, Card Payments.');
    return { env, conn };
  }

  const tillName = (req) => String((req.body && req.body.till_name) || (req.terminal && req.terminal.jti) || '').slice(0, 128) || null;

  /** Whether this till pays with Teya, and its card machines. */
  router.get('/till/teya/config', requireTerminal(secret), async (req, res, next) => {
    try {
      const s = await settingsFor(pool, req.office);
      const env = teya.cleanEnv(s.environment);
      const conn = await connectionFor(pool, req.office, env);
      const on = !!Number(s.enabled) && s.card_provider === 'teya' && !!(conn && conn.m2m_client_id);
      // The machine the back office gave this till wins; the venue default
      // otherwise. Sent as default_terminal_id too, which is what tills before
      // 1.16.20 read.
      const assigned = on ? await assignedTerminal(pool, req.office, env, req.terminal) : null;
      const out = {
        enabled: on,
        environment: env,
        store_id: on ? conn.store_id : null,
        store_name: on ? conn.store_name : null,
        assigned_terminal_id: assigned,
        default_terminal_id: on ? (assigned || conn.default_terminal_id) : null,
        terminals: [],
        terminals_error: null,
        // Teya's Windows SDK app (2026-10-19): Teya require it wherever an SDK
        // exists. The till downloads it from Teya, checks Teya's signature,
        // and signs the merchant in on the till.
        sdk: null,
      };
      if (Number(s.enabled) && s.card_provider === 'teya') {
        const p = teya.partner(env, await ownApp(pool, req.office, env));
        if (p.deviceId && p.deviceSecret) {
          out.sdk = {
            client_id: p.deviceId,
            client_secret: p.deviceSecret,
            production: env === 'live',
            windows: { version: SDK_WINDOWS.version, url: SDK_WINDOWS.url, thumbprint: SDK_WINDOWS.thumbprint },
          };
        }
      }
      if (on) {
        try {
          out.terminals = (await storeTerminals(pool, req.office, env, conn)).map(terminalView);
        } catch (e) {
          out.terminals_error = e.message;
        }
      }
      res.json(out);
    } catch (e) { sendError(res, e, next); }
  });

  router.post('/till/teya/payments', requireTerminal(secret), async (req, res, next) => {
    try {
      const { env, conn } = await tillContext(req);
      const b = req.body || {};
      const assigned = await assignedTerminal(pool, req.office, env, req.terminal);
      const terminalId = String(assigned || b.terminal_id || conn.default_terminal_id || '').trim().slice(0, 64);
      if (!terminalId) return res.status(400).json({ error: 'This till has no Teya card machine. Choose one in the back office, Card Payments, Teya.' });
      const amount = Math.round(Number(b.amount_minor));
      if (!(amount > 0) || amount > 10000000) return res.status(400).json({ error: 'That amount cannot be sent to the card machine.' });
      const tip = Math.max(0, Math.round(Number(b.tip_minor) || 0));
      const kind = b.type === 'REFUND' ? 'REFUND' : 'SALE';
      const reference = String(b.reference || `vesopa-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
      const idem = String(b.idempotency_key || reference).slice(0, 64);
      const p = await teya.createPayment(env, await machineToken(pool, req.office, env, conn), {
        storeId: conn.store_id, terminalId, amountMinor: amount, tipMinor: tip, reference, eposInstanceId: tillName(req), type: kind,
      }, idem);
      await logPayment(req.office, env, tillName(req), { id: p.payment_request_id, terminalId, storeId: conn.store_id, amount, tip, reference, orderId: b.order_id, kind });
      res.status(201).json({ id: p.payment_request_id, status: p.status || 'NEW', environment: env, message: messageFor(p.status || 'NEW') });
    } catch (e) { sendError(res, e, next); }
  });

  /** Where a payment is, waiting up to `wait` seconds (max 25) for a change. */
  router.get('/till/teya/payments/:id', requireTerminal(secret), async (req, res, next) => {
    try {
      const wait = Math.max(1, Math.min(25, Number(req.query.wait) || 20)) * 1000;
      res.json(await followAndLog(req.office, req.params.id, wait));
    } catch (e) { sendError(res, e, next); }
  });

  router.post('/till/teya/payments/:id/cancel', requireTerminal(secret), async (req, res, next) => {
    try {
      const row = await paymentRow(req.office, req.params.id);
      if (!row) return res.status(404).json({ error: 'No such payment.' });
      if (teya.FINAL.has(row.status)) return res.json({ ok: true, status: row.status });
      try {
        await teya.cancelPayment(row.environment, await machineToken(pool, req.office, row.environment), row.id);
      } catch (e) {
        // Too late to cancel (the card is being read): keep following.
        if (!(e instanceof teya.TeyaError) || e.status >= 500 || e.status === 0) throw e;
        return res.json({ ok: false, message: 'The card machine could not cancel now; the payment may still finish. Keep waiting for its answer.' });
      }
      res.json({ ok: true, message: 'Cancelling on the card machine…' });
    } catch (e) { sendError(res, e, next); }
  });

  /** Refund a Teya card payment, back to the same card, by its gateway payment id. */
  router.post('/till/teya/refunds', requireTerminal(secret), async (req, res, next) => {
    try {
      const { env, conn } = await tillContext(req);
      const b = req.body || {};
      const gw = String(b.gateway_payment_id || '').trim().slice(0, 64);
      const amount = Math.round(Number(b.amount_minor));
      if (!gw) return res.status(400).json({ error: 'This sale has no Teya payment to refund.' });
      if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount to refund.' });
      // The till may know the sale by Teya's payment request id (a result it
      // confirmed by checking) or by its gateway payment id.
      const [[orig]] = await pool.query(
        'SELECT * FROM epos_teya_payments WHERE office = ? AND (gateway_payment_id = ? OR id = ?) ORDER BY gateway_payment_id = ? DESC LIMIT 1',
        [req.office, gw, gw, gw]
      );
      if (orig && orig.status !== 'SUCCESSFUL') return res.status(409).json({ error: 'That card payment did not go through, so there is nothing to refund.' });
      if (orig && amount > orig.amount_minor + orig.tip_minor - orig.refunded_minor) {
        return res.status(400).json({ error: `Only £${((orig.amount_minor + orig.tip_minor - orig.refunded_minor) / 100).toFixed(2)} of this payment is left to refund.` });
      }
      const gatewayId = (orig && orig.gateway_payment_id) || gw;
      const env_ = orig ? orig.environment : env;
      const idem = String(b.idempotency_key || `refund-${gatewayId}-${amount}-${orig ? orig.refunded_minor : 0}`).slice(0, 64);
      const r = await teya.refundCardPayment(env_, await machineToken(pool, req.office, env_), {
        gatewayPaymentId: gatewayId,
        amountMinor: amount,
        terminalId: String(b.terminal_id || (orig && orig.terminal_id) || conn.default_terminal_id || '').slice(0, 64) || undefined,
        reference: b.reference,
      }, idem);
      const status = String((r && r.status) || 'PENDING').toUpperCase();
      if (status === 'SUCCESS' && orig) {
        await pool.execute('UPDATE epos_teya_payments SET refunded_minor = refunded_minor + ? WHERE id = ?', [amount, orig.id]);
      }
      res.json({
        ok: status !== 'FAILURE',
        status,
        refund_id: (r && r.transaction_id) || null,
        auth_code: (r && r.issuer_result && r.issuer_result.approval_code) || null,
        message: status === 'SUCCESS' ? 'Refunded to the card.' : status === 'FAILURE' ? `Teya refused the refund${r.status_reason ? ` (${String(r.status_reason).toLowerCase().replace(/_/g, ' ')})` : ''}.` : 'Teya is processing the refund.',
      });
    } catch (e) { sendError(res, e, next); }
  });

  return router;
}

function brandedPage(title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Vesopa</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#f3f4f6;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.card{max-width:420px;margin:16px;padding:32px;border-radius:20px;background:#171a21;border:1px solid #262b36;text-align:center}
.mark{width:56px;height:56px;margin:0 auto 16px;border-radius:16px;background:linear-gradient(135deg,#6d5efc,#22c3a6);display:grid;place-items:center;font-weight:800;font-size:26px;color:#fff}
h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#aab0bd}</style></head>
<body><div class="card"><div class="mark">V</div><h1>${esc(title)}</h1><p>${esc(text)}</p></div></body></html>`;
}

module.exports = {
  teyaRoutes,
  settingsFor,
  connectionFor,
  onlineFor,
  onlineForEnv,
  paymentView,
  messageFor,
};
