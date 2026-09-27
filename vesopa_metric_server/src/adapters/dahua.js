/**
 * Dahua access ANPR cameras (ITC2xx/ITC4xx), over their CGI API with digest
 * authentication.
 *
 * Dahua calls the allow-list the TrafficRedList, and a record on it can open
 * the barrier by itself (OpenGate=true) when the camera's barrier control is
 * set to "open by allowlist":
 *
 *   add      GET /cgi-bin/recordUpdater.cgi?action=insert&name=TrafficRedList
 *                &PlateNumber=AB12CDE&MasterOfCar=...&OpenGate=true
 *                &BeginTime=...&CancelTime=...           -> "RecNo=12"
 *   remove   GET /cgi-bin/recordUpdater.cgi?action=remove&name=TrafficRedList&recno=12
 *   open     GET /cgi-bin/trafficSnap.cgi?action=openStrobe&channel=1
 *                &info.openType=Normal&info.plateNumber=AB12CDE
 *
 * The RecNo each add returns is kept (gate_plates.device_ref) because Dahua
 * removes by record number, not by plate.
 */

const { request } = require('./http');

function stamp(offsetYears = 0) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + offsetYears);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  name: 'dahua',
  label: 'Dahua access ANPR camera (CGI)',

  async pushPlates(gate, plates) {
    const out = [];
    for (const p of plates) {
      const q = new URLSearchParams({
        action: 'insert',
        name: 'TrafficRedList',
        PlateNumber: p,
        MasterOfCar: 'Metric member',
        OpenGate: 'true',
        BeginTime: stamp(),
        CancelTime: stamp(10),
      });
      const r = await request({ base: gate.device_url, path: `cgi-bin/recordUpdater.cgi?${q}`, user: gate.device_user, pass: gate.device_pass });
      if (r.status !== 200) throw new Error(`adding ${p}: camera answered ${r.status} ${r.text.slice(0, 80)}`);
      out.push({ plate: p, ref: (r.text.match(/RecNo=(\d+)/i) || [])[1] || '' });
    }
    return out;
  },

  async removePlates(gate, rows) {
    for (const row of rows) {
      if (!row.device_ref) continue;
      const q = new URLSearchParams({ action: 'remove', name: 'TrafficRedList', recno: row.device_ref });
      const r = await request({ base: gate.device_url, path: `cgi-bin/recordUpdater.cgi?${q}`, user: gate.device_user, pass: gate.device_pass });
      if (r.status !== 200) throw new Error(`removing ${row.plate}: camera answered ${r.status}`);
    }
  },

  async open(gate, { plate }) {
    const q = new URLSearchParams({
      action: 'openStrobe',
      channel: String(gate.device_channel || 1),
      'info.openType': 'Normal',
      'info.plateNumber': plate || '',
    });
    const r = await request({ base: gate.device_url, path: `cgi-bin/trafficSnap.cgi?${q}`, user: gate.device_user, pass: gate.device_pass });
    return { ok: r.status === 200, status: r.status };
  },
};
