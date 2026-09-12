/**
 * Till licences: how many tills a venue may have signed in at once.
 *
 * A SEAT IS ONE SIGNED-IN TILL
 *
 * Signing a till in (either door: the password form or Continue with Vesopa)
 * takes a seat, and the till's token carries the seat's id as its `jti`. A
 * venue with a limit (`offices.till_licences`) and every seat taken is refused,
 * told which tills hold them, and told how to free one. NULL is no limit, and
 * every venue starts NULL.
 *
 * WHAT MAKES THE COUNT TRUE
 *
 *   * The same machine never holds two seats. A till tells the server its own
 *     permanent device id -- at sign-in from 1.7.3.0, and on every start through
 *     `/till/devices` whatever its version -- and when a seat learns a device id
 *     that an older seat already has, the older one is released as superseded.
 *     Signing in again on the bar till is one seat, not two.
 *   * Tills signed in before seats existed hold a token with no seat id. The
 *     first time one calls in, it is given a seat keyed on a hash of the token,
 *     so nobody has to sign in again for the numbers to add up. These are never
 *     refused: they were signed in before there was a limit to break.
 *
 * TAKING ONE BACK
 *
 * A seat released from the back office (Devices) or by the till signing out
 * turns that till's token away on its next call. It is a licence and not a lock:
 * the till's offline caches keep it selling until then, and that is right -- a
 * licence count must never stop a sale half way through.
 *
 * FAILING OPEN
 *
 * If the database cannot be asked, a till is let through. A venue unable to
 * sell because a licence lookup timed out would be a far worse fault than a
 * licence briefly uncounted.
 */
const crypto = require('crypto');

let pool = null;

/** Called once at start-up; until then (and in tests without it) nothing is checked. */
function init(db) {
  pool = db;
}

/** How long a lookup is trusted before the database is asked again. */
const CACHE_MS = 30_000;
/** How often a seat's last-seen time is written, at most. */
const SEEN_EVERY_MS = 5 * 60_000;

const cache = new Map(); // key -> { seatId, released, at, seenAt }

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * The venue's limit for an app, or null for none.
 *
 * Kept here as the name every caller already uses, but the answer now comes
 * from licences.js, which knows about the other three apps and about the
 * per-app table that replaced `offices.till_licences`. Lazily required: see the
 * note in claimSeat about the load-time cycle.
 */
async function limitFor(db, office, kind = 'till') {
  return require('./licences').limitFor(db, office, kind);
}

/** Seats in use now, newest first, with what a manager needs to recognise them. */
async function activeSeats(db, office, kind = 'till') {
  // The `kind` column arrived with schema_licence_keys.sql. A database without
  // it holds tills and nothing else -- which is exactly what the fallback
  // returns, rather than failing and letting a venue past its limit.
  try {
    const [rows] = await db.query(
      `SELECT id, device_id, device_name, kind, signed_in_by, signed_in_at, last_seen_at,
              token_hash IS NOT NULL AS legacy
         FROM bo_till_seats
        WHERE office = ? AND released_at IS NULL AND COALESCE(kind, 'till') = ?
        ORDER BY signed_in_at DESC`,
      [office, kind]
    );
    return rows.map((r) => ({ ...r, legacy: Number(r.legacy) === 1 }));
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    if (kind !== 'till') return [];
    const [rows] = await db.query(
      `SELECT id, device_id, device_name, signed_in_by, signed_in_at, last_seen_at,
              token_hash IS NOT NULL AS legacy
         FROM bo_till_seats
        WHERE office = ? AND released_at IS NULL
        ORDER BY signed_in_at DESC`,
      [office]
    );
    return rows.map((r) => ({ ...r, legacy: Number(r.legacy) === 1, kind: 'till' }));
  }
}

/** What a device is called in a refusal, so a manager can find it. */
function seatLabel(seat, noun = 'till') {
  return (
    seat.device_name ||
    (seat.signed_in_by ? `a ${noun} set up by ${seat.signed_in_by}` : `a ${noun}`)
  );
}

/** What each app is called in a sentence a manager reads. */
const NOUNS = {
  till: ['till licence', 'till licences', 'till'],
  kitchen: ['kitchen licence', 'kitchen licences', 'kitchen screen'],
  display: ['display licence', 'display licences', 'display'],
  express: ['kiosk licence', 'kiosk licences', 'kiosk'],
};

