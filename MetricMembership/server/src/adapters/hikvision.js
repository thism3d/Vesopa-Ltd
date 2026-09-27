/**
 * Hikvision ANPR cameras (iDS-TCM/TCG entrance cameras and the barrier
 * packages built on them), over ISAPI with digest authentication.
 *
 * From Hikvision's ANPR ISAPI integration guides:
 *
 *   allow-list add     PUT  /ISAPI/Traffic/channels/<ch>/licensePlateAuditData
 *                           <LicensePlateInfoList> of <LicensePlateInfo>,
 *                           listType whiteList
 *   allow-list remove  PUT  /ISAPI/Traffic/channels/<ch>/DelLicensePlateAuditData
 *   barrier open       PUT  /ISAPI/Parking/channels/<ch>/barrierGate
 *                           <BarrierGate><ctrlMode>open</ctrlMode></BarrierGate>
 *   events             the camera's "HTTP listening" / alarm host posts
 *                      EventNotificationAlert (XML or JSON, often multipart
 *                      with pictures) to /anpr/v1/gates/<key>/event
 *
 * CHECK ON THE UNIT: firmware generations differ in small ways (element
 * names, JSON vs XML). The installer should confirm the list shows up under
 * the camera's Vehicle Detection > Allowlist page after the first sync.
 */

const { request } = require('./http');

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function day(offsetYears = 0) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + offsetYears);
  return d.toISOString().slice(0, 10);
}

function ok(r, what) {
  if (r.status < 200 || r.status >= 300) {
    const reason = (r.text.match(/<subStatusCode>([^<]*)</) || [])[1] || r.text.slice(0, 120);
    throw new Error(`${what}: camera answered ${r.status} ${reason}`.trim());
  }
}

module.exports = {
  name: 'hikvision',
  label: 'Hikvision ANPR camera (ISAPI)',

  async pushPlates(gate, plates) {
    if (!plates.length) return [];
    const now = new Date().toISOString().slice(0, 19);
    const items = plates.map((p) => `<LicensePlateInfo><LicensePlate>${esc(p)}</LicensePlate><listType>whiteList</listType>`
      + `<createTime>${now}</createTime><effectiveStartDate>${day()}</effectiveStartDate>`
      + `<effectiveTime>${day(10)}</effectiveTime><id></id></LicensePlateInfo>`).join('');
    const r = await request({
      base: gate.device_url,
      path: `ISAPI/Traffic/channels/${gate.device_channel || 1}/licensePlateAuditData`,
      method: 'PUT',
      user: gate.device_user,
      pass: gate.device_pass,
      contentType: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?><LicensePlateInfoList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">${items}</LicensePlateInfoList>`,
    });
    ok(r, 'adding plates');
    return plates.map((p) => ({ plate: p, ref: '' }));
  },

  async removePlates(gate, rows) {
    if (!rows.length) return;
    const items = rows.map((r) => `<LicensePlateInfo><LicensePlate>${esc(r.plate)}</LicensePlate></LicensePlateInfo>`).join('');
    const r = await request({
      base: gate.device_url,
      path: `ISAPI/Traffic/channels/${gate.device_channel || 1}/DelLicensePlateAuditData`,
      method: 'PUT',
      user: gate.device_user,
      pass: gate.device_pass,
      contentType: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?><LicensePlateInfoList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">${items}</LicensePlateInfoList>`,
    });
    ok(r, 'removing plates');
  },

  async open(gate) {
    const r = await request({
      base: gate.device_url,
      path: `ISAPI/Parking/channels/${gate.device_channel || 1}/barrierGate`,
      method: 'PUT',
      user: gate.device_user,
      pass: gate.device_pass,
      contentType: 'application/xml',
      body: '<?xml version="1.0" encoding="UTF-8"?><BarrierGate version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><ctrlMode>open</ctrlMode></BarrierGate>',
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  },
};
