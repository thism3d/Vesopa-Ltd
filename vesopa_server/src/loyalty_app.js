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
 * menu.vesopaepos.com/app/<slug>/ that installs to a phone's home screen, and a
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
const { catalogueFor } = require('./fonts');
const QR = require('./qr');

const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODES_PER_HOUR_EMAIL = 5;
const CODES_PER_HOUR_IP = 40;
const TOKEN_TTL = '365d';
const NEAR_HOURS = 3;
const SESSION_CACHE_MS = 30_000;

/** Where the Flutter web build is served from (vesopa_loyalty/build/web, deployed here). */
const WEB_DIR = process.env.LOYALTY_WEB_DIR || path.join(__dirname, '..', 'loyalty_web');

const DEFAULT_BRAND = Object.freeze({
  primary: '#111827',
  accent: '#A5C715',
  background: '#F6F6F1',
  text: '#111111',
});

const HEX = /^#[0-9a-f]{6}$/i;
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
    },
    fonts: { heading: font(a.font_heading), body: font(a.font_body) },
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
    const lat = app && app.latitude != null ? Number(app.latitude) : null;
    const lng = app && app.longitude != null ? Number(app.longitude) : null;
    if (lat == null || lng == null) return [];
    const radius = Number(app.radius_m) || 400;
    join = `JOIN epos_customer_locations l
               ON l.office = s.office AND l.customer_id = s.customer_id
              AND l.at >= NOW() - INTERVAL ${NEAR_HOURS} HOUR`;
    where.push(`6371000 * 2 * ASIN(SQRT(
        POWER(SIN(RADIANS(l.latitude - ?) / 2), 2)
      + COS(RADIANS(?)) * COS(RADIANS(l.latitude)) * POWER(SIN(RADIANS(l.longitude - ?) / 2), 2)
    )) <= ?`);
    params.push(lat, lat, lng, radius);
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
    url: brand.slug ? `/app/${brand.slug}/#/inbox/${message.id}` : null,
  };

  let web = 0;
  let wns = 0;
  let failed = 0;
  await inBatches(channels, 12, async (ch) => {
    const result = ch.kind === 'wns'
      ? await push.sendWns(ch, payload, creds)
      : await push.sendWebPush(ch, payload);
    if (result === 'ok') {
      if (ch.kind === 'wns') wns++; else web++;
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
    [recipients.length, web, wns, failed, message.id]
  );
  return { recipients: recipients.length, web, wns, failed };
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
  await pool.execute(`DELETE FROM epos_customer_locations WHERE at < NOW() - INTERVAL 24 HOUR`);
  await pool.execute(`DELETE FROM epos_loyalty_app_codes WHERE created_at < NOW() - INTERVAL 1 DAY`);
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
      res.set('Cache-Control', 'public, max-age=60');
      res.json({
        ...brand,
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
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      sendMail({
        to: email,
        subject: `${brand.name}: your sign-in code is ${code}`,
        text: `Your ${brand.name} sign-in code is ${code}. It works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px">
          <h2 style="margin:0 0 8px">${esc(brand.name)}</h2>
          <p>Your sign-in code is</p>
          <p style="font-size:34px;font-weight:700;letter-spacing:6px;margin:8px 0 16px">${code}</p>
          <p style="color:#555">It works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.</p>
        </div>`,
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
      res.json({
        name: c.name,
        email: c.email,
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

  /** The inbox: every message the venue sent this customer, newest first. */
  router.get('/loyalty/v1/me/messages', requireCustomer, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT m.id, m.title, m.body, m.image_url, m.link_url, m.sent_at, i.read_at
           FROM epos_push_inbox i
           JOIN epos_push_messages m ON m.id = i.message_id
          WHERE i.office = ? AND i.customer_id = ?
          ORDER BY COALESCE(m.sent_at, i.created_at) DESC LIMIT 100`,
        [req.office, req.customerId]
      );
      res.json({ items: rows, unread: rows.filter((r) => !r.read_at).length });
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

  /** The customer's position, only when they allowed it. One row, kept a day. */
  router.post('/loyalty/v1/me/location', requireCustomer, json, async (req, res, next) => {
    try {
      const lat = Number((req.body || {}).latitude);
      const lng = Number((req.body || {}).longitude);
      const acc = Number((req.body || {}).accuracy);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ error: 'That is not a position.' });
      }
      await pool.execute(
        `INSERT INTO epos_customer_locations (office, customer_id, latitude, longitude, accuracy_m, at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE latitude = VALUES(latitude), longitude = VALUES(longitude),
           accuracy_m = VALUES(accuracy_m), at = NOW()`,
        [req.office, req.customerId, lat.toFixed(6), lng.toFixed(6), Number.isFinite(acc) ? Math.round(acc) : null]
      );
      // Whether they are at the venue now, so the app can greet them with the
      // latest news without a second round trip.
      const app = await readApp(pool, req.office);
      let near = false;
      if (app && app.latitude != null && app.longitude != null) {
        near = distanceM(lat, lng, Number(app.latitude), Number(app.longitude)) <= (Number(app.radius_m) || 400);
      }
      res.json({ ok: true, near });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/loyalty/v1/me/location', requireCustomer, async (req, res, next) => {
    try {
      await pool.execute('DELETE FROM epos_customer_locations WHERE office = ? AND customer_id = ?', [req.office, req.customerId]);
      res.json({ ok: true });
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
      await pool.execute('DELETE FROM epos_customer_locations WHERE office = ? AND customer_id = ?', [req.office, req.customerId]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- The back office ----------------------------------------------------------

  const SETTINGS = ['enabled', 'slug', 'app_name', 'welcome_text', 'logo_url', 'icon_url', 'hero_url',
    'colour_primary', 'colour_accent', 'colour_background', 'colour_text', 'font_heading', 'font_body',
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
           (SELECT COUNT(*) FROM epos_customer_locations
             WHERE office = ? AND at >= NOW() - INTERVAL ${NEAR_HOURS} HOUR) AS located`,
        [office, office, office, office]
      );
      // A suggestion for a venue that has not chosen an address: its dine-in
      // address if it has one, otherwise its name.
      let suggested = null;
      if (!app || !app.slug) {
        const [[o]] = await pool.query('SELECT id, name FROM offices WHERE contact_email = ?', [office]);
        const dine = o ? await maybeOne(pool, 'SELECT slug FROM dinein_venue WHERE office_id = ?', [o.id]) : null;
        suggested = (dine && dine.slug) || (o && o.name ? o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) : null);
      }
      const base = `https://${(process.env.MENU_HOST || 'menu.vesopaepos.com').trim()}`;
      const url = app && app.slug ? `${base}/app/${app.slug}/` : null;
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
          located: Number(stats.located) || 0,
        },
        web_push_ready: push.webPushReady(),
        web_build_ready: fs.existsSync(path.join(WEB_DIR, 'index.html')),
      });
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/loyalty-app', ...mayRun, express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const current = await readApp(pool, office);

      const slug = b.slug == null ? (current && current.slug) : String(b.slug).trim().toLowerCase();
      if (slug && !SLUG.test(slug)) {
        return res.status(400).json({ error: 'The address can use lower-case letters, numbers and hyphens (3 to 64).' });
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
        font_heading: cleanText(b.font_heading, 80),
        font_body: cleanText(b.font_body, 80),
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

      const cols = Object.keys(values);
      await pool.query(
        `INSERT INTO epos_loyalty_app (office, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
        [office, ...cols.map((c) => values[c])]
      );
      broadcast({ type: 'loyalty-app', office });
      res.json({ ok: true, settings: publicSettings(await readApp(pool, office)) });
    } catch (e) {
      next(e);
    }
  });

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
      await pool.execute(
        `INSERT INTO epos_push_messages (id, office, title, body, image_url, link_url, audience, status, send_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        [id, office, title, text, cleanUrl(b.image_url), cleanText(b.link_url, 500),
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
      const scope = `/app/${app.slug}/`;
      const icons = brand.icon
        ? [
          { src: brand.icon, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: brand.icon, sizes: '512x512', type: 'image/png', purpose: 'any' },
        ]
        : [];
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
        return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font-family:sans-serif;padding:32px">There is no app at this address.</p>');
      }
      if (!fs.existsSync(indexFile)) {
        return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Coming soon</title><p style="font-family:sans-serif;padding:32px">The app is being prepared. Please try again shortly.</p>');
      }
      const brand = await brandFor(pool, app.office, app);
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const html = fs.readFileSync(indexFile, 'utf8')
        .replace(/\/app\/__SLUG__\//g, `/app/${app.slug}/`)
        .replace(/__APP_NAME__/g, esc(brand.name))
        .replace(/__THEME__/g, esc(brand.colours.primary))
        .replace(/__BACKGROUND__/g, esc(brand.colours.background))
        .replace(/__ICON__/g, esc(brand.icon || `/app/${app.slug}/icons/Icon-192.png`));
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(html);
    } catch (e) {
      next(e);
    }
  }

  const statics = express.static(WEB_DIR, { index: false, fallthrough: false, maxAge: '1h' });
  router.get('/app/:slug/', page);
  router.get('/app/:slug/*rest', (req, res, next) => {
    const rest = Array.isArray(req.params.rest) ? req.params.rest.join('/') : String(req.params.rest || '');
    // A deep link inside the app (no file extension) is the app's page.
    if (!/\.[a-z0-9]+$/i.test(rest)) return page(req, res, next);
    // The push worker must be allowed to control the venue's whole app.
    if (rest === 'push-sw.js') res.set('Service-Worker-Allowed', `/app/${req.params.slug}/`);
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
