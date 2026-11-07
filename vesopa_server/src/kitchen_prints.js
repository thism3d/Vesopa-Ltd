/**
 * Kitchen tickets from Vesopa Go, for the paper printers on the tills
 * (testers, Pontardawe, 2026-11-07).
 *
 * A till prints its own tickets on the printer plugged into it. A phone has no
 * printer, so at a venue whose stations are set to Printer (or Both) a Go order
 * reached the kitchen board and never reached paper. This is the same answer
 * Vesopa Express has for kiosks (express_kiosk.js): the ticket waits here, one
 * row a station, a till with a printer at that station claims it, prints it and
 * says how it went.
 *
 * Only a ticket marked `source: 'go'` is queued: a till has printed its own
 * already, and queuing those would print every order twice.
 *
 * ONE UPDATE decides who wins a claim, so two tills with a printer each get one
 * ticket a station. A claim nobody answers goes back on offer after two
 * minutes, a failure until it has had five tries, and after thirty minutes the
 * ticket has expired: a till switched on at six o'clock doesn't print lunch.
 */

const crypto = require('crypto');
const { requireTerminal } = require('./auth');

const STATIONS = ['kp1', 'kp2', 'kp3', 'kp4', 'kp5', 'kp6'];
const MAX_TRIES = 5;

const ON_OFFER =
  "((p.status IN ('waiting', 'failed') AND p.attempts < " + MAX_TRIES + ')' +
  " OR (p.status = 'claimed' AND p.claimed_at < NOW() - INTERVAL 2 MINUTE))" +
  ' AND p.created_at > NOW() - INTERVAL 30 MINUTE';

function stationsOf(raw) {
  const named = new Set(String(raw || '').split(',').map((s) => s.trim().toLowerCase()));
  return STATIONS.filter((s) => named.has(s));
}

/** The stations of [ticket] that deliver to paper, in station order. */
function paperStations(ticket, modes) {
  const touched = new Set();
  for (const line of Array.isArray(ticket.lines) ? ticket.lines : []) {
    for (const s of stationsOf(line.stations)) touched.add(s);
  }
  return STATIONS.filter((s) => touched.has(s) && (modes[s] || 'printer') !== 'screen');
}

let ready = null;
function ensureTable(pool) {
  ready = ready || pool.query(
    `CREATE TABLE IF NOT EXISTS epos_kitchen_prints (
       ticket_id CHAR(36) NOT NULL,
       office VARCHAR(190) NOT NULL,
       station VARCHAR(8) NOT NULL,
       status VARCHAR(16) NOT NULL DEFAULT 'waiting',
       claim_id CHAR(36) NULL,
       claimed_by VARCHAR(120) NULL,
       claimed_at DATETIME NULL,
       attempts INT NOT NULL DEFAULT 0,
       error VARCHAR(300) NULL,
       printed_at DATETIME NULL,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (ticket_id, station),
       KEY idx_office_status (office, status),
       KEY idx_claim (claim_id)
     )`
  ).catch((e) => { ready = null; throw e; });
  return ready;
}

/** Put a Go ticket in the queue and tell the tills. Returns the stations queued. */
async function queueGoTicket(pool, broadcast, ticket, modes) {
  if (ticket.source !== 'go') return [];
  const stations = paperStations(ticket, modes);
  if (!stations.length) return [];
  await ensureTable(pool);
  for (const station of stations) {
    await pool.execute(
      'INSERT IGNORE INTO epos_kitchen_prints (ticket_id, office, station) VALUES (?, ?, ?)',
      [ticket.id, ticket.office, station]
    );
  }
  broadcast({ type: 'kitchen.print', id: ticket.id }, { office: ticket.office });
  return stations;
}

