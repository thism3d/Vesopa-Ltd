"""End to end on the live server: terminals, access keys and device settings.

    python tool/e2e_terminals_kitchen.py

Runs only against The Vesopa Kitchen, the test venue, with throwaway terminals
that it deletes again whatever happens. Takes no payment and touches no other
venue. Prints one line per check and fails if any does.
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
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: json };
  };
  const pages = `/api/admin/offices/${o.id}/terminals`;
  const made = [];
  const device = `e2e-${crypto.randomUUID().slice(0, 12)}`;
  try {
    const one = await call('POST', pages, { kind: 'till', name: 'E2E test' });
    check('admin issues a terminal and a key', one.status === 201 && /^VES-TILL-/.test(one.body.key || ''), one);
    made.push(one.body.id);
    const two = await call('POST', pages, { kind: 'till', name: 'E2E copy' });
    made.push(two.body.id);

    const license = (over) => call('POST', '/api/terminal/license', {
      device_kind: 'till', venue_code: o.id, terminal_number: one.body.number, access_key: one.body.key,
      device_id: device, device_fingerprint: 'e2e-fingerprint', device_name: 'E2E PC', ...over,
    }, 'none');
    check('a wrong key is refused', (await license({ access_key: 'VES-TILL-0000' })).status === 403);
    check('the right key on the wrong venue is refused', (await license({ venue_code: o.id + 1 })).status === 403);
    check('a till key on a kitchen screen is refused', (await license({ device_kind: 'kitchen' })).status === 403);
    const good = await license({});
    check('the right details license the till', good.status === 200 && !!good.body.terminalToken, good);
    const token = good.body.terminalToken;
    check('another machine cannot use a bound key', (await license({ device_fingerprint: 'other', device_id: 'other' })).status === 403);
    check('the same machine after a reinstall can', (await license({ device_id: `${device}-new` })).status === 200);
    await license({});

    check('the device token cannot open the back office', (await call('GET', '/api/terminals', undefined, token)).status === 401);

    const q = `?device_id=${device}&kind=till&version=e2e`;
    const first = await call('GET', `/api/device/terminal${q}`, undefined, token);
    check('the device finds its terminal', first.status === 200 && first.body.terminal.id === one.body.id, first);
    const pushed = await call('PUT', '/api/device/terminal/settings', {
      device_id: device, kind: 'till', base_rev: 0,
      values: [{ category: 'Printers', name: 'bill', value: 'A' }, { category: 'Orders', name: 'chime', value: true }],
    }, token);
    check('the device saves its settings', pushed.status === 200 && pushed.body.written === 2, pushed);

    const edited = await call('PUT', `${pages}/${one.body.id}/settings`, { values: [{ category: 'Printers', name: 'bill', value: 'Manager' }] });
    check('a manager edits one', edited.status === 200, edited);
    const stale = await call('PUT', '/api/device/terminal/settings', {
      device_id: device, kind: 'till', base_rev: pushed.body.rev,
      values: [{ category: 'Printers', name: 'bill', value: 'Old' }],
    }, token);
    check('an old value from the till cannot undo it', stale.body.held && stale.body.held.length === 1, stale);
    const again = await call('GET', `/api/device/terminal${q}`, undefined, token);
    const bill = (again.body.settings || []).find((s) => s.name === 'bill');
    check('the till reads the manager\'s value', bill && bill.value === 'Manager', again.body);

    const view = await call('GET', `${pages}/${one.body.id}/settings`);
    check('the page shows it, with what is waiting', view.status === 200 && view.body.settings.length === 2, view);
    const copied = await call('POST', `${pages}/${one.body.id}/settings/copy`, { to: [two.body.id], category: 'Printers' });
    check('copy to terminal', copied.status === 200 && copied.body.copied.length === 1, copied);

    const provider = await call('PUT', `${pages}/${one.body.id}/provider`, { provider: 'stripe' });
    check('a device gets its own provider', provider.status === 200, provider);
    const config = await call('GET', '/api/tap/config', undefined, token);
    check('Tap to Pay follows the device', config.body && config.body.tap_provider === 'stripe', config);
    await call('PUT', `${pages}/${one.body.id}/provider`, { provider: 'dojo' });
    const teya = await call('GET', '/api/till/teya/config', undefined, token);
    check('the device leaves the venue\'s Teya when set to Dojo', teya.status === 200 && teya.body.enabled === false, teya);
    await call('PUT', `${pages}/${one.body.id}/provider`, { provider: '' });

    const list = await call('GET', pages);
    check('the list says who takes the cards', list.status === 200 && list.body.venue_code === o.id, list);
    check('admin reads who takes the cards', (await call('GET', `/api/admin/offices/${o.id}/payment-providers`)).status === 200);
    check('admin reads the Go devices', (await call('GET', `/api/admin/offices/${o.id}/go-modes`)).status === 200);

    const back = await call('POST', '/api/terminal/relicense', { device_kind: 'till', device_fingerprint: 'e2e-fingerprint-long', device_id: device }, 'none');
    check('an unknown machine is not licensed by itself', back.status === 404, back);
    await db.query('UPDATE bo_terminals SET device_fingerprint = ? WHERE id = ?', ['e2e-fingerprint-long', one.body.id]);
    const relicensed = await call('POST', '/api/terminal/relicense', { device_kind: 'till', device_fingerprint: 'e2e-fingerprint-long', device_id: device }, 'none');
    check('a known machine comes back with no typing', relicensed.status === 200 && !!relicensed.body.terminalToken, relicensed);

    const gone = await call('POST', `${pages}/${one.body.id}/revoke`);
    check('the licence can be withdrawn', gone.status === 200 && !!gone.body.revoked_at, gone);
    const after = await call('GET', `/api/device/terminal${q}`, undefined, token);
    check('a withdrawn device stops', after.status === 401, after);
    check('a withdrawn key stops', (await license({})).status === 403);
    const noBack = await call('POST', '/api/terminal/relicense', { device_kind: 'till', device_fingerprint: 'e2e-fingerprint-long', device_id: device }, 'none');
    check('a withdrawn machine cannot come back by itself', noBack.status === 404, noBack);
  } catch (e) {
    check('the run finished', false, e.message);
  } finally {
    for (const id of made) {
      const [[row]] = await db.query('SELECT seat_id FROM bo_terminals WHERE id = ? AND office = ?', [id, OFFICE]);
      if (row && row.seat_id) await call('POST', `${pages}/${id}/revoke`);
      await db.query('DELETE FROM bo_terminal_settings WHERE terminal_id = ?', [id]);
      await db.query('DELETE FROM bo_terminals WHERE id = ? AND office = ?', [id, OFFICE]);
    }
    await db.query("UPDATE bo_till_seats SET released_at = NOW(), release_reason = 'e2e test' WHERE office = ? AND device_id LIKE 'e2e-%' AND released_at IS NULL", [OFFICE]);
    await db.query("DELETE FROM bo_terminal_settings WHERE terminal_id IN (SELECT id FROM bo_terminals WHERE office = ? AND device_id LIKE 'e2e-%')", [OFFICE]);
    await db.query("DELETE FROM bo_terminals WHERE office = ? AND device_id LIKE 'e2e-%'", [OFFICE]);
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