/** Refused: every seat is taken. Carries what the device shows and the back office lists. */
class SeatLimitError extends Error {
  constructor(limit, seats, kind = 'till') {
    const [one, many, thing] = NOUNS[kind] || NOUNS.till;
    const names = seats.map((s) => seatLabel(s, thing));
    const noun = limit === 1 ? `${one} is` : `${limit} ${many} are`;
    super(
      `${limit === 1 ? 'The' : 'All'} ${noun} in use${names.length ? `: ${names.join(', ')}` : ''}. ` +
        'Sign one of them out in the back office under Devices, or ask Vesopa for another licence.'
    );
    this.name = 'SeatLimitError';
    this.limit = limit;
    this.seats = seats;
    this.kind = kind;
  }
}

/**
 * Take a seat for a till signing in.
 *
 * [deviceId] is the till's own permanent id when it sends one; a seat already
 * held by that machine is reused rather than a second taken. Serialised per
 * venue on the office row, so two tills signing in at the same moment cannot
 * both take the last seat.
 */
async function claimSeat(db, { office, kind = 'till', deviceId, deviceName, by, fingerprint }) {
  // Required here rather than at the top of the file: licences.js reaches auth.js,
  // which reaches this file, and a cycle at load time would leave one of the
  // three with half its exports. Asked for at call time, everything is built.
  const licences = require('./licences');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM offices WHERE contact_email = ? FOR UPDATE', [office]);

    if (deviceId) {
      const [[mine]] = await conn.query(
        `SELECT id FROM bo_till_seats
          WHERE office = ? AND device_id = ? AND released_at IS NULL
          ORDER BY signed_in_at DESC LIMIT 1`,
        [office, deviceId]
      );
      if (mine) {
        // The same machine signing in again: its seat, its new token. The old
        // token is superseded the moment the till stores the new one.
        await conn.execute(
          `UPDATE bo_till_seats
              SET device_name = COALESCE(?, device_name), signed_in_by = ?,
                  signed_in_at = NOW(), last_seen_at = NOW()
            WHERE id = ?`,
          [deviceName || null, by || null, mine.id]
        );
        await conn.commit();
        forget(mine.id);
        return mine.id;
      }
    }

    const limit = await licences.limitFor(conn, office, kind);
    if (limit != null) {
      const seats = await activeSeats(conn, office, kind);
      if (seats.length >= limit) {
        // What happens to the device that does not fit depends on what it is.
        // A till or a kiosk can be mid-sale and a kitchen screen is holding the
        // orders being cooked, so those are refused and a manager chooses which
        // one to sign out. A customer display holds nothing: the newest wins.
        if (licences.POLICY[kind] === 'evict-oldest' && seats.length) {
          const oldest = seats[seats.length - 1];
          await conn.execute(
            `UPDATE bo_till_seats
                SET released_at = NOW(), released_by = ?, release_reason = ?
              WHERE id = ?`,
            [by || null, 'superseded by a newer display', oldest.id]
          );
          forget(oldest.id);
        } else {
          await conn.rollback();
          throw new SeatLimitError(limit, seats, kind);
        }
      }
    }

    const id = crypto.randomUUID();
    try {
      await conn.execute(
        `INSERT INTO bo_till_seats
           (id, office, kind, device_id, device_name, device_fingerprint,
            signed_in_by, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [id, office, kind, deviceId || null, deviceName || null, fingerprint || null, by || null]
      );
    } catch (e) {
      // A server whose licence-key migration has not run yet: take the seat
      // with the columns that do exist rather than refuse to sign a till in.
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      await conn.execute(
        `INSERT INTO bo_till_seats
           (id, office, device_id, device_name, signed_in_by, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [id, office, deviceId || null, deviceName || null, by || null]
      );
    }
    await conn.commit();
    return id;
  } catch (e) {
    try { await conn.rollback(); } catch { /* already done */ }
    throw e;
  } finally {
    conn.release();
  }
}

function forget(seatId) {
  for (const [key, entry] of cache) {
    if (entry.seatId === seatId) cache.delete(key);
  }
}

/**
 * The seat a terminal token names: by its `jti`, or -- a till signed in before
 * seats -- by the token's hash, registering it the first time it is seen.
 *
 * Returns `{ seatId, released }`, or null when the check could not be made.
 */
