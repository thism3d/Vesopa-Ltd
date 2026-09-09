/**
 * The single sign-on session, and the device it is sitting on.
 *
 * THE COOKIE CARRIES A RANDOM STRING AND NOTHING ELSE. It is not a JWT. A
 * session that lives in the browser as a signed token cannot be revoked — "sign
 * out everywhere" becomes a lie, and so does an admin locking a compromised
 * account. Here the cookie is a handle; the truth is a row, and deleting the
 * row ends the session everywhere at once.
 *
 * TWO CLOCKS. `idle_expires_at` ends a session somebody walked away from;
 * `expires_at` ends one that has been kept warm for a month. A session bounded
 * by only one of the two is either annoying or dangerous.
 *
 * WHAT "REMEMBER ME ON THIS DEVICE" ACTUALLY BUYS, because this is the part
 * that is easy to get dangerously wrong: a longer session, and the right to
 * skip the SECOND factor on this machine. Never the first. The device record
 * proves which computer this is; it does not prove who is sitting at it.
 * Treating it as if it did turns a stolen laptop into a permanent key to every
 * Vesopa app at once.
 */

const config = require('./config');
const geo = require('./geo');
const db = require('./db');
const { newId, newToken, hashToken } = require('./crypto');

/*
 * `__Host-` is a prefix the browser enforces: it refuses to accept the cookie
 * unless it is Secure, Path=/ and has no Domain attribute. That last part is
 * what matters — a cookie without a Domain cannot be set by, or leak to, a
 * sibling subdomain, so a compromise of some other *.vesopa.com site cannot
 * write a session cookie for this one.
 *
 * The prefix only works over HTTPS, so development drops it rather than
 * silently failing to set any cookie at all.
 */
const SESSION_COOKIE = config.isProduction ? '__Host-vesopa_sid' : 'vesopa_sid';
const DEVICE_COOKIE = config.isProduction ? '__Host-vesopa_dev' : 'vesopa_dev';

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    // Lax, not Strict: Strict would mean that arriving at Vesopa from a link in
    // the verification email does not carry the session, and the person is
    // asked to sign in again by the very email that signed them in.
    sameSite: 'lax',
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Start a session.
 *
 * `amr` is how they proved themselves this time — `['pwd']`, `['otp']`,
 * `['webauthn']` — and `acr` is the assurance level that adds up to. Both are
 * recorded because an application is allowed to demand more than the session
 * carries, and step-up has to know what it already has. Without them, "this
 * action needs a second factor" can only be implemented by logging everybody
 * out.
 */
