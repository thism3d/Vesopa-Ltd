/**
 * What cameras and ANPR back offices call: /anpr/v1/gates/<key>/...
 *
 *   POST event       a plate has been read at this lane. Answers whether the
 *                    barrier should open, and (where the lane can be told)
 *                    tells the barrier to open.
 *   GET  allowlist   every plate that should open this lane now, for a
 *                    controller that keeps its own list and pulls it.
 *   GET  ping        is the key right; for the installer.
 *
 * THE KEY IS THE LANE. Each gate gets a long random key when it is made in
 * the console; the camera is configured with a URL that contains it (or sends
 * it as X-Gate-Key). Only its SHA-256 is stored.
 *
 * WHAT A CAMERA SENDS varies by make, so the event body is searched rather
 * than read from fixed fields:
 *
 *   generic / Metric   JSON   { "plate": "AB12CDE", "direction": "in", "confidence": 93 }
 *   Hikvision          XML or JSON EventNotificationAlert, often multipart with
 *                      pictures: <ANPR><licensePlate>AB12CDE</licensePlate>...
 *   Dahua              JSON  { "Picture": { "Plate": { "PlateNumber": "AB12CDE" } } }
 *   Milesight and most others: some key naming the plate, found the same way.
 */

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const access = require('./access');
const activity = require('./activity');
const { adapterFor } = require('./adapters');
const { limiter } = require('./security');

const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

const PLATE_KEYS = ['plate', 'licenseplate', 'platenumber', 'plateno', 'plate_number', 'license_plate', 'registration', 'vrm', 'plate_text', 'platetext', 'numberplate', 'carplate'];
const DIRECTION_KEYS = ['direction', 'dir', 'lane_direction', 'vehicledirection', 'travel_direction'];
const CONF_KEYS = ['confidence', 'confidencelevel', 'plateconfidence', 'score'];

