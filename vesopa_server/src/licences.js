/**
 * Licences: how many of each app a venue may run, and on which machines.
 *
 * WHAT A LICENCE IS HERE
 *
 * Two separate things, and keeping them apart is what makes this usable:
 *
 *   * a LIMIT -- how many of an app a venue has paid for (`bo_licence_limits`).
 *     Absent means no limit, and every venue starts absent, so nothing that is
 *     running today stops running when this is deployed.
 *   * a KEY -- a string Vesopa issues, which activates on exactly one machine
 *     and is thereafter bound to it (`bo_licence_keys`).
 *
 * A venue can be limited without keys (count the devices, trust the venue) or
 * keyed as well (the device must present a key nobody else's machine can use).
 * Keys are the answer to "only activated on that device"; limits are the answer
 * to "if they paid for two, two".
 *
 * THE FINGERPRINT
 *
 * A device id is a UUID the app generates and keeps in its own settings. A
 * reinstall makes a new one and a copied install brings the old one along, so
 * it can say which machine this *probably* is and nothing more. A fingerprint
 * is a hash of things a copy cannot carry -- on Windows the MachineGuid, the
 * motherboard serial and the system drive serial. The app computes it; the
 * server only ever sees the hash, never the serials themselves, which keeps a
 * venue's hardware inventory out of this database.
 *
 * WHAT HAPPENS TO THE SIXTH DEVICE
 *
 * Not the same answer for every app, because the cost of being wrong differs.
 * See POLICY below.
 */
const crypto = require('crypto');

const express = require('express');

const { requireAuth } = require('./auth');

/** The apps a venue licenses. Matches bo_devices.kind. */
const KINDS = ['till', 'kitchen', 'display', 'express'];

/** What each app is called on screen. */
const LABELS = {
  till: 'Till',
  kitchen: 'Kitchen screen',
  display: 'Customer display',
  express: 'Express kiosk',
};

/**
 * What to do when a venue is at its limit and another device signs in.
 *
 * `refuse` -- tell the venue which devices hold the licences and let a manager
 * sign one out. The right answer wherever bouncing a device loses work or
 * money: a till or a kiosk can be mid-sale, and a kitchen screen that vanishes
 * takes the orders being cooked with it.
 *
 * `evict-oldest` -- the newest device wins and the one signed in longest ago is
 * bounced. Only for the customer display, which shows a basket and holds
 * nothing: losing one costs a screen that goes blank until somebody looks at it.
 */
const POLICY = {
  till: 'refuse',
  kitchen: 'refuse',
  express: 'refuse',
  display: 'evict-oldest',
};

const KEY_BYTES = 8;

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key).trim().toUpperCase()).digest('hex');
}

/**
 * A new licence key, as the venue will see it once and never again.
 *
 * Grouped in fours because it is read down a telephone. Upper case and hashed
 * upper case, so a venue that types it in lower case is not told it is wrong.
 */
function newKey(kind) {
  const body = crypto
    .randomBytes(KEY_BYTES)
    .toString('hex')
    .toUpperCase()
    .match(/.{4}/g)
    .join('-');
  const key = `VES-${String(kind).toUpperCase()}-${body}`;
  // Up to the end of the first group, not a fixed number of characters: a
  // prefix that stops halfway through "41B7" reads as a typo on the screen
  // where somebody is trying to tell two keys apart.
  const prefix = key.split('-').slice(0, 3).join('-');
  return { key, hash: hashKey(key), prefix };
}

/**
 * How many of an app this venue may have signed in, or null for no limit.
 *
 * Falls back to `offices.till_licences` for tills, so a venue the admin set a
 * number for before this table existed keeps it even if the migration that
 * copies it across has not run.
 */
