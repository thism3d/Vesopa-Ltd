const crypto = require('crypto');
const express = require('express');

const G = require('./wallet_google');

/**
 * Apple's pass update service, which is a protocol and not an API of ours.
 *
 * WHO IS CALLING
 *
 * Not a browser, not the till, and not an app of ours — there is no Vesopa app
 * on the customer's phone and there never needs to be. The caller is iOS
 * itself, on behalf of the Wallet app, hitting paths Apple chose. Every route
 * below is fixed: the shape, the status codes and the header names are all
 * Apple's, and the only latitude is what we do in the middle.
 *
 * The device finds these by the `webServiceURL` written into the pass, to which
 * it appends `/v1/...`. That is why APPLE_WALLET_WEB_SERVICE_URL is a bare
 * origin with no path, and why setting it before this file existed produced
 * passes that asked a URL which answered 404 — the pass carries the address
 * permanently, so it must be right at the moment the card is issued.
 *
 * THE FOUR CONVERSATIONS
 *
 *   register    "I am device D, holding pass S. Here is my push token."
 *   updates     "I am device D. Which of my passes changed since <tag>?"
 *   fetch       "Give me pass S again."
 *   unregister  "I deleted pass S. Stop telling me about it."
 *
 * Plus `/v1/log`, which is iOS reporting its own errors to us, and which is the
 * single most useful route here — see the note above it.
 *
 * AUTHENTICATION IS PER PASS, NOT PER VENUE
 *
 * Every request carries `Authorization: ApplePass <token>`, where the token is
 * the one baked into that one `.pkpass` when it was issued. There is no session
 * and no account: possession of the card is the credential, which is the right
 * model for a thing that lives in a stranger's pocket. A leaked token exposes
 * exactly one card and is rotated by reissuing it.
 */
