require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { dineinRoutes } = require('./dinein');
const { dineinPageRoutes, isMenuAddress } = require('./dinein_pages');
const { dineinOtpRoutes } = require('./dinein_otp');
const { dineinAuthRoutes, ENABLED: VESOPA_AUTH_ON } = require('./dinein_auth');
const { backofficeAuthRoutes, LIVE: VESOPA_BACKOFFICE_LIVE } = require('./backoffice_auth');
const { terminalVesopaRoutes, ENABLED: VESOPA_TILL_LIVE } = require('./terminal_vesopa');

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
const { permissionRoutes, TILL_COLUMNS } = require('./permissions');
const { commerceRoutes } = require('./commerce');
const { analyticsRoutes } = require('./analytics');
const { templateRoutes } = require('./templates');
const {
  kitchenRoutes,
  kitchenAppRoutes,
  tillKitchenRoutes,
} = require('./kitchen');
const { screensRoutes, tillScreenRoutes } = require('./screens');
const { fontsRoutes, tillFontRoutes } = require('./fonts');
const { assetVersions, staticCache } = require('./assets');
const { modifierRoutes, tillModifierRoutes } = require('./modifiers');
const { dojoWebhookRoutes, webhookStatus } = require('./dojo');
const { terminalRoutes, timesheetRoutes } = require('./terminals');
const { deviceRoutes } = require('./devices');
const { cardRoutes } = require('./cards');
const { importRoutes } = require('./imports');
const { reportRoutes } = require('./reports');
const {
  reportScheduleRoutes,
  startScheduler,
} = require('./report_schedules');
const { walletCore, walletRoutes, walletPublicRoutes } = require('./wallet');
const { appleWalletRoutes } = require('./wallet_apple_service');
const { ensureMemberNumber } = require('./member_numbers');
const { walletPageRoutes } = require('./wallet_pages');

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
/*
 * The raw bytes are kept alongside the parsed body, for one caller.
 *
 * Dojo signs its webhook with an HMAC over the exact bytes it sent, and
 * `JSON.stringify(req.body)` is not those bytes — it is a re-serialisation that
 * agrees with the original only by luck of key order and number formatting. So
 * the buffer is stashed as it goes past. It costs one reference per JSON
 * request and it is the only way the signature check in src/dojo.js can be
 * honest.
 */
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

const clients = new Set();

/**
 * Push to connected terminals (kitchen screens, other tills).
 *
 * Two audiences, and the difference matters. Without `options.office` this goes
 * to every socket, which is what the existing signals are: "the catalogue
 * moved", "till settings changed" — a nudge to re-fetch, carrying nothing a
 * terminal is not entitled to read anyway, and the re-fetch is scoped by the
 * caller's own tenancy.
 *
 * A kitchen ticket is not that. It carries what a named venue is cooking, so it
 * is delivered only to sockets that have said which office they belong to and
 * said this one. A socket that has never subscribed hears nothing office-scoped
 * at all — the default is silence, not everybody, because the failure mode of
 * the other default is one venue's orders appearing on another's wall.
 */
