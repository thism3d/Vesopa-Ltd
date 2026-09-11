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

/** The venue's limit, or null for none. */
async function limitFor(db, office) {
  try {
    const [[row]] = await db.query(
      'SELECT till_licences FROM offices WHERE contact_email = ?',
      [office]
    );
    const n = row && row.till_licences;
    return n == null ? null : Math.max(0, Number(n));
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return null;
    throw e;
  }
}

/** Seats in use now, newest first, with what a manager needs to recognise them. */
async function activeSeats(db, office) {
  const [rows] = await db.query(
    `SELECT id, device_id, device_name, signed_in_by, signed_in_at, last_seen_at,
            token_hash IS NOT NULL AS legacy
       FROM bo_till_seats
      WHERE office = ? AND released_at IS NULL
      ORDER BY signed_in_at DESC`,
    [office]
  );
  return rows.map((r) => ({ ...r, legacy: Number(r.legacy) === 1 }));
}

/** What a till is called in a refusal, so a manager can find it. */
function seatLabel(seat) {
  return seat.device_name || (seat.signed_in_by ? `a till set up by ${seat.signed_in_by}` : 'a till');
}

/** Refused: every seat is taken. Carries what the till shows and the back office lists. */
class SeatLimitError extends Error {
  constructor(limit, seats) {
    const names = seats.map(seatLabel);
    const noun = limit === 1 ? 'till licence is' : `${limit} till licences are`;
    super(
      `${limit === 1 ? 'The' : 'All'} ${noun} in use${names.length ? `: ${names.join(', ')}` : ''}. ` +
        'Sign one of them out in the back office under Devices, or ask Vesopa for another licence.'
    );
    this.name = 'SeatLimitError';
    this.limit = limit;
    this.seats = seats;
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
async function claimSeat(db, { office, deviceId, deviceName, by }) {
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

    const limit = await limitFor(conn, office);
    if (limit != null) {
      const seats = await activeSeats(conn, office);
      if (seats.length >= limit) {
        await conn.rollback();
        throw new SeatLimitError(limit, seats);
      }
    }

    const id = crypto.randomUUID();
    await conn.execute(
      `INSERT INTO bo_till_seats
         (id, office, device_id, device_name, signed_in_by, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [id, office, deviceId || null, deviceName || null, by || null]
    );
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
