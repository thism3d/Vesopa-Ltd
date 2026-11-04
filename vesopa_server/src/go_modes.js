/**
 * What a Vesopa Go device runs as (owner, 2026-11-03): "once account is
 * logged in then show EPOS option, Vesopa Kitchen option and customer display
 * option ... single app can be EPOS, display, kitchen but only one at a
 * time", and asked who chooses, "back office decides".
 *
 * So each Go device has a mode the venue sets on the back office's Devices
 * page: `ask` (the default: the device shows the three and remembers its
 * choice), `epos`, `kitchen` or `display`. A device set to one mode opens in
 * it and cannot be switched from the device.
 *
 *   GET  /api/go/mode               the device (terminal token): its mode
 *   POST /api/go/mode/report        the device: the mode it is running now
 *   POST /api/go/mode-token         the device: a kitchen or display credential
 *   GET  /api/go/device-modes       the back office: every Go device and its mode
 *   PUT  /api/go/device-modes/:id   the back office: set one
 *
 * THE CREDENTIAL. A Go device is signed in as a till (a terminal token on a
 * Go seat). As a kitchen screen or a customer display it needs that app's own
 * token, which only opens that app's routes (kitchen.js requireKitchen, the
 * display link). It is issued here for the venue the terminal token already
 * proves, the way the Vesopa doors issue them (terminal_vesopa.js): a kitchen
 * token as the kitchen door does, a display token on a display licence as the
 * display door does, counted the same way and failing open the same way.
 */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { requireTerminal } = require('./auth');
const licences = require('./licences');
const { attachAccess, requirePermission } = require('./permissions');