function broadcast(message, options = {}) {
  const payload = JSON.stringify(message);
  const office = options.office || null;
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (office && ws.office !== office) continue;
    ws.send(payload);
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

// Dojo's webhooks. Also unauthenticated, and for the same structural reason:
// the caller is the acquirer, which has no session here and proves itself with
// an HMAC over the raw body instead. Mounted at the root because the path
// carries the environment (/api/webhooks/dojo/sandbox|live) — sandbox and live
// are separate subscriptions with separate signing secrets, and the handler has
// to know which secret to check before it can trust anything in the payload.
app.use(dojoWebhookRoutes({ pool, broadcast }));

// The till's note keys. The authenticated half is office-scoped; the pull is
// mounted at the root alongside /till/products.
app.use('/api', denominationRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use(tillDenominationRoutes({ pool }));

// Roles and permission groups, and the middleware that resolves what the
// signed-in user may do. Mounted before the routes it guards so that every one
// of them can read `req.access`.
app.use('/api', permissionRoutes({ pool, broadcast, secret: JWT_SECRET }));

app.use('/api', backofficeRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', programmingRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', commerceRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', analyticsRoutes({ pool, secret: JWT_SECRET }));
app.use('/api/admin', adminRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api/admin', templateRoutes({ pool, broadcast, secret: JWT_SECRET }));

// Kitchen screens. Three routers because they are authorised three different
// ways — the back office on a session, the screens on a kitchen token, and the
// tills on nothing at all, exactly as /till/orders is. See src/kitchen.js.
app.use('/api', kitchenRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', kitchenAppRoutes({ pool, broadcast, secret: JWT_SECRET }));

// Screen programming: the venue's own sale-screen layouts. The back office's
// half is session-authorised under /api; the tills read theirs from /till/,
// unauthenticated and scoped by an office query, exactly as
// /api/till-settings/public already is. The two do not share a path, which is
// deliberate — see the note at the top of src/screens.js.
app.use('/api', screensRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', tillScreenRoutes({ pool }));
// Beside the screens, and split the same way: the authed half for the back
// office, the /till/ half for terminals. A modifier group's buttons arrive
// with the screens above, not from these routes.
app.use('/api', modifierRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', tillModifierRoutes({ pool }));
// And the lettering those buttons wear. Split the same way again, with one
// difference worth knowing about: the till's *upload* takes a terminal token
// rather than an office query, because it writes a file to our disk. See the
// note at the top of src/fonts.js.
app.use('/api', fontsRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', tillFontRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use(tillKitchenRoutes({ pool, broadcast, secret: JWT_SECRET }));

// Terminals that know about each other: the shared open bills behind a table
// plan two tills can both see, one clerk in one place at a time, and the time
// clock. Split the usual way -- the tills' half at the root, authorised by the
// terminal token rather than by an office query, because unlike a price list
// these routes carry what customers have ordered and who is on shift.
app.use(terminalRoutes({ pool, broadcast, secret: JWT_SECRET }));
app.use('/api', timesheetRoutes({ pool, broadcast, secret: JWT_SECRET }));

// Which machines a venue has and what has happened to them. Mounted once at
// the root because the routes inside carry their own absolute paths: the tills
// write through /till/devices with a terminal token, the back office reads
// /api/devices with a session one, and they are two halves of one table.
app.use(deviceRoutes({ pool, broadcast, secret: JWT_SECRET }));

// Magnetic swipe cards: staff, loyalty and gift. Mounted once at the root for
// the same reason devices is -- the tills' half and the back office's half are
// two views of one set of tables, and splitting them across two mounts would
// put them in two places to read.
app.use(cardRoutes({ pool, broadcast, secret: JWT_SECRET }));
// Bringing a catalogue in from a spreadsheet. Mounted after the CRUD routes
// it writes through, so nothing here can shadow /api/products.
app.use('/api', importRoutes({ pool, broadcast, secret: JWT_SECRET }));

// Reports a venue hands to its accountant, and the schedules that send them.
// Dine-in: the QR menu a customer reads on their own phone, the orders they
// place from it, and everything the back office needs to set it up.
//
// Mounted at the ROOT, and the router states its own full paths — the same
// shape as cards.js and devices.js, and for the same reason. The back office
// and the customer's phone are under /api; the till is not, because every
// other route a till calls is at the root and one that was not simply 404ed.
// The pages a customer actually opens are mounted further down, ahead of the
// static middleware.
app.use(dineinRoutes({ pool, broadcast, secret: JWT_SECRET }));
// Signing in to a menu with a code. Mounted at the root like the rest of
// dine-in, and beside it rather than inside it because it is a self-contained
// piece with its own outside dependency.
app.use(dineinOtpRoutes({ pool, secret: JWT_SECRET }));

/*
 * Signing in to a menu with a Vesopa account — the first product migration.
 *
 * NOT MOUNTED AT ALL unless VESOPA_AUTH_ENABLED is on AND the client
 * credentials are present. That is rule 2 of the migration plan: legacy login
 * ships dormant behind a flag, and rollback is flipping it back and restarting
 * rather than a deploy under pressure with a room full of covers.
 *
 * It is an ADDITION to the code sign-in, never a replacement — and guest
 * ordering, which is what most diners do, is untouched either way.
 */
if (VESOPA_AUTH_ON) {
  app.use(dineinAuthRoutes({ pool, secret: JWT_SECRET }));
  console.log('[boot] Vesopa account sign-in is ON for the menu');
}

/*
 * The back office, migration two. Same rules as the menu: dormant behind its
 * own flag, the password form untouched beside it, and the token it issues is
 * the back office's own — so nothing downstream of sign-in can tell which door
 * somebody came through, and turning it off is a flag rather than a rewrite.
 */
app.use(backofficeAuthRoutes({ pool, secret: JWT_SECRET, issueToken }));
if (VESOPA_BACKOFFICE_LIVE) {
  console.log('[boot] Vesopa account sign-in is ON for the back office');
}

/*
 * The till, migration four — and the one that is not a browser.
 *
 * A till is a PUBLIC client: it ships to venues and holds no secret, so it runs
 * the code flow itself with PKCE against a loopback address and hands the ID
 * token here. This endpoint verifies it and issues the terminal token, which is
 * the same credential `/api/login` hands a till that signed in with a password.
 */
app.use(terminalVesopaRoutes({ pool, secret: JWT_SECRET, issueToken, issueTerminalToken }));
if (VESOPA_TILL_LIVE) {
  console.log('[boot] Vesopa account commissioning is ON for tills');
}

app.use('/api', reportRoutes({ pool, secret: JWT_SECRET }));
app.use('/api', reportScheduleRoutes({ pool, secret: JWT_SECRET }));

/**
 * Google Wallet passes.
 *
 * One core is built and handed to both route sets so they share an OAuth token
 * cache — the token is good for an hour, and a customer scanning a QR should
 * not cause a second exchange with Google just because a different router
 * served the request.
 *
 * The public half is mounted at the root and *before* the static middleware and
 * the client-side routing shell, so /wallet/join/... resolves here rather than
 * being answered with the back-office single-page app.
 */
const wallet = walletCore({ pool, secret: JWT_SECRET });
app.use('/api', walletRoutes({ pool, broadcast, secret: JWT_SECRET, core: wallet }));
app.use(walletPublicRoutes({ pool, secret: JWT_SECRET, core: wallet }));

// Apple Wallet, sharing the same core so both platforms read one set of brand
// settings and one subject loader. Mounted at the root: it carries both the
// customer-facing /wallet/c/:token link -- which serves an iPhone a .pkpass and
// redirects everything else to the Google half -- and its own /api routes.
app.use(appleWalletRoutes({ pool, secret: JWT_SECRET, core: wallet }));

// The pages a card links out to — rewards, membership, gift-card balance and
// what's on. Mounted at the root beside the other customer-facing wallet links
// and before the static middleware, for the same reason they are: /wallet/...
// has to resolve here rather than being answered with the back-office SPA.
app.use(walletPageRoutes({ pool, secret: JWT_SECRET, core: wallet }));

// The pass artwork. Public on purpose and safe to be: it is the same branded
// bands that go inside every .pkpass, with nothing in them that is not already
// on a card in a customer's pocket. The back office's live preview reads them
// from here, and Google Wallet -- which fetches artwork itself, with no
// credentials -- can be pointed at them too.
app.use(
  '/assets/wallet',
  express.static(path.join(__dirname, '..', 'assets', 'wallet'), {
    maxAge: '7d',
    immutable: false,
  })
);

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
              discount_minor, promotion_name, is_modifier
       FROM epos_order_lines WHERE order_id = ? ORDER BY line_no`,
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
    /*
     * THE MEMBERSHIP AND THE FACE TRAVEL WITH THE NAME.
     *
     * This is the endpoint behind the Customer key, and until now it answered
     * with a name, a phone number and a discount and nothing else. That is the
     * whole of two of the venue's complaints:
     *
     *   "If a customer has expired, they can still use the loyalty card on the
     *   till" — a clerk who picks the member off this list instead of swiping
     *   their card attaches them with nothing checked, because the till was
     *   never told the membership had run out.
     *
     *   "Photos of customers doesn't show on the till" — the till has drawn
     *   `MemberFace` since 1.6.8.0 and it draws initials when there is no
     *   photograph, which is exactly what a row with no `photo_url` in it
     *   looks like.
     *
     * Both are fixed by sending the two columns. The gate itself lives on the
     * till, in `OrderRepository.attachCustomer`, so that every door is closed
     * by one check rather than four.
     *
     * `points_balance` comes too. It costs nothing here and it is what the
     * customer display now shows beside their name.
     *
     * DATE_FORMAT, not the bare column. mysql2 hands a DATE back as a Date at
     * local midnight and JSON turns that into the previous evening in British
     * summer time — a membership that expires a day early, every summer. Every
     * other read of this column in the codebase formats it for that reason.
     *
     * Falls back when the columns are not there. `photo_url` arrives with
     * schema_membership.sql and the migrations are applied only when the
     * deploy is asked to, so naming a column that does not exist yet would
     * take the Customer key down completely rather than degrade it — the same
     * treatment `member_no` gets on the back-office list route.
     */
    const base = `id, name, phone, email, card_number, discount_type,
                  discount_value, points_balance,
                  DATE_FORMAT(membership_expiry, '%Y-%m-%d') AS membership_expiry`;
    const where = `
       FROM epos_customers
       WHERE email_key = ?
       ${q ? 'AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)' : ''}
       ORDER BY name LIMIT 50`;
    const params = q ? [office, q, q, q] : [office];

    let rows;
    for (const select of [`${base}, photo_url`, base]) {
      try {
        [rows] = await pool.query(`SELECT ${select} ${where}`, params);
        break;
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR' || select === base) throw e;
      }
    }
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
    // Every member gets a number, whichever door they came in through. See
    // src/member_numbers.js for why this is not part of issuing a card.
    await ensureMemberNumber(pool, c.office, id);
    broadcast({ type: 'customers.updated' });
    res.status(201).json({ id });
  } catch (e) {
    next(e);
  }
});

/** Void reasons for the till's confirmation dialog. */
/**
 * The void reasons a till offers.
 *
 * SCOPED, LIKE EVERY OTHER TILL ENDPOINT, AND IT WAS NOT
 *
 * This read had no office on it at all — the handler took `_req`, so the
 * request was never even looked at — and it therefore returned every reason
 * belonging to every venue on the platform. Measured on live: 61 rows where a
 * venue has nine, with "Customer changed their mind" appearing once per office.
 *
 * That is what was reported as the same reason listed over and over on the void
 * dialog. It is not duplicated data — the table is clean, nine rows per venue —
 * it is one venue being shown everybody's.
 *
 * And it is a leak as well as a mess: a reason is free text a manager types, so
 * anything one venue called a reason was being read off every other venue's
 * till.
 *
 * An office is required, as it is on /till/receipts, /till/customers,
 * /till/deals and /till/departments. A till that names none gets the platform
 * defaults rather than everybody's, because the alternative is a void dialog
 * with nothing in it on a till that has not been updated yet — and a clerk who
 * cannot void is a clerk who cannot serve.
 */
/*
 * The five things a venue explains, and the one list each.
 *
 * "In Error Reasons, Can we have reasons for No Sale, Refunds, Voids and
 * Cancel (Void and Cancel is already done just need to split them off."
 *
 * Cancel was not "already done" — the till has been showing the VOID list when
 * a clerk cancels a check, which is why the venue reads it as done and why
 * they want it split. "Rung up in error" explains one line coming off a bill
 * and says nothing about why a whole check was abandoned, and a manager
 * reading the Z report cannot tell the two apart afterwards.
 *
 * A whitelist rather than passing the query through. `applies_to` is a free
 * string column, and a till asking for a value nothing seeds would get an
 * empty list and a dialog a clerk cannot get past.
 */
const REASON_ACTIONS = ['void', 'cancel', 'refund', 'no_sale', 'discount'];

/**
 * What a venue calls the reasons for one action.
 *
 * Scoped by office, like every other /till read, and for a reason worth
 * repeating: this query once had no office on it at all — the handler took
 * `_req` — so it returned every reason belonging to every venue on the
 * platform. Measured on live: 61 rows where a venue has nine. That was
 * reported as the same reason listed over and over on the void dialog, and it
 * was not duplicated data but one venue being shown everybody's. It is a leak
 * as well as a mess, because a reason is free text a manager types.
 *
 * A till that names no office gets the platform defaults rather than
 * everybody's, because the alternative is an empty dialog on a till that has
 * not been updated yet — and a clerk who cannot void is a clerk who cannot
 * serve.
 */
async function reasonsFor(office, appliesTo) {
  if (!office) {
    const [rows] = await pool.query(
      'SELECT reason FROM bo_error_reasons' +
        ' WHERE applies_to = ? AND office_id IS NULL ORDER BY sort_order, id',
      [appliesTo]
    );
    return rows.map((r) => r.reason);
  }

  const [rows] = await pool.query(
    'SELECT e.reason FROM bo_error_reasons e' +
      '  JOIN offices o ON o.id = e.office_id' +
      ' WHERE e.applies_to = ? AND o.contact_email = ?' +
      ' ORDER BY e.sort_order, e.id',
    [appliesTo, office]
  );
  return rows.map((r) => r.reason);
}

/**
 * One list, named by the action asking for it.
 *
 * Falls back to the void list for `cancel` when a venue has no cancel reasons
 * of its own. The migration seeds one for every office that exists today, so
 * this is for the office created between the migration running and somebody
 * opening the Error Reasons page — and for the venue that deletes every cancel
 * reason it has, which the back office lets them do. Either way the answer is
 * the list the till used yesterday rather than a dialog with nothing in it.
 *
 * No such fallback for the other four: an empty refund or no-sale list is a
 * venue that has not set any up, and the till carries on without asking rather
 * than blocking the drawer. See ui/void_dialog.dart.
 */
app.get('/till/error-reasons', async (req, res, next) => {
  const office = req.query.office;
  const appliesTo = String(req.query.applies_to || 'void');
  if (!REASON_ACTIONS.includes(appliesTo)) {
    return res.status(400).json({
      error: `applies_to must be one of ${REASON_ACTIONS.join(', ')}`,
    });
  }
  try {
    let reasons = await reasonsFor(office, appliesTo);
    if (!reasons.length && appliesTo === 'cancel') {
      reasons = await reasonsFor(office, 'void');
    }
    res.json(reasons);
  } catch (e) {
    next(e);
  }
});

/**
 * The old route, kept exactly as it was.
 *
 * Every till in every venue on 1.6.8.0 and earlier calls this and expects a
 * bare JSON array of strings. It delegates rather than being rewritten, so the
 * two can never drift, and it is not deprecated in any way a till can notice —
 * a Store rollout takes days to reach every terminal and the ones still on the
 * old build have to keep being able to void.
 */
app.get('/till/void-reasons', async (req, res, next) => {
  try {
    res.json(await reasonsFor(req.query.office, 'void'));
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
          voided_at, terminal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // Which till the void was rung on. "Where are the voids coming from"
        // is the question this log exists to answer and could not.
        v.terminal ?? null,
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
    // swipe_card comes down with the PIN, and for the same reason: a staff card
    // has to sign somebody on with the broadband down, so the check happens
    // against the till's own cache.
    //
    // TRIED, THEN FALLEN BACK FROM, RATHER THAN ASSUMED
    //
    // `swipe_card` is added by schema_swipe_cards.sql, and deploy.ps1 applies the
    // migrations only when it is asked to (`-Schema`). So there is a real
    // window in which this code is live and the column is not -- and naming a
    // column that does not exist is not a degraded response, it is an error,
    // which would take *staff sign-on itself* down across every till in the
    // venue for the sake of a feature none of them is using yet.
    //
    // A till that gets no swipe_card simply has no staff cards, which is
    // exactly true on a venue that has not run the migration.
    // PERMISSIONS COME DOWN FOR THE SAME REASON THE PIN DOES
    //
    // A manager approving a void at eight on a Friday cannot wait for the
    // broadband. So the group's switches travel with the staff list and the
    // till decides locally, exactly as it already does for the PIN and the
    // staff card.
    const columns = TILL_COLUMNS.map((c) => `g.${c}`).join(', ');

    const WITH_CARD = `
      SELECT c.id, c.pluid, c.clark_name AS name, c.pin_code AS pin,
             COALESCE(c.swipe_card, '') AS swipe_card,
             c.permission_group_id, g.name AS permission_group, ${columns}
        FROM bo_clarks c
        LEFT JOIN epos_permission_groups g
               ON g.id = c.permission_group_id AND g.email = c.email
       WHERE c.email = ? AND COALESCE(c.active, 1) = 1
       ORDER BY c.pluid, c.clark_name`;

    const WITHOUT_CARD = `
      SELECT c.id, c.pluid, c.clark_name AS name, c.pin_code AS pin,
             c.permission_group_id, g.name AS permission_group, ${columns}
        FROM bo_clarks c
        LEFT JOIN epos_permission_groups g
               ON g.id = c.permission_group_id AND g.email = c.email
       WHERE c.email = ? AND COALESCE(c.active, 1) = 1
       ORDER BY c.pluid, c.clark_name`;

    // The oldest shape of all: no card column and no permissions table. A till
    // talking to a server whose migrations have not been run must still be able
    // to sign somebody on, so each fallback drops one thing rather than
    // failing.
    const PLAIN = `
      SELECT id, pluid, clark_name AS name, pin_code AS pin
        FROM bo_clarks
       WHERE email = ? AND COALESCE(active, 1) = 1
       ORDER BY pluid, clark_name`;

    let rows;
    try {
      [rows] = await pool.query(WITH_CARD, [req.office]);
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
      try {
        [rows] = await pool.query(WITHOUT_CARD, [req.office]);
      } catch (e2) {
        if (e2.code !== 'ER_BAD_FIELD_ERROR' && e2.code !== 'ER_NO_SUCH_TABLE') throw e2;
        [rows] = await pool.query(PLAIN, [req.office]);
      }
    }

    // A clerk in no group is unrestricted, which is what every clerk was before
    // permission groups existed. Sent as a filled-in object rather than as a
    // null the till has to interpret: "no group" and "a group with nothing
    // ticked" are opposite answers, and the till must never have to guess which
    // one an absent field meant.
    rows = rows.map((row) => {
      const grouped = row.permission_group_id != null && row.permission_group;
      const permissions = {};
      for (const column of TILL_COLUMNS) {
        permissions[column] = grouped ? row[column] === 1 : true;
      }
      const clean = { ...row };
      for (const column of TILL_COLUMNS) delete clean[column];
      return { ...clean, permissions };
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/**
 * The roles a new member of staff can be given, for the till's own form.
 *
 * "This should ask for their name, role and either pin or to swipe a new staff
 * card." Role means a permission group: it is what actually decides whether
 * somebody may void a line or open the drawer, and picking one from a list is
 * the only way a manager standing at the counter can get it right.
 *
 * Names only. The switches inside a group already travel with `/till/staff`,
 * so there is nothing here worth a second copy of them.
 */
app.get('/till/permission-groups', requireTerminal(JWT_SECRET), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name FROM epos_permission_groups
        WHERE email = ? ORDER BY sort_order, name`,
      [req.office]
    );
    res.json(rows);
  } catch (e) {
    // A venue whose migrations predate permission groups has no roles to
    // offer, which is not an error — it is a venue where every clerk is
    // unrestricted. An empty list lets the till draw the form without one.
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    next(e);
  }
});

/**
 * Take somebody on, from the till.
 *
 * "Ability to add staff members from the function screen." A new starter
 * arrives at four on a Friday and cannot ring anything up until somebody with
 * a back-office login has been found — which in a venue with one manager and
 * no office computer means they cannot start.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not touch cards. `POST /till/cards/assign` already exists, already
 * knows this venue's prefixes and already refuses a card that belongs to
 * somebody else *by name*. The till creates the person here and then assigns
 * the card there, so there is one implementation of what a staff card is.
 *
 * The rules are the back office's rules, enforced identically, because a
 * member of staff created here has to be able to sign on there:
 *
 *   * a PIN is exactly four digits — the pad submits on the fourth key, so a
 *     five-digit PIN creates somebody who can never sign on at all;
 *   * a PIN already in use is refused, naming its holder, because two people
 *     on one PIN means every sale either of them rings up is recorded against
 *     whichever row was found first.
 *
 * A PIN is optional here and is not in the back office, and that is the one
 * difference. It is the "or swipe a new staff card" half of the ask: the till
 * creates the person, then writes the card onto them. The till is responsible
 * for not leaving somebody with neither — see the Functions screen.
 */
app.post('/till/staff', requireTerminal(JWT_SECRET), async (req, res, next) => {
  try {
    const office = req.office;
    const name = String(req.body?.name || '').trim().slice(0, 190);
    if (!name) return res.status(400).json({ error: 'A name is required.' });

    const pin = req.body?.pin == null ? '' : String(req.body.pin).trim();
    if (pin && !/^\d{4}$/.test(pin)) {
      return res.status(400).json({
        error: 'A PIN must be exactly 4 digits, numbers only.',
      });
    }

    if (pin) {
      const [[clash]] = await pool.query(
        'SELECT clark_name FROM bo_clarks WHERE email = ? AND pin_code = ?',
        [office, pin]
      );
      if (clash) {
        return res.status(409).json({
          error: `That PIN is already in use by ${clash.clark_name}.`,
        });
      }
    }

    // The role, checked against this venue's own groups. An id from another
    // venue would otherwise hand somebody that venue's switches.
    let groupId = null;
    if (req.body?.permission_group_id != null && req.body.permission_group_id !== '') {
      const id = Number(req.body.permission_group_id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'That role does not exist.' });
      }
      const [[group]] = await pool.query(
        'SELECT id FROM epos_permission_groups WHERE id = ? AND email = ?',
        [id, office]
      );
      if (!group) return res.status(400).json({ error: 'That role does not exist.' });
      groupId = id;
    }

    // The next clerk number, per venue. `pluid` is how the till's own reports
    // group a shift, and two people sharing one would merge their takings.
    const [[{ next_pluid: pluid }]] = await pool.query(
      'SELECT COALESCE(MAX(pluid), 0) + 1 AS next_pluid FROM bo_clarks WHERE email = ?',
      [office]
    );

    const values = [office, pluid, name, pin || null, 1];
    let result;
    try {
      [result] = await pool.execute(
        `INSERT INTO bo_clarks
           (email, pluid, clark_name, pin_code, active, permission_group_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [...values, groupId]
      );
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      [result] = await pool.execute(
        `INSERT INTO bo_clarks (email, pluid, clark_name, pin_code, active)
         VALUES (?, ?, ?, ?, ?)`,
        values
      );
    }

    broadcast({ type: 'staff.updated' });
    res.status(201).json({
      id: result.insertId,
      pluid,
      name,
      pin: pin || '',
      swipe_card: '',
      permission_group_id: groupId,
    });
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
    //
    // The shape of the room and the colours come with it. This route used to
    // select the name and nothing else, so a venue that had drawn an L in the
    // designer saw it in the back office and on a customer's phone, and the
    // till — the one screen staff actually work from — went on showing a plain
    // rectangle. The till knew how to draw the walls; the walls were simply
    // never sent to it.
    const [rooms] = await pool.query(
      `SELECT r.id, r.name, r.outline, r.floor_colour, r.wall_colour
       FROM floor_rooms r
       JOIN offices o ON o.id = r.office_id
       WHERE o.contact_email = ?
       ORDER BY r.sort_order, r.id`,
      [office]
    );
    const [tables] = await pool.query(
      `SELECT t.id, t.room_id, t.table_number, t.label, t.pos_x, t.pos_y,
              t.width, t.height, t.shape, t.seats, t.colour
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

/* ---------------------------------------------------------------------------
   LAYING OUT THE FLOOR FROM THE TILL

   The designer has always been a back-office screen, which means arranging a
   room happens on a laptop in an office, from memory, about a room the person
   is not standing in. The obvious place to do it is on the till, on the floor,
   looking at the tables — so these are the same three writes the designer
   makes, reachable by a commissioned terminal.

   WHAT MAKES THIS SAFE ENOUGH TO EXPOSE

   The office comes from the terminal's own token and never from the request.
   requireTerminal puts it there after verifying the signature, so a till can
   only ever rewrite its own venue's plan; passing somebody else's office in the
   body changes nothing, because the body is not consulted for it.

   Every row touched is matched on office_id as well as on id. That is belt and
   braces over the first rule, and it is the rule that actually held the day the
   designer's own reads were unscoped and one venue could see another's layout.

   These do not replace the back office. A venue that would rather arrange its
   floor on a big screen still can, and both write the same rows.
   --------------------------------------------------------------------------- */

/**
 * A table's permanent public address.
 *
 * The same shape the designer mints, and for the same reason: this is what is
 * printed on the card that sits on the table, so it is generated once and never
 * again — a rename, a renumber or a move to another room must not invalidate a
 * card somebody has already laminated.
 *
 * Spelled out here rather than shared with programming.js, where it is a
 * closure inside the route factory. Exporting it would mean either widening
 * that module's surface or restructuring it, and this is one line of crypto
 * whose only requirement is that it does not collide.
 */
function newPublicId() {
  return require('crypto').randomUUID().replace(/-/g, '');
}

/** The office id behind the email a terminal token carries. */
async function terminalOfficeId(office) {
  const [[row]] = await pool.query(
    'SELECT id FROM offices WHERE contact_email = ?',
    [office]
  );
  return row ? row.id : null;
}

/**
 * A colour a picker wrote, or null.
 *
 * Six hex digits and a hash. Refused rather than corrected: this ends up in a
 * style attribute on a page other people read, and a "colour" that is really a
 * string of CSS is a way of styling somebody else's screen.
 */
function tillColour(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : null;
}

/** Corners in grid squares, clamped, as JSON text — or null for a rectangle. */
function tillOutline(raw) {
  if (raw == null || raw === '') return null;
  let points = raw;
  if (typeof raw === 'string') {
    try {
      points = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(points) || points.length < 3) return null;

  const clean = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // A corner at -4 or at 900 is a dragging accident, and a room drawn off the
    // plan cannot be dragged back because its handles are off the plan too.
    clean.push([
      Math.max(0, Math.min(200, Math.round(x))),
      Math.max(0, Math.min(200, Math.round(y))),
    ]);
  }
  return JSON.stringify(clean);
}

/** Where the tables are, after a drag. */
/**
 * Create a product from the till, for a barcode nobody has met before.
 *
 * The venue's request: "if a new barcode is scanned on the till ask if you want
 * to create a new product asking for product name, price, tax rate, sub
 * department and department."
 *
 * WHY THIS ROUTE EXISTS AT ALL
 *
 * The till can already edit a product, but only in its own database — the
 * Products screen says "updated on this terminal" and means it. That is fine
 * for a stock adjustment nobody else needs. It is useless here: a product
 * created only on the terminal that scanned it is wiped by the next catalogue
 * sync, and does not exist on the till at the other end of the bar. A new
 * product has to reach the back office or it is not a product.
 *
 * Terminal token, not a session: nobody is signed into a back office at the
 * counter with a case of stock in front of them. `req.office` is the venue's
 * contact email, which is exactly the key bo_products is scoped by — see
 * terminalOfficeId for the one place that is not true.
 *
 * The PLU is allocated the same way the back office allocates one, and
 * deliberately not accepted from the till: a terminal choosing its own numbers
 * would collide with the next product a manager adds, and the collision would
 * surface as two different things ringing up as each other.
 */
app.post('/till/products', requireTerminal(JWT_SECRET), async (req, res, next) => {
  const body = req.body || {};
  try {
    const office = req.office;

    const name = String(body.product_name ?? '').trim().slice(0, 190);
    if (!name) return res.status(400).json({ error: 'Give the product a name.' });

    // Digits and letters only, and never blank here: this route exists because
    // a barcode was scanned, and a product created without one would be a
    // product the scan that prompted it still cannot find.
    const barcode = String(body.barcode ?? '')
      .replace(/[^0-9A-Za-z-]/g, '')
      .slice(0, 64);
    if (!barcode) return res.status(400).json({ error: 'No barcode.' });

    // Already known is not an error — two tills scanning the same new case at
    // once is an ordinary Tuesday. Answer with the product that exists so the
    // till rings it up instead of showing a failure nobody can act on.
    const [[existing]] = await pool.query(
      'SELECT pluid, product_name FROM bo_products WHERE email = ? AND barcode = ? LIMIT 1',
      [office, barcode]
    );
    if (existing) {
      return res.json({
        pluid: existing.pluid,
        product_name: existing.product_name,
        already: true,
      });
    }

    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Give the product a price.' });
    }
    const tax = Number(body.tax_percentage);

    const [[row]] = await pool.query(
      'SELECT COALESCE(MAX(pluid), 0) + 1 AS next FROM bo_products WHERE email = ?',
      [office]
    );
    const pluid = row.next;

    await pool.execute(
      `INSERT INTO bo_products
         (email, pluid, product_name, department_name, group_name,
          price, tax_percentage, stock_quantity, print_to_receipt, barcode)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      [
        office,
        pluid,
        name,
        String(body.department_name ?? '').trim().slice(0, 190) || null,
        String(body.group_name ?? '').trim().slice(0, 190) || null,
        price,
        Number.isFinite(tax) && tax >= 0 ? tax : 0,
        barcode,
      ]
    );

    // Every till, not just this one. The terminal that scanned it will pick the
    // product up on the same refresh as the rest of them, so there is no path
    // where one till has it and the others do not.
    broadcast({ type: 'catalogue.updated' });
    res.status(201).json({ pluid, product_name: name, already: false });
  } catch (e) {
    next(e);
  }
});

app.put('/till/floor/tables', requireTerminal(JWT_SECRET), async (req, res, next) => {
  const tables = Array.isArray(req.body && req.body.tables) ? req.body.tables : [];
  if (!tables.length) return res.json({ ok: true, saved: 0 });

  let conn;
  try {
    const officeId = await terminalOfficeId(req.office);
    if (officeId == null) {
      return res.status(400).json({ error: 'This terminal has no venue.' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();
    for (const t of tables) {
      // Matched on the office as well as the id, so a drag on one venue's till
      // can never move a table belonging to another.
      await conn.execute(
        'UPDATE floor_tables' +
          '   SET pos_x = ?, pos_y = ?, width = ?, height = ?,' +
          '       shape = ?, seats = ?, colour = ?' +
          ' WHERE id = ? AND office_id = ?',
        [
          Math.max(0, Math.min(200, Number(t.pos_x) || 0)),
          Math.max(0, Math.min(200, Number(t.pos_y) || 0)),
          Math.max(1, Math.min(20, Number(t.width) || 2)),
          Math.max(1, Math.min(20, Number(t.height) || 2)),
          t.shape === 'circle' ? 'circle' : 'rect',
          Math.max(0, Math.min(99, Number(t.seats) || 4)),
          tillColour(t.colour),
          Number(t.id),
          officeId,
        ]
      );
    }
    await conn.commit();

    // Every other till in the venue, and the back office, at once.
    broadcast({ type: 'floor.updated' });
    res.json({ ok: true, saved: tables.length });
  } catch (e) {
    if (conn) await conn.rollback();
    next(e);
  } finally {
    if (conn) conn.release();
  }
});

/** A new table, put down on the floor somebody is standing on. */
app.post('/till/floor/tables', requireTerminal(JWT_SECRET), async (req, res, next) => {
  const body = req.body || {};
  try {
    const officeId = await terminalOfficeId(req.office);
    if (officeId == null) {
      return res.status(400).json({ error: 'This terminal has no venue.' });
    }

    const roomId = Number(body.room_id);
    const [[room]] = await pool.query(
      'SELECT id FROM floor_rooms WHERE id = ? AND office_id = ?',
      [roomId, officeId]
    );
    if (!room) return res.status(400).json({ error: 'That room is not yours.' });

    const number = Number(body.table_number);
    if (!Number.isInteger(number) || number < 1) {
      return res.status(400).json({ error: 'Give the table a number.' });
    }

    // A name has to be unique across the venue and not merely within the room:
    // a runner carrying food to "Window" is not helped by being told there are
    // two of them in different rooms.
    const name = String(body.name || '').trim() || null;
    if (name) {
      const [[clash]] = await pool.query(
        'SELECT id FROM floor_tables WHERE office_id = ? AND LOWER(name) = LOWER(?)',
        [officeId, name]
      );
      if (clash) {
        return res.status(409).json({
          error: 'There is already a table called "' + name + '".',
        });
      }
    }

    const [r] = await pool.execute(
      'INSERT INTO floor_tables' +
        ' (office_id, room_id, table_number, name, public_id, qr_enabled,' +
        '  pos_x, pos_y, width, height, shape, seats, colour)' +
        ' VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
      [
        officeId,
        roomId,
        number,
        name,
        // Minted here and never again: this is the address printed on the card
        // that sits on the table, so it has to survive every rename and move.
        newPublicId(),
        Math.max(0, Math.min(200, Number(body.pos_x) || 0)),
        Math.max(0, Math.min(200, Number(body.pos_y) || 0)),
        Math.max(1, Math.min(20, Number(body.width) || 2)),
        Math.max(1, Math.min(20, Number(body.height) || 2)),
        body.shape === 'circle' ? 'circle' : 'rect',
        Math.max(0, Math.min(99, Number(body.seats) || 4)),
        tillColour(body.colour),
      ]
    );

    broadcast({ type: 'floor.updated' });
    res.status(201).json({ id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'Table ' + body.table_number + ' already exists.',
      });
    }
    next(e);
  }
});

/** The shape of the room, walked out on the floor it describes. */
app.put('/till/floor/rooms/:id', requireTerminal(JWT_SECRET), async (req, res, next) => {
  const body = req.body || {};
  try {
    const officeId = await terminalOfficeId(req.office);
    if (officeId == null) {
      return res.status(400).json({ error: 'This terminal has no venue.' });
    }

    const sets = [];
    const params = [];
    if (body.outline !== undefined) {
      sets.push('outline = ?');
      params.push(tillOutline(body.outline));
    }
    for (const field of ['floor_colour', 'wall_colour']) {
      if (body[field] === undefined) continue;
      sets.push(field + ' = ?');
      params.push(tillColour(body[field]));
    }
    if (!sets.length) return res.json({ ok: true, changed: 0 });

    const [r] = await pool.execute(
      'UPDATE floor_rooms SET ' + sets.join(', ') + ' WHERE id = ? AND office_id = ?',
      [...params, Number(req.params.id), officeId]
    );
    if (!r.affectedRows) {
      return res.status(404).json({ error: 'That room is not yours.' });
    }

    broadcast({ type: 'floor.updated' });
    res.json({ ok: true, changed: r.affectedRows });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// The back-office single-page app
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Every asset URL carries a hash of its own contents, and the page that points
 * at them is never cached.
 *
 * The fault this fixes was reported from an iPad and is not a subtle one: a
 * layout fix deployed on one day was still not visible on that iPad days later,
 * because Safari was serving a `/style.css` it already had and there is no
 * gesture on iOS that reliably clears it. See src/assets.js.
 */
const assets = assetVersions(PUBLIC_DIR);

/** The app shell, with a version on every asset it references. */
const shell = assets.rewrite(
  fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
);

function sendShell(_req, res) {
  // `no-store`, not `no-cache`. This document is a few kilobytes and it is the
  // thing that names every other URL — a stale copy of it points at the old
  // stylesheet by name, and versioning the stylesheet achieves nothing.
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.type('html').send(shell);
}

// Before the static middleware, or `express.static` answers /index.html with
// the file on disk and the rewrite never runs.
/**
 * The customer-facing dine-in pages: /t/<table>, /m/<venue>, /o/<order>, and —
 * on the menu host only — /<venue> and / itself.
 *
 * Mounted at the root and ahead of the shell, the static middleware and the
 * back office's catch-all, because these are the addresses printed on cards
 * that get laminated and stood on tables. Anything that could shadow them has
 * to lose.
 *
 * Ahead of the `/` shell route specifically: menu.vesopaepos.com/ has its own
 * page saying what that address is for, and with the shell registered first it
 * was answered with the back office sign-in instead. Every route in here that
 * is not host-guarded is a prefix no venue can claim — see RESERVED in
 * dinein.js — and the host-guarded ones call next() on every other host, so the
 * back office's own routing is untouched.
 */
app.use(dineinPageRoutes({ pool }));

/**
 * The back office does not exist on a customer's menu address.
 *
 * `express.static` served the whole of public/ on every hostname, so
 * menu.vesopaepos.com and a venue's own domain both handed out index.html,
 * app.js and style.css — the entire back office bundle, on an address printed
 * on a card and given to the public. No data leaked, because every API route
 * behind it still refused without a token, but it is a hundred kilobytes of
 * somebody else's application on a venue's own domain, and a sign-in page
 * where a menu should be.
 *
 * Two prefixes stay, because the menu itself uses them: /assets for the marks
 * and the icons, and /uploads for the venue's own photographs.
 */
const MENU_ONLY_PREFIXES = ['/assets/', '/uploads/'];
app.use(async (req, res, next) => {
  try {
    if (!(await isMenuAddress(pool, req))) return next();
  } catch (e) {
    // A lookup that failed is not a reason to stop serving anything — but it
    // is a reason to say so. This catch silently swallowed a ReferenceError
    // for an import that was never added, which turned the whole guard into a
    // no-op that looked deployed and tested clean.
    console.warn('[menu-host] could not decide the host, serving anyway:', e.message);
    return next();
  }
  if (MENU_ONLY_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();
  // Anything else here is the back office, and it is not what this address is
  // for. Answered rather than passed on: there is nothing at this address to
  // send anybody to.
  return res.status(404).type('txt').send('Not found');
});

app.get(['/', '/index.html'], sendShell);

app.use(express.static(PUBLIC_DIR, { setHeaders: staticCache }));

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
      // `printer_route` rides along beside `printer_routes` for terminals on
      // the previous release, which only know the singular field. See
      // schema_product_printing.sql.
      // The category's *name and order*, not its id: the till prints a heading
      // and sorts by a number, and neither is a foreign key it has any use for.
      // Joined here so a terminal never has to hold a second table to render a
      // ticket.
      `SELECT p.pluid, p.product_name, p.department_name, p.group_name,
              p.accounting_code, p.price, p.tax_percentage, p.stock_quantity,
              p.button_position, p.button_color, p.printer_route,
              p.printer_routes, p.print_to_receipt, p.emoji, p.image_url,
              p.is_modifier, p.barcode, p.allergens,
              p.price_2, p.price_3, p.price_4, p.price_5, p.price_6,
              -- "Set a check box on a product (Renews membership)". Which
              -- lines on a bill move a member's expiry when it is paid for.
              -- Any number of products may carry it — full, concession,
              -- junior and social are four products and one meaning, which is
              -- what the single named PLU it replaces could not express.
              p.renews_membership,
              pc.name AS print_category, pc.sort_order AS print_category_order
       FROM bo_products p
       LEFT JOIN bo_print_categories pc
              ON pc.id = p.print_category_id AND pc.email = p.email
       WHERE p.email = ?
       ORDER BY p.button_position IS NULL, p.button_position`,
      [office]
    );
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      // The price-level columns arrive with schema_price_levels.sql, and
      // deploy.sh applies migrations only when it is asked to. A till that
      // cannot read its catalogue cannot sell, so a missing column costs the
      // extra prices rather than the whole product list — the same fallback
      // /till/staff makes for swipe_card, for the same reason.
      try {
        const [rows] = await pool.query(
          `SELECT pluid, product_name, department_name, group_name,
                  accounting_code, price, tax_percentage, stock_quantity,
                  button_position, button_color, printer_route, printer_routes,
                  print_to_receipt, emoji, image_url
           FROM bo_products
           WHERE email = ?
           ORDER BY button_position IS NULL, button_position`,
          [office]
        );
        return res.json(rows);
      } catch (fallbackError) {
        return next(fallbackError);
      }
    }
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
          customer_phone, split_group, split_index, split_count, staff_id,
          room_id, terminal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // Which room the table is in. A table number is only unique within one,
        // so without this two rooms' Table 1 are the same table in every report
        // that groups by it.
        order.room_id ?? null,
        // Which machine took the money. Null from a till on an older build,
        // and left null rather than guessed -- reports show those as Unknown,
        // which is the truth about a sale nobody recorded a terminal for.
        order.terminal ?? null,
      ]
    );

    // Zero rows means we already hold this sale. Report it as a duplicate and
    // do NOT re-insert the lines, or a retry would double the takings.
    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(409).json({ status: 'duplicate', id: order.id });
    }

    // Indexed, so the bill keeps the order it was rung in. The id is a UUID
    // primary key and there is nothing else to sort by — see
    // schema_screens_modifiers_lines.sql.
    for (const [lineNo, line] of (order.lines || []).entries()) {
      await conn.execute(
        `INSERT INTO epos_order_lines
           (id, order_id, plu_id, name, quantity, unit_price_minor,
            tax_percentage, note, discount_minor, promotion_id, promotion_name,
            added_by, added_at, is_modifier, line_no)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // Whether this line hangs off the one above it. A till on the
          // previous version sends neither field, and every one of its lines is
          // an item in its own right — which is what the defaults say.
          line.is_modifier ? 1 : 0,
          lineNo,
        ]
      );
    }

    // ----------------------------------------------------------------------
    // Take what was sold off the shelf
    // ----------------------------------------------------------------------
    //
    // Nothing did this. `stock_quantity` was written by the product editor and
    // by the importer, read by the reports, and never moved by a sale — so a
    // venue counting stock in and then selling all week saw the same number it
    // typed on Monday. Reported as "order completed, stock should decrease.
    // Why not decreasing?", and the answer was that no code anywhere did it.
    //
    // WHY IT IS HERE
    //
    // Inside the same transaction as the lines, and after the duplicate check
    // above. That check returns early on a sale we already hold, so a till
    // retrying a sync cannot take the same items off twice — which is the one
    // way an automatic stock movement does real damage.
    //
    // WHAT IT LEAVES ALONE
    //
    //   * Products with a NULL stock_quantity. Null means "not counted" and is
    //     the default for most of a catalogue: a pub does not track pints of
    //     lager as units. Only a product somebody has actually put a number on
    //     is moved.
    //   * Modifier lines. "Extra sausage" is a line on the bill and generally
    //     not a product with its own shelf; when it is, it has its own PLU and
    //     is rung as an item.
    //
    // It is allowed to go negative rather than clamping at zero. A negative
    // count is how a venue finds out the shelf was wrong, and silently
    // stopping at zero hides exactly the discrepancy this exists to surface.
    //
    // The same account the sale was filed under. `order.email` is the venue,
    // and 'default' is what a till on an older build sends — both are already
    // used for the order row above, and stock has to be scoped identically or
    // one venue's sale moves another venue's shelf.
    const stockOwner = order.email || 'default';
    for (const line of order.lines || []) {
      if (line.is_modifier) continue;
      const qty = Number(line.quantity ?? 1);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      await conn.execute(
        `UPDATE bo_products
            SET stock_quantity = stock_quantity - ?
          WHERE email = ? AND pluid = ? AND stock_quantity IS NOT NULL`,
        [qty, stockOwner, line.plu_id]
      );
    }

    for (const payment of order.payments || []) {
      await conn.execute(
        `INSERT INTO epos_payments
           (id, order_id, method, amount_minor, cash_breakdown,
            reference, gratuity_minor, entry_mode)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          payment.method,
          payment.amount_minor,
          // Which notes were handed over, when the clerk counted them in on
          // the till's cash keys. Null for card and for keyed-in cash.
          payment.cash_breakdown ?? null,
          // The acquirer's own id for this payment — Dojo's paymentIntentId.
          // The column has existed since schema_commerce.sql but nothing ever
          // wrote it, which left every card sale unlinkable to the acquirer:
          // no matched refund, and no way for a Dojo webhook to find the sale
          // it is talking about. Null for cash.
          payment.reference ?? null,
          payment.gratuity_minor ?? 0,
          // 'terminal' | 'manual' | 'hosted' | 'native' — a keyed card carries
          // different interchange and different liability from a dipped one,
          // and the card report has to be able to tell them apart.
          payment.entry_mode ?? null,
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

/**
 * End-of-day figures, computed from what was actually taken.
 *
 * `office` is required, exactly as it is on `/till/receipts` above. Both are
 * open routes a terminal reaches without a token, and this one answered with
 * the day's takings of every venue on the platform added together — a figure
 * that was wrong for whoever asked and private to everybody else.
 */
app.get('/reports/end-of-day', async (req, res, next) => {
  const office = req.query.office;
  if (!office) return res.status(400).json({ error: 'An office is required.' });

  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const [[totals]] = await pool.query(
      `SELECT COUNT(*)                        AS orders,
              COALESCE(SUM(total_minor), 0)   AS gross_minor,
              COALESCE(SUM(tax_minor), 0)     AS tax_minor
       FROM epos_orders
       WHERE email = ? AND DATE(closed_at) = ?`,
      [office, date]
    );
    const [byMethod] = await pool.query(
      `SELECT p.method, COALESCE(SUM(p.amount_minor), 0) AS amount_minor
       FROM epos_payments p
       JOIN epos_orders o ON o.id = p.order_id
       WHERE o.email = ? AND DATE(o.closed_at) = ?
       GROUP BY p.method`,
      [office, date]
    );
    res.json({ date, ...totals, by_method: byMethod });
  } catch (err) {
    next(err);
  }
});

/**
 * Deep links, and this is the last route on purpose.
 *
 * The back office routes client-side (/products, /tables, /reports/schedules,
 * …), so a refresh or a pasted URL has to serve the app rather than 404 — the
 * client then reads location.pathname and opens that section.
 *
 * TWO things about it, both learned the hard way:
 *
 *   * **It matches more than one segment.** It used to end `[a-z0-9-]*$`,
 *     which is a single segment with no slash in it, so every one-word route
 *     refreshed fine and the only two that did not were the two report pages —
 *     /reports/financial-summary and /reports/schedules — which 404d. That is
 *     the sort of fault that looks like "refresh is broken" while most of the
 *     app refreshes perfectly.
 *
 *   * **It is registered last, after every real route.** It used to sit above
 *     /till/products and /reports/end-of-day and hold them out by name, in an
 *     exclusion list that a new route has to remember to join. Widening the
 *     pattern to two segments would have swallowed /reports/end-of-day whole
 *     and answered a till's JSON request with a page of HTML. Express matches
 *     in order, so being last means every real route wins by construction and
 *     nothing has to be remembered.
 *
 * The exclusions stay anyway, and are worth keeping: an unknown /api/... should
 * 404 as an API rather than hand a fetch() a page of HTML to choke on. They are
 * anchored to a whole segment, so a future /apiary would not be caught by the
 * `api` in the list.
 */
app.get(
  /^\/(?!(?:api|till|orders|health|assets)(?:\/|$))(?!.*\.[a-z0-9]+$)[a-z0-9-]+(?:\/[a-z0-9-]+)*\/?$/,
  sendShell
);

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

/*
 * The clock behind scheduled reports.
 *
 * Started after `listen`, so a database that is slow to answer delays a report
 * rather than the port opening. The timer is `unref`'d inside, so it can never
 * be the reason a deploy's restart hangs waiting for the process to exit.
 */
startScheduler({ pool });

/*
 * Say at boot which Dojo webhook environments can actually verify a delivery.
 *
 * Worth a line of its own because the failure is silent from the outside: an
 * endpoint with no signing secret still answers, still returns a well-formed
 * error, and still looks alive to anything that curls it — while rejecting
 * every genuine event Dojo sends. Better to see it in the deploy log than to
 * find it in a reconciliation gap a week later.
 */
{
  const wh = webhookStatus();
  const configured = Object.entries(wh)
    .filter(([, on]) => on)
    .map(([env]) => env);
  if (configured.length) {
    console.log(`[dojo] webhook signing configured for: ${configured.join(', ')}`);
  } else {
    console.warn(
      '[dojo] no webhook signing secret set — every Dojo delivery will be ' +
      'rejected. Set DOJO_WEBHOOK_SECRET_SANDBOX and/or _LIVE in .env'
    );
  }
}

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

  /**
   * `{"type":"subscribe","office":"…"}` — which venue this socket belongs to.
   *
   * Only office-scoped pushes need it, and only kitchen tickets are office
   * scoped today. It is not a credential and is not treated as one: what
   * arrives over the socket is a *nudge* carrying an id, and every screen still
   * reads the board over HTTP with a kitchen token that says which office it
   * may read. So the worst a forged subscribe can do is learn that somebody,
   * somewhere, placed an order — and then be refused the order itself.
   *
   * Anything else on this socket is ignored rather than erroring: a client from
   * a future release saying something we do not understand yet must not have
   * its connection dropped for it.
   */
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'subscribe' && typeof msg.office === 'string') {
        ws.office = msg.office.trim() || null;
      }
    } catch {
      // Not JSON. Nothing here reads anything else, so there is nothing to do.
    }
  });
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
