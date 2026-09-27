/**
 * Generic: any camera, controller or ANPR back office that can call a web
 * address.
 *
 * DECISION: it POSTs a read to /anpr/v1/gates/<key>/event and opens on the
 * answer ({ "open": true }, or the word OPEN with ?format=text).
 *
 * ALLOW-LIST: it fetches /anpr/v1/gates/<key>/allowlist (JSON, or CSV with
 * ?format=csv) on its own schedule; or, when the gate has a device_url, this
 * server POSTs the full list there after every change:
 *
 *   POST <device_url>
 *   { "gate": "North entry", "plates": ["AB12CDE", ...], "generated_at": "..." }
 *
 * A full list every time rather than adds and removes: a controller that
 * missed one message is right again on the next.
 *
 * OPEN: with a device_url, POST <device_url>/open { "plate": ... }.
 */

const { request } = require('./http');

async function pushAll(gate, plates) {
  if (!gate.device_url) return { ok: true, skipped: 'pull' };
  const r = await request({
    base: gate.device_url,
    path: '',
    method: 'POST',
    user: gate.device_user,
    pass: gate.device_pass,
    contentType: 'application/json',
    body: JSON.stringify({ gate: gate.name, plates, generated_at: new Date().toISOString() }),
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`controller answered ${r.status}`);
  return { ok: true };
}

module.exports = {
  name: 'generic',
  label: 'Generic (web address / webhook)',
  // Generic sends the whole list rather than differences.
  fullList: true,
  pushAll,
  async open(gate, { plate }) {
    if (!gate.device_url) return { ok: false, skipped: 'no device address' };
    const r = await request({
      base: gate.device_url,
      path: 'open',
      method: 'POST',
      user: gate.device_user,
      pass: gate.device_pass,
      contentType: 'application/json',
      body: JSON.stringify({ gate: gate.name, plate }),
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  },
};
