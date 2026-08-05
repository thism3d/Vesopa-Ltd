require('dotenv').config();

const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const {
  verifyPassword,
  issueToken,
  issueTerminalToken,
  requireTerminal,
  AccessDeniedError,
} = require('./auth');
const { passwordRoutes } = require('./passwords');
const { verifyMail } = require('./mailer');
const {
  denominationRoutes,
  tillDenominationRoutes,
} = require('./denominations');
const { backofficeRoutes } = require('./backoffice');
const { adminRoutes } = require('./admin');
const { programmingRoutes } = require('./programming');
const { commerceRoutes } = require('./commerce');
const { analyticsRoutes } = require('./analytics');
const { templateRoutes } = require('./templates');

const PORT = process.env.PORT || 4000;

// Credentials come from the environment only — never checked into source.
// See .env.example; copy it to .env and fill in the real values.
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Signs back-office sessions. A weak or shared secret means forgeable logins,
// so this is required rather than defaulted.
const JWT_SECRET = required('JWT_SECRET');

// Session lengths behind the "Keep me signed in" box. Unticked is a working
// day — a shared back-office machine should not stay open overnight. Ticked is
// a month, so a manager's own laptop stops asking every morning.
const SESSION_TTL = '12h';
const REMEMBER_TTL = '30d';

// Points at the same database the PHP back office already uses, so products
// added there are immediately sellable on the tills.
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: required('DB_USER'),
  password: required('DB_PASSWORD'),
  database: process.env.DB_NAME || 'vesopa_eposdb',
  waitForConnections: true,
  connectionLimit: 10,
  // Full Unicode, so emoji on products (4-byte UTF-8) store correctly rather
  // than erroring.
  charset: 'utf8mb4',
});

const app = express();
// Live runs behind nginx. Without this every request reports the proxy's own
// address, so the password-reset throttle would see one caller and lock out
// the whole platform after a handful of requests.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const clients = new Set();

/** Push to every connected terminal (kitchen screens, other tills). */
function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Back office ----------------------------------------------------------

app.post('/api/login', async (req, res, next) => {
  const { email, password, remember, terminal } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await verifyPassword(pool, email, password);
    if (!user) {
      // Deliberately vague: saying which half was wrong tells an attacker
      // which accounts exist.
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    // "Keep me signed in" has to move the token's own lifetime, not just where
    // the browser files it — a 12h JWT in localStorage still forces a fresh
    // sign-in tomorrow morning, which is exactly what the box promises not to.
    const ttl = remember ? REMEMBER_TTL : SESSION_TTL;
    const body = {
      token: issueToken(user, JWT_SECRET, ttl),
      user,
      expiresIn: ttl,
    };

    // A till asks for one of these when it is commissioned. It is what lets the
    // terminal read its venue's staff list later — long after this session
    // token has expired — so a PIN can be checked with no network. Only issued
    // when asked for, so a browser sign-in never receives one.
    if (terminal && user.officeEmail) {
      body.terminalToken = issueTerminalToken(user, JWT_SECRET);
    }

    res.json(body);
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return res.status(403).json({ error: e.message });
    }
    next(e);
  }
});

// Unauthenticated by design — the caller is someone who cannot sign in. The
// routes are individually throttled and never confirm whether an account
// exists. Mounted before the authenticated routers so requireAuth cannot
// swallow them.
app.use('/api', passwordRoutes({ pool }));