/** The ticket as a till prints it, only the lines of [stations]. */
async function ticketFor(pool, ticketId, office, stations) {
  const [[head]] = await pool.query(
    `SELECT id, kind, table_number, room_name, staff_name, covers, note, placed_at
       FROM epos_kitchen_tickets WHERE id = ? AND office = ?`,
    [ticketId, office]
  );
  if (!head) return null;
  const [rows] = await pool.query(
    `SELECT quantity, name, note, stations, is_modifier
       FROM epos_kitchen_ticket_lines WHERE ticket_id = ? ORDER BY seq`,
    [ticketId]
  );
  const wanted = new Set(stations);
  return {
    ...head,
    lines: rows
      .map((l) => ({
        quantity: Number(l.quantity) || 1,
        name: l.name,
        note: l.note,
        is_modifier: !!l.is_modifier,
        stations: stationsOf(l.stations).filter((s) => wanted.has(s)),
      }))
      .filter((l) => l.stations.length),
  };
}

function kitchenPrintRoutes({ pool, broadcast, secret }) {
  const router = require('express').Router();
  const terminal = requireTerminal(secret);

  router.get('/till/kitchen/print-queue', terminal, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      await ensureTable(pool);
      const [rows] = await pool.query(
        'SELECT p.ticket_id, p.station FROM epos_kitchen_prints p' +
          ' WHERE p.office = ? AND ' + ON_OFFER +
          ' ORDER BY p.created_at, p.ticket_id LIMIT 100',
        [req.office]
      );
      const byTicket = new Map();
      for (const r of rows) {
        if (!byTicket.has(r.ticket_id)) byTicket.set(r.ticket_id, []);
        byTicket.get(r.ticket_id).push(r.station);
      }
      res.json({ jobs: [...byTicket].map(([id, stations]) => ({ ticket_id: id, stations })) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/till/kitchen/print-queue/:id/claim', terminal, async (req, res, next) => {
    try {
      const wanted = stationsOf((Array.isArray(req.body?.stations) ? req.body.stations : []).join(','));
      if (!wanted.length) return res.status(400).json({ error: 'Name the stations this till prints.' });
      await ensureTable(pool);
      const claim = crypto.randomUUID();
      const by = String(req.body?.terminal || '').trim().slice(0, 120) || 'A till';
      await pool.execute(
        'UPDATE epos_kitchen_prints p' +
          " SET p.status = 'claimed', p.claim_id = ?, p.claimed_by = ?, p.claimed_at = NOW()," +
          '     p.attempts = p.attempts + 1, p.error = NULL' +
          ' WHERE p.ticket_id = ? AND p.office = ?' +
          '   AND p.station IN (' + wanted.map(() => '?').join(',') + ') AND ' + ON_OFFER,
        [claim, by, req.params.id, req.office, ...wanted]
      );
      const [won] = await pool.query(
        'SELECT station FROM epos_kitchen_prints WHERE claim_id = ? ORDER BY station',
        [claim]
      );
      if (!won.length) return res.json({ claim_id: null, stations: [] });
      const stations = won.map((w) => w.station);
      const ticket = await ticketFor(pool, req.params.id, req.office, stations);
      if (!ticket) return res.status(404).json({ error: 'No such ticket.' });
      res.json({ claim_id: claim, stations, ticket });
    } catch (e) {
      next(e);
    }
  });

  router.post('/till/kitchen/print-queue/:id/result', terminal, async (req, res, next) => {
    try {
      const claim = String(req.body?.claim_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(claim)) return res.status(400).json({ error: 'Which claim?' });
      let changed = 0;
      for (const r of Array.isArray(req.body?.results) ? req.body.results : []) {
        const [station] = stationsOf(r && r.station);
        if (!station) continue;
        const where = " WHERE ticket_id = ? AND office = ? AND station = ? AND claim_id = ? AND status = 'claimed'";
        const key = [req.params.id, req.office, station, claim];
        const [u] = r.ok
          ? await pool.execute("UPDATE epos_kitchen_prints SET status = 'printed', printed_at = NOW(), error = NULL" + where, key)
          : await pool.execute(
              "UPDATE epos_kitchen_prints SET status = 'failed', error = ?" + where,
              [String(r.error || 'The printer did not print it.').slice(0, 300), ...key]
            );
        changed += u.affectedRows;
      }
      // A failure is back on offer: the other tills may have a working printer.
      if (changed) broadcast({ type: 'kitchen.print', id: req.params.id }, { office: req.office });
      res.json({ ok: true, updated: changed });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { kitchenPrintRoutes, queueGoTicket, paperStations };
