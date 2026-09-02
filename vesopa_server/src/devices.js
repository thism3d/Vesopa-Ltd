const express = require('express');
const { requireAuth, requireTerminal } = require('./auth');

/**
 * The machines in a venue, and what has happened to them.
 *
 * `bo_devices` and `bo_device_log` have been in schema_devices.sql since the
 * terminal work, with nothing writing to them. This is what writes to them.
 *
 * WHY THE TILL REGISTERS THE DISPLAY, AND NOT THE DISPLAY ITSELF
 *
 * The customer display ships with **no network capability at all** — its MSIX
 * manifest declares none, deliberately, because a screen pointed at the public
 * that reads one local file has no business reaching the internet. So it cannot
 * register itself, and giving it the ability to would be undoing a decision
 * worth keeping.
 *
 * It does not need to. A display is paired to a till on the same PC (see
 * `vesopa_epos/lib/data/display_pairing.dart`), and the till is commissioned,
 * online, and already talking to this server. The till registers what it is
 * paired with, which also means a display can only ever appear against the
 * venue whose till accepted it — the pairing *is* the authorisation, and there
 * is no route by which an unpaired screen can put a row in this table.
 *
 * TENANCY
 *
 *   /till/devices   a commissioned till, terminal token. The office comes off
 *                   the signed token and never off a query string — the same
 *                   rule /till/staff and /till/bills follow.
 *   /api/devices    the back office, session token, scoped to the signed-in
 *                   office.
 *
 * NOTHING HERE IS ON THE PATH THAT TAKES MONEY. A till whose registration POST
 * fails carries on selling and its display carries on showing bills; the only
 * thing lost is a row on a screen in the back office, and the next start
 * corrects it.
 */
