/**
 * Vesopa Express -- the self-service kiosk, server half.
 *
 * A customer builds a basket on a portrait touchscreen, pays on the Dojo card
 * machine beside it, and walks away with a collection number. Everything that
 * decides money happens here; the kiosk draws screens and asks questions.
 *
 * FOUR AUDIENCES, FOUR DOORS
 *
 *   /api/express/*          the back office, on a session token: the switch,
 *                           the kiosks, the orders.
 *   /api/express/commission a manager setting a kiosk up with Continue with
 *                           Vesopa -- an ID token in, a kiosk token out.
 *   /api/express/kiosk/*    the kiosk itself, on its own `express` token. Reads
 *                           its menu, places and pays for orders. Nothing else
 *                           exists to it: requireAuth refuses any scoped token,
 *                           requireTerminal refuses anything but a till's, so a
 *                           token lifted off a kiosk opens one venue's menu and
 *                           nothing at all of its back office.
 *   /express/board/:token   the collection board, a web page for any TV,
 *                           behind a secret address and showing numbers only.
 *
 * NOTHING IS A SALE UNTIL THE MONEY IS IN
 *
 * An order is created `awaiting_payment` with a number on it. Only when Dojo
 * says the payment is Captured -- seen by the kiosk's poll, by the Dojo
 * webhook, or by the sweep that looks after kiosks that went away mid-payment
 * -- does finalise() write the sale, raise the kitchen ticket and tell the
 * venue, in one transaction guarded by the order's own status. Whichever of the
 * three gets there first does it; the other two find the order already paid
 * and do nothing. That is what makes a duplicate webhook, a racing poll and a
 * kiosk unplugged at the wrong moment all end in exactly one sale.
 *
 * THE KEY STAYS HERE
 *
 * The kiosk never holds a Dojo key. It is a public client on a screen in a room
 * full of strangers; the server creates the intent, starts the card machine,
 * and answers the kiosk's "how is it going?".
 *
 * OFF UNTIL A VENUE TURNS IT ON. See schema_till_express.sql.
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { requireAuth, requireTerminal } = require('./auth');
const core = require('./menu_core');
const { recordSale } = require('./sales');
const { recordTicket, readModes, parseStations, stationNames } = require('./kitchen');
const terminalVesopa = require('./terminal_vesopa');
const { linkAndFind } = require('./backoffice_auth');
const dojo = require('./dojo_client');
const { boardPage } = require('./express_board');

/** What a venue that has never opened the page has. */
const DEFAULTS = Object.freeze({
  enabled: 0,
  eat_in: 1,
  take_away: 1,
  pay_card: 1,
  pay_counter: 0,
  demo_mode: 0,
  ask_name: 0,
  idle_seconds: 60,
  number_start: 1,
  number_end: 999,
  welcome_title: null,
  welcome_subtitle: null,
  welcome_image_url: null,
  upsell_items: null,
  notify_till: 1,
  notify_kitchen: 1,
  board_enabled: 1,
  receipt_mode: 'ask',
});

/** Whether the kiosk prints a ticket: see schema_till_express.sql. */
const RECEIPT_MODES = ['always', 'ask', 'never'];

/**
 * The languages a kiosk offers, first one the default.
 *
 * English only for now. The Welsh is written (l10n/strings.dart in the kiosk)
 * but was drafted by the developer, and a venue in Wales showing the public a
 * translation nobody Welsh has read is worse than showing none -- so it is
 * hidden until a Welsh speaker has checked it. Bringing it back is adding 'cy'
 * here: the kiosk draws the language button only when there is more than one,
 * so no kiosk release is needed.
 */
const LANGUAGES = ['en'];

/**
 * Kitchen printing: how long a claimed print may go unanswered before another
 * till may take it, how many tries a station gets, and how late is too late.
 */
const PRINT_CLAIM_MINUTES = 2;
const PRINT_ATTEMPTS = 5;
const PRINT_EXPIRE_MINUTES = 30;

const FLAGS = [
  'enabled', 'eat_in', 'take_away', 'pay_card', 'pay_counter', 'demo_mode',
  'ask_name', 'notify_till', 'notify_kitchen', 'board_enabled',
];

/**
 * Bounds on the numbers a manager can type, clamped here as well as in the
 * form because the form is not the only way a row gets written. An idle
 * timeout of three seconds clears a basket while somebody is reading the menu.
 */
const BOUNDS = {
  idle_seconds: [20, 600],
  number_start: [1, 9000],
  number_end: [1, 9999],
};

const TEXT = {
  welcome_title: 120,
  welcome_subtitle: 200,
  welcome_image_url: 500,
};

/** The exit passcode's hash. PBKDF2 so the kiosk can check it offline too. */
const PBKDF2_ITERATIONS = 120000;

/** A kiosk is commissioned once and then runs for months, like a till. */
const KIOSK_TOKEN_TTL = '3650d';

/**
 * How long a Dojo session read is reused, so a kiosk polling fast does not
 * turn every poll into a call to Dojo. Settable only so the tests can drive a
 * payment through its states without sleeping between them.
 */
const SESSION_CACHE_MS = Number(process.env.EXPRESS_SESSION_CACHE_MS ?? 1500);

/** How often the unwatched-payment sweep may run per venue (see sweep). */
const SWEEP_EVERY_MS = Number(process.env.EXPRESS_SWEEP_MS ?? 30000);

/** How long a Ready number stays on the board before it is assumed collected. */
const READY_ON_BOARD_MINUTES = 15;

/** An unpaid order older than this is somebody who walked away. */
const ABANDON_MINUTES = 30;

const ORDER_TYPES = { eat_in: 'Eat in', take_away: 'Take away' };

// ---------------------------------------------------------------------------
// Small pure helpers, exported for the tests
// ---------------------------------------------------------------------------

/** The venue's day, in the UK -- the server clock may be UTC. */
function businessDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function clamp(value, [lo, hi], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), lo), hi);
}

function hashPasscode(passcode, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto
    .pbkdf2Sync(String(passcode), salt, PBKDF2_ITERATIONS, 32, 'sha256')
    .toString('hex');
  return { salt, hash };
}

function passcodeMatches(passcode, salt, hash) {
  if (!salt || !hash) return false;
  const given = hashPasscode(passcode, salt).hash;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(String(hash)));
}