async function seatFor(claims, token) {
  if (!pool) return null;
  // A practice till holds no licence. Its token carries no seat id, and the
  // branch below would otherwise mint one keyed on the token's hash -- so a
  // venue that let two people practise would find itself a licence short at
  // the worst possible moment. Training is not a thing a venue pays for.
  if (claims.demo) return null;
  const key = claims.jti ? `j:${claims.jti}` : `h:${hashToken(token)}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) {
    if (!hit.released && now - hit.seenAt > SEEN_EVERY_MS) {
      hit.seenAt = now;
      pool.execute('UPDATE bo_till_seats SET last_seen_at = NOW() WHERE id = ?', [hit.seatId])
        .catch(() => {});
    }
    return hit;
  }

  let row;
  if (claims.jti) {
    [[row]] = await pool.query(
      'SELECT id, released_at FROM bo_till_seats WHERE id = ? AND office = ?',
      [claims.jti, claims.office]
    );
    // A token whose seat has no row was minted on a server that had not run
    // the migration yet. It is not refused: it is given the seat it names.
    if (!row) {
      await pool.execute(
        `INSERT IGNORE INTO bo_till_seats
           (id, office, signed_in_by, signed_in_at, last_seen_at)
         VALUES (?, ?, ?, FROM_UNIXTIME(?), NOW())`,
        [claims.jti, claims.office, claims.commissionedBy || null, claims.iat || Math.floor(now / 1000)]
      );
      row = { id: claims.jti, released_at: null };
    }
  } else {
    const hash = hashToken(token);
    [[row]] = await pool.query(
      'SELECT id, released_at FROM bo_till_seats WHERE token_hash = ?',
      [hash]
    );
    if (!row) {
      const id = crypto.randomUUID();
      await pool.execute(
        `INSERT IGNORE INTO bo_till_seats
           (id, office, token_hash, signed_in_by, signed_in_at, last_seen_at)
         VALUES (?, ?, ?, ?, FROM_UNIXTIME(?), NOW())`,
        [id, claims.office, hash, claims.commissionedBy || null, claims.iat || Math.floor(now / 1000)]
      );
      [[row]] = await pool.query(
        'SELECT id, released_at FROM bo_till_seats WHERE token_hash = ?',
        [hash]
      );
    }
  }
  if (!row) return null;

  const entry = { seatId: row.id, released: row.released_at != null, at: now, seenAt: now };
  if (!entry.released) {
    pool.execute('UPDATE bo_till_seats SET last_seen_at = NOW() WHERE id = ?', [row.id])
      .catch(() => {});
  }
  cache.set(key, entry);
  return entry;
}

/**
 * Name the machine behind a seat, from `/till/devices`.
 *
 * This is where an older till's seat learns which machine it is, and where a
 * machine that signed in again lets go of its previous seat -- so a venue
 * never sees the bar till counted twice.
 */
async function bindDevice(db, { office, seatId, deviceId, deviceName }) {
  if (!seatId || !deviceId) return;
  await db.execute(
    `UPDATE bo_till_seats SET device_id = ?, device_name = COALESCE(?, device_name)
      WHERE id = ? AND office = ?`,
    [deviceId, deviceName || null, seatId, office]
  );
  const [older] = await db.query(
    `SELECT id FROM bo_till_seats
      WHERE office = ? AND device_id = ? AND id <> ? AND released_at IS NULL`,
    [office, deviceId, seatId]
  );
  for (const seat of older) {
    await releaseSeat(db, { office, seatId: seat.id, by: null, reason: 'superseded' });
  }
}

/** Give a seat back. Its till's next call is refused. */
async function releaseSeat(db, { office, seatId, by, reason }) {
  const [r] = await db.execute(
    `UPDATE bo_till_seats
        SET released_at = NOW(), released_by = ?, release_reason = ?
      WHERE id = ? AND office = ? AND released_at IS NULL`,
    [by || null, reason || null, seatId, office]
  );
  forget(seatId);
  return r.affectedRows > 0;
}

module.exports = {
  init,
  limitFor,
  activeSeats,
  claimSeat,
  seatFor,
  bindDevice,
  releaseSeat,
  hashToken,
  SeatLimitError,
  _cache: cache,
};
