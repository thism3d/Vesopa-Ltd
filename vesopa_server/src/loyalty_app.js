/**
 * The loyalty app: the API it talks to, the back office that runs it, and the
 * notifications it receives.
 *
 * WHAT THE APP IS
 *
 * A venue's own app (white-labelled: its name, logo, colours and fonts) that a
 * member signs in to with their email address. It shows their card as a QR code,
 * their points and their history, and the venue's news. It is one Flutter app
 * (vesopa_loyalty/) delivered two ways: a web app at
 * loyalty.vesopa.com/<slug>/ that installs to a phone's home screen, and a
 * Windows app from the Microsoft Store under the venue's own name.
 *
 * THE QR CODE IS THE CARD NUMBER
 *
 * The same number a Wallet pass carries and a plastic card is printed with, so
 * every till already recognises it. A member who joins in the app is issued a
 * loyalty number from the venue's own prefix and sequence -- exactly what
 * "Issue card" at the till would have given them.
 *
 * SIGNING IN
 *
 * An emailed six-digit code, never a password. A new address joins the scheme
 * (the venue has switched the app on, which is the venue saying members may join
 * here). The customer's token names a session row, so signing out -- on the
 * device, everywhere, or by the venue -- is immediate.
 *
 * NOTIFICATIONS, FOUR WAYS
 *
 *   * Web Push -- phones and browsers (loyalty_push.js).
 *   * Windows -- the venue's Store app, through WNS (loyalty_push.js).
 *   * Location -- "members near the venue now": customers who allowed location
 *     and were last seen within the venue's radius in the last few hours.
 *   * In the app -- every message lands in the app's inbox for every customer
 *     it was for, so declining notifications never means missing the news.
 *
 * Collation: the tables this file creates state utf8mb4_general_ci on `office`;
 * joins to older tables go on the customer id with an explicit COLLATE, never on
 * an office column (see the note in schema_loyalty_app.sql).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const { accessGuard } = require('./permissions');
const { sendMail } = require('./mailer');
const { ensureMemberNumber } = require('./member_numbers');
const { seal, unseal } = require('./express_kiosk');
const push = require('./loyalty_push');
const multer = require('multer');
const { catalogueFor } = require('./fonts');
const QR = require('./qr');
const loyaltyAuth = require('./loyalty_auth');
const loyaltyAccountRoutes = require('./loyalty_account');
const { loyaltyDeletionRoutes } = require('./privacy_provider');
const { appPath, appUrl, RESERVED, NOT_FOUND, LOYALTY_HOST } = require('./loyalty_host');
const loyaltyEmail = require('./loyalty_email');

const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODES_PER_HOUR_EMAIL = 5;
const CODES_PER_HOUR_IP = 40;
const TOKEN_TTL = '365d';
const NEAR_HOURS = 3;
const SESSION_CACHE_MS = 30_000;

/** Where the Flutter web build is served from (vesopa_loyalty/build/web, deployed here). */
const WEB_DIR = process.env.LOYALTY_WEB_DIR || path.join(__dirname, '..', 'loyalty_web');

/**
 * A member's photograph, into the same uploads folder the back office uses.
 * Images only, five megabytes: a phone photograph is a few, and anything
 * larger is a mistake rather than a face.
 */
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.jpg';
      cb(null, `member-${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only a JPEG, PNG or WebP photograph can be used.'));
  },
});

const DEFAULT_BRAND = Object.freeze({
  primary: '#111827',
  accent: '#A5C715',
  background: '#F6F6F1',
  text: '#111111',
});

const HEX = /^#[0-9a-f]{6}$/i;

/** 0.8 to 1.6, in steps the back office offers; anything else is 1. */
const fontScale = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.8 && n <= 1.6 ? Math.round(n * 100) / 100 : 1;
};

/** The venue's news rules: `limit` (default, twelve) or `scroll`. */
const inboxRules = (a) => ({
  mode: a && a.inbox_mode === 'scroll' ? 'scroll' : 'limit',
  limit: Math.min(Math.max(Number(a && a.inbox_limit) || 12, 1), 500),
});
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;

const cleanText = (v, max) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};
const cleanUrl = (v) => {
  const s = cleanText(v, 500);
  if (!s) return null;
  return /^(https:\/\/|\/uploads\/|\/assets\/)/i.test(s) ? s : null;
};
const cleanHex = (v) => {
  const s = cleanText(v, 16);
  return s && HEX.test(s) ? s.toUpperCase() : null;
};
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));
const hashCode = (office, email, code, secret) =>
  crypto.createHmac('sha256', secret).update(`${office}|${email}|${code}`).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Whether a value parses as JSON of the given kind, or the fallback. */
function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Reading a venue's app
// ---------------------------------------------------------------------------

async function readApp(db, office) {
  const [[row]] = await db.query('SELECT * FROM epos_loyalty_app WHERE office = ?', [office]);
  return row || null;
}

async function appBySlug(db, slug) {
  if (!SLUG.test(String(slug || ''))) return null;
  const [[row]] = await db.query(
    'SELECT * FROM epos_loyalty_app WHERE slug = ? AND enabled = 1',
    [String(slug).toLowerCase()]
  );
  return row || null;
}

/** Optional reads: a table a venue's server does not have yet is an empty answer. */
async function maybeOne(db, sql, params) {
  try {
    const [[row]] = await db.query(sql, params);
    return row || null;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return null;
    throw e;
  }
}

/**
 * Everything the app draws, for one venue: its own settings first, then the
 * venue's Wallet-card branding and its dine-in page, so a venue that has
 * branded either already has an app that looks like it before it touches this.
 */
async function brandFor(db, office, app) {
  const [[officeRow]] = await db.query('SELECT id, name FROM offices WHERE contact_email = ?', [office]);
  const wallet = await maybeOne(db, 'SELECT * FROM epos_wallet_settings WHERE office = ?', [office]);
  const dinein = officeRow
    ? await maybeOne(db, 'SELECT display_name, logo_url, accent_colour FROM dinein_venue WHERE office_id = ?', [officeRow.id])
    : null;
  const loyalty = await maybeOne(db, 'SELECT point_value_minor, min_redeem_points FROM epos_loyalty_settings WHERE office = ?', [office]);
  const a = app || {};
  // The venue's own fonts, from the same library its tills use: a family and
  // its faces, each a URL on this server the app downloads and registers.
  let catalogue = [];
  if (a.font_heading || a.font_body) {
    try {
      catalogue = await catalogueFor(db, office);
    } catch {
      catalogue = [];
    }
  }
  const font = (slug) => {
    const f = slug ? catalogue.find((c) => c.slug === slug) : null;
    return f ? { slug: f.slug, family: f.family, faces: f.faces.map((x) => ({ weight: x.weight, url: x.url })) } : null;
  };
  const w = wallet || {};
  const links = parseJson(a.links, {});
  if (!links.website && w.homepage_url) links.website = w.homepage_url;
  if (!links.phone && w.support_phone) links.phone = w.support_phone;
  const lat = a.latitude ?? w.latitude ?? null;
  const lng = a.longitude ?? w.longitude ?? null;
  return {
    slug: a.slug || null,
    name: a.app_name || w.program_name || (dinein && dinein.display_name) || (officeRow && officeRow.name) || 'Loyalty',
    venue: w.issuer_name || (dinein && dinein.display_name) || (officeRow && officeRow.name) || '',
    welcome: a.welcome_text || 'Your card, your points and our latest news.',
    logo: a.logo_url || w.logo_url || (dinein && dinein.logo_url) || null,
    icon: a.icon_url || a.logo_url || w.logo_url || null,
    hero: a.hero_url || w.hero_url || null,
    colours: {
      primary: a.colour_primary || (w.hex_background && HEX.test(w.hex_background) ? w.hex_background : null)
        || (dinein && dinein.accent_colour && HEX.test(dinein.accent_colour) ? dinein.accent_colour : null)
        || DEFAULT_BRAND.primary,
      accent: a.colour_accent || DEFAULT_BRAND.accent,
      background: a.colour_background || DEFAULT_BRAND.background,
      text: a.colour_text || DEFAULT_BRAND.text,
      // The icons. Null means "the main colour", which is what they were
      // before the venue could choose.
      icon: a.colour_icon || null,
    },
    fonts: { heading: font(a.font_heading), body: font(a.font_body) },
    // How much bigger (or smaller) than the app's own type. 1 is as it was.
    font_scale: fontScale(a.font_scale),
    // How the news page keeps its messages: the newest `limit`, or all of
    // them loaded as the page scrolls. Sent so the page can say which it is.
    inbox: inboxRules(a),
    links,
    address: w.address_text || null,
    hours: w.hours_text || null,
    location: lat != null && lng != null
      ? { latitude: Number(lat), longitude: Number(lng), radius_m: Number(a.radius_m) || 400 }
      : null,
    points: {
      value_minor: loyalty ? Number(loyalty.point_value_minor) || 1 : 1,
      min_redeem: loyalty ? Number(loyalty.min_redeem_points) || 0 : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * A loyalty number for a member who joined in the app, from the venue's own
 * prefix and sequence -- the number "Issue card" at the till would have given
 * them (cards.js), so it scans like any other card. Null when the venue has no
 * loyalty prefix, in which case the app shows the member number instead.
 */
async function issueLoyaltyNumber(conn, office, customerId) {
  const settings = await maybeOne(conn, 'SELECT loyalty_prefix, number_digits FROM epos_card_settings WHERE office = ?', [office]);
  // cards.js CARD_DEFAULTS: a venue that has never opened its card settings
  // numbers loyalty cards 9998 + five digits.
  const prefix = String(settings ? (settings.loyalty_prefix || '') : '9998');
  if (!prefix) return null;
  const width = Math.min(Math.max(Number(settings && settings.number_digits) || 5, 4), 12);
  await conn.execute(
    `INSERT INTO epos_card_sequences (office, kind, next_number) VALUES (?, 'loyalty', 2)
     ON DUPLICATE KEY UPDATE next_number = next_number + 1`,
    [office]
  );
  const [[row]] = await conn.query(
    "SELECT next_number FROM epos_card_sequences WHERE office = ? AND kind = 'loyalty'",
    [office]
  );
  const card = `${prefix}${String(Number(row.next_number) - 1).padStart(width, '0')}`;
  await conn.execute('UPDATE epos_customers SET card_number = ? WHERE id = ? AND email_key = ?', [card, customerId, office]);
  return card;
}

async function customerByEmail(db, office, email) {
  const [[row]] = await db.query(
    `SELECT id, name, email, card_number FROM epos_customers
      WHERE email_key = ? AND LOWER(email) = ? ORDER BY created_at LIMIT 1`,
    [office, String(email).toLowerCase()]
  );
  return row || null;
}

/** A new member, from the app. A card number straight away, so the QR works at once. */
async function joinScheme(pool, office, { name, email }) {
  const id = crypto.randomUUID();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO epos_customers (id, email_key, name, email, notes)
       VALUES (?, ?, ?, ?, 'Joined in the loyalty app')`,
      [id, office, name, email]
    );
    await issueLoyaltyNumber(conn, office, id);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await ensureMemberNumber(pool, office, id).catch(() => null);
  return id;
}