/** The key that seals a venue's Dojo key at rest, or null if none is set. */
function sealingKey() {
  const raw = process.env.EXPRESS_SECRET_KEY || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

function seal(plain) {
  const key = sealingKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function unseal(sealed) {
  const key = sealingKey();
  if (!key || !sealed || !String(sealed).startsWith('v1:')) return null;
  try {
    const raw = Buffer.from(String(sealed).slice(3), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The platform's own key: the sandbox key while this is in testing. */
function platformKey() {
  return process.env.EXPRESS_DOJO_API_KEY || process.env.DOJO_API_KEY || '';
}

/** The key a venue's kiosks pay with, and where it came from. */
function venueKey(settings) {
  const own = settings && settings.dojo_key_enc ? unseal(settings.dojo_key_enc) : null;
  if (own) return { key: own, source: 'venue' };
  const platform = platformKey();
  return { key: platform, source: platform ? 'platform' : 'none' };
}

/** Upsell ids as a clean list of positive integers, at most twelve. */
function cleanIdList(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(
    list.map((v) => Number(String(v).trim())).filter((n) => Number.isInteger(n) && n > 0)
  )].slice(0, 12);
}

/**
 * What the kiosk should show for a payment, from the order row.
 *
 *   paid, cancelled, counter, demo -- the order's own outcome
 *   present_card    the machine is waiting for a card
 *   processing      a card is on it: PIN, "please wait", remove card
 *   declined        a verdict; the same intent can be tried again
 *   uncertain       the machine stopped answering; the intent is being asked
 *   unavailable     the card machine could not be reached or refused to start
 *   starting        nothing has come back yet
 */
function paymentStage(order) {
  if (['paid', 'ready', 'collected'].includes(order.status)) return 'paid';
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'counter') return 'counter';
  if (order.status === 'demo') return 'demo';
  if (order.status === 'failed') return 'declined';

  const status = String(order.dojo_status || '').toLowerCase();
  if (status === 'unavailable') return 'unavailable';
  if (status === 'declined' || status === 'canceled' || status === 'cancelled') return 'declined';
  if (status === 'expired') return 'uncertain';
  if (!order.dojo_session_id) return 'starting';

  const prompt = String(order.dojo_prompt || '');
  if (prompt === 'EnterPin' || prompt === 'PleaseWait' || prompt === 'RemoveCard') {
    return 'processing';
  }
  if (status === 'signatureverificationrequired' || status === 'authorized') return 'processing';
  return 'present_card';
}

function describe(order) {
  let lines = [];
  try { lines = JSON.parse(order.lines_json || '[]'); } catch { lines = []; }
  return {
    public_id: order.public_id,
    number: order.number,
    status: order.status,
    order_type: order.order_type,
    payment: order.payment,
    customer_name: order.customer_name || null,
    subtotal_minor: order.subtotal_minor,
    discount_minor: order.discount_minor,
    tax_minor: order.tax_minor,
    total_minor: order.total_minor,
    lines,
    stage: paymentStage(order),
    message: order.status_note || null,
  };
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function expressKioskRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query(
        'SELECT contact_email FROM offices WHERE id = ?',
        [req.user.officeId]
      );
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  async function readSettings(office) {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_express_settings WHERE office = ?',
      [office]
    );
    return row || { office, ...DEFAULTS };
  }

  function boardUrl(req, settings) {
    if (!settings.board_token) return null;
    const base = (process.env.BACKOFFICE_URL || (req.protocol + '://' + req.get('host')))
      .replace(/\/+$/, '');
    return base + '/express/board/' + settings.board_token;
  }

  /** The settings as the back office may see them: no hashes, no keys. */
  function forBackOffice(req, settings) {
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (settings[k] !== undefined && settings[k] !== null) out[k] = settings[k];
      if (TEXT[k]) out[k] = settings[k] || null;
    }
    out.upsell_items = cleanIdList(settings.upsell_items);
    const { key, source } = venueKey(settings);
    return {
      ...out,
      passcode_set: !!settings.exit_hash,
      dojo_key_source: source,
      dojo_key_hint: source === 'venue' ? settings.dojo_key_hint || null : null,
      dojo_sandbox: dojo.isSandboxKey(key),
      can_store_key: !!sealingKey(),
      board_url: out.board_enabled ? boardUrl(req, settings) : null,
      vesopa_sign_in: terminalVesopa.ENABLED,
    };
  }

  function expressOff(res) {
    return res.status(403).json({
      error: 'Vesopa Express is switched off for this venue. A manager can turn it on in the back office.',
      code: 'express_off',
    });
  }

  // -------------------------------------------------------------------------
  // Back office: the switch
  // -------------------------------------------------------------------------

  router.get('/api/express/settings', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      res.json(forBackOffice(req, await readSettings(office)));
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/express/settings', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const current = await readSettings(office);
      const body = req.body || {};
      const patch = {};

      for (const f of FLAGS) {
        if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f] ? 1 : 0;
      }
      for (const [f, bounds] of Object.entries(BOUNDS)) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          patch[f] = clamp(body[f], bounds, DEFAULTS[f]);
        }
      }
      for (const [f, max] of Object.entries(TEXT)) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          const text = String(body[f] ?? '').trim().slice(0, max);
          patch[f] = text || null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'upsell_items')) {
        const ids = cleanIdList(body.upsell_items);
        patch.upsell_items = ids.length ? ids.join(',') : null;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'receipt_mode')) {
        const mode = String(body.receipt_mode || '').trim().toLowerCase();
        if (!RECEIPT_MODES.includes(mode)) {
          return res.status(400).json({ error: 'Receipts are printed always, when asked, or never.' });
        }
        patch.receipt_mode = mode;
      }

      // What the row would be, so the rules below judge the whole of it and
      // not only what this request happened to send.
      const merged = { ...DEFAULTS, ...current, ...patch };
      if (!Number(merged.eat_in) && !Number(merged.take_away)) {
        return res.status(400).json({
          error: 'Choose at least one of Eat in and Take away, or the kiosk has no way to start an order.',
        });
      }
      if (!Number(merged.pay_card) && !Number(merged.pay_counter) && !Number(merged.demo_mode)) {
        return res.status(400).json({
          error: 'Choose at least one way to pay: by card at the kiosk, or at the counter.',
        });
      }
      if (Number(merged.number_end) <= Number(merged.number_start)) {
        return res.status(400).json({
          error: 'The last collection number has to be higher than the first.',
        });
      }

      // The exit passcode. Digits, four to eight, because it is typed on a
      // number pad by somebody leaning over a kiosk in a busy room.
      if (body.clear_passcode) {
        patch.exit_salt = null;
        patch.exit_hash = null;
      } else if (body.passcode !== undefined && body.passcode !== null && body.passcode !== '') {
        const passcode = String(body.passcode).trim();
        if (!/^[0-9]{4,8}$/.test(passcode)) {
          return res.status(400).json({ error: 'The passcode has to be 4 to 8 digits.' });
        }
        const { salt, hash } = hashPasscode(passcode);
        patch.exit_salt = salt;
        patch.exit_hash = hash;
      }

      // The venue's own Dojo key. Sealed before it touches the database, and
      // only the last four characters ever come back.
      if (body.clear_dojo_key) {
        patch.dojo_key_enc = null;
        patch.dojo_key_hint = null;
      } else if (typeof body.dojo_key === 'string' && body.dojo_key.trim()) {
        const key = body.dojo_key.trim();
        if (!/^sk_(sandbox|live)_[A-Za-z0-9_-]{16,}$/.test(key)) {
          return res.status(400).json({
            error: 'That does not look like a Dojo secret key. It starts sk_live_ (or sk_sandbox_ for testing).',
          });
        }
        const sealed = seal(key);
        if (!sealed) {
          return res.status(503).json({
            error: 'This server cannot store a card key yet: EXPRESS_SECRET_KEY is not set.',
          });
        }
        patch.dojo_key_enc = sealed;
        patch.dojo_key_hint = key.slice(-4);
      }

      // The board's secret address. Made the first time it is needed, and made
      // again on request -- the old address stops working that moment.
      if (body.rotate_board || (Number(merged.board_enabled) && !current.board_token)) {
        patch.board_token = crypto.randomBytes(16).toString('hex');
      }

      const cols = Object.keys(patch);
      if (cols.length) {
        await pool.execute(
          'INSERT INTO epos_express_settings (office, ' + cols.join(', ') + ')' +
            ' VALUES (?' + ', ?'.repeat(cols.length) + ')' +
            ' ON DUPLICATE KEY UPDATE ' + cols.map((c) => c + ' = VALUES(' + c + ')').join(', '),
          [office, ...cols.map((c) => patch[c])]
        );
      }

      // The kiosks re-read their config on this, so switching the venue off
      // reaches a kiosk mid-afternoon without anybody touching it.
      broadcast({ type: 'express.settings' }, { office });
      res.json(forBackOffice(req, await readSettings(office)));
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Back office: the kiosks
  // -------------------------------------------------------------------------

  router.get('/api/express/kiosks', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        'SELECT id, name, dojo_terminal_id, commissioned_by, commissioned_at,' +
          '       last_seen_at, app_version, screen, revoked_at' +
          '  FROM epos_express_kiosks WHERE office = ?' +
          ' ORDER BY (revoked_at IS NULL) DESC, commissioned_at',
        [office]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/express/kiosks/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const body = req.body || {};
      const sets = [];
      const params = [];
      if (body.name !== undefined) {
        const name = String(body.name || '').trim().slice(0, 80);
        if (!name) return res.status(400).json({ error: 'A kiosk needs a name.' });
        sets.push('name = ?');
        params.push(name);
      }
      if (body.dojo_terminal_id !== undefined) {
        const tid = String(body.dojo_terminal_id || '').trim().slice(0, 64);
        sets.push('dojo_terminal_id = ?');
        params.push(tid || null);
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
      const [r] = await pool.execute(
        'UPDATE epos_express_kiosks SET ' + sets.join(', ') +
          ' WHERE id = ? AND office = ? AND revoked_at IS NULL',
        [...params, req.params.id, office]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such kiosk.' });
      broadcast({ type: 'express.settings' }, { office });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Take a kiosk away. Its token stops working on its next request. */
  router.delete('/api/express/kiosks/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [r] = await pool.execute(
        'UPDATE epos_express_kiosks SET revoked_at = NOW()' +
          ' WHERE id = ? AND office = ? AND revoked_at IS NULL',
        [req.params.id, office]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such kiosk.' });
      broadcast({ type: 'express.settings' }, { office });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** The card machines this venue's key can reach, to pair with a kiosk. */
  router.get('/api/express/terminals', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const { key } = venueKey(await readSettings(office));
      if (!key) return res.json({ terminals: [], error: 'No Dojo key is set up yet.' });
      try {
        const list = await dojo.listTerminals(key);
        res.json({
          sandbox: dojo.isSandboxKey(key),
          // Dojo puts the number printed on the device under `properties.tid`
          // -- it is how staff tell two readers apart; the opaque tm_ id means
          // nothing on the counter.
          terminals: (Array.isArray(list) ? list : []).map((t) => ({
            id: t.id || t.terminalId,
            tid: (t.properties && t.properties.tid) || t.tid || null,
            status: t.status || null,
          })),
        });
      } catch (err) {
        res.json({ terminals: [], error: 'Dojo would not list the card machines: ' + err.message });
      }
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Back office: the orders
  // -------------------------------------------------------------------------

  router.get('/api/express/orders', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
        ? String(req.query.date)
        : businessDate();
      await sweep(office).catch(() => {});
      await expirePrints(office).catch(() => {});
      const [rows] = await pool.query(
        'SELECT o.id, o.public_id, o.number, o.status, o.status_note, o.order_type,' +
          '       o.payment, o.customer_name, o.total_minor, o.sale_id, o.ticket_id,' +
          '       o.created_at, o.paid_at, o.ready_at, o.collected_at, o.lines_json,' +
          '       k.name AS kiosk_name' +
          '  FROM epos_express_orders o' +
          '  LEFT JOIN epos_express_kiosks k ON k.id = o.kiosk_id' +
          ' WHERE o.office = ? AND o.business_date = ?' +
          ' ORDER BY o.id DESC LIMIT 500',
        [office, day]
      );

      // Where each order's kitchen paper got to, by station, in the venue's
      // own station names -- "Grill: not printed" is a sentence somebody can
      // act on; a blank is not.
      const prints = new Map();
      if (rows.length) {
        const [jobs] = await pool.query(
          'SELECT order_id, station, status, claimed_by, error FROM epos_express_prints' +
            ' WHERE office = ? AND order_id IN (' + rows.map(() => '?').join(',') + ')' +
            ' ORDER BY station',
          [office, ...rows.map((r) => r.id)]
        );
        const names = jobs.length ? await stationNames(pool, office) : {};
        for (const j of jobs) {
          (prints.get(j.order_id) || prints.set(j.order_id, []).get(j.order_id)).push({
            station: j.station,
            name: names[j.station] || j.station.toUpperCase().replace('KP', 'KP '),
            status: j.status,
            by: j.claimed_by || null,
            error: j.error || null,
          });
        }
      }

      res.json({
        date: day,
        orders: rows.map((r) => {
          let lines = [];
          try { lines = JSON.parse(r.lines_json || '[]'); } catch { lines = []; }
          const { lines_json: _drop, ...rest } = r;
          return {
            ...rest,
            items: lines.filter((l) => !l.isModifier).reduce((n, l) => n + l.qty, 0),
            prints: prints.get(r.id) || [],
          };
        }),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Move a number along by hand: Ready (it goes up on the board) or Collected
   * (it comes off). For a pass with no kitchen screen to bump -- the till and
   * the back office both do it, through this one rule. Answers the status the
   * order now has, or null when it had already moved on.
   */
  async function moveOrder(office, id, action) {
    const from = { ready: ['paid'], collected: ['paid', 'ready'] }[action];
    if (!from) return undefined;
    const stamp = action === 'ready' ? 'ready_at' : 'collected_at';
    const [r] = await pool.execute(
      'UPDATE epos_express_orders SET status = ?, ' + stamp + ' = NOW()' +
        ' WHERE id = ? AND office = ? AND status IN (' + from.map(() => '?').join(',') + ')',
      [action, id, office, ...from]
    );
    if (!r.affectedRows) return null;
    broadcast({ type: 'express.changed', id: Number(id), status: action }, { office });
    return action;
  }

  /** Staff moving a number along by hand: the pass has no screen, or it was missed. */
  router.post('/api/express/orders/:id/:action', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const moved = await moveOrder(office, req.params.id, String(req.params.action));
      if (moved === undefined) return res.status(400).json({ error: 'Unknown action.' });
      if (moved === null) return res.status(409).json({ error: 'That order has already moved on.' });
      res.json({ ok: true, status: moved });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Commissioning: Continue with Vesopa, exactly as a till and a kitchen do
  // -------------------------------------------------------------------------

  router.post('/api/express/commission', async (req, res, next) => {
    try {
      if (!terminalVesopa.ENABLED) {
        return res.status(404).json({ error: 'Vesopa sign-in is not switched on here.' });
      }
      const body = req.body || {};
      let claims;
      try {
        claims = await terminalVesopa.verifyTillToken(body.id_token);
      } catch (error) {
        // Vague to the caller, specific in the log -- the same rule the till's
        // door follows. Somebody probing does not need to know which check.
        console.warn('[express] refused a token:', error.message);
        return res.status(401).json({ error: 'That sign-in could not be accepted.' });
      }
      if (!claims.email || claims.email_verified !== true) {
        return res.status(403).json({ error: 'Your Vesopa account has no confirmed email address.' });
      }

      // The same matching, linking and access rules every other door uses.
      const user = await linkAndFind(pool, claims);
      if (!user) {
        return res.status(403).json({
          error: 'There is no back-office user for that address. Ask your manager to add you.',
        });
      }
      if (user.blocked) return res.status(403).json({ error: user.blocked });
      if (!user.officeEmail) {
        return res.status(403).json({
          error: 'Your account is not attached to a venue, so it cannot set up a kiosk.',
        });
      }

      const office = user.officeEmail;
      const settings = await readSettings(office);
      if (!Number(settings.enabled)) return expressOff(res);

      const [[{ n }]] = await pool.query(
        'SELECT COUNT(*) AS n FROM epos_express_kiosks WHERE office = ?',
        [office]
      );
      const id = crypto.randomUUID();
      const name = String(body.name || '').trim().slice(0, 80) || 'Kiosk ' + (Number(n) + 1);
      await pool.execute(
        'INSERT INTO epos_express_kiosks (id, office, name, commissioned_by, app_version, screen)' +
          ' VALUES (?, ?, ?, ?, ?, ?)',
        [
          id,
          office,
          name,
          String(claims.email).toLowerCase().slice(0, 190),
          String(body.app_version || '').slice(0, 40) || null,
          String(body.screen || '').slice(0, 40) || null,
        ]
      );

      const token = jwt.sign(
        {
          scope: 'express',
          office,
          officeId: user.officeId,
          kiosk: id,
          // Who set it up. Not used for authorisation -- it is here so a
          // question about one kiosk can be traced to a person.
          commissionedBy: String(claims.email).toLowerCase(),
        },
        secret,
        { expiresIn: KIOSK_TOKEN_TTL }
      );

      broadcast({ type: 'express.settings' }, { office });
      res.json({
        token,
        kiosk: { id, name },
        venue: { name: user.officeName || null },
        passcode_set: !!settings.exit_hash,
      });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // The kiosk's own door
  // -------------------------------------------------------------------------

  const seen = new Map();

  async function kioskAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const signedOut = () =>
      res.status(401).json({
        error: 'This kiosk needs to be set up again.',
        code: 'kiosk_signed_out',
      });
    if (!token) return signedOut();

    let claims;
    try {
      claims = jwt.verify(token, secret);
    } catch {
      return signedOut();
    }
    if (claims.scope !== 'express' || !claims.office || !claims.kiosk) return signedOut();

    try {
      const [[kiosk]] = await pool.query(
        'SELECT * FROM epos_express_kiosks WHERE id = ? AND office = ?',
        [claims.kiosk, claims.office]
      );
      // Revocation is checked on every request, not left to the token's
      // expiry: a kiosk taken away in the back office stops at once.
      if (!kiosk || kiosk.revoked_at) {
        return res.status(401).json({
          error: 'This kiosk has been removed in the back office.',
          code: 'kiosk_revoked',
        });
      }
      req.kiosk = kiosk;
      req.office = claims.office;
      req.officeId = claims.officeId || null;

      // A heartbeat, at most once a minute, so the back office can say which
      // kiosks are alive without every poll being a write.
      const last = seen.get(kiosk.id) || 0;
      if (Date.now() - last > 60000) {
        seen.set(kiosk.id, Date.now());
        pool
          .execute(
            'UPDATE epos_express_kiosks SET last_seen_at = NOW(),' +
              ' app_version = COALESCE(?, app_version) WHERE id = ?',
            [String(req.get('x-express-version') || '').slice(0, 40) || null, kiosk.id]
          )
          .catch(() => {});
      }
      next();
    } catch (e) {
      next(e);
    }
  }

  async function officeIdFor(req) {
    return req.officeId || (await core.officeIdOf(pool, req.office));
  }

  /** The venue's public face, from its dine-in page, for the kiosk's header. */
  async function venueFace(officeId) {
    const [[office]] = await pool.query('SELECT name FROM offices WHERE id = ?', [officeId]);
    const [[venue]] = await pool.query(
      'SELECT display_name, logo_url, banner_url, accent_colour FROM dinein_venue WHERE office_id = ?',
      [officeId]
    );
    return {
      name: ((venue && venue.display_name) || (office && office.name) || '').trim(),
      logo_url: (venue && venue.logo_url) || null,
      banner_url: (venue && venue.banner_url) || null,
      accent: (venue && venue.accent_colour) || '#A5C715',
    };
  }

  /**
   * What the kiosk prints at the top and bottom of a ticket: the venue's own
   * receipt branding, the same fields the till prints, so a customer's paper
   * from the kiosk and from the counter say the same thing about who took
   * their money. A venue that has never opened the receipt designer gets its
   * name and nothing else.
   */
  async function receiptFace(office, settings, venueName) {
    let row = null;
    try {
      [[row]] = await pool.query(
        'SELECT venue_name, address_line1, address_line2, city, postcode, phone,' +
          '       vat_number, company_number, footer_message, footer_note' +
          '  FROM epos_branding WHERE office = ?',
        [office]
      );
    } catch (e) {
      if (!e || e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    const text = (v) => String(v || '').trim() || null;
    const place = [text(row && row.city), text(row && row.postcode)].filter(Boolean).join(' ');
    return {
      mode: RECEIPT_MODES.includes(settings.receipt_mode) ? settings.receipt_mode : DEFAULTS.receipt_mode,
      venue_name: text(row && row.venue_name) || venueName || null,
      address: [text(row && row.address_line1), text(row && row.address_line2), place || null]
        .filter(Boolean),
      phone: text(row && row.phone),
      vat_number: text(row && row.vat_number),
      company_number: text(row && row.company_number),
      footer: text(row && row.footer_message),
      footer_note: text(row && row.footer_note),
    };
  }

  router.get('/api/express/kiosk/config', kioskAuth, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const settings = await readSettings(req.office);
      const officeId = await officeIdFor(req);
      const { key } = venueKey(settings);
      const exit = settings.exit_hash
        ? {
            algorithm: 'pbkdf2-sha256',
            iterations: PBKDF2_ITERATIONS,
            salt: settings.exit_salt,
            hash: settings.exit_hash,
          }
        : null;
      const base = {
        enabled: !!Number(settings.enabled),
        kiosk: {
          id: req.kiosk.id,
          name: req.kiosk.name,
          has_card_machine: !!req.kiosk.dojo_terminal_id,
        },
        venue: await venueFace(officeId),
        exit,
        server_time: new Date().toISOString(),
      };
      // Sent whether the kiosk is on or off, and that is deliberate: `enabled:
      // false` is the answer a kiosk needs to put its menu away. A 404 here
      // would look like a server that is down.
      if (!base.enabled) return res.json(base);

      res.json({
        ...base,
        languages: LANGUAGES,
        receipt: await receiptFace(req.office, settings, base.venue.name),
        order_types: {
          eat_in: !!Number(settings.eat_in),
          take_away: !!Number(settings.take_away),
        },
        payments: {
          card: !!Number(settings.pay_card) && !!req.kiosk.dojo_terminal_id && !!key,
          counter: !!Number(settings.pay_counter),
          demo: !!Number(settings.demo_mode),
          sandbox: dojo.isSandboxKey(key),
        },
        ask_name: !!Number(settings.ask_name),
        idle_seconds: Number(settings.idle_seconds) || DEFAULTS.idle_seconds,
        welcome: {
          title: settings.welcome_title || null,
          subtitle: settings.welcome_subtitle || null,
          image_url: settings.welcome_image_url || null,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Set the exit passcode from the kiosk, the first time only.
   *
   * A kiosk has to be leavable, and the one moment somebody is certainly
   * standing at it with the authority to choose a code is when they have just
   * set it up. After that the code is changed in the back office, never here:
   * a kiosk that could change its own passcode is a kiosk anybody who learned
   * the old one could lock everybody else out of.
   */
  router.post('/api/express/kiosk/passcode', kioskAuth, async (req, res, next) => {
    try {
      const passcode = String((req.body && req.body.passcode) || '').trim();
      if (!/^[0-9]{4,8}$/.test(passcode)) {
        return res.status(400).json({ error: 'The passcode has to be 4 to 8 digits.' });
      }
      const { salt, hash } = hashPasscode(passcode);
      const [r] = await pool.execute(
        'UPDATE epos_express_settings SET exit_salt = ?, exit_hash = ?' +
          ' WHERE office = ? AND exit_hash IS NULL',
        [salt, hash, req.office]
      );
      if (!r.affectedRows) {
        return res.status(409).json({
          error: 'This venue already has a kiosk passcode. It can be changed in the back office.',
        });
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.get('/api/express/kiosk/menu', kioskAuth, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const settings = await readSettings(req.office);
      if (!Number(settings.enabled)) return expressOff(res);
      const officeId = await officeIdFor(req);
      const sections = (await core.menuSections(pool, officeId, req.office, { meals: true }))
        .filter((s) => s.items.length);

      // "May we suggest" -- the venue's own picks, or its popular dishes.
      const all = sections.flatMap((s) => s.items).filter((i) => i.available);
      const picks = cleanIdList(settings.upsell_items);
      let upsell = picks.map((id) => all.find((i) => i.id === id)).filter(Boolean);
      if (!upsell.length) upsell = all.filter((i) => i.popular).slice(0, 4);

      res.json({ sections, upsell: upsell.map((i) => i.id) });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /**
   * The next collection number for today, atomically.
   *
   * One statement, so two kiosks finishing in the same second cannot both be
   * handed 42. The insert path answers the first number of the day; the update
   * path goes round from the last number to the first.
   */
  async function allocateNumber(db, office, settings) {
    const start = clamp(settings.number_start, BOUNDS.number_start, DEFAULTS.number_start);
    const end = Math.max(start + 1, clamp(settings.number_end, BOUNDS.number_end, DEFAULTS.number_end));
    const day = businessDate();
    const [r] = await db.execute(
      'INSERT INTO epos_express_counters (office, business_date, last_number) VALUES (?, ?, ?)' +
        ' ON DUPLICATE KEY UPDATE last_number =' +
        ' LAST_INSERT_ID(IF(last_number >= ? OR last_number < ?, ?, last_number + 1))',
      [office, day, start, end, start, start]
    );
    const number = r.affectedRows === 1 ? start : Number(r.insertId) || start;
    return { number, day };
  }

  async function loadOrder(where, params) {
    const [[order]] = await pool.query(
      'SELECT * FROM epos_express_orders WHERE ' + where + ' LIMIT 1',
      params
    );
    return order || null;
  }

  async function kioskName(kioskId) {
    if (!kioskId) return 'Vesopa Express';
    const [[k]] = await pool.query('SELECT name FROM epos_express_kiosks WHERE id = ?', [kioskId]);
    return (k && k.name) || 'Vesopa Express';
  }

  /**
   * Ask the card machine to take the money.
   *
   * The intent is created ONCE per order and its id kept: Dojo ignores
   * Idempotency-Key, so creating another on a retry would be a second charge.
   * A new terminal session against the same intent is what "try again" means.
   */
  async function startPayment(order, settings, kiosk) {
    const { key } = venueKey(settings);
    const terminalId = kiosk.dojo_terminal_id;
    if (!key || !terminalId) {
      await pool.execute(
        "UPDATE epos_express_orders SET dojo_status = 'Unavailable', status_note = ? WHERE id = ?",
        ['This kiosk has no card machine set up. Please pay at the counter.', order.id]
      );
      return;
    }
    try {
      let intentId = order.dojo_intent_id;
      if (!intentId) {
        const intent = await dojo.createIntent(key, {
          amountMinor: order.total_minor,
          reference: 'Kiosk ' + order.number + ' ' + order.public_id.slice(0, 8),
          description: 'Vesopa Express order ' + order.number,
        });
        intentId = intent.id;
        const [r] = await pool.execute(
          'UPDATE epos_express_orders SET dojo_intent_id = ? WHERE id = ? AND dojo_intent_id IS NULL',
          [intentId, order.id]
        );
        if (!r.affectedRows) {
          // Another request made one first; use theirs.
          intentId = (await loadOrder('id = ?', [order.id])).dojo_intent_id;
        }
      }
      const session = await dojo.startSession(key, { terminalId, intentId });
      sessionCache.delete(order.id);
      await pool.execute(
        'UPDATE epos_express_orders SET dojo_session_id = ?, dojo_status = ?, dojo_prompt = NULL,' +
          ' dojo_terminal_id = ?, status_note = NULL WHERE id = ? AND status = ?',
        [session.id, session.status || 'InitiateRequested', terminalId, order.id, 'awaiting_payment']
      );
    } catch (err) {
      console.warn('[express] card machine would not start:', err.message);
      await pool.execute(
        "UPDATE epos_express_orders SET dojo_status = 'Unavailable', status_note = ? WHERE id = ?",
        ['The card machine is not answering. Please try again, or pay at the counter.', order.id]
      );
    }
  }

  const sessionCache = new Map();

  /**
   * Bring an unpaid order up to date with the card machine.
   *
   * Signature: accepted -- a kiosk has nobody to look at one, and the till
   * accepts by default too. Expired: the machine stopped answering, which is
   * NOT a decline -- the intent is asked, and if the money is there the order
   * is finished rather than abandoned.
   */
  async function refresh(order, settings) {
    if (order.status !== 'awaiting_payment' || !order.dojo_session_id) return order;
    const cached = sessionCache.get(order.id);
    if (cached && Date.now() - cached < SESSION_CACHE_MS) return order;
    sessionCache.set(order.id, Date.now());

    const { key } = venueKey(settings);
    let session;
    try {
      session = await dojo.getSession(key, order.dojo_session_id);
    } catch (err) {
      console.warn('[express] could not read the card machine:', err.message);
      return order;
    }
    const state = dojo.sessionState(session);
    const prompt = dojo.lastPrompt(session);

    if (state === 'paid') {
      await finalise(order.id, 'poll');
      return loadOrder('id = ?', [order.id]);
    }
    if (state === 'signature') {
      try { await dojo.answerSignature(key, order.dojo_session_id, true); } catch { /* next poll */ }
    }
    if (state === 'uncertain' && order.dojo_intent_id) {
      try {
        if (dojo.intentPaid(await dojo.getIntent(key, order.dojo_intent_id))) {
          await finalise(order.id, 'intent');
          return loadOrder('id = ?', [order.id]);
        }
      } catch { /* treated as uncertain below */ }
    }

    const note = state === 'failed'
      ? (String(session.status).toLowerCase() === 'declined'
          ? 'The card was declined.'
          : 'The payment was cancelled on the card machine.')
      : state === 'uncertain'
        ? 'The card machine stopped answering.'
        : null;

    await pool.execute(
      'UPDATE epos_express_orders SET dojo_status = ?, dojo_prompt = ?, status_note = ?' +
        " WHERE id = ? AND status = 'awaiting_payment'",
      [session.status || null, prompt, note, order.id]
    );
    return loadOrder('id = ?', [order.id]);
  }

  /**
   * The money is in: write the sale, raise the ticket, tell the venue.
   *
   * ONCE. The first statement moves the order from awaiting_payment to paid
   * and everything after it runs only if that statement moved a row, all in one
   * transaction. A webhook and a poll arriving together both run this; the
   * second waits on the row lock, finds the order paid, and leaves.
   */
  async function finalise(orderId, via) {
    const conn = await pool.getConnection();
    let done = null;
    try {
      await conn.beginTransaction();
      const [moved] = await conn.execute(
        "UPDATE epos_express_orders SET status = 'paid', paid_at = NOW(), status_note = NULL" +
          " WHERE id = ? AND status = 'awaiting_payment'",
        [orderId]
      );
      if (!moved.affectedRows) {
        await conn.rollback();
        return null;
      }
      const [[order]] = await conn.query('SELECT * FROM epos_express_orders WHERE id = ?', [orderId]);
      const settings = await readSettings(order.office);
      const lines = JSON.parse(order.lines_json || '[]');
      const terminal = await kioskName(order.kiosk_id);
      const typeLabel = ORDER_TYPES[order.order_type] || 'Take away';
      const saleId = crypto.randomUUID();

      const sale = {
        id: saleId,
        email: order.office,
        table_number: null,
        subtotal_minor: order.subtotal_minor,
        discount_minor: order.discount_minor,
        tax_minor: order.tax_minor,
        total_minor: order.total_minor,
        customer_name: order.customer_name || null,
        closed_at: new Date().toISOString(),
        clerk_name: 'Vesopa Express',
        order_note: 'Kiosk order ' + order.number + ' - ' + typeLabel,
        terminal,
        lines: lines.map((l) => ({
          plu_id: l.plu_id,
          name: l.name,
          quantity: l.qty,
          unit_price_minor: l.unit,
          tax_percentage: l.tax_percentage || 0,
          note: l.note || null,
          is_modifier: !!l.isModifier,
        })),
        payments: [
          {
            method: 'card',
            amount_minor: order.total_minor,
            // Dojo's paymentIntentId, which is what the webhook reconciliation
            // and a refund at the till both look a card sale up by.
            reference: order.dojo_intent_id,
            entry_mode: 'terminal',
          },
        ],
      };
      await recordSale(conn, sale);

      const ticket = Number(settings.notify_kitchen)
        ? await kitchenTicket(conn, order, lines, saleId, typeLabel, terminal)
        : null;
      if (ticket) await recordTicket(conn, ticket);

      // The stations that print, as jobs for a till to claim. In the same
      // transaction as the sale: a paid order must never exist without the
      // record that its kitchen still needs paper.
      const printing = Number(settings.notify_kitchen)
        ? await printingStations(conn, order.office, lines)
        : [];
      for (const station of printing) {
        await conn.execute(
          'INSERT IGNORE INTO epos_express_prints (order_id, office, station) VALUES (?, ?, ?)',
          [orderId, order.office, station]
        );
      }

      await conn.execute(
        'UPDATE epos_express_orders SET sale_id = ?, ticket_id = ? WHERE id = ?',
        [saleId, ticket ? ticket.id : null, orderId]
      );
      await conn.commit();
      done = { order, sale, ticket, settings, printing };
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }

    // Only once it is durable. A screen told about an order that then failed
    // to commit is a screen showing food nobody paid for.
    const { order, sale, ticket, settings, printing } = done;
    if (ticket) {
      broadcast({ type: 'kitchen.ticket', id: ticket.id, office: order.office }, { office: order.office });
    }
    if (printing.length) {
      // A till with a printer for one of these asks for the job straight away
      // rather than on its next poll.
      broadcast({ type: 'express.print', order_id: order.id, stations: printing }, { office: order.office });
    }
    broadcast(
      { type: 'order.created', id: sale.id, tableNumber: null, totalMinor: sale.total_minor, lines: sale.lines },
      { office: order.office }
    );
    broadcast(
      {
        type: 'express.order',
        public_id: order.public_id,
        number: order.number,
        order_type: order.order_type,
        total_minor: order.total_minor,
        kiosk: sale.terminal,
        notify_till: !!Number(settings.notify_till),
        via,
      },
      { office: order.office }
    );
    return done;
  }

  /**
   * Which stations each line of an order goes to, in line order.
   *
   * A dish goes where its product is routed. An add-on goes WHERE ITS DISH
   * GOES, whatever its own product says -- the till's rule, word for word (see
   * routesByLine in vesopa_epos/lib/data/modifier_layout.dart), so a kiosk
   * ticket is exactly the ticket a till would have fired. "Extra cheese" is
   * read on the grill beside the burger it belongs to, and a meal's side and
   * drink travel on the meal's ticket rather than scattering across the
   * kitchen. Shared by the screen ticket and the printer jobs, so the two
   * halves of one order can never be routed by two different rules.
   */
  async function stationsByLine(db, office, lines) {
    const plus = [...new Set(lines.map((l) => Number(l.plu_id)).filter((p) => p > 0))];
    const routes = new Map();
    if (plus.length) {
      const [rows] = await db.query(
        'SELECT pluid, printer_routes, printer_route FROM bo_products' +
          ' WHERE email = ? AND pluid IN (' + plus.map(() => '?').join(',') + ')',
        [office, ...plus]
      );
      for (const r of rows) routes.set(r.pluid, parseStations(r.printer_routes ?? r.printer_route));
    }
    const stationsOf = [];
    lines.forEach((line, index) => {
      const parent = line.isModifier && line.parentIndex != null
        ? stationsOf[line.parentIndex]
        : undefined;
      stationsOf[index] = parent !== undefined ? parent : routes.get(Number(line.plu_id)) || [];
    });
    return stationsOf;
  }

  /**
   * The stations of an order that PRINT: routed to by one of its lines and
   * set to Printer or Both. A kiosk has no printer of its own for the
   * kitchen, so these become jobs a till claims -- see epos_express_prints.
   */
  async function printingStations(db, office, lines) {
    const modes = await readModes(db, office);
    const stationsOf = await stationsByLine(db, office, lines);
    const routed = new Set(stationsOf.flat());
    return [...routed].filter((s) => modes[s] === 'printer' || modes[s] === 'both').sort();
  }

  /**
   * The kitchen ticket a till would have fired for this order.
   *
   * Only lines routed to a station that has a SCREEN on it (mode screen or
   * both), exactly as the till's own fire does. A station that is printer only
   * is printed by a till, which a kiosk is not: those become print jobs (see
   * printingStations) instead of vanishing.
   */
  async function kitchenTicket(conn, order, lines, saleId, typeLabel, terminal) {
    const modes = await readModes(conn, order.office);
    const screens = new Set(
      Object.entries(modes)
        .filter(([, mode]) => mode === 'screen' || mode === 'both')
        .map(([station]) => station)
    );
    if (!screens.size) return null;

    const stationsOf = await stationsByLine(conn, order.office, lines);
    const ticketLines = [];
    lines.forEach((line, index) => {
      const onScreens = stationsOf[index].filter((s) => screens.has(s));
      if (!onScreens.length) return;
      ticketLines.push({
        id: crypto.randomUUID(),
        quantity: line.qty,
        name: line.name,
        plu_id: line.plu_id,
        note: line.note || null,
        is_modifier: !!line.isModifier,
        stations: onScreens,
      });
    });
    if (!ticketLines.length) return null;

    return {
      id: crypto.randomUUID(),
      office: order.office,
      order_id: saleId,
      ticket_no: String(order.number),
      kind: 'sale',
      table_number: null,
      room_name: typeLabel,
      // epos_kitchen_tickets.staff_name is 80 characters, and a kiosk name can
      // be 80 on its own; strict mode refuses an overlong value outright.
      staff_name: ('Kiosk - ' + terminal).slice(0, 80),
      covers: null,
      note: order.customer_name ? 'For ' + order.customer_name : null,
      placed_at: new Date(),
      lines: ticketLines,
    };
  }

  /**
   * Pay at the counter: the order goes to the till's queue, unpaid.
   *
   * Through dine-in's own tables, so the till already knows what to do with
   * it -- the same card slides in, Accept rings it onto a bill and fires the
   * kitchen, and the money is taken the way the till always takes it. No till
   * release is needed for this to work.
   */
  async function sendToCounter(order, lines, officeId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const publicId = crypto.randomBytes(16).toString('hex');
      const label = ('Kiosk ' + order.number).slice(0, 60);
      const [placed] = await conn.execute(
        'INSERT INTO dinein_orders' +
          ' (public_id, office_id, table_id, table_label, customer_name,' +
          '  customer_phone, note, status, diner_id, total_minor)' +
          " VALUES (?, ?, NULL, ?, ?, NULL, ?, 'placed', NULL, ?)",
        [
          publicId,
          officeId,
          label,
          order.customer_name || null,
          'Vesopa Express: pay at the counter - ' + (ORDER_TYPES[order.order_type] || 'Take away'),
          order.total_minor,
        ]
      );
      const rowIds = [];
      for (const line of lines) {
        const parent = line.parentIndex == null ? null : rowIds[line.parentIndex] ?? null;
        const [written] = await conn.execute(
          'INSERT INTO dinein_order_lines' +
            ' (dinein_order_id, plu_id, name, qty, unit_price_minor, note,' +
            '  parent_line_id, is_modifier, unavailable_action)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            // dinein_order_lines.name is 160 characters and a catalogue name
            // can be 255; strict mode would refuse the whole order for it.
            placed.insertId, line.plu_id, String(line.name).slice(0, 160), line.qty, line.unit,
            line.note || null, parent, line.isModifier ? 1 : 0, line.unavailable || 'remove',
          ]
        );
        rowIds.push(written.insertId);
      }
      await conn.execute(
        'UPDATE epos_express_orders SET dinein_order_id = ? WHERE id = ?',
        [placed.insertId, order.id]
      );
      await conn.commit();

      broadcast(
        {
          type: 'dinein.order',
          order_id: placed.insertId,
          public_id: publicId,
          table: label,
          total_minor: order.total_minor,
          lines: lines.length,
        },
        { office: order.office }
      );
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  router.post('/api/express/kiosk/orders', kioskAuth, async (req, res, next) => {
    try {
      const settings = await readSettings(req.office);
      if (!Number(settings.enabled)) return expressOff(res);
      const body = req.body || {};

      const clientRef = /^[0-9a-fA-F-]{36}$/.test(String(body.client_ref || ''))
        ? String(body.client_ref).toLowerCase()
        : null;
      if (clientRef) {
        const again = await loadOrder('kiosk_id = ? AND client_ref = ?', [req.kiosk.id, clientRef]);
        if (again) return res.json(describe(again));
      }

      const orderType = String(body.order_type || '');
      if (!ORDER_TYPES[orderType] || !Number(settings[orderType])) {
        return res.status(400).json({ error: 'Please choose eat in or take away.' });
      }

      const { key } = venueKey(settings);
      let payment;
      if (Number(settings.demo_mode)) {
        payment = 'demo';
      } else if (body.payment === 'counter' && Number(settings.pay_counter)) {
        payment = 'counter';
      } else if (body.payment === 'card' && Number(settings.pay_card)) {
        if (!req.kiosk.dojo_terminal_id || !key) {
          return res.status(409).json({
            error: 'This kiosk has no card machine set up yet.',
            code: 'no_card_machine',
          });
        }
        payment = 'card';
      } else {
        return res.status(400).json({ error: 'That way of paying is not available here.' });
      }

      const customerName = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
      if (Number(settings.ask_name) && !customerName) {
        return res.status(400).json({ error: 'Please tell us your name, so we can call you.' });
      }

      const officeId = await officeIdFor(req);
      let priced;
      try {
        priced = await core.priceBasket(pool, {
          officeId,
          email: req.office,
          basket: body.lines,
        });
      } catch (e) {
        if (e instanceof core.BasketError) return res.status(e.status).json({ error: e.message });
        throw e;
      }

      const tax = core.inclusiveTax(priced.lines);
      const { number, day } = await allocateNumber(pool, req.office, settings);
      const publicId = crypto.randomBytes(16).toString('hex');
      const status = payment === 'demo' ? 'demo' : payment === 'counter' ? 'counter' : 'awaiting_payment';

      let inserted;
      try {
        [inserted] = await pool.execute(
          'INSERT INTO epos_express_orders' +
            ' (public_id, office, kiosk_id, client_ref, number, business_date, order_type,' +
            '  payment, status, customer_name, subtotal_minor, discount_minor, total_minor,' +
            '  tax_minor, lines_json)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
          [
            publicId, req.office, req.kiosk.id, clientRef, number, day, orderType,
            payment, status, customerName, priced.subtotal, priced.subtotal, tax,
            JSON.stringify(priced.lines),
          ]
        );
      } catch (e) {
        // The same basket arriving twice at the same moment: the unique key
        // on (kiosk, client_ref) lets one through, and this one answers it.
        if (e && e.code === 'ER_DUP_ENTRY' && clientRef) {
          const again = await loadOrder('kiosk_id = ? AND client_ref = ?', [req.kiosk.id, clientRef]);
          if (again) return res.json(describe(again));
        }
        throw e;
      }

      let order = await loadOrder('id = ?', [inserted.insertId]);
      if (payment === 'counter') {
        await sendToCounter(order, priced.lines, officeId);
        if (Number(settings.notify_till)) {
          broadcast(
            {
              type: 'express.order',
              public_id: order.public_id,
              number: order.number,
              order_type: order.order_type,
              total_minor: order.total_minor,
              kiosk: req.kiosk.name,
              payment: 'counter',
              notify_till: true,
            },
            { office: req.office }
          );
        }
      } else if (payment === 'card') {
        await startPayment(order, settings, req.kiosk);
      }
      order = await loadOrder('id = ?', [inserted.insertId]);
      res.status(201).json(describe(order));
    } catch (e) {
      next(e);
    }
  });

  async function kioskOrder(req) {
    return loadOrder('public_id = ? AND office = ? AND kiosk_id = ?', [
      String(req.params.publicId || ''),
      req.office,
      req.kiosk.id,
    ]);
  }

  router.get('/api/express/kiosk/orders/:publicId', kioskAuth, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      let order = await kioskOrder(req);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      order = await refresh(order, await readSettings(req.office));
      res.json(describe(order));
    } catch (e) {
      next(e);
    }
  });

  /** Try the card again: a new session on the machine, the SAME intent. */
  router.post('/api/express/kiosk/orders/:publicId/retry', kioskAuth, async (req, res, next) => {
    try {
      let order = await kioskOrder(req);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      if (order.status !== 'awaiting_payment') return res.json(describe(order));
      const settings = await readSettings(req.office);
      const { key } = venueKey(settings);

      // The money may be in already -- the machine said Expired but took it.
      if (order.dojo_intent_id && key) {
        try {
          if (dojo.intentPaid(await dojo.getIntent(key, order.dojo_intent_id))) {
            await finalise(order.id, 'intent');
            return res.json(describe(await loadOrder('id = ?', [order.id])));
          }
        } catch { /* start again below */ }
      }
      await startPayment(order, settings, req.kiosk);
      order = await loadOrder('id = ?', [order.id]);
      res.json(describe(order));
    } catch (e) {
      next(e);
    }
  });

  /**
   * The customer stopped before paying.
   *
   * Dojo only honours a cancel before a card is presented. So the machine is
   * asked, then read back: if the money went through anyway the order is
   * finished, and if a card is still on the machine the kiosk is told to let
   * it run rather than walking away from a payment in progress.
   */
  router.post('/api/express/kiosk/orders/:publicId/cancel', kioskAuth, async (req, res, next) => {
    try {
      let order = await kioskOrder(req);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      if (order.status !== 'awaiting_payment') return res.json(describe(order));
      const settings = await readSettings(req.office);
      const { key } = venueKey(settings);

      if (order.dojo_session_id && key) {
        await dojo.cancelSession(key, order.dojo_session_id);
        sessionCache.delete(order.id);
        try {
          const session = await dojo.getSession(key, order.dojo_session_id);
          const state = dojo.sessionState(session);
          if (state === 'paid') {
            await finalise(order.id, 'cancel-race');
            return res.json(describe(await loadOrder('id = ?', [order.id])));
          }
          if (state === 'waiting' && dojo.lastPrompt(session) !== 'PresentCard' && dojo.lastPrompt(session)) {
            return res.status(409).json({
              error: 'The card machine is already taking this payment. Please follow its screen.',
              code: 'in_progress',
            });
          }
        } catch { /* the cancel stands */ }
      }

      await pool.execute(
        "UPDATE epos_express_orders SET status = 'cancelled', status_note = NULL" +
          " WHERE id = ? AND status = 'awaiting_payment'",
        [order.id]
      );
      order = await loadOrder('id = ?', [order.id]);
      res.json(describe(order));
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // Looking after payments nobody is watching
  // -------------------------------------------------------------------------

  const lastSweep = new Map();

  /**
   * Unpaid orders a kiosk stopped asking about -- it was switched off, lost
   * its network, or crashed between "card presented" and "approved".
   *
   * Run when somebody looks (the board, the back office), at most every thirty
   * seconds per venue: a sweep on a timer is a second thing to deploy and to
   * forget, and this is exactly as current as the screen that is asking. The
   * money-in case is finished; anything abandoned for half an hour is closed.
   */
  async function sweep(office) {
    const last = lastSweep.get(office) || 0;
    if (Date.now() - last < SWEEP_EVERY_MS) return;
    lastSweep.set(office, Date.now());

    const [stale] = await pool.query(
      "SELECT * FROM epos_express_orders WHERE office = ? AND status = 'awaiting_payment'" +
        ' AND created_at < (NOW() - INTERVAL 90 SECOND) ORDER BY id LIMIT 5',
      [office]
    );
    if (!stale.length) return;
    const settings = await readSettings(office);
    const { key } = venueKey(settings);
    for (const order of stale) {
      let paid = false;
      if (order.dojo_intent_id && key) {
        try { paid = dojo.intentPaid(await dojo.getIntent(key, order.dojo_intent_id)); } catch { paid = false; }
      }
      if (paid) {
        await finalise(order.id, 'sweep');
      } else if (Date.now() - new Date(order.created_at).getTime() > ABANDON_MINUTES * 60000) {
        await pool.execute(
          "UPDATE epos_express_orders SET status = 'failed', status_note = 'Abandoned before payment'" +
            " WHERE id = ? AND status = 'awaiting_payment'",
          [order.id]
        );
      }
    }
  }

  /** From src/dojo.js: a verified Dojo event about some payment. */
  async function onDojoEvent(e) {
    if (!e || !e.paymentIntentId) return;
    const status = String(e.status || '').toLowerCase();
    if (status !== 'captured' && status !== 'succeeded') return;
    const order = await loadOrder(
      "dojo_intent_id = ? AND status = 'awaiting_payment'",
      [e.paymentIntentId]
    );
    if (order) await finalise(order.id, 'webhook');
  }

  // -------------------------------------------------------------------------
  // Back office: meals
  // -------------------------------------------------------------------------
  //
  // Which meals each dish on the Dine-in menu offers. A meal is a catalogue
  // product with its own price and its own questions -- see mealsFor in
  // menu_core.js -- so this page only links products to dishes, and shows the
  // manager what each meal will walk a customer through.

  async function officeIdOfUser(req, office) {
    return req.user.officeId || (await core.officeIdOf(pool, office));
  }

  router.get('/api/express/meals', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const officeId = await officeIdOfUser(req, office);
      const sections = await core.menuSections(pool, officeId, office, { meals: true });
      res.json({
        items: sections.flatMap((s) => s.items.map((i) => ({
          id: i.id,
          name: i.name,
          section: s.name,
          plu_id: i.plu_id,
          price_minor: i.price_minor,
          image_url: i.image_url,
          meals: (i.meals || []).map((m) => ({
            id: m.id,
            plu_id: m.plu_id,
            label: m.label,
            name: m.name,
            price_minor: m.price_minor,
            steps: m.steps.map((g) => ({
              name: g.name,
              min_select: g.min_select,
              max_select: g.max_select,
              options: g.options.map((o) => ({ name: o.name, price_minor: o.price_minor })),
            })),
          })),
        }))),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/api/express/meals', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const officeId = await officeIdOfUser(req, office);
      const body = req.body || {};
      const itemId = Number(body.item_id);
      const plu = Number(body.plu_id);
      if (!Number.isInteger(itemId) || !Number.isInteger(plu) || plu <= 0) {
        return res.status(400).json({ error: 'Choose a dish and the product that is its meal.' });
      }
      const [[item]] = await pool.query(
        'SELECT id, plu_id FROM dinein_items WHERE id = ? AND office_id = ?',
        [itemId, officeId]
      );
      if (!item) return res.status(404).json({ error: 'That dish is not on your menu.' });
      if (Number(item.plu_id) === plu) {
        return res.status(400).json({
          error: 'A meal has to be its own product, with its own price: make a product such as '
            + '"Cheeseburger Meal" and choose that.',
        });
      }
      const [[product]] = await pool.query(
        'SELECT pluid, product_name FROM bo_products WHERE email = ? AND pluid = ?',
        [office, plu]
      );
      if (!product) return res.status(404).json({ error: 'There is no product with that PLU.' });

      const label = String(body.label || '').trim().slice(0, 40) || null;
      const [[{ n }]] = await pool.query(
        'SELECT COUNT(*) AS n FROM dinein_item_meals WHERE item_id = ?',
        [itemId]
      );
      try {
        const [r] = await pool.execute(
          'INSERT INTO dinein_item_meals (office_id, item_id, plu_id, label, sort_order) VALUES (?, ?, ?, ?, ?)',
          [officeId, itemId, plu, label, Number(n)]
        );
        res.status(201).json({ ok: true, id: r.insertId });
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: product.product_name + ' is already a meal for that dish.' });
        }
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/express/meals/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const officeId = await officeIdOfUser(req, office);
      const body = req.body || {};
      const sets = [];
      const params = [];
      if (body.label !== undefined) {
        sets.push('label = ?');
        params.push(String(body.label || '').trim().slice(0, 40) || null);
      }
      if (body.sort_order !== undefined && Number.isInteger(Number(body.sort_order))) {
        sets.push('sort_order = ?');
        params.push(Number(body.sort_order));
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
      const [r] = await pool.execute(
        'UPDATE dinein_item_meals SET ' + sets.join(', ') + ' WHERE id = ? AND office_id = ?',
        [...params, req.params.id, officeId]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such meal.' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/api/express/meals/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const officeId = await officeIdOfUser(req, office);
      const [r] = await pool.execute(
        'DELETE FROM dinein_item_meals WHERE id = ? AND office_id = ?',
        [req.params.id, officeId]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such meal.' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // The till: kiosk orders, and kiosk tickets for the kitchen printers
  // -------------------------------------------------------------------------
  //
  // On the till's own token (requireTerminal), which carries the venue. A kiosk
  // token and a kitchen screen's are refused by it, as a till's is refused by
  // everything else in this file.

  const terminal = requireTerminal(secret);

  /** A print job nobody printed in time is expired, never printed late. */
  async function expirePrints(office) {
    await pool.execute(
      "UPDATE epos_express_prints SET status = 'expired'" +
        " WHERE office = ? AND status IN ('waiting', 'claimed', 'failed')" +
        ' AND created_at < (NOW() - INTERVAL ' + PRINT_EXPIRE_MINUTES + ' MINUTE)',
      [office]
    );
  }

  async function kioskNamesOf(rows) {
    const ids = [...new Set(rows.map((r) => r.kiosk_id).filter(Boolean))];
    const names = new Map();
    if (ids.length) {
      const [ks] = await pool.query(
        'SELECT id, name FROM epos_express_kiosks WHERE id IN (' + ids.map(() => '?').join(',') + ')',
        ids
      );
      for (const k of ks) names.set(k.id, k.name);
    }
    return names;
  }

  function linesOf(order) {
    try { return JSON.parse(order.lines_json || '[]'); } catch { return []; }
  }

  /**
   * Today's kiosk orders a till should know about: paid and being made, and
   * ready and waiting to be collected. The till raises a card for each new one
   * and offers Ready and Collected on it -- which is how a counter-service
   * venue with no kitchen screen moves a number up on the board.
   *
   * `enabled` and `notify_till` travel with the list, because they decide
   * whether a till raises anything at all, and a till has to stop the minute a
   * manager says so. Pay-at-the-counter orders are not here: they reach the
   * till as dine-in orders, where it takes the money for them.
   */
  router.get('/till/express/orders', terminal, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const settings = await readSettings(req.office);
      if (!Number(settings.enabled)) return res.json({ enabled: false, notify_till: false, orders: [] });
      await sweep(req.office).catch(() => {});
      const [rows] = await pool.query(
        'SELECT * FROM epos_express_orders' +
          " WHERE office = ? AND business_date = ? AND status IN ('paid', 'ready')" +
          ' ORDER BY paid_at, id LIMIT 200',
        [req.office, businessDate()]
      );
      const names = await kioskNamesOf(rows);
      res.json({
        enabled: true,
        notify_till: !!Number(settings.notify_till),
        orders: rows.map((o) => ({
          id: o.id,
          number: o.number,
          status: o.status,
          order_type: o.order_type,
          customer_name: o.customer_name || null,
          total_minor: o.total_minor,
          kiosk: names.get(o.kiosk_id) || 'Vesopa Express',
          paid_at: o.paid_at,
          ready_at: o.ready_at,
          lines: linesOf(o).map((l) => ({
            name: l.name,
            qty: l.qty,
            unit_minor: l.unit,
            is_modifier: !!l.isModifier,
            note: l.note || null,
          })),
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/till/express/orders/:id/:action', terminal, async (req, res, next) => {
    try {
      const moved = await moveOrder(req.office, req.params.id, String(req.params.action));
      if (moved === undefined) return res.status(400).json({ error: 'Unknown action.' });
      if (moved === null) return res.status(409).json({ error: 'That order has already moved on.' });
      res.json({ ok: true, status: moved });
    } catch (e) {
      next(e);
    }
  });

  /** A job is on offer: nobody has it, its claim went quiet, or it failed and has tries left. */
  const ON_OFFER =
    "(p.status = 'waiting'" +
    " OR (p.status = 'claimed' AND p.claimed_at < (NOW() - INTERVAL " + PRINT_CLAIM_MINUTES + ' MINUTE))' +
    " OR (p.status = 'failed' AND p.attempts < " + PRINT_ATTEMPTS + '))' +
    ' AND p.created_at >= (NOW() - INTERVAL ' + PRINT_EXPIRE_MINUTES + ' MINUTE)';

  /** The ticket a till prints for one kiosk order, at the stations named. */
  async function printTicket(order, stations) {
    const lines = linesOf(order);
    const stationsOf = await stationsByLine(pool, order.office, lines);
    const wanted = new Set(stations);
    return {
      order_id: order.id,
      number: order.number,
      order_type: order.order_type,
      order_type_label: ORDER_TYPES[order.order_type] || 'Take away',
      customer_name: order.customer_name || null,
      kiosk: await kioskName(order.kiosk_id),
      placed_at: order.paid_at || order.created_at,
      stations,
      lines: lines
        .map((l, i) => ({
          name: l.name,
          qty: l.qty,
          note: l.note || null,
          is_modifier: !!l.isModifier,
          stations: stationsOf[i].filter((s) => wanted.has(s)),
        }))
        .filter((l) => l.stations.length),
    };
  }

  /**
   * Kiosk tickets waiting for a kitchen printer.
   *
   * A till asks on every `express.print` it hears and on a slow poll, takes
   * the stations it has a printer for, and claims them -- see the claim route.
   * Only the last thirty minutes: an order that nobody printed by then has
   * expired, and the back office says so, rather than a till switched on at
   * six o'clock printing lunch.
   */
  router.get('/till/express/print-queue', terminal, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const settings = await readSettings(req.office);
      if (!Number(settings.enabled) || !Number(settings.notify_kitchen)) return res.json({ jobs: [] });
      await expirePrints(req.office);
      const [rows] = await pool.query(
        'SELECT p.order_id, p.station FROM epos_express_prints p' +
          ' WHERE p.office = ? AND ' + ON_OFFER +
          ' ORDER BY p.created_at, p.order_id LIMIT 100',
        [req.office]
      );
      const byOrder = new Map();
      for (const r of rows) (byOrder.get(r.order_id) || byOrder.set(r.order_id, []).get(r.order_id)).push(r.station);
      res.json({
        jobs: [...byOrder].map(([orderId, stations]) => ({ order_id: orderId, stations })),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Take some stations of one order's ticket to print.
   *
   * ONE UPDATE decides who wins: it stamps a fresh claim id on every named
   * station still on offer, and the till is answered with exactly the
   * stations that carry its id. Two tills asking in the same instant both run
   * the statement; the row lock makes one of them find nothing left to take.
   * So a venue with two tills and a printer at each gets one ticket per
   * station, not two.
   */
  router.post('/till/express/print-queue/:orderId/claim', terminal, async (req, res, next) => {
    try {
      const body = req.body || {};
      const wanted = [...new Set((Array.isArray(body.stations) ? body.stations : [])
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => parseStations(s).length))];
      if (!wanted.length) return res.status(400).json({ error: 'Name the stations this till prints.' });

      const claim = crypto.randomUUID();
      const by = String(body.terminal || '').trim().slice(0, 120) || 'A till';
      await pool.execute(
        'UPDATE epos_express_prints p' +
          ' SET p.status = ?, p.claim_id = ?, p.claimed_by = ?, p.claimed_at = NOW(),' +
          '     p.attempts = p.attempts + 1, p.error = NULL' +
          ' WHERE p.order_id = ? AND p.office = ?' +
          '   AND p.station IN (' + wanted.map(() => '?').join(',') + ') AND ' + ON_OFFER,
        ['claimed', claim, by, req.params.orderId, req.office, ...wanted]
      );
      const [won] = await pool.query(
        'SELECT station FROM epos_express_prints WHERE claim_id = ? ORDER BY station',
        [claim]
      );
      if (!won.length) return res.json({ claim_id: null, stations: [] });

      const order = await loadOrder('id = ? AND office = ?', [req.params.orderId, req.office]);
      if (!order) return res.status(404).json({ error: 'No such order.' });
      const stations = won.map((w) => w.station);
      res.json({ claim_id: claim, stations, ticket: await printTicket(order, stations) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * How the printing went, station by station. A failure goes back on offer
   * (for another till, or this one when somebody has loaded paper) until it
   * has had its tries; the back office shows the printer's own words.
   */
  router.post('/till/express/print-queue/:orderId/result', terminal, async (req, res, next) => {
    try {
      const body = req.body || {};
      const claim = String(body.claim_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(claim)) return res.status(400).json({ error: 'Which claim?' });
      const results = Array.isArray(body.results) ? body.results : [];
      let changed = 0;
      for (const r of results) {
        const station = String((r && r.station) || '').trim().toLowerCase();
        if (!parseStations(station).length) continue;
        const ok = !!(r && r.ok);
        const [u] = await pool.execute(
          ok
            ? "UPDATE epos_express_prints SET status = 'printed', printed_at = NOW(), error = NULL" +
                " WHERE order_id = ? AND office = ? AND station = ? AND claim_id = ? AND status = 'claimed'"
            : "UPDATE epos_express_prints SET status = 'failed', error = ?" +
                " WHERE order_id = ? AND office = ? AND station = ? AND claim_id = ? AND status = 'claimed'",
          ok
            ? [req.params.orderId, req.office, station, claim]
            : [String((r && r.error) || 'The printer did not print it.').slice(0, 300),
                req.params.orderId, req.office, station, claim]
        );
        changed += u.affectedRows;
      }
      if (changed) {
        broadcast({ type: 'express.changed', id: Number(req.params.orderId), prints: true }, { office: req.office });
      }
      res.json({ ok: true, updated: changed });
    } catch (e) {
      next(e);
    }
  });

  // -------------------------------------------------------------------------
  // The collection board
  // -------------------------------------------------------------------------

  async function boardSettings(token) {
    if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
    const [[row]] = await pool.query(
      'SELECT * FROM epos_express_settings WHERE board_token = ? AND board_enabled = 1 AND enabled = 1',
      [token]
    );
    return row || null;
  }

  router.get('/express/board/:token', async (req, res, next) => {
    try {
      const settings = await boardSettings(req.params.token);
      res.set('Cache-Control', 'no-store');
      res.set('X-Robots-Tag', 'noindex');
      if (!settings) {
        return res.status(404).type('html').send(boardPage({ missing: true }));
      }
      const officeId = await core.officeIdOf(pool, settings.office);
      const venue = await venueFace(officeId);
      res.type('html').send(boardPage({ venueName: venue.name, token: req.params.token }));
    } catch (e) {
      next(e);
    }
  });

  /**
   * Numbers, and nothing else. No names, no totals, no dishes: the page is on
   * a TV facing the room and its address may be written on a sticky note.
   */
  router.get('/express/board/:token/data', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const settings = await boardSettings(req.params.token);
      if (!settings) return res.status(404).json({ error: 'No such board.' });
      const office = settings.office;
      await sweep(office).catch(() => {});

      const [rows] = await pool.query(
        'SELECT id, number, status, ticket_id, ready_at FROM epos_express_orders' +
          " WHERE office = ? AND business_date = ? AND status IN ('paid', 'ready')" +
          ' ORDER BY paid_at, id',
        [office, businessDate()]
      );

      // A ticket whose every station is done is Ready. Read from the kitchen's
      // own rows, by id, bound as parameters -- never joined across tables of
      // different collations.
      const pending = rows.filter((r) => r.status === 'paid' && r.ticket_id);
      if (pending.length) {
        const [stations] = await pool.query(
          'SELECT ticket_id, SUM(status <> ' + "'done'" + ') AS open_count' +
            '  FROM epos_kitchen_ticket_stations' +
            ' WHERE ticket_id IN (' + pending.map(() => '?').join(',') + ')' +
            ' GROUP BY ticket_id',
          pending.map((r) => r.ticket_id)
        );
        const doneTickets = new Set(
          stations.filter((s) => Number(s.open_count) === 0).map((s) => s.ticket_id)
        );
        const nowReady = pending.filter((r) => doneTickets.has(r.ticket_id));
        if (nowReady.length) {
          await pool.execute(
            "UPDATE epos_express_orders SET status = 'ready', ready_at = NOW()" +
              " WHERE status = 'paid' AND id IN (" + nowReady.map(() => '?').join(',') + ')',
            nowReady.map((r) => r.id)
          );
          for (const r of nowReady) {
            r.status = 'ready';
            r.ready_at = new Date();
          }
        }
      }

      const cutoff = Date.now() - READY_ON_BOARD_MINUTES * 60000;
      res.json({
        preparing: rows.filter((r) => r.status === 'paid').map((r) => r.number),
        ready: rows
          .filter((r) => r.status === 'ready' && new Date(r.ready_at).getTime() >= cutoff)
          .map((r) => r.number),
        server_time: new Date().toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });

  router.onDojoEvent = (e) => onDojoEvent(e);
  return router;
}

module.exports = {
  expressKioskRoutes,
  // Exported for the tests: the pieces with real logic that need no database.
  businessDate,
  hashPasscode,
  passcodeMatches,
  seal,
  unseal,
  venueKey,
  cleanIdList,
  paymentStage,
  describe,
  DEFAULTS,
  PBKDF2_ITERATIONS,
};
