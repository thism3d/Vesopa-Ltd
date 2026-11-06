"""Pause Events & tickets at Pontardawe RFC (owner, 2026-11-06), or resume it.

    python tool/pause_pontardawe_events.py          # pause, with the usual 24-hour warning
    python tool/pause_pontardawe_events.py resume   # put it back

The owner: pause what the club is not using. It had no events and no ticket
orders. Uses the same route as Pause on admin.vesopa.com, so it shows there and
can be resumed there. Touches nothing else, and Memberships is left alone.
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
const mysql = require('mysql2/promise');
const { issueToken } = require('./src/auth');
(async () => {
  const db = mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const [[a]] = await db.query("SELECT id, email, name, role, office_id FROM backoffice_users WHERE role = 'admin' LIMIT 1");
  const t = issueToken({ id: a.id, email: a.email, name: a.name, role: a.role, officeId: a.office_id }, process.env.JWT_SECRET);
  const [[e]] = await db.query("SELECT COUNT(*) n FROM epos_events WHERE office = 'info@vesopa.com'");
  const [[o]] = await db.query("SELECT COUNT(*) n FROM epos_event_orders WHERE office = 'info@vesopa.com'");
  console.log(`  events ${e.n}, ticket orders ${o.n}`);
  if (%ACTION% === 'pause' && (e.n || o.n)) throw new Error('The club has events now: not pausing.');
  const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/admin/offices/35/holds/module:events`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: %ACTION%, reason: 'Not in use (owner, 2026-11-06)' }),
  });
  console.log(`  ${%ACTION%}: ${r.status} ${JSON.stringify(await r.json())}`);
  await db.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
"""


def main():
    action = "resume" if "resume" in sys.argv else "pause"
    stage = pathlib.Path(tempfile.mkdtemp(prefix="hold-"))
    (stage / "zz_hold.js").write_text(SCRIPT.replace("%ACTION%", repr(action)), encoding="utf-8")
    venue.ssh("put", str(stage), "/tmp/.holdstage")
    venue.ssh(
        "run",
        f"cp /tmp/.holdstage/zz_hold.js {venue.BACKOFFICE}/ && rm -rf /tmp/.holdstage && "
        f"chown {venue.USER} {venue.BACKOFFICE}/zz_hold.js && "
        f"(cd {venue.BACKOFFICE} && sudo -u {venue.USER} node zz_hold.js); "
        f"rc=$?; rm -f {venue.BACKOFFICE}/zz_hold.js; exit $rc",
    )


if __name__ == "__main__":
    main()