/** A member already on the books who has no card number yet gets one on first sign-in. */
async function ensureCard(pool, office, customerId) {
  const [[row]] = await pool.query('SELECT card_number FROM epos_customers WHERE id = ? AND email_key = ?', [customerId, office]);
  if (!row || row.card_number) return;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await issueLoyaltyNumber(conn, office, customerId);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.warn('[loyalty_app] could not issue a card number:', e.message);
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Audiences and sending
// ---------------------------------------------------------------------------

/** Customers a message is for: members with the app, narrowed by the audience. */
async function recipientsFor(db, office, audience, app) {
  const kind = audience && audience.kind;
  const where = ['s.office = ?', 's.revoked_at IS NULL', 'c.email_key = ?'];
  const params = [office, office];
  let join = '';
  if (kind === 'tier') {
    where.push('c.tier_name = ?');
    params.push(String(audience.tier || ''));
  } else if (kind === 'lapsed') {
    const days = Math.min(Math.max(Number(audience.days) || 30, 1), 3650);
    where.push('(c.last_visit IS NULL OR c.last_visit < NOW() - INTERVAL ? DAY)');
    params.push(days);
  } else if (kind === 'near') {
    if (!app || app.latitude == null || app.longitude == null) return [];
    // Who was checked and found inside the venue's area lately. No position is
    // kept to measure against: see POST /loyalty/v1/me/location.
    join = `JOIN epos_customer_near n
               ON n.office = s.office AND n.customer_id = s.customer_id
              AND n.near_at >= NOW() - INTERVAL ${NEAR_HOURS} HOUR`;
  }
  const [rows] = await db.query(
    `SELECT DISTINCT c.id
       FROM epos_loyalty_app_sessions s
       JOIN epos_customers c ON c.id = s.customer_id COLLATE utf8mb4_general_ci
       ${join}
      WHERE ${where.join(' AND ')}`,
    params
  );
  return rows.map((r) => r.id);
}

async function channelsFor(db, office, customerIds) {
  if (!customerIds.length) return [];
  const [rows] = await db.query(
    `SELECT * FROM epos_push_channels
      WHERE office = ? AND disabled_at IS NULL AND customer_id IN (?)`,
    [office, customerIds]
  );
  return rows;
}

/** Run [fn] over [items], [limit] at a time. */
async function inBatches(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Deliver one message: into every recipient's inbox, then to every device they
 * have registered. The message row has already been claimed (status 'sending').
 */
async function deliver(pool, message) {
  const office = message.office;
  const app = await readApp(pool, office);
  const brand = await brandFor(pool, office, app);
  const audience = parseJson(message.audience, { kind: 'all' });
  const recipients = await recipientsFor(pool, office, audience, app);

  if (recipients.length) {
    const rows = recipients.map((cid) => [message.id, cid, office]);
    for (let i = 0; i < rows.length; i += 500) {
      await pool.query(
        'INSERT IGNORE INTO epos_push_inbox (message_id, customer_id, office) VALUES ?',
        [rows.slice(i, i + 500)]
      );
    }
  }

  const channels = await channelsFor(pool, office, recipients);
  const creds = app && app.wns_package_sid && app.wns_secret_enc
    ? { packageSid: app.wns_package_sid, secret: unseal(app.wns_secret_enc) }
    : null;
  const payload = {
    id: message.id,
    title: message.title,
    body: message.body,
    image: message.image_url || null,
    link: message.link_url || null,
    icon: brand.icon || null,
    url: brand.slug ? `${appUrl(brand.slug)}#/inbox/${message.id}` : null,
  };

  let web = 0;
  let wns = 0;
  // The phone builds. Counted apart from `web` because "it reached 40 phones"
  // means something different from "it reached 40 browsers", and a venue asking
  // why nobody turned up deserves to know which.
  let android = 0;
  let ios = 0;
  let failed = 0;

  // One line per channel kind. A kind this release has never heard of is left
  // to Web Push, which is what every channel was before there were kinds.
  const senders = {
    wns: (ch) => push.sendWns(ch, payload, creds),
    fcm: (ch) => push.sendFcm(ch, payload),
    apns: (ch) => push.sendApns(ch, payload),
  };

  await inBatches(channels, 12, async (ch) => {
    const send = senders[ch.kind];
    const result = send ? await send(ch) : await push.sendWebPush(ch, payload);
    if (result === 'ok') {
      if (ch.kind === 'wns') wns++;
      else if (ch.kind === 'fcm') android++;
      else if (ch.kind === 'apns') ios++;
      else web++;
      await pool.execute('UPDATE epos_push_channels SET last_ok_at = NOW(), fail_count = 0 WHERE id = ?', [ch.id]);
    } else if (result === 'gone') {
      failed++;
      await pool.execute('UPDATE epos_push_channels SET disabled_at = NOW() WHERE id = ?', [ch.id]);
    } else {
      failed++;
      await pool.execute(
        'UPDATE epos_push_channels SET fail_count = fail_count + 1, disabled_at = IF(fail_count >= 9, NOW(), disabled_at) WHERE id = ?',
        [ch.id]
      );
    }
  });

  await pool.execute(
    `UPDATE epos_push_messages
        SET status = 'sent', sent_at = NOW(), recipients = ?, reached_web = ?, reached_wns = ?, failed = ?
      WHERE id = ?`,
    // reached_web carries the browsers AND the phones: the column predates the
    // mobile builds and adding two more to every report query, export and
    // screen would cost more than it tells anybody. The split is returned
    // below, where a caller that wants it can have it.
    [recipients.length, web + android + ios, wns, failed, message.id]
  );
  return { recipients: recipients.length, web, wns, android, ios, failed };
}

/** Claim and send whatever is due. Safe to call from two places at once. */
async function sendDue(pool) {
  for (let n = 0; n < 5; n++) {
    const [[due]] = await pool.query(
      `SELECT * FROM epos_push_messages
        WHERE status = 'scheduled' AND send_at <= NOW()
        ORDER BY send_at LIMIT 1`
    );
    if (!due) return;
    const [claim] = await pool.execute(
      "UPDATE epos_push_messages SET status = 'sending' WHERE id = ? AND status = 'scheduled'",
      [due.id]
    );
    if (!claim.affectedRows) continue;
    try {
      await deliver(pool, due);
    } catch (e) {
      console.error('[loyalty_app] sending failed:', e.message);
      await pool.execute("UPDATE epos_push_messages SET status = 'sent', sent_at = NOW() WHERE id = ?", [due.id]);
    }
  }
}

/** Old locations and spent codes go. */
async function sweep(pool) {
  await pool.execute(`DELETE FROM epos_customer_near WHERE near_at < NOW() - INTERVAL ${NEAR_HOURS} HOUR`);
  await pool.execute(`DELETE FROM epos_loyalty_app_codes WHERE created_at < NOW() - INTERVAL 1 DAY`);
  // Spent and expired WebAuthn challenges are rubbish, not history.
  await loyaltyAuth.sweepChallenges(pool);
}

let schedulerTimer = null;
function startLoyaltyScheduler({ pool, everyMs = 15_000 }) {
  if (schedulerTimer) return;
  let ticks = 0;
  const tick = async () => {
    try {
      await sendDue(pool);
      if (ticks++ % 240 === 0) await sweep(pool);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') console.warn('[loyalty_app] scheduler:', e.message);
    }
  };
  schedulerTimer = setInterval(tick, everyMs);
  schedulerTimer.unref();
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function loyaltyAppRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  // The back office's half rides on the key that already decides who may run
  // the venue's loyalty scheme (Commerce > Loyalty).
  const mayRun = accessGuard({ pool, secret })('commerce.loyalty');
  const json = express.json({ limit: '32kb' });

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  const callerIp = (req) => String(req.ip || req.socket?.remoteAddress || '').slice(0, 64);

  // ---- The customer's token --------------------------------------------------

  const sessions = new Map(); // sessionId -> { revoked, at }

  function customerToken(office, customerId, sessionId) {
    return jwt.sign({ scope: 'loyalty', office, cid: customerId }, secret, {
      expiresIn: TOKEN_TTL,
      jwtid: sessionId,
    });
  }

  async function requireCustomer(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    let claims;
    try {
      claims = jwt.verify(String(token || ''), secret);
    } catch {
      return res.status(401).json({ error: 'Please sign in again.' });
    }
    if (claims.scope !== 'loyalty' || !claims.office || !claims.cid || !claims.jti) {
      return res.status(401).json({ error: 'Please sign in again.' });
    }
    const now = Date.now();
    let s = sessions.get(claims.jti);
    if (!s || now - s.at > SESSION_CACHE_MS) {
      const [[row]] = await pool.query(
        'SELECT revoked_at FROM epos_loyalty_app_sessions WHERE id = ? AND office = ?',
        [claims.jti, claims.office]
      );
      s = { revoked: !row || row.revoked_at != null, at: now };
      sessions.set(claims.jti, s);
      if (!s.revoked) {
        pool.execute('UPDATE epos_loyalty_app_sessions SET last_seen_at = NOW() WHERE id = ?', [claims.jti]).catch(() => {});
      }
    }
    if (s.revoked) return res.status(401).json({ error: 'You have been signed out. Please sign in again.' });
    req.office = claims.office;
    req.customerId = claims.cid;
    req.sessionId = claims.jti;
    next();
  }

  async function revokeSessions(where, params) {
    const [rows] = await pool.query(`SELECT id FROM epos_loyalty_app_sessions WHERE ${where} AND revoked_at IS NULL`, params);
    if (!rows.length) return 0;
    const ids = rows.map((r) => r.id);
    await pool.query('UPDATE epos_loyalty_app_sessions SET revoked_at = NOW() WHERE id IN (?)', [ids]);
    await pool.query('UPDATE epos_push_channels SET disabled_at = NOW() WHERE session_id IN (?) AND disabled_at IS NULL', [ids]);
    for (const id of ids) sessions.delete(id);
    return ids.length;
  }

  // ---- Public: the app itself -------------------------------------------------

  /** Everything the app draws for this venue, and which notifications are possible. */
  router.get('/loyalty/v1/app/:slug', async (req, res, next) => {
    try {
      const app = await appBySlug(pool, req.params.slug);
      if (!app) return res.status(404).json({ error: 'There is no app at this address.' });
      const brand = await brandFor(pool, app.office, app);
      const keys = push.vapid();
      /*
       * HOW THIS VENUE SIGNS PEOPLE IN, sent with the branding because the
       * app has to draw the right page before anybody has signed in and so
       * cannot ask a route that needs a token.
       *
       * It is a description, not a permission. Every method is checked again
       * on the route that uses it -- the app is software on somebody's phone
       * and an old copy of it will happily offer a method the venue has since
       * switched off.
       */
      const signin = await loyaltyAuth.configFor(pool, app.office, app);
      // Cached for a minute like the rest, so switching a method on shows up
      // in the app within a minute rather than needing a reinstall.
      res.set('Cache-Control', 'public, max-age=60');
      res.json({
        ...brand,
        signin,
        push: {
          web: keys ? { vapid_public_key: keys.publicKey } : null,
          windows: !!(app.wns_package_sid && app.wns_secret_enc),
        },
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Email a sign-in code. Always answers the same way, whether or not the
   * address is a member: the answer must not tell a stranger who is.
   */
  router.post('/loyalty/v1/app/:slug/code', json, async (req, res, next) => {
    try {
      const app = await appBySlug(pool, req.params.slug);
      if (!app) return res.status(404).json({ error: 'There is no app at this address.' });
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      if (!emailOk(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

      const ip = callerIp(req);
      const [[recent]] = await pool.query(
        `SELECT
           SUM(email = ?) AS by_email,
           SUM(ip_address = ?) AS by_ip
         FROM epos_loyalty_app_codes
         WHERE office = ? AND created_at > NOW() - INTERVAL 1 HOUR`,
        [email, ip, app.office]
      );
      if (Number(recent.by_email) >= CODES_PER_HOUR_EMAIL || Number(recent.by_ip) >= CODES_PER_HOUR_IP) {
        return res.status(429).json({ error: 'Too many codes asked for. Please try again in an hour.' });
      }

      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      await pool.execute(
        `INSERT INTO epos_loyalty_app_codes (id, office, email, code_hash, expires_at, ip_address)
         VALUES (?, ?, ?, ?, NOW() + INTERVAL ${CODE_MINUTES} MINUTE, ?)`,
        [crypto.randomUUID(), app.office, email, hashCode(app.office, email, code, secret), ip]
      );

      const brand = await brandFor(pool, app.office, app);
      // The venue's own email, not a bare div: see src/loyalty_email.js for
      // why it is built out of tables and inline styles.
      const mail = loyaltyEmail.signInCode(brand, { code, minutes: CODE_MINUTES });
      sendMail({
        to: email,
        subject: `${brand.name}: your sign-in code is ${code}`,
        text: mail.text,
        html: mail.html,
        account: process.env.MENU_SMTP_USER ? 'menu' : undefined,
      }).catch(() => {});
      res.json({ ok: true, minutes: CODE_MINUTES });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Swap a code for a session. A new address joins the scheme: the first answer
   * is `needs_name` (the code is not spent), and the app asks again with a name.
   */
  router.post('/loyalty/v1/app/:slug/verify', json, async (req, res, next) => {
    try {
      const app = await appBySlug(pool, req.params.slug);
      if (!app) return res.status(404).json({ error: 'There is no app at this address.' });
      const body = req.body || {};
      const email = String(body.email || '').trim().toLowerCase();
      const code = String(body.code || '').trim();
      if (!emailOk(email) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Enter the six-digit code from the email.' });
      }

      // Every code still good for this address, not only the newest: somebody
      // who asked twice and types the first email's code has done nothing
      // wrong. Five tries in all, counted across them.
      const [live] = await pool.query(
        `SELECT id, code_hash, attempts FROM epos_loyalty_app_codes
          WHERE office = ? AND email = ? AND used_at IS NULL AND expires_at > NOW()
          ORDER BY created_at DESC, id LIMIT 5`,
        [app.office, email]
      );
      const tries = live.reduce((n, r) => n + Number(r.attempts), 0);
      if (!live.length || tries >= CODE_TRIES) {
        return res.status(400).json({ error: 'That code has expired. Ask for a new one.' });
      }
      const given = Buffer.from(hashCode(app.office, email, code, secret));
      const row = live.find((r) => crypto.timingSafeEqual(given, Buffer.from(r.code_hash)));
      if (!row) {
        await pool.execute('UPDATE epos_loyalty_app_codes SET attempts = attempts + 1 WHERE id = ?', [live[0].id]);
        return res.status(400).json({ error: 'That code is not right. Check the email and try again.' });
      }

      let customer = await customerByEmail(pool, app.office, email);
      if (!customer) {
        const name = cleanText(body.name, 120);
        if (!name) return res.status(409).json({ needs_name: true });
        const id = await joinScheme(pool, app.office, { name, email });
        customer = { id };
      } else {
        await ensureCard(pool, app.office, customer.id);
      }

      // Spent -- and so is every other code this address still had, so an
      // older email cannot be used to sign in again.
      await pool.execute(
        'UPDATE epos_loyalty_app_codes SET used_at = NOW() WHERE office = ? AND email = ? AND used_at IS NULL',
        [app.office, email]
      );
      const sessionId = crypto.randomUUID();
      const platform = ['web', 'windows'].includes(body.platform) ? body.platform : 'web';
      await pool.execute(
        `INSERT INTO epos_loyalty_app_sessions (id, office, customer_id, platform, user_agent, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [sessionId, app.office, customer.id, platform, cleanText(req.headers['user-agent'], 255)]
      );
      res.json({ token: customerToken(app.office, customer.id, sessionId) });
    } catch (e) {
      next(e);
    }
  });

  // ---- The signed-in customer ---------------------------------------------------

  /** The card: who, the number to show as a QR, points and what they are worth. */
  router.get('/loyalty/v1/me', requireCustomer, async (req, res, next) => {
    try {
      const [[c]] = await pool.query('SELECT * FROM epos_customers WHERE id = ? AND email_key = ?', [req.customerId, req.office]);
      if (!c) return res.status(404).json({ error: 'Your membership could not be found. Please ask the venue.' });
      const loyalty = await maybeOne(pool, 'SELECT point_value_minor FROM epos_loyalty_settings WHERE office = ?', [req.office]);
      const pointValue = loyalty ? Number(loyalty.point_value_minor) || 1 : 1;
      const points = Number(c.points_balance) || 0;
      // The membership as the venue runs it: how long one lasts, what it
      // costs, and the day everyone's runs to where the venue renews on one
      // date -- so the app can say what renewing means, not only when.
      const scheme = await maybeOne(
        pool,
        'SELECT membership_term_months, membership_fee_minor, membership_renewal_date FROM epos_loyalty_settings WHERE office = ?',
        [req.office]
      ).catch(() => null);
      const expiry = c.membership_expiry ? new Date(c.membership_expiry) : null;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      res.json({
        name: c.name,
        email: c.email,
        photo_url: c.photo_url || null,
        membership: {
          expiry: c.membership_expiry || null,
          expired: !!(expiry && expiry < today),
          term_months: scheme ? Number(scheme.membership_term_months) || null : null,
          fee_minor: scheme ? Number(scheme.membership_fee_minor) || 0 : 0,
          renewal_date: scheme ? scheme.membership_renewal_date || null : null,
        },
        card_number: c.card_number || null,
        member_no: c.member_no ?? null,
        // What the till scans. The card number where there is one -- exactly as
        // the Wallet pass does -- and the member number otherwise.
        qr: c.card_number || (c.member_no != null ? String(c.member_no) : c.id),
        points,
        points_value_minor: points * pointValue,
        tier: c.tier_name || null,
        visits: Number(c.visits) || 0,
        last_visit: c.last_visit || null,
        membership_expiry: c.membership_expiry || null,
        member_since: c.created_at || null,
      });
    } catch (e) {
      next(e);
    }
  });

  /** Points earned and spent, newest first. `before` pages back. */
  router.get('/loyalty/v1/me/history', requireCustomer, async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      const before = req.query.before ? new Date(String(req.query.before)) : null;
      const params = [req.office, req.customerId];
      let older = '';
      if (before && !Number.isNaN(before.getTime())) {
        older = 'AND created_at < ?';
        params.push(before);
      }
      params.push(limit);
      const [rows] = await pool.query(
        `SELECT id, kind, points, balance_after, spend_minor, value_minor, note, created_at
           FROM epos_loyalty_txns
          WHERE office = ? AND customer_id = ? ${older}
          ORDER BY created_at DESC LIMIT ?`,
        params
      );
      res.json({ items: rows, more: rows.length === limit });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The inbox: what the venue sent this customer, newest first, kept the way
   * the venue chose (see inboxRules).
   *
   *   limit  -- the newest N and no more. Nothing is deleted; a message past
   *             the Nth is simply not offered, and comes back if N is raised.
   *   scroll -- a page at a time. `before` is the `sent_at` of the last one
   *             shown; `more` says whether to ask again.
   *
   * The unread count is of what is offered, so the bell never promises a
   * message the page will not show.
   */
  router.get('/loyalty/v1/me/messages', requireCustomer, async (req, res, next) => {
    try {
      const app = await maybeOne(pool, 'SELECT inbox_mode, inbox_limit FROM epos_loyalty_app WHERE office = ?', [req.office]).catch(() => null);
      const rules = inboxRules(app);
      const params = [req.office, req.customerId];
      let older = '';
      const before = req.query.before ? new Date(String(req.query.before)) : null;
      if (rules.mode === 'scroll' && before && !Number.isNaN(before.getTime())) {
        older = 'AND COALESCE(m.sent_at, i.created_at) < ?';
        params.push(before);
      }
      const page = rules.mode === 'scroll'
        ? Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
        : rules.limit;
      params.push(page + 1);
      const [rows] = await pool.query(
        `SELECT m.id, m.title, m.body, m.image_url, m.link_url,
                m.video_url, m.video_embed_url, m.sent_at, i.read_at,
                COALESCE(m.sent_at, i.created_at) AS shown_at
           FROM epos_push_inbox i
           JOIN epos_push_messages m ON m.id = i.message_id
          WHERE i.office = ? AND i.customer_id = ? ${older}
          ORDER BY shown_at DESC LIMIT ?`,
        params
      );
      const more = rules.mode === 'scroll' && rows.length > page;
      const items = rows.slice(0, page);
      let unread = items.filter((r) => !r.read_at).length;
      if (rules.mode === 'scroll' && !older) {
        // The bell counts everything unread, not only the first page.
        const [[all]] = await pool.query(
          'SELECT COUNT(*) AS n FROM epos_push_inbox WHERE office = ? AND customer_id = ? AND read_at IS NULL',
          [req.office, req.customerId]
        );
        unread = Number(all.n) || 0;
      }
      res.json({ items, unread, more, mode: rules.mode, limit: rules.limit });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The member's own photograph, from the app.
   *
   * Their face on their card, so the venue can see it is them at the till --
   * the till already shows the photo the back office attached, and this is
   * the member attaching it themselves. Same upload as the back office's
   * /api/customer-photo, same folder, and the old picture is left on disk
   * until the venue tidies uploads: a file the till may still be showing
   * from cache is not deleted under it.
   */
  router.post('/loyalty/v1/me/photo', requireCustomer, (req, res, next) => {
    photoUpload.single('image')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'Choose a photograph.' });
      try {
        const url = `/uploads/${req.file.filename}`;
        await pool.execute('UPDATE epos_customers SET photo_url = ? WHERE id = ? AND email_key = ?', [url, req.customerId, req.office]);
        broadcast({ type: 'customers.updated', office: req.office });
        res.status(201).json({ photo_url: url });
      } catch (e) {
        next(e);
      }
    });
  });

  router.delete('/loyalty/v1/me/photo', requireCustomer, async (req, res, next) => {
    try {
      await pool.execute('UPDATE epos_customers SET photo_url = NULL WHERE id = ? AND email_key = ?', [req.customerId, req.office]);
      broadcast({ type: 'customers.updated', office: req.office });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/loyalty/v1/me/messages/:id/read', requireCustomer, async (req, res, next) => {
    try {
      await pool.execute(
        'UPDATE epos_push_inbox SET read_at = COALESCE(read_at, NOW()) WHERE message_id = ? AND customer_id = ? AND office = ?',
        [String(req.params.id), req.customerId, req.office]
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Where notifications can reach this device: a Web Push subscription or a WNS channel. */
  router.post('/loyalty/v1/me/push', requireCustomer, json, async (req, res, next) => {
    try {
      const body = req.body || {};
      let row;
      if (body.kind === 'wns') {
        const uri = String(body.channel_uri || '');
        if (!push.allowedWns(uri)) return res.status(400).json({ error: 'That is not a Windows notification channel.' });
        row = { kind: 'wns', endpoint: uri, p256dh: null, auth: null };
      } else if (body.kind === 'fcm' || body.kind === 'apns') {
        // A phone registration is a device token and nothing else -- no URL, so
        // none of the host checks above apply and none are needed: the server
        // posts to Google's or Apple's gateway, never to an address the device
        // chose. What IS checked is the shape, because an APNs token goes
        // straight into a URL path.
        const deviceToken = String(body.device_token || '').trim();
        const shaped = body.kind === 'apns'
          ? /^[0-9a-f]{16,200}$/i.test(deviceToken)
          : deviceToken.length > 0 && deviceToken.length <= 4096;
        if (!shaped) {
          return res.status(400).json({ error: 'That is not a device notification token.' });
        }
        row = { kind: body.kind, endpoint: deviceToken, p256dh: null, auth: null };
      } else {
        const sub = body.subscription || {};
        const endpoint = String(sub.endpoint || '');
        const keys = sub.keys || {};
        if (!push.allowedWebPush(endpoint) || !keys.p256dh || !keys.auth) {
          return res.status(400).json({ error: 'That is not a browser notification subscription.' });
        }
        row = { kind: 'webpush', endpoint, p256dh: String(keys.p256dh).slice(0, 255), auth: String(keys.auth).slice(0, 255) };
      }
      const hash = sha256(row.endpoint);
      await pool.execute(
        `INSERT INTO epos_push_channels
           (id, office, customer_id, session_id, kind, endpoint, endpoint_hash, p256dh, auth_secret)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE office = VALUES(office), customer_id = VALUES(customer_id),
           session_id = VALUES(session_id), kind = VALUES(kind), p256dh = VALUES(p256dh),
           auth_secret = VALUES(auth_secret), disabled_at = NULL, fail_count = 0`,
        [crypto.randomUUID(), req.office, req.customerId, req.sessionId, row.kind, row.endpoint, hash, row.p256dh, row.auth]
      );
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/loyalty/v1/me/push', requireCustomer, json, async (req, res, next) => {
    try {
      const endpoint = String((req.body || {}).endpoint || (req.body || {}).channel_uri || '');
      await pool.execute(
        'UPDATE epos_push_channels SET disabled_at = NOW() WHERE endpoint_hash = ? AND customer_id = ? AND office = ?',
        [sha256(endpoint), req.customerId, req.office]
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The customer's position, only when they allowed it -- and NEVER STORED.
   *
   * The privacy policy says a member's location is used there and then for the
   * app to work and is not saved, so that is what happens: the position is
   * checked against the venue's own area in this request and forgotten when it
   * ends. What is kept is only whether they were inside that area, and when,
   * for the NEAR_HOURS a "near us now" offer can use it (schema_loyalty_near).
   * No coordinates reach the database or the logs.
   */
  router.post('/loyalty/v1/me/location', requireCustomer, json, async (req, res, next) => {
    try {
      const lat = Number((req.body || {}).latitude);
      const lng = Number((req.body || {}).longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ error: 'That is not a position.' });
      }
      const app = await readApp(pool, req.office);
      let near = false;
      if (app && app.latitude != null && app.longitude != null) {
        near = distanceM(lat, lng, Number(app.latitude), Number(app.longitude)) <= (Number(app.radius_m) || 400);
      }
      if (near) {
        await pool.execute(
          `INSERT INTO epos_customer_near (office, customer_id, near_at) VALUES (?, ?, NOW())
           ON DUPLICATE KEY UPDATE near_at = NOW()`,
          [req.office, req.customerId]
        );
      } else {
        await pool.execute('DELETE FROM epos_customer_near WHERE office = ? AND customer_id = ?', [req.office, req.customerId]);
      }
      res.json({ ok: true, near });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/loyalty/v1/me/location', requireCustomer, async (req, res, next) => {
    try {
      await pool.execute('DELETE FROM epos_customer_near WHERE office = ? AND customer_id = ?', [req.office, req.customerId]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The member's card as a Wallet pass.
   *
   * A link, not the pass itself: the signing, the pass record and Apple's
   * update service already live behind /wallet/c/:token (wallet_apple_service.js),
   * and that link is the one a printed QR code uses, so a card added from the
   * app is the same pass, updated the same way, as one added at the counter.
   * Ten minutes, because it stands in for the member's session: long enough to
   * download, useless if it turns up in a log later.
   */
  router.get('/loyalty/v1/me/wallet', requireCustomer, async (req, res, next) => {
    try {
      const token = jwt.sign(
        { scope: 'wallet', office: req.office, kind: 'loyalty', sub: String(req.customerId) },
        secret,
        { expiresIn: '10m' }
      );
      const base = LOYALTY_HOST
        ? `https://${LOYALTY_HOST}`
        : String(process.env.BACKOFFICE_URL || '').replace(/\/+$/, '');
      res.set('Cache-Control', 'no-store').json({
        apple: `${base}/wallet/c/${token}?apple=1`,
        google: `${base}/wallet/s/${token}`,
      });
    } catch (e) {
      next(e);
    }
  });

  /** Sign this device out. Its notification channel goes with it. */
  router.post('/loyalty/v1/me/signout', requireCustomer, async (req, res, next) => {
    try {
      await revokeSessions('id = ?', [req.sessionId]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Remove the app from this membership: every device signed out, every
   * notification channel and the last position forgotten. The membership itself
   * -- points, history -- is the venue's record and stays.
   */
  router.delete('/loyalty/v1/me', requireCustomer, async (req, res, next) => {
    try {
      await revokeSessions('office = ? AND customer_id = ?', [req.office, req.customerId]);
      await pool.execute('UPDATE epos_push_channels SET disabled_at = NOW() WHERE office = ? AND customer_id = ?', [req.office, req.customerId]);
      await pool.execute('DELETE FROM epos_customer_near WHERE office = ? AND customer_id = ?', [req.office, req.customerId]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /*
   * The other ways in, and the account section.
   *
   * Mounted on this router with the session helpers handed over, so there is
   * one idea of what a customer token is and one place that mints it.
   */
  /*
   * Delete my account and data: filed with Vesopa Auth, which runs every
   * deletion request (src/privacy_provider.js).
   */
  router.use(loyaltyDeletionRoutes({ pool, requireCustomer }));

  router.use(loyaltyAccountRoutes({
    pool, json, requireCustomer, customerToken, appBySlug, revokeSessions,
    callerIp, customerByEmail, ensureCard, joinScheme, brandFor, sendMail,
    cleanText, emailOk,
  }));

  // ---- The back office ----------------------------------------------------------

  const SETTINGS = ['enabled', 'slug', 'app_name', 'welcome_text', 'logo_url', 'icon_url', 'hero_url',
    'colour_primary', 'colour_accent', 'colour_background', 'colour_text', 'colour_icon', 'font_scale',
    'font_heading', 'font_body', 'inbox_mode', 'inbox_limit',
    'links', 'latitude', 'longitude', 'radius_m'];

  function publicSettings(row) {
    const out = {};
    for (const k of SETTINGS) out[k] = row ? row[k] ?? null : null;
    out.enabled = row ? Number(row.enabled) === 1 : false;
    out.links = parseJson(out.links, {});
    out.wns_package_sid = row ? row.wns_package_sid || null : null;
    out.wns_configured = !!(row && row.wns_package_sid && row.wns_secret_enc);
    return out;
  }

  /** The Loyalty app page: settings, what it looks like, and who has it. */
  router.get('/api/loyalty-app', ...mayRun, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const app = await readApp(pool, office);
      const brand = await brandFor(pool, office, app);
      const [[stats]] = await pool.query(
        `SELECT
           (SELECT COUNT(DISTINCT customer_id) FROM epos_loyalty_app_sessions
             WHERE office = ? AND revoked_at IS NULL) AS members,
           (SELECT COUNT(*) FROM epos_push_channels
             WHERE office = ? AND disabled_at IS NULL AND kind = 'webpush') AS web,
           (SELECT COUNT(*) FROM epos_push_channels
             WHERE office = ? AND disabled_at IS NULL AND kind = 'wns') AS windows,
           (SELECT COUNT(*) FROM epos_push_channels
             WHERE office = ? AND disabled_at IS NULL AND kind IN ('fcm', 'apns')) AS phones,
           (SELECT COUNT(*) FROM epos_customer_near
             WHERE office = ? AND near_at >= NOW() - INTERVAL ${NEAR_HOURS} HOUR) AS located`,
        [office, office, office, office, office]
      );
      // A suggestion for a venue that has not chosen an address: its dine-in
      // address if it has one, otherwise its name.
      let suggested = null;
      if (!app || !app.slug) {
        const [[o]] = await pool.query('SELECT id, name FROM offices WHERE contact_email = ?', [office]);
        const dine = o ? await maybeOne(pool, 'SELECT slug FROM dinein_venue WHERE office_id = ?', [o.id]) : null;
        suggested = (dine && dine.slug) || (o && o.name ? o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) : null);
      }
      const url = app && app.slug ? appUrl(app.slug) : null;
      let fonts = [];
      try {
        fonts = (await catalogueFor(pool, office)).map((f) => ({ slug: f.slug, family: f.family, built_in: !!f.builtIn }));
      } catch {
        fonts = [];
      }
      res.json({
        settings: publicSettings(app),
        brand,
        suggested_slug: suggested,
        url,
        // For posters, table talkers and receipts: scanning it opens the app.
        qr_svg: url ? QR.svg(url, { size: 180 }) : null,
        fonts,
        stats: {
          members: Number(stats.members) || 0,
          web: Number(stats.web) || 0,
          windows: Number(stats.windows) || 0,
          // The Play and App Store builds, registered by device token.
          phones: Number(stats.phones) || 0,
          located: Number(stats.located) || 0,
        },
        signin: await signinState(office, app),
        web_push_ready: push.webPushReady(),
        // False until the server holds the Firebase service account (FCM_* in
        // .env): Android channels are registered but nothing can be sent.
        android_push_ready: push.fcmReady(),
        web_build_ready: fs.existsSync(path.join(WEB_DIR, 'index.html')),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The sign-in section of the page: which ways in are on, which leads, and
   * -- separately -- which ones this SERVER can actually do.
   *
   * `available` is why a venue is not left staring at a switch that does
   * nothing. Texting needs an SMS account and Continue with Vesopa needs an
   * OAuth client; where the server has neither, the page says so instead of
   * letting somebody switch on a method their members would then fail on.
   */
  async function signinState(office, app) {
    let rows = [];
    try {
      [rows] = await pool.query(
        'SELECT method, enabled FROM epos_loyalty_app_methods WHERE office = ?', [office]
      );
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    const chosen = rows.length
      ? Object.fromEntries(rows.map((r) => [r.method, !!r.enabled]))
      : { ...loyaltyAuth.DEFAULT_METHODS };
    const methods = {};
    const available = {};
    for (const m of loyaltyAuth.METHODS) {
      methods[m] = !!chosen[m];
      available[m] = loyaltyAuth.available(m);
    }
    return {
      methods,
      available,
      // What the members actually get, after anything this server cannot do
      // has been dropped and the never-lock-anybody-out rule has run.
      effective: await loyaltyAuth.configFor(pool, office, app),
      policy: loyaltyAuth.policyFor(app, await loyaltyAuth.methodsFor(pool, office)),
      policies: loyaltyAuth.POLICIES,
      self_service: !app || app.self_service == null ? true : Number(app.self_service) === 1,
    };
  }

  router.put('/api/loyalty-app', ...mayRun, express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const current = await readApp(pool, office);

      const slug = b.slug == null ? (current && current.slug) : String(b.slug).trim().toLowerCase();
      if (slug && !SLUG.test(slug)) {
        return res.status(400).json({ error: 'The address can use lower-case letters, numbers and hyphens (3 to 64).' });
      }
      if (slug && RESERVED.has(slug)) {
        return res.status(400).json({ error: 'That address is kept for Vesopa. Choose another.' });
      }
      if (slug) {
        const [[taken]] = await pool.query('SELECT office FROM epos_loyalty_app WHERE slug = ? AND office <> ?', [slug, office]);
        if (taken) return res.status(409).json({ error: 'Another venue already uses that address.' });
      }
      const enabled = b.enabled === true || b.enabled === 1 || b.enabled === '1';
      if (enabled && !slug) return res.status(400).json({ error: 'Choose the app\'s address before switching it on.' });

      const lat = b.latitude === '' || b.latitude == null ? null : Number(b.latitude);
      const lng = b.longitude === '' || b.longitude == null ? null : Number(b.longitude);
      if ((lat != null && (!Number.isFinite(lat) || Math.abs(lat) > 90))
        || (lng != null && (!Number.isFinite(lng) || Math.abs(lng) > 180))) {
        return res.status(400).json({ error: 'That position is not right. Latitude is -90 to 90, longitude -180 to 180.' });
      }
      const links = {};
      for (const [k, v] of Object.entries(typeof b.links === 'object' && b.links ? b.links : {})) {
        const key = String(k).replace(/[^a-z_]/gi, '').slice(0, 24);
        const val = cleanText(v, 300);
        if (key && val) links[key] = val;
      }

      const values = {
        enabled: enabled ? 1 : 0,
        slug: slug || null,
        app_name: cleanText(b.app_name, 80),
        welcome_text: cleanText(b.welcome_text, 255),
        logo_url: cleanUrl(b.logo_url),
        icon_url: cleanUrl(b.icon_url),
        hero_url: cleanUrl(b.hero_url),
        colour_primary: cleanHex(b.colour_primary),
        colour_accent: cleanHex(b.colour_accent),
        colour_background: cleanHex(b.colour_background),
        colour_text: cleanHex(b.colour_text),
        colour_icon: cleanHex(b.colour_icon),
        font_scale: fontScale(b.font_scale),
        font_heading: cleanText(b.font_heading, 80),
        font_body: cleanText(b.font_body, 80),
        inbox_mode: b.inbox_mode === 'scroll' ? 'scroll' : 'limit',
        inbox_limit: Math.min(Math.max(Math.round(Number(b.inbox_limit) || 12), 1), 500),
        links: JSON.stringify(links),
        latitude: lat == null ? null : lat.toFixed(6),
        longitude: lng == null ? null : lng.toFixed(6),
        radius_m: Math.min(Math.max(Number(b.radius_m) || 400, 50), 20000),
      };

      // The Windows app's WNS credentials: the SID in the clear, the secret
      // sealed, and only replaced when a new one is typed.
      if (b.wns_package_sid !== undefined) values.wns_package_sid = cleanText(b.wns_package_sid, 255);
      if (b.wns_secret) {
        const sealed = seal(String(b.wns_secret));
        if (!sealed) return res.status(503).json({ error: 'Secrets cannot be stored on this server yet.' });
        values.wns_secret_enc = sealed;
      }
      if (b.clear_wns) {
        values.wns_package_sid = null;
        values.wns_secret_enc = null;
      }

      if (b.auth_policy !== undefined) {
        values.auth_policy = loyaltyAuth.POLICIES.includes(String(b.auth_policy))
          ? String(b.auth_policy) : 'code_first';
      }
      if (b.self_service !== undefined) {
        values.self_service = (b.self_service === true || b.self_service === 1 || b.self_service === '1') ? 1 : 0;
      }

      const cols = Object.keys(values);
      await pool.query(
        `INSERT INTO epos_loyalty_app (office, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
        [office, ...cols.map((c) => values[c])]
      );

      /*
       * The ways in, one row each.
       *
       * Written whole rather than merged: the page sends every method with a
       * true or a false, so a switch turned OFF is a row saying so. Merging
       * would mean an off switch left no trace and the default crept back.
       */
      if (b.signin_methods && typeof b.signin_methods === 'object') {
        for (const m of loyaltyAuth.METHODS) {
          const on = b.signin_methods[m] === true || b.signin_methods[m] === 1 || b.signin_methods[m] === '1';
          await pool.execute(
            `INSERT INTO epos_loyalty_app_methods (office, method, enabled, sort_order)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), sort_order = VALUES(sort_order)`,
            [office, m, on ? 1 : 0, loyaltyAuth.METHODS.indexOf(m)]
          );
        }
      }
      broadcast({ type: 'loyalty-app', office });
      const saved = await readApp(pool, office);
      res.json({
        ok: true,
        settings: publicSettings(saved),
        signin: await signinState(office, saved),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * A YouTube or Vimeo address, normalised to the form that can be embedded,
   * or null for anything else.
   *
   * Only these two, and only their own domains: an "embed" field that took
   * any address at all would be an invitation to put a third party's script
   * into every member's app.
   */
  function embedUrl(raw) {
    const value = cleanText(raw, 500);
    if (!value) return null;
    let u;
    try {
      u = new URL(value);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1);
      return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = u.searchParams.get('v') || (u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : '');
      return /^[\w-]{6,20}$/.test(id) ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const id = (u.pathname.match(/(\d{6,12})/) || [])[1];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
    return null;
  }

  function cleanAudience(a) {
    const kind = ['all', 'near', 'tier', 'lapsed'].includes(a && a.kind) ? a.kind : 'all';
    if (kind === 'tier') return { kind, tier: cleanText(a.tier, 60) || '' };
    if (kind === 'lapsed') return { kind, days: Math.min(Math.max(Number(a.days) || 30, 1), 3650) };
    return { kind };
  }

  /** How many members, and devices, a message would reach -- before it is sent. */
  router.post('/api/loyalty-app/audience', ...mayRun, json, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const app = await readApp(pool, office);
      const audience = cleanAudience((req.body || {}).audience);
      const ids = await recipientsFor(pool, office, audience, app);
      const channels = await channelsFor(pool, office, ids);
      res.json({
        members: ids.length,
        web: channels.filter((c) => c.kind === 'webpush').length,
        windows: channels.filter((c) => c.kind === 'wns').length,
        android: channels.filter((c) => c.kind === 'fcm').length,
        ios: channels.filter((c) => c.kind === 'apns').length,
        needs_location: audience.kind === 'near' && (!app || app.latitude == null),
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/api/loyalty-app/messages', ...mayRun, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT id, title, body, image_url, link_url, audience, status, send_at, sent_at,
                recipients, reached_web, reached_wns, failed, created_by, created_at
           FROM epos_push_messages WHERE office = ? ORDER BY created_at DESC LIMIT 100`,
        [office]
      );
      res.json(rows.map((r) => ({ ...r, audience: parseJson(r.audience, { kind: 'all' }) })));
    } catch (e) {
      next(e);
    }
  });

  /** Send a notification, now or at a time. */
  router.post('/api/loyalty-app/messages', ...mayRun, json, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const app = await readApp(pool, office);
      if (!app || !Number(app.enabled)) {
        return res.status(409).json({ error: 'Switch the app on before sending notifications.' });
      }
      const b = req.body || {};
      const title = cleanText(b.title, 80);
      const text = cleanText(b.body, 500);
      if (!title || !text) return res.status(400).json({ error: 'A notification needs a title and a message.' });
      let sendAt = new Date();
      if (b.send_at) {
        sendAt = new Date(String(b.send_at));
        if (Number.isNaN(sendAt.getTime())) return res.status(400).json({ error: 'That send time is not a date.' });
        if (sendAt.getTime() > Date.now() + 366 * 86400_000) {
          return res.status(400).json({ error: 'A notification can be scheduled up to a year ahead.' });
        }
      }
      const id = crypto.randomUUID();
      /*
       * A video is one of two different things and the app must know which.
       *
       * video_url is a file this server holds, which the app can play in
       * place. video_embed_url is somebody else's page -- YouTube, Vimeo --
       * which it cannot, and which it shows as a poster that opens a browser.
       * Drawing a play button over something that turns out to need a browser
       * is the sort of thing people tap three times and give up on.
       */
      const embed = embedUrl(b.video_url) || embedUrl(b.video_embed_url);
      const file = embed ? null : cleanUrl(b.video_url);
      await pool.execute(
        `INSERT INTO epos_push_messages
           (id, office, title, body, image_url, link_url, video_url, video_embed_url,
            audience, status, send_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        [id, office, title, text, cleanUrl(b.image_url), cleanText(b.link_url, 500),
          file, embed,
          JSON.stringify(cleanAudience(b.audience)), sendAt, req.user.email]
      );
      // Now means now: not the next tick of the clock.
      if (sendAt.getTime() <= Date.now() + 1000) {
        sendDue(pool).catch((e) => console.warn('[loyalty_app] send now:', e.message));
      }
      res.status(201).json({ id });
    } catch (e) {
      next(e);
    }
  });

  router.post('/api/loyalty-app/messages/:id/cancel', ...mayRun, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [r] = await pool.execute(
        "UPDATE epos_push_messages SET status = 'cancelled' WHERE id = ? AND office = ? AND status = 'scheduled'",
        [String(req.params.id), office]
      );
      if (!r.affectedRows) return res.status(409).json({ error: 'Only a notification that has not gone yet can be cancelled.' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- The web app ----------------------------------------------------------------

  /** The per-venue install manifest: its own name, colour and icon. */
  router.get('/app/:slug/manifest.webmanifest', async (req, res, next) => {
    try {
      const app = await appBySlug(pool, req.params.slug);
      if (!app) return res.status(404).end();
      const brand = await brandFor(pool, app.office, app);
      const scope = appPath(req, app.slug);
      /*
       * AN EMPTY ICON LIST IS NOT "NO ICON" TO A PHONE -- it is a generated
       * letter tile, and that is what a venue's app looked like on a home
       * screen until somebody filled in an icon nobody knew was needed.
       *
       * So a venue that has set nothing installs as Vesopa, from the build's
       * own icons. The maskable pair matters on Android: without one it crops
       * the square inside its circle and takes the corners off the logo.
       */
      const icons = brand.icon
        ? [
          { src: brand.icon, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: brand.icon, sizes: '512x512', type: 'image/png', purpose: 'any' },
        ]
        : [
          { src: `${scope}icons/Icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${scope}icons/Icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `${scope}icons/Icon-maskable-192.png`, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: `${scope}icons/Icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ];
      res.type('application/manifest+json').send(JSON.stringify({
        name: brand.name,
        short_name: brand.name.slice(0, 24),
        start_url: scope,
        scope,
        display: 'standalone',
        orientation: 'portrait',
        background_color: brand.colours.background,
        theme_color: brand.colours.primary,
        icons,
      }));
    } catch (e) {
      next(e);
    }
  });

  // The address without its slash, sent to the one with it: the app's files are
  // addressed relative to /app/<slug>/. Express ignores a trailing slash when it
  // matches, so the slash is checked here -- without this the redirect matched
  // its own target and went round for ever.
  router.get('/app/:slug', (req, res, next) => {
    if (req.path.endsWith('/')) return next();
    res.redirect(301, `/app/${encodeURIComponent(req.params.slug)}/`);
  });

  /**
   * The app's page: the shared Flutter build, with this venue's name, colour,
   * icon and address written into index.html. Everything under it is the same
   * files for every venue.
   */
  async function page(req, res, next) {
    try {
      const app = await appBySlug(pool, req.params.slug);
      const indexFile = path.join(WEB_DIR, 'index.html');
      if (!app) {
        return res.status(404).type('html').send(NOT_FOUND);
      }
      if (!fs.existsSync(indexFile)) {
        return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Coming soon</title><p style="font-family:sans-serif;padding:32px">The app is being prepared. Please try again shortly.</p>');
      }
      const brand = await brandFor(pool, app.office, app);
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const base = appPath(req, app.slug);
      // Shared links are read by other sites, which need a whole address.
      const absolute = (u) => (/^https?:\/\//.test(String(u)) ? u : `${appUrl(app.slug).replace(/\/[^/]*\/$/, '')}${u}`);
      const html = fs.readFileSync(indexFile, 'utf8')
        // Built with --base-href /__SLUG__/ (older builds: /app/__SLUG__/).
        .replace(/\/app\/__SLUG__\//g, base)
        .replace(/\/__SLUG__\//g, base)
        .replace(/__DESCRIPTION__/g, esc(`${brand.name}: ${String(brand.welcome || '').replace(/\.$/, '')}.`))
        .replace(/__URL__/g, esc(appUrl(app.slug)))
        .replace(/__OG_IMAGE__/g, esc(absolute(brand.icon || brand.logo || `${base}icons/Icon-512.png`)))
        .replace(/__APP_NAME__/g, esc(brand.name))
        .replace(/__THEME__/g, esc(brand.colours.primary))
        .replace(/__BACKGROUND__/g, esc(brand.colours.background))
        // The loading screen shows what the APP shows. A venue that set a logo
        // but no separate app icon was getting Vesopa's mark on the splash and
        // its own a second later, which reads as having opened the wrong thing.
        .replace(/__ICON__/g, esc(brand.icon || brand.logo || `${base}icons/Icon-192.png`));
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(html);
    } catch (e) {
      next(e);
    }
  }

  /*
   * Where Vesopa Auth sends somebody back to after Continue with Vesopa.
   *
   * ONE ADDRESS FOR EVERY VENUE. The app is one build served at
   * /app/<slug>/, so a redirect URI per venue would mean registering a new
   * one at auth every time somebody switched an app on -- and a venue whose
   * registration was missed would meet `invalid_redirect_uri` with nothing
   * in the app to explain it.
   *
   * Which venue it was is carried in `state`, as "<slug>.<nonce>". The nonce
   * is the app's own and is checked by the app, not here: this page's whole
   * job is to get the browser back to the right address with the code still
   * attached.
   *
   * Registered BEFORE /app/:slug/ so it is not mistaken for a venue called
   * "vesopa" with a deep link called "callback".
   */
  router.get('/app/vesopa/callback', (req, res) => {
    const state = String(req.query.state || '');
    const slug = state.split('.')[0].toLowerCase();
    if (!SLUG.test(slug)) {
      return res.status(400).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Sign-in</title>'
        + '<p style="font-family:system-ui;padding:32px">That sign-in could not be matched to an app. '
        + 'Please open your card again and retry.</p>'
      );
    }
    const q = new URLSearchParams();
    // Passed straight through, error included: the app has the wording for
    // a refusal and this page has no idea which venue's voice to use.
    for (const k of ['code', 'state', 'error', 'error_description']) {
      if (req.query[k]) q.set(k === 'code' ? 'vesopa_code' : `vesopa_${k}`, String(req.query[k]));
    }
    res.redirect(302, `${appPath(req, encodeURIComponent(slug))}?${q.toString()}`);
  });

  /** Signed out at Vesopa: back to the venue's app, which will ask again. */
  router.get('/app/vesopa/signed-out', (req, res) => {
    const slug = String(req.query.state || '').split('.')[0].toLowerCase();
    res.redirect(302, SLUG.test(slug) ? appPath(req, encodeURIComponent(slug)) : '/');
  });

  const statics = express.static(WEB_DIR, { index: false, fallthrough: false, maxAge: '1h' });
  router.get('/app/:slug/', page);
  router.get('/app/:slug/*rest', (req, res, next) => {
    const rest = Array.isArray(req.params.rest) ? req.params.rest.join('/') : String(req.params.rest || '');
    // A deep link inside the app (no file extension) is the app's page.
    if (!/\.[a-z0-9]+$/i.test(rest)) return page(req, res, next);
    // The push worker must be allowed to control the venue's whole app.
    if (rest === 'push-sw.js') res.set('Service-Worker-Allowed', appPath(req, req.params.slug));
    req.url = `/${rest}`;
    return statics(req, res, (err) => (err ? res.status(err.status || 404).end() : res.status(404).end()));
  });

  return router;
}

/** Metres between two positions (haversine). */
function distanceM(lat1, lng1, lat2, lng2) {
  const r = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

module.exports = {
  loyaltyAppRoutes,
  startLoyaltyScheduler,
  sendDue,
  deliver,
  recipientsFor,
  brandFor,
  issueLoyaltyNumber,
  distanceM,
  WEB_DIR,
};