const MODES = ['ask', 'epos', 'kitchen', 'display'];
const clamp = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function goModeRoutes({ pool, secret, auth }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);

  let ready = null;
  function ensure() {
    ready ||= pool.query(`CREATE TABLE IF NOT EXISTS bo_go_device_modes (
        office VARCHAR(191) NOT NULL,
        device_id VARCHAR(64) NOT NULL,
        mode VARCHAR(12) NOT NULL DEFAULT 'ask',
        running VARCHAR(12) NULL,
        running_at DATETIME NULL,
        updated_by VARCHAR(191) NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (office, device_id)
      )`).catch((e) => { ready = null; throw e; });
    return ready;
  }

  /** The device behind a terminal token: its seat's device id, else what it says. */
  async function deviceOf(req) {
    const seatId = req.seatId || (req.terminal && req.terminal.jti);
    if (seatId) {
      try {
        const [[seat]] = await pool.query(
          'SELECT device_id, device_name, kind FROM bo_till_seats WHERE id = ? AND office = ?', [seatId, req.office]);
        if (seat && seat.device_id) return { id: String(seat.device_id), name: seat.device_name || null, kind: seat.kind || null };
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }
    const id = clamp((req.body && req.body.device_id) || req.query.device_id, 64);
    return id ? { id, name: clamp((req.body && req.body.device_name) || '', 120) || null, kind: null } : null;
  }

  async function modeOf(office, deviceId) {
    await ensure();
    const [[row]] = await pool.query(
      'SELECT mode FROM bo_go_device_modes WHERE office = ? AND device_id = ?', [office, deviceId]);
    return row && MODES.includes(row.mode) ? row.mode : 'ask';
  }

  router.get('/api/go/mode', terminal, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const device = await deviceOf(req);
      if (!device) return res.json({ mode: 'ask', fixed: false });
      const mode = await modeOf(req.office, device.id);
      res.json({ mode, fixed: mode !== 'ask', device_id: device.id });
    } catch (e) { next(e); }
  });

  /** What the device is showing now, for the back office's list. */
  router.post('/api/go/mode/report', terminal, express.json(), async (req, res, next) => {
    try {
      const device = await deviceOf(req);
      const running = clamp((req.body || {}).running, 12);
      if (!device || !['epos', 'kitchen', 'display'].includes(running)) return res.status(400).json({ error: 'Which mode?' });
      await ensure();
      await pool.query(
        `INSERT INTO bo_go_device_modes (office, device_id, mode, running, running_at)
         VALUES (?, ?, 'ask', ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE running = VALUES(running), running_at = VALUES(running_at)`,
        [req.office, device.id, running]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /**
   * A kitchen or display credential for this Go device, for its venue. The
   * mode must be the one the back office set, or `ask` (the device's own
   * choice): a device the venue fixed as a till cannot make itself a screen.
   */
  router.post('/api/go/mode-token', terminal, express.json(), async (req, res, next) => {
    try {
      const body = req.body || {};
      const want = clamp(body.mode, 12);
      if (!['kitchen', 'display'].includes(want)) return res.status(400).json({ error: 'A kitchen or display credential only.' });
      const device = await deviceOf(req);
      if (!device) return res.status(400).json({ error: 'This device has no id.' });
      const mode = await modeOf(req.office, device.id);
      if (mode !== 'ask' && mode !== want) {
        return res.status(403).json({ error: `Your back office has set this device to run as ${label(mode)}.`, mode });
      }
      const who = String(req.terminal.commissionedBy || 'vesopa-go').toLowerCase();
      const name = clamp(body.device_name, 120) || device.name || 'Vesopa Go';
      const [[office]] = await pool.query('SELECT name FROM offices WHERE contact_email = ?', [req.office]).catch(() => [[null]]);
      if (want === 'kitchen') {
        const token = jwt.sign(
          { scope: 'kitchen', office: req.office, user: who, name: name, via: 'go' },
          secret, { expiresIn: '90d' });
        return res.json({ token, office: req.office, venue: (office && office.name) || null });
      }
      // A display counts against the venue's display licences, as the
      // display's own door does; on another Go device's id, so the device's
      // till seat and its display seat are two different things.
      let seatId = null;
      try {
        seatId = await licences.signInDevice(pool, {
          office: req.office,
          kind: 'display',
          deviceId: `go-${device.id}`.slice(0, 64),
          deviceName: `${name} (display)`.slice(0, 120),
          by: who,
        });
      } catch (error) {
        if (error.name === 'SeatLimitError') {
          return res.status(409).json({
            error: error.message,
            licences: error.limit,
            seats: (error.seats || []).map((x) => ({ name: x.device_name })),
          });
        }
        throw error;
      }
      const token = jwt.sign(
        { scope: 'display', office: req.office, user: who, name, via: 'go' },
        secret,
        seatId ? { expiresIn: '90d', jwtid: seatId } : { expiresIn: '90d' });
      return res.json({ token, office: req.office, venue: (office && office.name) || null, seat: Boolean(seatId) });
    } catch (e) { next(e); }
  });

  // ---- the back office ----------------------------------------------------

  async function officeOf(req) {
    if (req.user.officeId) {
      const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (o) return o.contact_email;
    }
    return req.user.email;
  }

  // The back office's own rule for who may change a venue's devices.
  const manager = [attachAccess({ pool }), requirePermission('programming.devices')];

  router.get('/api/go/device-modes', auth, async (req, res, next) => {
    try {
      const office = await officeOf(req);
      await ensure();
      let seats = [];
      try {
        [seats] = await pool.query(
          `SELECT device_id, device_name, signed_in_at, last_seen_at FROM bo_till_seats
            WHERE office = ? AND released_at IS NULL AND kind = 'go' ORDER BY device_name`, [office]);
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
      const [modes] = await pool.query(
        'SELECT device_id, mode, running, running_at, updated_by, updated_at FROM bo_go_device_modes WHERE office = ?', [office]);
      const byId = new Map(modes.map((m) => [String(m.device_id), m]));
      const devices = seats.filter((s) => s.device_id).map((s) => {
        const m = byId.get(String(s.device_id)) || {};
        return {
          device_id: String(s.device_id),
          name: s.device_name || 'Vesopa Go',
          mode: MODES.includes(m.mode) ? m.mode : 'ask',
          running: m.running || null,
          running_at: m.running_at || null,
          updated_by: m.updated_by || null,
          last_seen_at: s.last_seen_at || s.signed_in_at || null,
        };
      });
      res.json({ modes: MODES.map((m) => ({ id: m, label: label(m) })), devices });
    } catch (e) { next(e); }
  });

  router.put('/api/go/device-modes/:id', auth, ...manager, express.json(), async (req, res, next) => {
    try {
      const office = await officeOf(req);
      const deviceId = clamp(req.params.id, 64);
      const mode = clamp((req.body || {}).mode, 12);
      if (!deviceId || !MODES.includes(mode)) return res.status(400).json({ error: 'That is not a mode a device can run as.' });
      await ensure();
      await pool.query(
        `INSERT INTO bo_go_device_modes (office, device_id, mode, updated_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE mode = VALUES(mode), updated_by = VALUES(updated_by)`,
        [office, deviceId, mode, clamp(req.user.email, 191)]);
      res.json({ device_id: deviceId, mode });
    } catch (e) { next(e); }
  });

  return router;
}

function label(mode) {
  return ({ ask: 'Ask on the device', epos: 'EPOS', kitchen: 'Vesopa Kitchen', display: 'Customer display' })[mode] || mode;
}

module.exports = { goModeRoutes, MODES };