async function create({
  userId,
  amr = [],
  acr = 'aal1',
  remembered = false,
  deviceId = null,
  ip = '',
  country = '',
  userAgent = '',
}) {
  const token = newToken(32);
  const publicId = newId();

  /*
   * Where in the world this is, resolved HERE rather than by the caller.
   *
   * Every caller already passes the address, so asking each of them to pass a
   * country as well would be five places to forget it — and the one that
   * forgot would be the one whose sessions had no country on the devices page,
   * for no reason anybody could see. Doing it once, here, on the path that
   * runs exactly once per sign-in, is both cheaper and impossible to miss.
   *
   * It cannot fail: geo.countryFor swallows everything and answers '' when it
   * does not know, which is what the column already means.
   */
  const where = country || (await geo.countryFor(ip));

  const idleMs = config.session.idleHours * 3600 * 1000;
  const absoluteDays = remembered
    ? config.session.rememberedDays
    : config.session.absoluteDays;

  const result = await db.execute(
    `INSERT INTO sso_sessions
       (public_id, user_id, token_hash, device_id, amr, acr, ip, country,
        user_agent, idle_expires_at, expires_at, remembered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
             DATE_ADD(NOW(), INTERVAL ? SECOND),
             DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
    [
      publicId,
      userId,
      hashToken(token),
      deviceId,
      JSON.stringify(amr),
      acr,
      String(ip).slice(0, 45),
      String(where).slice(0, 2),
      String(userAgent).slice(0, 400),
      Math.floor(idleMs / 1000),
      absoluteDays,
      remembered ? 1 : 0,
    ],
  );

  await db.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);

  return { id: result.insertId, publicId, token, remembered };
}

/**
 * Put the session cookie on the response.
 *
 * A session that was NOT remembered gets no maxAge, so the cookie dies with the
 * browser — which is the behaviour somebody signing in on a shared machine is
 * entitled to expect from leaving the box unticked.
 */
function setCookie(res, token, remembered) {
  const maxAge = remembered ? config.session.rememberedDays * 24 * 3600 * 1000 : null;
  res.cookie(SESSION_COOKIE, token, cookieOptions(maxAge));
}

function clearCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/**
 * Who is this, if anybody.
 *
 * Returns null for every kind of "no" — no cookie, unknown token, revoked,
 * expired, suspended user. Callers must not need to tell those apart, and a
 * page that behaves differently for "expired" and "never existed" tells an
 * attacker which of their guesses was once real.
 */
async function load(req) {
  const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (!token) return null;

  const session = await db.one(
    `SELECT s.*, u.public_id AS user_public_id, u.display_name, u.status AS user_status,
            u.avatar_path, u.is_staff, u.is_developer
       FROM sso_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
        AND s.expires_at > NOW() AND s.idle_expires_at > NOW()
      LIMIT 1`,
    [hashToken(token)],
  );
  if (!session) return null;
  if (session.user_status !== 'active') return null;

  return session;
}

/**
 * Push the idle clock forward.
 *
 * Throttled to once a minute. Without that, every request on a busy page is an
 * UPDATE on the sessions table, and the row is hot enough that the writes
 * queue behind each other.
 */
async function touch(session) {
  const lastSeen = new Date(session.last_seen_at).getTime();
  if (Date.now() - lastSeen < 60000) return;

  await db.execute(
    `UPDATE sso_sessions
        SET last_seen_at = NOW(),
            idle_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE id = ?`,
    [config.session.idleHours * 3600, session.id],
  );
}

/**
 * Raise a live session's assurance after a step-up, without ending it.
 *
 * The person stays signed in and simply becomes more proved than they were —
 * which is the entire point of step-up, and why `amr` is a list rather than a
 * single value.
 */
async function raiseAssurance(sessionId, amr, acr) {
  await db.execute('UPDATE sso_sessions SET amr = ?, acr = ? WHERE id = ?', [
    JSON.stringify(amr),
    acr,
    sessionId,
  ]);
}

async function revoke(sessionId, reason = 'logout') {
  await db.execute(
    'UPDATE sso_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
    [String(reason).slice(0, 60), sessionId],
  );
}

/** End every session this person has. Used by logout-everywhere and by lockouts. */
async function revokeAllForUser(userId, reason = 'user') {
  const result = await db.execute(
    'UPDATE sso_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
    [String(reason).slice(0, 60), userId],
  );
  return result.affectedRows;
}

async function listForUser(userId) {
  return db.query(
    `SELECT s.public_id, s.ip, s.country, s.user_agent, s.created_at, s.last_seen_at,
            s.expires_at, s.remembered, d.name AS device_name
       FROM sso_sessions s
       LEFT JOIN devices d ON d.id = s.device_id
      WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > NOW()
      ORDER BY s.last_seen_at DESC`,
    [userId],
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * Recognise the device this request is coming from, and roll its secret.
 *
 * The cookie holds `id.secret`. The secret is rotated on every use, exactly
 * like a refresh token and for the same reason: a cookie copied off a machine
 * works precisely once, and the moment the real device presents the value it
 * still holds, the two disagree and we know a copy exists.
 *
 * A stale secret is therefore not "an old tab" — it is somebody holding a copy
 * — and it revokes the device and every session on it.
 */
async function recogniseDevice(req, res) {
  const raw = req.cookies ? req.cookies[DEVICE_COOKIE] : null;
  if (!raw || !raw.includes('.')) return null;

  const [idPart, secret] = raw.split('.', 2);
  const id = parseInt(idPart, 10);
  if (!Number.isFinite(id) || !secret) return null;

  const device = await db.one('SELECT * FROM devices WHERE id = ?', [id]);
  if (!device || device.revoked_at) return null;

  if (device.token_hash !== hashToken(secret)) {
    // Somebody has a copy of this cookie. Kill the device and everything on it,
    // and tell the person — this is exactly the event they need to hear about.
    await db.execute(
      'UPDATE devices SET revoked_at = NOW(), reuse_detected_at = NOW() WHERE id = ?',
      [id],
    );
    await db.execute(
      `UPDATE sso_sessions SET revoked_at = NOW(), revoked_reason = 'device_reuse'
        WHERE device_id = ? AND revoked_at IS NULL`,
      [id],
    );
    res.clearCookie(DEVICE_COOKIE, cookieOptions());
    return { reuseDetected: true, userId: device.user_id };
  }

  const nextSecret = await rotateDevice(device, req, res);
  return { ...device, rotatedSecret: nextSecret };
}

async function rotateDevice(device, req, res) {
  const secret = newToken(32);
  // The country moves with the address. A remembered laptop that turns up in
  // another country is the single thing on the devices page worth noticing,
  // and it is only noticeable if the row is kept current.
  const country = await geo.countryFor(req.clientIp);
  await db.execute(
    `UPDATE devices
        SET token_hash = ?, token_rotated_at = NOW(), last_seen_at = NOW(),
            last_ip = ?, last_country = ?
      WHERE id = ?`,
    [
      hashToken(secret),
      String(req.clientIp || '').slice(0, 45),
      String(country).slice(0, 2),
      device.id,
    ],
  );
  res.cookie(
    DEVICE_COOKIE,
    `${device.id}.${secret}`,
    cookieOptions(config.session.deviceTrustDays * 24 * 3600 * 1000),
  );
  return secret;
}

/** Start remembering this machine. Only ever after a successful sign-in. */
async function rememberDevice({ userId, req, res, name = '' }) {
  const secret = newToken(32);
  const country = await geo.countryFor(req.clientIp);
  const result = await db.execute(
    `INSERT INTO devices
       (user_id, token_hash, name, platform, browser, user_agent,
        first_ip, last_ip, last_country, trusted_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [
      userId,
      hashToken(secret),
      String(name || describeDevice(req.userAgent)).slice(0, 120),
      // `platform` and `browser` are columns that have existed since
      // schema_002 and were never written, so the devices page had to re-parse
      // the user agent on every render to say "Safari on iPhone". Writing them
      // once, here, is what lets the page show an icon per KIND of device.
      platformOf(req.userAgent),
      browserOf(req.userAgent),
      String(req.userAgent || '').slice(0, 400),
      String(req.clientIp || '').slice(0, 45),
      String(req.clientIp || '').slice(0, 45),
      String(country).slice(0, 2),
      config.session.deviceTrustDays,
    ],
  );
  res.cookie(
    DEVICE_COOKIE,
    `${result.insertId}.${secret}`,
    cookieOptions(config.session.deviceTrustDays * 24 * 3600 * 1000),
  );
  return result.insertId;
}

/** May this device skip the second factor right now? */
function deviceIsTrusted(device) {
  if (!device || device.reuseDetected || device.revoked_at) return false;
  if (!device.trusted_until) return false;
  return new Date(device.trusted_until) > new Date();
}

async function revokeDevice(userId, deviceId) {
  await db.transaction(async (tx) => {
    await tx.execute(
      'UPDATE devices SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [deviceId, userId],
    );
    await tx.execute(
      `UPDATE sso_sessions SET revoked_at = NOW(), revoked_reason = 'device_revoked'
        WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL`,
      [deviceId, userId],
    );
  });
}

async function listDevices(userId) {
  return db.query(
    `SELECT id, name, platform, browser, last_ip, last_country, first_seen_at,
            last_seen_at, trusted_until
       FROM devices
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY last_seen_at DESC`,
    [userId],
  );
}

/**
 * What kind of machine, what platform, what browser — from the user agent.
 *
 * DELIBERATELY ROUGH, all three of them. This is shown on the devices page so
 * somebody can tell "the laptop" from "the phone" and spot the one that is
 * neither. It is not analytics, nobody makes a decision on the aggregate, and a
 * wrong guess costs nothing at all.
 *
 * There is no user-agent parsing library here on purpose: one would be a
 * dependency that needs updating every time a browser renumbers itself, on the
 * one server where a supply-chain update is worth the most to an attacker, in
 * order to improve a label.
 */
function platformOf(userAgent) {
  const ua = String(userAgent || '');
  return (
    (/iPad/.test(ua) && 'iPad') ||
    (/iPhone/.test(ua) && 'iPhone') ||
    (/Android/.test(ua) && 'Android') ||
    (/Windows NT/.test(ua) && 'Windows') ||
    (/Macintosh|Mac OS X/.test(ua) && 'Mac') ||
    (/CrOS/.test(ua) && 'ChromeOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    ''
  );
}

function browserOf(userAgent) {
  const ua = String(userAgent || '');
  return (
    (/Edg\//.test(ua) && 'Edge') ||
    (/OPR\/|Opera/.test(ua) && 'Opera') ||
    (/SamsungBrowser/.test(ua) && 'Samsung Internet') ||
    (/Firefox\//.test(ua) && 'Firefox') ||
    (/Chrome\//.test(ua) && 'Chrome') ||
    (/Safari\//.test(ua) && !/Chrome/.test(ua) && 'Safari') ||
    ''
  );
}

/**
 * Which icon this row gets: `phone`, `tablet`, `desktop` or `device`.
 *
 * The owner asked for "different device different logo", and the reason it is
 * worth the twelve lines is the same reason the country is: a list of nine rows
 * that all say the same thing in the same shape is a list nobody reads. A phone
 * outline among six laptops is seen before it is read.
 */
function kindOf(userAgent, platform = '') {
  const ua = String(userAgent || '');
  const known = String(platform || '') || platformOf(ua);
  if (known === 'iPad' || /Tablet/i.test(ua)) return 'tablet';
  if (known === 'iPhone' || known === 'Android' || /Mobile/.test(ua)) {
    // An Android tablet says Android and does NOT say Mobile. That is the one
    // distinction Google actually documents, so it is the one used here.
    return known === 'Android' && !/Mobile/.test(ua) ? 'tablet' : 'phone';
  }
  if (known === 'Windows' || known === 'Mac' || known === 'Linux' || known === 'ChromeOS') {
    return 'desktop';
  }
  return 'device';
}

/** "Chrome on Windows", or as much of that as we can honestly say. */
function describeDevice(userAgent) {
  const os = platformOf(userAgent) || 'Unknown device';
  const browser = browserOf(userAgent);
  return browser ? `${browser} on ${os}` : os;
}

module.exports = {
  SESSION_COOKIE,
  DEVICE_COOKIE,
  create,
  setCookie,
  clearCookie,
  load,
  touch,
  raiseAssurance,
  revoke,
  revokeAllForUser,
  listForUser,
  recogniseDevice,
  rememberDevice,
  deviceIsTrusted,
  revokeDevice,
  listDevices,
  describeDevice,
  platformOf,
  browserOf,
  kindOf,
};
