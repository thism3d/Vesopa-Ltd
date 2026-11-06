"""End to end on the live server: printer drives.

    python tool/e2e_print_drive_kitchen.py

Runs only against The Vesopa Kitchen, with a throwaway terminal and drive that
it deletes again whatever happens. Plays the part of the till, so no paper comes
out and no real device is touched. Prints one line per check.
"""
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import update_venue_versions as venue  # noqa: E402  (its ssh helper and paths)

SCRIPT = r"""
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true, quiet: true });
const crypto = require('crypto');
const fs = require('fs');
const mysql = require('mysql2/promise');
const { issueToken } = require('./src/auth');

const OFFICE = 'manager@vesopa.co.uk';
const base = `http://127.0.0.1:${process.env.PORT}`;
let failed = 0;
const check = (name, ok, extra) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`);
  if (!ok) failed += 1;
};

(async () => {
  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const [[a]] = await db.query("SELECT id, email, name, role, office_id FROM backoffice_users WHERE role = 'admin' LIMIT 1");
  const admin = issueToken({ id: a.id, email: a.email, name: a.name, role: a.role, officeId: a.office_id }, process.env.JWT_SECRET);
  const [[o]] = await db.query('SELECT id FROM offices WHERE contact_email = ?', [OFFICE]);
  const call = async (method, p, body, token = admin) => {
    const r = await fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, text };
  };
  const send = async (link, name, type, bytes) => {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type }), name);
    form.append('sender', 'E2E');
    return fetch(base + link, { method: 'POST', body: form });
  };
  const terminals = `/api/admin/offices/${o.id}/terminals`;
  const drives = `/api/admin/offices/${o.id}/print-drives`;
  const device = `e2e-${crypto.randomUUID().slice(0, 12)}`;
  let terminal = null;
  let drive = null;
  try {
    const made = await call('POST', terminals, { kind: 'till', name: 'E2E print' });
    terminal = made.body.id;
    const lic = await call('POST', '/api/terminal/license', {
      device_kind: 'till', venue_code: o.id, terminal_number: made.body.number, access_key: made.body.key,
      device_id: device, device_fingerprint: `e2e-print-${device}`,
    }, 'none');
    const token = lic.body.terminalToken;
    check('a throwaway till is licensed', !!token, lic);
    await call('GET', `/api/device/terminal?device_id=${device}&kind=till`, undefined, token);
    await call('PUT', '/api/device/terminal/settings', {
      device_id: device, kind: 'till', base_rev: 0,
      values: [{ category: 'Printers', name: 'vesopa_printers#printers', value: [{ id: 'p1', name: 'E2E printer' }] }],
    }, token);

    const list = await call('GET', drives);
    const mine = (list.body.connectors || []).find((c) => c.id === terminal);
    check('the till offers its printers', mine && mine.printers[0] && mine.printers[0].name === 'E2E printer', list.body);
    check('a drive needs a real printer', (await call('POST', drives, { name: 'X', terminal_id: terminal, printer_id: 'nope' })).status === 400);
    const add = await call('POST', drives, { name: 'E2E drive', terminal_id: terminal, printer_id: 'p1' });
    check('a drive is made', add.status === 201, add);
    drive = add.body.id;

    const test = await call('POST', `${drives}/${drive}/test`);
    check('a test page goes in', test.status === 201, test);
    let jobs = (await call('GET', `/api/device/print-jobs?device_id=${device}&kind=till`, undefined, token)).body.jobs;
    check('the till sees it waiting', jobs.length === 1 && jobs[0].printer_id === 'p1', jobs);
    const file = await fetch(`${base}/api/device/print-jobs/${jobs[0].id}/file`, { headers: { Authorization: `Bearer ${token}` } });
    const bytes = Buffer.from(await file.arrayBuffer());
    check('the till collects a real PDF', file.status === 200 && bytes.subarray(0, 4).toString() === '%PDF', file.status);
    const twice = await fetch(`${base}/api/device/print-jobs/${jobs[0].id}/file`, { headers: { Authorization: `Bearer ${token}` } });
    check('it cannot be collected twice', twice.status === 409, twice.status);
    const done = await call('POST', `/api/device/print-jobs/${jobs[0].id}/status`, { printed: true }, token);
    check('the till says it printed', done.status === 200, done);
    const late = await call('POST', `/api/device/print-jobs/${jobs[0].id}/status`, { printed: false }, token);
    check('a late answer cannot undo it', late.status === 409, late);
    const history = await call('GET', `${drives}/${drive}/jobs`);
    check('the history shows printed', history.body.jobs[0].status === 'printed', history.body);
    check('someone can print it again', (await call('POST', `${drives}/jobs/${jobs[0].id}/again`)).status === 200);
    jobs = (await call('GET', `/api/device/print-jobs?device_id=${device}&kind=till`, undefined, token)).body.jobs;
    check('and it waits again', jobs.length === 1, jobs);
    check('someone can cancel a waiting job', (await call('POST', `${drives}/jobs/${jobs[0].id}/cancel`)).status === 200);

    const link = (await call('GET', drives)).body.drives.find((d) => d.id === drive).link;
    check('the link has a page', (await fetch(base + link)).status === 200);
    check('the link takes a PDF', (await send(link, 'menu.pdf', 'application/pdf', Buffer.from('%PDF-1.4 e2e'))).status === 200);
    check('a file pretending to be a PDF is refused', (await send(link, 'evil.pdf', 'application/pdf', Buffer.from('<html>'))).status === 415);
    jobs = (await call('GET', `/api/device/print-jobs?device_id=${device}&kind=till`, undefined, token)).body.jobs;
    check('the link\'s document reaches the till', jobs.length === 1 && jobs[0].filename === 'menu.pdf', jobs);

    const other = await call('GET', `/api/device/print-jobs?device_id=someone-else&kind=till`, undefined, token);
    check('another device sees nothing', other.body.jobs.length === 0, other);
    check('the back office needs a sign-in', (await fetch(`${base}/api/print-drives`)).status === 401);
    check('a device token cannot open it', (await call('GET', '/api/print-drives', undefined, token)).status === 401);
    const ipp = await fetch(`${base}/ipp/print/${link.split('/').pop()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ipp' },
      body: Buffer.concat([
        Buffer.from([2, 0, 0, 2, 0, 0, 0, 1, 1, 0x47, 0, 18]), Buffer.from('attributes-charset'),
        Buffer.from([0, 5]), Buffer.from('utf-8'), Buffer.from([3]), Buffer.from('%PDF-1.4 from a phone'),
      ]),
    });
    const answer = Buffer.from(await ipp.arrayBuffer());
    check('a phone can print over the internet', ipp.status === 200 && answer.readUInt16BE(2) === 0, [ipp.status, answer.subarray(0, 8)]);
    jobs = (await call('GET', `/api/device/print-jobs?device_id=${device}&kind=till`, undefined, token)).body.jobs;
    check('and it lands in the drive for the till', jobs.length === 2, jobs);
    const profile = await fetch(`${base}${link}/airprint.mobileconfig`);
    check('the iPhone profile downloads', profile.status === 200 && (await profile.text()).includes('com.apple.airprint'));
    const manifest = await fetch(`${base}${link}/manifest.webmanifest`);
    check('Android gets its Share menu entry', manifest.status === 200 && !!(await manifest.json()).share_target);
    const swapped = await call('POST', `${drives}/${drive}/link`);
    check('a new link can be made', swapped.status === 200, swapped);
    check('the old link stops', (await fetch(base + link)).status === 404);
  } catch (e) {
    check('the run finished', false, e.message);
  } finally {
    if (drive) {
      const [files] = await db.query('SELECT id, office FROM bo_print_jobs WHERE drive_id = ?', [drive]);
      for (const f of files) fs.rmSync(path.join(__dirname, 'data', 'print-drive', OFFICE.replace(/[^\w.@-]/g, '_'), f.id), { force: true });
      await db.query('DELETE FROM bo_print_jobs WHERE drive_id = ?', [drive]);
      await db.query('DELETE FROM bo_print_drives WHERE id = ?', [drive]);
    }
    if (terminal) {
      await call('POST', `${terminals}/${terminal}/revoke`);
      await db.query('DELETE FROM bo_terminal_settings WHERE terminal_id = ?', [terminal]);
      await db.query('DELETE FROM bo_terminals WHERE id = ?', [terminal]);
    }
    await db.query("UPDATE bo_till_seats SET released_at = NOW(), release_reason = 'e2e test' WHERE office = ? AND device_id LIKE 'e2e-%' AND released_at IS NULL", [OFFICE]);
    await db.end();
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
"""


def main():
    stage = pathlib.Path(tempfile.mkdtemp(prefix="e2e-"))
    (stage / "zz_e2e.js").write_text(SCRIPT, encoding="utf-8")
    venue.ssh("put", str(stage), "/tmp/.e2estage")
    venue.ssh(
        "run",
        f"cp /tmp/.e2estage/zz_e2e.js {venue.BACKOFFICE}/ && rm -rf /tmp/.e2estage && "
        f"chown {venue.USER} {venue.BACKOFFICE}/zz_e2e.js && "
        f"(cd {venue.BACKOFFICE} && sudo -u {venue.USER} node zz_e2e.js); "
        f"rc=$?; rm -f {venue.BACKOFFICE}/zz_e2e.js; exit $rc",
    )


if __name__ == "__main__":
    main()