/** The first value under any of `names`, anywhere in a parsed JSON body. */
function findKey(obj, names, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (names.includes(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) return v;
  }
  for (const v of Object.values(obj)) {
    const found = findKey(v, names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function fromXml(text, names) {
  for (const n of names) {
    const m = text.match(new RegExp(`<(?:\\w+:)?${n}[^>]*>\\s*([^<]{1,40}?)\\s*</`, 'i'));
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Read a plate, direction and confidence out of whatever arrived. `raw` is the
 * body as bytes (multipart and XML arrive that way); `json` is a parsed body
 * when there was one; `query` covers cameras that put it all in the address.
 */
function parseEvent({ raw, json, query, contentType = '' }) {
  const out = { plate: undefined, direction: undefined, confidence: undefined, source: 'json' };
  if (json && typeof json === 'object' && Object.keys(json).length) {
    out.plate = findKey(json, PLATE_KEYS);
    out.direction = findKey(json, DIRECTION_KEYS);
    out.confidence = findKey(json, CONF_KEYS);
  }
  if (!out.plate && raw && raw.length) {
    // Multipart (Hikvision sends the alert plus pictures): only the text parts
    // matter, and a picture's bytes read as latin1 cannot fake a tag match
    // worse than they already could.
    const text = raw.toString('latin1');
    const jsonPart = text.match(/\{[\s\S]*"(?:licensePlate|plateNumber|PlateNumber|plate)"[\s\S]*?\}\s*(?=\r?\n--|$)/);
    if (jsonPart) {
      try {
        const parsed = JSON.parse(jsonPart[0]);
        out.plate = findKey(parsed, PLATE_KEYS);
        out.direction = findKey(parsed, DIRECTION_KEYS);
        out.confidence = findKey(parsed, CONF_KEYS);
        out.source = 'multipart-json';
      } catch { /* try XML */ }
    }
    if (!out.plate) {
      out.plate = fromXml(text, ['licensePlate', 'plateNumber', 'PlateNumber', 'plate']);
      out.direction = fromXml(text, ['direction', 'vehicleDirection']);
      out.confidence = fromXml(text, ['confidenceLevel', 'confidence']);
      out.source = /multipart/i.test(contentType) ? 'multipart-xml' : 'xml';
    }
  }
  if (!out.plate && query) {
    out.plate = findKey(query, PLATE_KEYS);
    out.direction = out.direction || findKey(query, DIRECTION_KEYS);
    out.confidence = out.confidence || findKey(query, CONF_KEYS);
    out.source = 'query';
  }
  // Hikvision reports "unknown" when it saw a car but no plate.
  if (out.plate && /^(unknown|none|null|-+)$/i.test(String(out.plate))) out.plate = '';
  return out;
}

async function gateByKey(key) {
  if (!key || String(key).length < 20) return null;
  return db.one(
    `SELECT g.* FROM gates g JOIN sites s ON s.id = g.site_id
      WHERE g.key_hash = ? AND g.active = 1 AND s.active = 1`,
    [hashKey(key)],
  );
}

function anprRouter() {
  const r = express.Router();
  // Pictures come with events; nothing a camera sends needs more than this.
  const raw = express.raw({ type: () => true, limit: '8mb' });

  const lane = async (req, res, next) => {
    const gate = await gateByKey(req.params.key || req.get('X-Gate-Key'));
    if (!gate) return res.status(404).json({ error: 'No gate has that key.', open: false });
    req.gate = gate;
    next();
  };

  r.get('/gates/:key/ping', limiter({ perMinute: 30 }), lane, (req, res) => {
    res.json({ ok: true, gate: req.gate.name, direction: req.gate.direction, mode: req.gate.mode });
  });

  r.post('/gates/:key/event', limiter({ perMinute: 600 }), raw, lane, async (req, res, next) => {
    try {
      const contentType = String(req.get('content-type') || '');
      let json = null;
      if (/json/i.test(contentType) && Buffer.isBuffer(req.body) && req.body.length) {
        try { json = JSON.parse(req.body.toString('utf8')); } catch { json = null; }
      }
      const read = parseEvent({ raw: Buffer.isBuffer(req.body) ? req.body : null, json, query: req.query, contentType });
      if (!read.plate) {
        activity.record({ actor: { type: 'gate', id: req.gate.id, label: req.gate.name }, action: 'gate.unreadable', req, detail: { contentType, bytes: req.body ? req.body.length : 0 } });
        return reply(req, res, { open: false, decision: 'deny', reason: 'no_plate' });
      }
      const answer = await access.decide(req.gate, { ...read });

      // A lane this server can command is told to open, rather than trusted to
      // read the answer: most cameras post and forget. Not repeated for a
      // burst of reads of the same car.
      if (answer.open && !answer.repeat && req.gate.device_url && req.gate.mode !== 'allowlist') {
        const adapter = adapterFor(req.gate);
        if (typeof adapter.open === 'function' && req.gate.adapter !== 'generic' && req.gate.adapter !== 'metric_aigate') {
          adapter.open(req.gate, { plate: answer.plate }).then((o) => {
            activity.record({ actor: { type: 'gate', id: req.gate.id, label: req.gate.name }, action: o.ok ? 'gate.opened' : 'gate.open_failed', detail: { plate: answer.plate, status: o.status } });
          }).catch((e) => activity.record({ actor: { type: 'gate', id: req.gate.id, label: req.gate.name }, action: 'gate.open_failed', detail: { plate: answer.plate, error: e.message } }));
        }
      }
      return reply(req, res, answer);
    } catch (e) {
      next(e);
    }
  });

  r.get('/gates/:key/allowlist', limiter({ perMinute: 60 }), lane, async (req, res, next) => {
    try {
      const plates = await access.allowedPlates(req.gate.site_id);
      await db.run('UPDATE gates SET last_seen_at = NOW(), last_sync_at = NOW() WHERE id = ?', [req.gate.id]);
      if (String(req.query.format) === 'csv') {
        return res.type('text/csv').send(`plate\n${plates.join('\n')}${plates.length ? '\n' : ''}`);
      }
      res.json({ gate: req.gate.name, plates, count: plates.length, generated_at: new Date().toISOString() });
    } catch (e) { next(e); }
  });

  return r;
}

/** JSON by default; the bare word for controllers that can only match text. */
function reply(req, res, answer) {
  if (String(req.query.format) === 'text') return res.type('text/plain').send(answer.open ? 'OPEN' : 'DENY');
  return res.json({
    open: answer.open,
    decision: answer.decision,
    reason: answer.reason,
    plate: answer.plate,
    direction: answer.direction,
  });
}

module.exports = { anprRouter, parseEvent, hashKey };