function deviceRoutes({ pool, broadcast, secret }) {
  const router = express.Router();

  /** Free text, but bounded. A column is not a place to put a stack trace. */
  const clamp = (value, max) => {
    const s = String(value ?? '').trim();
    return s ? s.slice(0, max) : null;
  };

  /**
   * The caller's address, for the log.
   *
   * Behind nginx on the live box, so the forwarded header is read first and its
   * *first* entry taken — the rest of the list is whatever the client sent and
   * is not evidence of anything.
   */
  function callerIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0];
    return clamp(forwarded || req.socket?.remoteAddress || '', 64);
  }

  /**
   * Append to the log.
   *
   * The name and kind are written in alongside the id on purpose: this table is
   * denormalised so that a device renamed — or forgotten — after the fact
   * cannot rewrite what the log says it was called when it did the thing. See
   * schema_devices.sql.
   *
   * Never allowed to fail a request. A device that connected but whose log line
   * did not land is still connected, and refusing the registration over it
   * would be losing the thing to keep the note about the thing.
   */
  async function logEvent(office, device, event, { actor, detail, ip } = {}) {
    try {
      await pool.execute(
        `INSERT INTO bo_device_log
           (office, device_id, device_name, kind, event, actor, detail, ip_address)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          office,
          device.device_id,
          clamp(device.name, 120),
          clamp(device.kind, 24),
          clamp(event, 32),
          clamp(actor, 190),
          clamp(detail, 255),
          ip || null,
        ]
      );
    } catch (e) {
      // Swallowed. See the note above.
    }
  }

  // ---------------------------------------------------------------------------
  // The tills' half. Mounted at the root, so the paths below are the whole URL.
  // ---------------------------------------------------------------------------

  /**
   * Register a device, or say that one is still here.
   *
   * One row per machine per venue, updated in place — a till that reconnects
   * forty times in a service is one row that changes forty times, not forty
   * rows. `first_seen_at` is deliberately left alone by the update: it is when
   * this venue first saw the machine, and a reconnect must not rewrite it.
   *
   * A till registers *itself* (kind `till`) and each display it is paired with
   * (kind `display`), in one call, because that is one round trip on a start
   * rather than three and it keeps the two facts consistent: a till that could
   * register itself but not its screens would show a venue a till with no
   * display beside a display that is plainly working.
   */
  router.post('/till/devices', requireTerminal(secret), async (req, res, next) => {
    try {
      const office = req.office;
      const ip = callerIp(req);

      const submitted = Array.isArray(req.body?.devices) ? req.body.devices : [];
      if (!submitted.length) {
        return res.status(400).json({ error: 'No devices were sent.' });
      }
      // A venue has a handful of machines. A caller sending hundreds is either
      // broken or not a till, and either way this is not the route for it.
      if (submitted.length > 32) {
        return res.status(400).json({ error: 'Too many devices in one call.' });
      }

      const written = [];
      for (const raw of submitted) {
        const deviceId = clamp(raw?.device_id, 64);
        if (!deviceId) continue;

        const device = {
          device_id: deviceId,
          kind: clamp(raw?.kind, 24) || 'unknown',
          name: clamp(raw?.name, 120),
        };

        // Whether this is the first time this venue has seen the machine. Read
        // before the upsert, because after it the answer is always "no" — and
        // it is what decides between a 'connected' line in the log and the
        // 'paired' line that is worth reading a year later.
        const [[existing]] = await pool.query(
          'SELECT device_id FROM bo_devices WHERE office = ? AND device_id = ?',
          [office, deviceId]
        );

        await pool.execute(
          `INSERT INTO bo_devices
             (office, device_id, kind, name, signed_in_as, app_version,
              ip_address, online, last_seen_at)
           VALUES (?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)
           ON DUPLICATE KEY UPDATE
             kind         = VALUES(kind),
             name         = VALUES(name),
             signed_in_as = VALUES(signed_in_as),
             app_version  = VALUES(app_version),
             ip_address   = VALUES(ip_address),
             online        = 1,
             last_seen_at  = CURRENT_TIMESTAMP`,
          [
            office,
            deviceId,
            device.kind,
            device.name,
            clamp(raw?.signed_in_as, 190),
            clamp(raw?.app_version, 32),
            ip,
          ]
        );

        if (!existing) {
          await logEvent(
            office,
            device,
            device.kind === 'display' ? 'paired' : 'connected',
            {
              actor: clamp(raw?.signed_in_as, 190),
              detail: clamp(raw?.paired_to, 255),
              ip,
            }
          );
        }
        written.push(deviceId);
      }

      broadcast({ type: 'devices' });
      res.json({ registered: written.length });
    } catch (e) {
      next(e);
    }
  });

  /**
   * A device has gone: unpaired from the till, or the till itself shutting
   * down.
   *
   * The row is marked offline rather than deleted. "This venue has a customer
   * display and it is not switched on" is a far more useful thing for a manager
   * to read than the display simply not being listed — a machine that vanishes
   * from a list looks like a machine nobody ever had.
   */
  router.post('/till/devices/:id/offline', requireTerminal(secret), async (req, res, next) => {
    try {
      const office = req.office;
      const deviceId = clamp(req.params.id, 64);
      if (!deviceId) return res.status(400).json({ error: 'No device.' });

      const [[device]] = await pool.query(
        'SELECT device_id, kind, name FROM bo_devices WHERE office = ? AND device_id = ?',
        [office, deviceId]
      );
      if (!device) return res.json({ ok: true });

      await pool.execute(
        'UPDATE bo_devices SET online = 0 WHERE office = ? AND device_id = ?',
        [office, deviceId]
      );
      await logEvent(office, device, clamp(req.body?.event, 32) || 'disconnected', {
        detail: clamp(req.body?.detail, 255),
        ip: callerIp(req),
      });

      broadcast({ type: 'devices' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // The back office's half. Absolute paths as well: one router, mounted once at
  // the root, because the two halves of this file describe one table and
  // splitting them across two mounts would put them in two places to read.
  // ---------------------------------------------------------------------------

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

  const auth = requireAuth(secret);

  /**
   * Every machine this venue has, tills first and then screens.
   *
   * `stale` rather than a second online flag: a till that loses power stops
   * saying it is here but has no chance to say it has gone, so a row can claim
   * to be online long after the machine was switched off. Rather than run a
   * sweep, the answer is computed at read time from how long ago it last
   * checked in — which is the honest version, and needs nothing running in the
   * background to stay true.
   */
  router.get('/api/devices', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT device_id, kind, name, signed_in_as, app_version, ip_address,
                online, first_seen_at, last_seen_at,
                TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS seconds_ago
         FROM bo_devices
         WHERE office = ?
         ORDER BY FIELD(kind, 'till', 'display', 'kitchen'), name, device_id`,
        [office]
      );

      res.json(
        rows.map((d) => ({
          ...d,
          // Three minutes. A till registers on every start and on a slow
          // heartbeat; anything quieter than this is a machine that is off.
          stale: Number(d.seconds_ago) > 180,
        }))
      );
    } catch (e) {
      next(e);
    }
  });

  /** What has happened to this venue's machines, newest first. */
  router.get('/api/devices/log', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const deviceId = clamp(req.query.device_id, 64);
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

      const [rows] = await pool.query(
        `SELECT id, device_id, device_name, kind, event, actor, detail,
                ip_address, at
         FROM bo_device_log
         WHERE office = ? ${deviceId ? 'AND device_id = ?' : ''}
         ORDER BY at DESC, id DESC
         LIMIT ?`,
        deviceId ? [office, deviceId, limit] : [office, limit]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Forget a machine.
   *
   * Removes the row and nothing else. **The log is not touched**, and there is
   * deliberately no route that touches it: a log a manager can edit is worth
   * nothing in the argument it exists to settle, and "remove the device, erase
   * everything it ever did" is precisely the hole somebody would go looking
   * for. See schema_devices.sql.
   *
   * A machine that is still running will register again on its next start,
   * which is correct — this is for a screen that has been taken off the wall,
   * not a way to stop one reporting.
   */
  router.delete('/api/devices/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const deviceId = clamp(req.params.id, 64);
      if (!deviceId) return res.status(400).json({ error: 'No device.' });

      const [[device]] = await pool.query(
        'SELECT device_id, kind, name FROM bo_devices WHERE office = ? AND device_id = ?',
        [office, deviceId]
      );
      if (!device) return res.status(404).json({ error: 'No such device.' });

      await pool.execute(
        'DELETE FROM bo_devices WHERE office = ? AND device_id = ?',
        [office, deviceId]
      );
      await logEvent(office, device, 'forgotten', {
        actor: req.user.email,
        ip: callerIp(req),
      });

      broadcast({ type: 'devices' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { deviceRoutes };