async function limitFor(db, office, kind) {
  try {
    const [[row]] = await db.query(
      'SELECT seats FROM bo_licence_limits WHERE office = ? AND kind = ?',
      [office, kind]
    );
    if (row && row.seats != null) return Math.max(0, Number(row.seats));
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  if (kind !== 'till') return null;
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

/** Every limit this venue has, for the back office. */
async function limitsFor(db, office) {
  const out = {};
  for (const kind of KINDS) out[kind] = await limitFor(db, office, kind);
  return out;
}

/**
 * Present a licence key from a machine.
 *
 * First machine to present it claims it. Any other machine is refused -- that
 * refusal is the whole feature, so it is deliberately not softened by a
 * "probably the same machine" guess.
 *
 * A device that sends no fingerprint (an app too old to compute one) can still
 * activate a key, and the key records what it can. Refusing those would turn a
 * licence into a reason a venue cannot open, which it must never be.
 */
async function activate(db, { office, kind, key, fingerprint, deviceId, deviceName, by }) {
  const hash = hashKey(key);
  const [[row]] = await db.query(
    `SELECT id, office, kind, device_fingerprint, device_name, revoked_at
       FROM bo_licence_keys WHERE key_hash = ?`,
    [hash]
  );
  if (!row) return { ok: false, error: 'That licence key is not recognised.' };
  if (row.revoked_at) {
    return { ok: false, error: 'That licence key has been withdrawn. Please contact Vesopa.' };
  }
  if (row.office !== office) {
    // Deliberately the same wording as an unknown key: which venue a key
    // belongs to is not a thing to confirm to somebody who does not have it.
    return { ok: false, error: 'That licence key is not recognised.' };
  }
  if (kind && row.kind !== kind) {
    return {
      ok: false,
      error: `That is a ${LABELS[row.kind] || row.kind} licence, not a ${LABELS[kind] || kind} one.`,
    };
  }

  if (row.device_fingerprint && fingerprint && row.device_fingerprint !== fingerprint) {
    return {
      ok: false,
      error:
        `That licence is already in use on ${row.device_name || 'another machine'}. ` +
        'Ask Vesopa to move it to this one.',
      inUseOn: row.device_name || null,
    };
  }

  await db.execute(
    `UPDATE bo_licence_keys
        SET device_fingerprint = COALESCE(device_fingerprint, ?),
            device_id          = COALESCE(?, device_id),
            device_name        = COALESCE(?, device_name),
            activated_at       = COALESCE(activated_at, NOW()),
            activated_by       = COALESCE(activated_by, ?)
      WHERE id = ?`,
    [fingerprint || null, deviceId || null, deviceName || null, by || null, row.id]
  );

  return { ok: true, id: row.id, kind: row.kind };
}

/**
 * Everything a device signing in has to satisfy, in one place.
 *
 * Both doors into a till (the password form in server.js and Continue with
 * Vesopa in terminal_vesopa.js) come through here, so the rules cannot drift
 * apart between them -- which they would, because only one of the two is
 * usually remembered when a rule changes.
 *
 * Order matters. The key is checked first: a machine presenting somebody else's
 * key is refused before it is given a seat, or a refused sign-in would still
 * have used up a licence.
 *
 * A device that sends no key is not refused. Keys are opt-in per venue -- most
 * are counted and trusted -- and a venue that has never been issued one must go
 * on working exactly as it did.
 */
async function signInDevice(
  pool,
  { office, kind = 'till', deviceId, deviceName, fingerprint, licenceKey, by }
) {
  const tillSeats = require('./till_seats');

  if (licenceKey) {
    const result = await activate(pool, {
      office,
      kind,
      key: licenceKey,
      fingerprint,
      deviceId,
      deviceName,
      by,
    });
    if (!result.ok) {
      const err = new Error(result.error);
      err.name = 'LicenceKeyError';
      err.licenceKey = true;
      throw err;
    }
  }

  return tillSeats.claimSeat(pool, {
    office,
    kind,
    deviceId,
    deviceName,
    fingerprint,
    by,
  });
}

/**
 * Venue-facing and admin routes.
 *
 * Setting a limit is the platform admin's (it is what the venue pays for);
 * seeing the limits and which devices hold them is the venue's.
 */
function licenceRoutes({ pool, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  const officeOf = async (req) => {
    const [[row]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [
      req.user.officeId,
    ]);
    return row ? row.contact_email : null;
  };

  /** This venue's limits, what is in use, and its keys. */
  router.get('/licences', auth, async (req, res, next) => {
    try {
      const office = await officeOf(req);
      if (!office) return res.status(404).json({ error: 'No venue on this login.' });

      const limits = await limitsFor(pool, office);

      let inUse = {};
      try {
        const [rows] = await pool.query(
          `SELECT kind, COUNT(*) AS n FROM bo_till_seats
            WHERE office = ? AND released_at IS NULL GROUP BY kind`,
          [office]
        );
        for (const r of rows) inUse[r.kind || 'till'] = Number(r.n);
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }

      let keys = [];
      try {
        const [rows] = await pool.query(
          `SELECT id, kind, key_prefix, label, device_name, activated_at, revoked_at
             FROM bo_licence_keys WHERE office = ? ORDER BY kind, created_at DESC`,
          [office]
        );
        keys = rows;
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      }

      res.json({
        kinds: KINDS.map((kind) => ({
          kind,
          label: LABELS[kind],
          limit: limits[kind],
          in_use: inUse[kind] || 0,
          policy: POLICY[kind],
        })),
        keys,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/** The admin's half: set a venue's limits and issue its keys. */
function adminLicenceRoutes({ pool }) {
  const router = express.Router();

  const officeEmail = async (officeId) => {
    const [[row]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [officeId]);
    return row ? row.contact_email : null;
  };

  /** What this venue is limited to now, and its keys — for the admin's form. */
  router.get('/offices/:id/licence-limits', async (req, res, next) => {
    try {
      const office = await officeEmail(Number(req.params.id));
      if (!office) return res.status(404).json({ error: 'No such venue.' });
      let keys = [];
      try {
        const [rows] = await pool.query(
          `SELECT id, kind, key_prefix, label, device_name, activated_at, revoked_at
             FROM bo_licence_keys WHERE office = ? ORDER BY kind, created_at DESC`,
          [office]
        );
        keys = rows;
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      }
      res.json({ limits: await limitsFor(pool, office), keys, kinds: KINDS, labels: LABELS });
    } catch (e) {
      next(e);
    }
  });

  /** How many of each app this venue has paid for. */
  router.put('/offices/:id/licence-limits', async (req, res, next) => {
    try {
      const office = await officeEmail(Number(req.params.id));
      if (!office) return res.status(404).json({ error: 'No such venue.' });
      const body = req.body || {};
      for (const kind of KINDS) {
        if (!(kind in body)) continue;
        const raw = body[kind];
        // A blank box is "no limit", which is a deletion rather than a zero --
        // zero would mean the venue may run none of that app at all.
        if (raw === null || raw === '' || raw === undefined) {
          await pool.execute('DELETE FROM bo_licence_limits WHERE office = ? AND kind = ?', [
            office,
            kind,
          ]);
          continue;
        }
        const seats = Math.max(0, Number(raw) || 0);
        await pool.execute(
          `INSERT INTO bo_licence_limits (office, kind, seats, updated_by)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE seats = VALUES(seats), updated_by = VALUES(updated_by)`,
          [office, kind, seats, req.user?.email || null]
        );
      }
      res.json({ ok: true, limits: await limitsFor(pool, office) });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Issue a key. The only time the key itself exists anywhere but the venue's
   * hands -- it is hashed on the way in and cannot be read back.
   */
  router.post('/offices/:id/licence-keys', async (req, res, next) => {
    try {
      const office = await officeEmail(Number(req.params.id));
      if (!office) return res.status(404).json({ error: 'No such venue.' });
      const kind = String((req.body || {}).kind || '').toLowerCase();
      if (!KINDS.includes(kind)) {
        return res.status(400).json({ error: `Which app? One of: ${KINDS.join(', ')}.` });
      }
      const { key, hash, prefix } = newKey(kind);
      await pool.execute(
        `INSERT INTO bo_licence_keys (office, kind, key_hash, key_prefix, label, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [office, kind, hash, prefix, (req.body || {}).label || null, req.user?.email || null]
      );
      res.json({
        key,
        kind,
        note: 'Copy this now. It is stored only as a hash and cannot be shown again.',
      });
    } catch (e) {
      next(e);
    }
  });

  /** Take a key back, or free it so it can be activated on new hardware. */
  router.post('/licence-keys/:id/revoke', async (req, res, next) => {
    try {
      await pool.execute(
        'UPDATE bo_licence_keys SET revoked_at = NOW(), revoked_by = ? WHERE id = ?',
        [req.user?.email || null, Number(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Move a key to another machine: forget the fingerprint so the next machine
   * to present it claims it. A deliberate act by a person, which is the point --
   * a licence that re-bound itself silently would not be bound to anything.
   */
  router.post('/licence-keys/:id/rebind', async (req, res, next) => {
    try {
      await pool.execute(
        `UPDATE bo_licence_keys
            SET device_fingerprint = NULL, device_id = NULL, device_name = NULL,
                activated_at = NULL, activated_by = NULL
          WHERE id = ? AND revoked_at IS NULL`,
        [Number(req.params.id)]
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = {
  KINDS,
  LABELS,
  POLICY,
  hashKey,
  newKey,
  limitFor,
  limitsFor,
  activate,
  signInDevice,
  licenceRoutes,
  adminLicenceRoutes,
};