// The till's note keys. The authenticated half is office-scoped; the pull is
// mounted at the root alongside /till/products.
app.use('/api', denominationRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use(tillDenominationRoutes({ pool }));

app.use('/api', backofficeRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', programmingRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', commerceRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', analyticsRoutes({ pool, secret: JWT_SECRET }));
app.use('/api/admin', adminRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api/admin', templateRoutes({ pool, broadcast, secret: JWT_SECRET }));

/**
 * The floor plan, as the till sees it. Unauthenticated like /products: a
 * terminal needs the layout to show its tables, and the plan is not sensitive.
 */
/**
 * Receipt history for the till, scoped to the venue and filterable by date.
 * Returns the header rows only; the full receipt (lines + tenders) is fetched
 * one at a time when the clerk opens or reprints it, to keep the list light.
 */
app.get('/till/receipts', async (req, res, next) => {
  const office = req.query.office;
  if (!office) return res.status(400).json({ error: 'An office is required.' });

  const { from, to } = req.query;
  try {
    const where = ['email = ?', 'closed_at IS NOT NULL'];
    const params = [office];
    if (from) { where.push('DATE(closed_at) >= ?'); params.push(from); }
    if (to) { where.push('DATE(closed_at) <= ?'); params.push(to); }

    const [rows] = await pool.query(
      `SELECT id, table_number, total_minor, tax_minor, discount_minor,
              closed_at
       FROM epos_orders
       WHERE ${where.join(' AND ')}
       ORDER BY closed_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/** One full receipt, for viewing / PDF / reprint. */
app.get('/till/receipts/:id', async (req, res, next) => {
  const office = req.query.office;
  if (!office) return res.status(400).json({ error: 'An office is required.' });

  try {
    // Scoped by office as well as id, so one venue cannot pull another's
    // receipt by guessing an id.
    const [[order]] = await pool.query(
      'SELECT * FROM epos_orders WHERE id = ? AND email = ?',
      [req.params.id, office]
    );
    if (!order) return res.status(404).json({ error: 'No such receipt' });

    const [lines] = await pool.query(
      `SELECT name, quantity, unit_price_minor, tax_percentage, note,
              discount_minor, promotion_name
       FROM epos_order_lines WHERE order_id = ?`,
      [req.params.id]
    );
    const [payments] = await pool.query(
      `SELECT method, amount_minor, taken_at, reference, entry_mode,
              gratuity_minor, cash_breakdown
       FROM epos_payments WHERE order_id = ?`,
      [req.params.id]
    );

    res.json({ order, lines, payments });
  } catch (e) {
    next(e);
  }
});

/** Customer search from the till (attach to a sale). Scoped to the venue. */
app.get('/till/customers', async (req, res, next) => {
  const office = req.query.office;
  if (!office) return res.status(400).json({ error: 'An office is required.' });

  const q = req.query.q ? `%${req.query.q}%` : null;
  try {
    const [rows] = await pool.query(
      `SELECT id, name, phone, email, card_number, discount_type, discount_value
       FROM epos_customers
       WHERE email_key = ?
       ${q ? 'AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)' : ''}
       ORDER BY name LIMIT 50`,
      q ? [office, q, q, q] : [office]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/** Add a customer from the till. Idempotent on the id the till mints. */
app.post('/till/customers', async (req, res, next) => {
  const c = req.body || {};
  if (!c.office || !c.name) {
    return res.status(400).json({ error: 'office and name are required' });
  }
  try {
    const { randomUUID } = require('crypto');
    const id = c.id || randomUUID();
    await pool.execute(
      `INSERT INTO epos_customers
         (id, email_key, name, phone, email, card_number, discount_type, discount_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [
        id,
        c.office,
        c.name,
        c.phone ?? null,
        c.email ?? null,
        c.card_number ?? null,
        c.discount_type ?? 'none',
        c.discount_value ?? 0,
      ]
    );
    broadcast({ type: 'customers.updated' });
    res.status(201).json({ id });
  } catch (e) {
    next(e);
  }
});

/** Void reasons for the till's confirmation dialog. */
app.get('/till/void-reasons', async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT reason FROM bo_error_reasons WHERE applies_to = 'void' ORDER BY id"
    );
    res.json(rows.map((r) => r.reason));
  } catch (e) {
    next(e);
  }
});

/**
 * Record a void. Idempotent on the void id, so a retry from the outbox cannot
 * log the same void twice.
 */
app.post('/till/voids', async (req, res, next) => {
  const v = req.body;
  if (!v || !v.id || !v.reason) {
    return res.status(400).json({ error: 'id and reason are required' });
  }
  try {
    await pool.execute(
      `INSERT IGNORE INTO epos_void_log
         (id, email, order_id, clerk_pin, reason, items, scope, amount_minor,
          voided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v.id,
        v.office || 'default',
        v.order_id ?? null,
        v.clerk_pin ?? null,
        v.reason,
        // Which items went, and whether this was a part-void or the whole
        // check. Tills on the previous build send neither and log as before.
        v.items ?? null,
        v.scope === 'item' ? 'item' : 'sale',
        v.amount_minor ?? 0,
        v.voided_at ? new Date(v.voided_at) : new Date(),
      ]
    );
    broadcast({ type: 'voids.updated' });
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Mix & match deals, so the till can apply them with no network. */
app.get('/till/deals', async (req, res, next) => {
  const office = req.query.office;
  if (!office) {
    return res.status(400).json({ error: 'An office is required.' });
  }

  try {
    // Scoped, like the catalogue: without this a till fires another venue's
    // promotions and undercharges for them.
    const [deals] = await pool.query(
      `SELECT mm.id, mm.name, mm.trigger_qty, mm.deal_price_minor, mm.active
       FROM bo_mix_match mm
       JOIN offices o ON o.id = mm.office_id
       WHERE mm.active = 1 AND o.contact_email = ?`,
      [office]
    );
    const [links] = await pool.query(
      'SELECT mix_match_id, plu_id FROM bo_mix_match_products'
    );
    res.json(
      deals.map((d) => ({
        ...d,
        plu_ids: links
          .filter((l) => l.mix_match_id === d.id)
          .map((l) => l.plu_id),
      }))
    );
  } catch (e) {
    next(e);
  }
});

/**
 * Category buttons for the till's right-hand rail: the picture, emoji and
 * colour the office set against each department.
 *
 * Deliberately separate from /till/products rather than joined into it. The
 * catalogue pull is per *product* and a department's picture would be repeated
 * on every row of it, and the till caches these independently so a category
 * keeps its picture even when the product pull is what failed.
 */
app.get('/till/departments', async (req, res, next) => {
  const office = req.query.office;
  if (!office) {
    return res.status(400).json({ error: 'An office is required.' });
  }
  try {
    const [rows] = await pool.query(
      `SELECT department_name, emoji, image_url, button_color, sort_order
       FROM bo_product_departments
       WHERE email = ? AND department_name IS NOT NULL
       ORDER BY sort_order, department_name`,
      [office]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/**
 * The staff list, for PIN sign-on at the terminal.
 *
 * The one till route that is NOT `?office=`-addressable, because it carries
 * PINs: the tenancy comes from a signed terminal token instead, so knowing a
 * venue's contact email is not enough to download its staff credentials.
 *
 * PINs are sent because the check has to work with no network. A till that
 * cannot verify a PIN offline is a till that cannot sell, and refusing to open
 * mid-service is a worse failure than the risk of caching four digits on a
 * terminal that is already trusted with the venue's catalogue and takings.
 */
app.get('/till/staff', requireTerminal(JWT_SECRET), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, pluid, clark_name AS name, pin_code AS pin
       FROM bo_clarks
       WHERE email = ? AND COALESCE(active, 1) = 1
       ORDER BY pluid, clark_name`,
      [req.office]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

app.get(['/till/floor', '/floor.json'], async (req, res, next) => {
  const office = req.query.office;
  if (!office) {
    return res.status(400).json({ error: 'An office is required.' });
  }

  try {
    // Scoped: a till must show its own venue's rooms, not every venue's.
    const [rooms] = await pool.query(
      `SELECT r.id, r.name
       FROM floor_rooms r
       JOIN offices o ON o.id = r.office_id
       WHERE o.contact_email = ?
       ORDER BY r.sort_order, r.id`,
      [office]
    );
    const [tables] = await pool.query(
      `SELECT t.id, t.room_id, t.table_number, t.label, t.pos_x, t.pos_y,
              t.width, t.height, t.shape, t.seats
       FROM floor_tables t
       JOIN offices o ON o.id = t.office_id
       WHERE o.contact_email = ?
       ORDER BY t.table_number`,
      [office]
    );
    res.json(
      rooms.map((r) => ({
        ...r,
        tables: tables.filter((t) => t.room_id === r.id),
      }))
    );
  } catch (e) {
    next(e);
  }
});

// The back-office single-page app.
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Deep links. The back office routes client-side (/products, /tables, …), so a
 * refresh or a pasted URL must still serve the app rather than 404 — the
 * client then reads location.pathname and opens the right section.
 *
 * Declared after the API routes so it can never swallow them.
 */
app.get(/^\/(?!api|till|orders|health|assets|.*\.[a-z]+$)[a-z0-9-]*$/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/**
 * Catalogue pull. The till caches this locally so it can sell while offline.
 *
 * Served under /till/* because the back office routes client-side and owns
 * /products as a page — without the prefix, a manager refreshing the products
 * page was handed raw JSON instead of the app.
 */
app.get(['/till/products', '/products.json'], async (req, res, next) => {
  // Which venue's till is asking. Without this the terminal is handed every
  // office's catalogue at once — duplicate products from other businesses.
  const office = req.query.office;
  if (!office) {
    return res.status(400).json({
      error: 'An office is required: /till/products?office=<contact email>',
    });
  }

  try {
    const [rows] = await pool.query(
      `SELECT pluid, product_name, department_name, group_name,
              accounting_code, price, tax_percentage, stock_quantity,
              button_position, button_color, printer_route, emoji, image_url
       FROM bo_products
       WHERE email = ?
       ORDER BY button_position IS NULL, button_position`,
      [office]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * Accept a completed sale from a terminal.
 *
 * Idempotent by order id: a till that retries after a dropped connection sends
 * the same UUID, and the INSERT IGNORE below collapses the duplicate rather
 * than booking the sale twice. That is what lets the client retry freely.
 */
app.post(['/till/orders', '/orders'], async (req, res, next) => {
  const order = req.body;
  if (!order || !order.id) {
    return res.status(400).json({ error: 'order id is required' });
  }

  // A paused office's tills are refused. Pausing that only locked the browser
  // would let a non-paying customer carry on taking money — this is what makes
  // the suspension mean something.
  if (order.email) {
    const [[office]] = await pool.query(
      'SELECT status FROM offices WHERE contact_email = ?',
      [order.email]
    );
    if (office && office.status !== 'active') {
      return res.status(402).json({
        error: `This office is ${office.status}. Contact Vesopa support.`,
      });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT IGNORE INTO epos_orders
         (id, email, table_number, clerk_pin, subtotal_minor, discount_minor,
          tax_minor, total_minor, covers, notes, customer_name, session_id,
          closed_at, voucher_code, voucher_minor, service_minor, points_earned,
          points_balance, clerk_name, order_note, gratuity_minor, gratuity_bp,
          gift_card_minor, gift_card_code, deposit_minor, deposit_reference,
          points_redeemed, points_value_minor, promo_minor, customer_id,
          customer_phone, split_group, split_index, split_count, staff_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.id,
        order.email || 'default',
        order.table_number ?? null,
        order.clerk_pin ?? null,
        order.subtotal_minor ?? 0,
        order.discount_minor ?? 0,
        order.tax_minor ?? 0,
        order.total_minor ?? 0,
        order.covers ?? null,
        order.notes ?? null,
        order.customer_name ?? null,
        order.session_id ?? null,
        order.closed_at ? new Date(order.closed_at) : null,
        // Receipt context. Older tills do not send these; the defaults keep
        // their sales inserting exactly as before.
        order.voucher_code ?? null,
        order.voucher_minor ?? 0,
        // `service_minor` was the earlier name for the same money; accept both
        // so a till on either version records its service charge.
        order.service_minor ?? order.gratuity_minor ?? 0,
        order.points_earned ?? 0,
        order.points_balance ?? null,
        order.clerk_name ?? null,
        order.order_note ?? null,
        // Commerce: gratuity, held money redeemed, points spent, offers, and
        // which share of a split bill this is.
        order.gratuity_minor ?? 0,
        order.gratuity_bp ?? 0,
        order.gift_card_minor ?? 0,
        order.gift_card_code ?? null,
        order.deposit_minor ?? 0,
        order.deposit_reference ?? null,
        order.points_redeemed ?? 0,
        order.points_value_minor ?? 0,
        order.promo_minor ?? 0,
        order.customer_id ?? null,
        order.customer_phone ?? null,
        order.split_group ?? null,
        order.split_index ?? 0,
        order.split_count ?? 0,
        // Which member of staff was signed on. Grouped by id in reports rather
        // than by clerk_name, which can be edited or duplicated.
        order.staff_id ?? null,
      ]
    );

    // Zero rows means we already hold this sale. Report it as a duplicate and
    // do NOT re-insert the lines, or a retry would double the takings.
    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(409).json({ status: 'duplicate', id: order.id });
    }

    for (const line of order.lines || []) {
      await conn.execute(
        `INSERT INTO epos_order_lines
           (id, order_id, plu_id, name, quantity, unit_price_minor,
            tax_percentage, note, discount_minor, promotion_id, promotion_name,
            added_by, added_at)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          line.plu_id,
          line.name,
          line.quantity ?? 1,
          line.unit_price_minor,
          line.tax_percentage ?? 0,
          line.note ?? null,
          // What an offer took off this line, so the receipt and the
          // promotion report can both explain the discount.
          line.discount_minor ?? 0,
          line.promotion_id ?? null,
          line.promotion_name ?? null,
          // Who put this item on the bill and when. Null from a till on the
          // previous version, and from any line rung up before staff sign-on
          // was switched on at that venue.
          line.added_by ?? null,
          line.added_at ? new Date(line.added_at) : null,
        ]
      );
    }

    for (const payment of order.payments || []) {
      await conn.execute(
        `INSERT INTO epos_payments
           (id, order_id, method, amount_minor, cash_breakdown)
         VALUES (UUID(), ?, ?, ?, ?)`,
        [
          order.id,
          payment.method,
          payment.amount_minor,
          // Which notes were handed over, when the clerk counted them in on
          // the till's cash keys. Null for card and for keyed-in cash.
          payment.cash_breakdown ?? null,
        ]
      );
    }

    await conn.commit();

    // Tell the kitchen, the other terminals, and any open back-office
    // dashboard — but only once the sale is durable.
    broadcast({
      type: 'order.created',
      id: order.id,
      tableNumber: order.table_number ?? null,
      totalMinor: order.total_minor ?? 0,
      lines: order.lines || [],
    });

    res.status(201).json({ status: 'accepted', id: order.id });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

/** End-of-day figures, computed from what was actually taken. */
app.get('/reports/end-of-day', async (req, res, next) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const [[totals]] = await pool.query(
      `SELECT COUNT(*)                        AS orders,
              COALESCE(SUM(total_minor), 0)   AS gross_minor,
              COALESCE(SUM(tax_minor), 0)     AS tax_minor
       FROM epos_orders
       WHERE DATE(closed_at) = ?`,
      [date]
    );
    const [byMethod] = await pool.query(
      `SELECT p.method, COALESCE(SUM(p.amount_minor), 0) AS amount_minor
       FROM epos_payments p
       JOIN epos_orders o ON o.id = p.order_id
       WHERE DATE(o.closed_at) = ?
       GROUP BY p.method`,
      [date]
    );
    res.json({ date, ...totals, by_method: byMethod });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, () =>
  console.log(`Vesopa EPOS API listening on :${PORT}`)
);

// Say at boot whether password-reset mail can actually leave the building.
// Only logs — an unreachable mailbox must never stop the tills from selling.
verifyMail();

// Server -> terminal push: kitchen tickets, live table status, catalogue
// changes. Sales never travel this way; they go over HTTP so they can be
// retried from the outbox when a terminal has been offline.
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  // Liveness, refreshed by the client's pong below.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

/**
 * WebSocket heartbeat.
 *
 * There was none, and it caused two problems on live tills:
 *
 *  - A till sits idle between services. nginx closes an idle upstream
 *    connection at proxy_read_timeout, 60s by default, so the socket was being
 *    culled on quiet tills purely for being quiet. A ping every 30s is traffic,
 *    so the connection is never idle long enough to qualify.
 *  - A terminal that loses power or drops off the network never sends a FIN, so
 *    its socket stayed in `clients` forever. Every broadcast then wrote to a
 *    dead handle, and the client count was meaningless.
 *
 * A client that has not ponged since the previous tick is gone: terminate it
 * rather than close it, because a graceful close on a half-open socket waits
 * for a reply that is never coming.
 */
const HEARTBEAT_MS = 30_000;

const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // Already gone; the next tick would have caught it anyway.
      clients.delete(ws);
    }
  }
}, HEARTBEAT_MS);

// Otherwise the interval keeps the event loop alive and the process will not
// exit on SIGTERM — which pm2 escalates to SIGKILL after its grace period.
heartbeat.unref?.();
wss.on('close', () => clearInterval(heartbeat));

module.exports = { app, server, pool, wss };