function appleWebServiceRoutes({ pool, config, build }) {
  const router = express.Router();

  /**
   * The pass this request is about, if the caller may have it.
   *
   * Returns null for "no such pass" and for "wrong token" alike, and the caller
   * turns both into 401. Distinguishing them would let anyone with a serial
   * number learn whether it exists.
   */
  async function authorise(req, passTypeId, serial) {
    const header = String(req.headers.authorization || '');
    const match = /^ApplePass\s+(.+)$/i.exec(header.trim());
    if (!match) return null;

    const [[pass]] = await pool.query(
      `SELECT id, office, kind, subject_id, apple_serial, apple_auth_token,
              apple_issued_at, apple_updated_at
         FROM epos_wallet_passes
        WHERE apple_serial = ?`,
      [String(serial)]
    );
    if (!pass || !pass.apple_auth_token) return null;

    // The pass type in the URL has to be the one this card actually is.
    // Without the check, a valid token for a loyalty card would authorise a
    // request that claims to be about a gift card, and the registration would
    // be written under the wrong topic — which pushes as `TopicDisallowed`
    // months later with nothing to connect it to.
    const type = G.PASS_TYPES[pass.kind];
    if (!type || type.appleType !== String(passTypeId)) return null;

    // Constant-time, because the alternative leaks the token a character at a
    // time to anyone willing to measure. Lengths are compared first because
    // timingSafeEqual throws on a mismatch rather than returning false.
    const given = Buffer.from(match[1], 'utf8');
    const held = Buffer.from(String(pass.apple_auth_token), 'utf8');
    if (given.length !== held.length) return null;
    if (!crypto.timingSafeEqual(given, held)) return null;

    return pass;
  }

  /**
   * When this card last changed, as a whole number of seconds.
   *
   * `apple_updated_at` once anything has moved the card, and the issue time
   * before that — a pass that has never been updated last changed when it was
   * made. Seconds rather than milliseconds because the same value has to
   * survive a round trip through `Last-Modified`, which has no sub-second
   * resolution, and a tag that disagreed with the header by 400ms would make
   * every conditional fetch a full download.
   */
  const tagOf = (pass) => {
    const when = pass.apple_updated_at || pass.apple_issued_at;
    return when ? Math.floor(new Date(when).getTime() / 1000) : 0;
  };

  // ---------------------------------------------------------------------------
  // Register
  // ---------------------------------------------------------------------------

  /**
   * A device says it is holding this pass, and hands over the token that wakes
   * it.
   *
   * 201 the first time and 200 on a repeat, which is Apple's distinction and
   * worth honouring: iOS re-registers on its own after a restore or an OS
   * upgrade, and it uses the status to tell "you are new to me" from "we have
   * met". Neither is an error.
   *
   * The push token is overwritten every time rather than inserted once. It
   * changes — on a restore from backup, on an upgrade — and a stale one is a
   * card that silently stops updating, which is this feature's whole failure
   * mode.
   */
  router.post(
    '/v1/devices/:deviceId/registrations/:passTypeId/:serial',
    async (req, res, next) => {
      try {
        const { deviceId, passTypeId, serial } = req.params;
        const pass = await authorise(req, passTypeId, serial);
        if (!pass) return res.sendStatus(401);

        const pushToken = String((req.body && req.body.pushToken) || '').trim();
        if (!pushToken) return res.status(400).json({ error: 'pushToken is required' });

        const [[existing]] = await pool.query(
          `SELECT device_id FROM epos_wallet_devices
            WHERE device_id = ? AND serial_number = ?`,
          [String(deviceId), String(serial)]
        );

        await pool.execute(
          `INSERT INTO epos_wallet_devices
             (device_id, serial_number, pass_type_id, push_token, office)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             push_token   = VALUES(push_token),
             pass_type_id = VALUES(pass_type_id),
             office       = VALUES(office),
             last_error   = NULL`,
          [String(deviceId), String(serial), String(passTypeId), pushToken, pass.office]
        );

        // Pin the change tag on first contact. Until now it has been reading
        // through to `apple_issued_at`, which moves every time the card is
        // rebuilt — and a tag that moves on its own tells this device the pass
        // changed when it did not, costing it a download on every check-in
        // forever.
        if (!pass.apple_updated_at) {
          await pool.execute(
            `UPDATE epos_wallet_passes
                SET apple_updated_at = COALESCE(apple_updated_at, apple_issued_at, NOW())
              WHERE id = ?`,
            [pass.id]
          );
        }

        return res.sendStatus(existing ? 200 : 201);
      } catch (e) {
        next(e);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Unregister
  // ---------------------------------------------------------------------------

  /**
   * The holder deleted the card.
   *
   * The row goes, rather than being marked. A device that has said "stop
   * telling me" must be forgotten — keeping it would mean pushing to a phone
   * that has explicitly opted out, every time the card changes, until the token
   * eventually rots into a `BadDeviceToken`.
   */
  router.delete(
    '/v1/devices/:deviceId/registrations/:passTypeId/:serial',
    async (req, res, next) => {
      try {
        const { deviceId, passTypeId, serial } = req.params;
        const pass = await authorise(req, passTypeId, serial);
        if (!pass) return res.sendStatus(401);

        await pool.execute(
          'DELETE FROM epos_wallet_devices WHERE device_id = ? AND serial_number = ?',
          [String(deviceId), String(serial)]
        );
        return res.sendStatus(200);
      } catch (e) {
        next(e);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // What changed
  // ---------------------------------------------------------------------------

  /**
   * "Which of my passes have changed since <tag>?"
   *
   * Note what does *not* authenticate this one: there is no Authorization
   * header on this request, and Apple does not send one. The device library
   * identifier is the credential, which is why it must never be guessable and
   * why we only ever answer with serials that device has already registered —
   * this route can tell you what you already knew, and nothing else.
   *
   * 204 when nothing has moved, which is the overwhelmingly common answer and
   * is why it is a separate status rather than an empty list: iOS treats a
   * body-less 204 as "go back to sleep" without parsing anything.
   */
  router.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res, next) => {
    try {
      const { deviceId, passTypeId } = req.params;
      const since = Number(req.query.passesUpdatedSince) || 0;

      const [rows] = await pool.query(
        `SELECT p.apple_serial AS serial,
                UNIX_TIMESTAMP(COALESCE(p.apple_updated_at, p.apple_issued_at)) AS tag
           FROM epos_wallet_devices d
           JOIN epos_wallet_passes p ON p.apple_serial = d.serial_number
          WHERE d.device_id = ? AND d.pass_type_id = ?`,
        [String(deviceId), String(passTypeId)]
      );

      const changed = rows.filter((r) => Number(r.tag) > since);
      if (!changed.length) return res.sendStatus(204);

      // The tag handed back is the newest thing in this answer, so passing it
      // to the next call excludes everything in this one. Strictly greater
      // than, above, is what makes that true.
      const lastUpdated = changed.reduce((max, r) => Math.max(max, Number(r.tag) || 0), 0);

      return res.json({
        serialNumbers: changed.map((r) => String(r.serial)),
        lastUpdated: String(lastUpdated),
      });
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // The pass itself
  // ---------------------------------------------------------------------------

  /**
   * Hand back the current card.
   *
   * Built on demand, exactly as the customer-facing link builds it, because a
   * `.pkpass` is a snapshot and the whole point of this request is to get one
   * taken now. There is no stored file to serve and deliberately so — storing
   * one would mean invalidating it on every sale.
   *
   * `If-Modified-Since` is honoured against the change tag rather than against
   * the build. Two passes minted from the same data are byte-identical (see the
   * fixed ZIP date in wallet_apple.js), but the *row* is touched by every
   * rebuild, so answering from the build time would mean this route never
   * returned 304 and every check-in pulled a third of a megabyte over mobile
   * data.
   */
  router.get('/v1/passes/:passTypeId/:serial', async (req, res, next) => {
    try {
      const { passTypeId, serial } = req.params;
      const pass = await authorise(req, passTypeId, serial);
      if (!pass) return res.sendStatus(401);

      // Read before building. `build` writes `apple_issued_at = NOW()`, so a
      // tag taken afterwards would always be this instant, and the 304 below
      // could never fire.
      const tag = tagOf(pass);
      const lastModified = new Date(tag * 1000);

      const since = Date.parse(String(req.headers['if-modified-since'] || ''));
      if (Number.isFinite(since) && tag * 1000 <= since) {
        return res.sendStatus(304);
      }

      let built;
      try {
        built = await build(pass.office, pass.kind, pass.subject_id);
      } catch (e) {
        // The subject is gone — a customer deleted, a staff member removed. The
        // card cannot be rebuilt and never will be, so 404 rather than 500:
        // it is the honest answer and iOS stops asking.
        if (e.status === 404) return res.sendStatus(404);
        throw e;
      }

      return res
        .status(200)
        .set({
          'Content-Type': 'application/vnd.apple.pkpass',
          'Content-Disposition': `inline; filename="vesopa-${pass.kind}.pkpass"`,
          'Last-Modified': lastModified.toUTCString(),
          'Cache-Control': 'no-store, must-revalidate',
        })
        .send(built.bytes);
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // The log
  // ---------------------------------------------------------------------------

  /**
   * iOS telling us what went wrong at its end.
   *
   * The most valuable four lines in this file. There is no app on the
   * customer's phone, so there is no client to instrument and no crash report
   * to read: when a pass fails to update, this endpoint is the only place the
   * reason is ever spoken aloud. It is where "the web service returned an
   * invalid pass" and "authentication failed" arrive, and both of those are
   * otherwise completely silent.
   *
   * Logged rather than stored. These are Apple's own strings about our
   * deployment, they arrive rarely, and they belong beside the rest of the
   * server's output rather than in a table nobody thinks to read.
   *
   * Always 200, whatever the body. A device that cannot file a complaint retries
   * it, and there is nothing here worth making it retry.
   */
  router.post('/v1/log', (req, res) => {
    const logs = (req.body && Array.isArray(req.body.logs) ? req.body.logs : [])
      .map((line) => String(line).slice(0, 500))
      .slice(0, 20);
    for (const line of logs) console.error('[wallet] Apple Wallet device log:', line);
    res.sendStatus(200);
  });

  return router;
}

module.exports = { appleWebServiceRoutes };
