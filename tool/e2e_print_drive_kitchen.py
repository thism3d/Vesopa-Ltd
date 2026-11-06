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
  let extra = null;
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
    const profileBytes = Buffer.from(await profile.arrayBuffer());
    check('the iPhone profile downloads', profile.status === 200 && profileBytes.includes('com.apple.airprint'));
    const signedFile = path.join(require('os').tmpdir(), `e2e-${device}.der`);
    fs.writeFileSync(signedFile, profileBytes);
    const signer = require('child_process').spawnSync('sh', ['-c',
      `openssl smime -verify -binary -inform der -in ${signedFile} -noverify -signer ${signedFile}.pem >/dev/null 2>&1 && openssl x509 -in ${signedFile}.pem -noout -subject -enddate; rm -f ${signedFile} ${signedFile}.pem`]);
    check('it is signed by Apple Distribution: Vesopa Software Ltd', /Apple Distribution: Vesopa Software Ltd/.test(String(signer.stdout)), String(signer.stdout));
    console.log(`       ${String(signer.stdout).trim().replace(/\n/g, ' | ')}`);
    check('the page says when a phone has reached the printer', (await (await fetch(`${base}${link}/seen?since=${Date.now() - 60000}`)).json()).seen === true);
    check('and not before it did', (await (await fetch(`${base}${link}/seen?since=${Date.now() + 60000}`)).json()).seen === false);
    const guide = await (await fetch(base + link)).text();
    check('the page has the steps and the manifest in its head', guide.includes('Add to this device') && guide.indexOf('rel="manifest"') < guide.indexOf('</head>'));
    const manifest = await fetch(`${base}${link}/manifest.webmanifest`);
    check('Android gets its Share menu entry', manifest.status === 200 && !!(await manifest.json()).share_target);
    const online = await call('POST', drives, { name: 'E2E online only' });
    check('an online-only printer is made', online.status === 201, online);
    extra = online.body.id;
    check('a second printer on one venue', (await call('GET', drives)).body.drives.filter((d) => /^E2E/.test(d.name)).length === 2);
    check('it takes a document', (await send(online.body.link, 'report.pdf', 'application/pdf', Buffer.from('%PDF-1.4 kept'))).status === 200);
    const kept = await call('GET', `${drives}/${extra}/jobs`);
    check('and keeps it, saved', kept.body.jobs[0].status === 'saved', kept.body);
    check('no till is sent it', (await call('GET', `/api/device/print-jobs?device_id=${device}&kind=till`, undefined, token)).body.jobs.length === 2);
    const opened = await call('GET', `${drives}/jobs/${kept.body.jobs[0].id}/file`);
    check('it can be opened', opened.status === 200 && opened.text.startsWith('%PDF'), opened.status);
    const offer = await call('GET', '/api/device/print-profile-link', undefined, token);
    check('Go gets a link for all the printers', offer.status === 200 && offer.body.drives.length >= 2, offer);
    const whole = await fetch(`${base}${new URL(offer.body.url).pathname}`);
    const wholeText = await whole.text();
    check('the profile holds every printer', whole.status === 200 && (wholeText.match(/ResourcePath/g) || []).length >= 2, whole.status);
    check('a made-up profile link is refused', (await fetch(`${base}/print-profile/nonsense`)).status === 404);

    // The Virtual Printers page's operations.
    const row = async (id) => (await call('GET', drives)).body.drives.find((d) => d.id === id);
    const keep = (await row(extra));
    check('the page gets its counts', keep.saved === 1 && keep.today === 1 && keep.total === 1 && keep.bytes > 0 && !!keep.last_job_at, keep);
    const feed = await call('GET', `${drives}/activity`);
    check('every printer\'s documents in one list', feed.status === 200 && feed.body.jobs.some((j) => j.drive_name === 'E2E online only' && j.online_only), feed.status);
    check('a printer needs a name', (await call('PUT', `${drives}/${extra}`, { name: '  ' })).status === 400);
    check('it can be renamed', (await call('PUT', `${drives}/${extra}`, { name: 'E2E renamed' })).status === 200 && (await row(extra)).name === 'E2E renamed');
    check('renaming leaves everything else alone', (await row(extra)).online_only && (await row(extra)).enabled);
    check('it can be paused', (await call('PUT', `${drives}/${extra}`, { enabled: false })).status === 200);
    const pausedPage = await fetch(base + keep.link);
    check('a paused printer says so', pausedPage.status === 404 && (await pausedPage.text()).includes('paused'));
    check('a paused printer takes nothing', (await send(keep.link, 'x.pdf', 'application/pdf', Buffer.from('%PDF-1.4 x'))).status === 404);
    const noPaused = (await call('GET', '/api/device/print-profile-link', undefined, token)).body.drives;
    check('Go is not offered a paused printer', !noPaused.some((d) => d.name === 'E2E renamed'), noPaused);
    check('and it resumes', (await call('PUT', `${drives}/${extra}`, { enabled: true })).status === 200 && (await fetch(base + keep.link)).status === 200);
    check('a printer must be a real one', (await call('PUT', `${drives}/${extra}`, { terminal_id: terminal, printer_id: 'nope' })).status === 400);
    const savedJob = (await call('GET', `${drives}/${extra}/jobs`)).body.jobs[0];
    check('with no paper printer it cannot go to paper', (await call('POST', `${drives}/jobs/${savedJob.id}/again`)).status === 409);
    check('a paper printer can be attached later', (await call('PUT', `${drives}/${extra}`, { terminal_id: terminal, printer_id: 'p1' })).status === 200 && !(await row(extra)).online_only);
    check('a saved document can then go to paper', (await call('POST', `${drives}/jobs/${savedJob.id}/again`)).status === 200);
    check('and the phones switch works there', (await call('PUT', `${drives}/${extra}`, { phones: true })).status === 200 && (await row(extra)).phones);
    check('taking the paper printer away keeps what was waiting', (await call('PUT', `${drives}/${extra}`, { terminal_id: 0 })).status === 200);
    const back = await row(extra);
    check('it is saved again, with phones off', back.online_only && back.saved === 1 && back.waiting === 0 && !back.phones, back);
    const web = await call('POST', `${drives}/profile-link`);
    check('the page gets a link for every printer', web.status === 200 && (await (await fetch(`${base}${new URL(web.body.url).pathname}`)).text()).includes('com.apple.airprint'));
    check('a document can be deleted', (await call('DELETE', `${drives}/jobs/${savedJob.id}`)).status === 200);
    check('and is gone', (await call('GET', `${drives}/jobs/${savedJob.id}/file`)).status === 404 && (await row(extra)).total === 0);
    const swapped = await call('POST', `${drives}/${drive}/link`);
    check('a new link can be made', swapped.status === 200, swapped);
    check('the old link stops', (await fetch(base + link)).status === 404);
  } catch (e) {
    check('the run finished', false, e.message);
  } finally {
    for (const gone of [drive, extra].filter(Boolean)) {
      const [files] = await db.query('SELECT id, office FROM bo_print_jobs WHERE drive_id = ?', [gone]);
      for (const f of files) fs.rmSync(path.join(__dirname, 'data', 'print-drive', OFFICE.replace(/[^\w.@-]/g, '_'), f.id), { force: true });
      await db.query('DELETE FROM bo_print_jobs WHERE drive_id = ?', [gone]);
      await db.query('DELETE FROM bo_print_drives WHERE id = ?', [gone]);
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
