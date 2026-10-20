"""Move the venues on automatic updates to the newest release of each app (2026-10-20).

    python tool/pin_auto_update_venues.py              # pin AUTO_VENUES to the newest till, kitchen and display
    python tool/pin_auto_update_venues.py --check      # only show what it would pin

The owner, 2026-10-20: "Every night Nicky updates the software of Pontardawe
RFC, like that do the updates automatically." A release script calls this
once its installers are on admin.vesopa.com: each venue below is pinned
(admin.vesopa.com Versions) to the newest installer of each app, with update
prompts on. The apps then fetch it, check its SHA-256, and install it
overnight by themselves (lib/data/app_update.dart, quiet hours 02:00-06:00),
or when somebody presses Update now. Venues not listed are never touched.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_memberships  # noqa: E402,F401  (loads the server login)

# Office ids on automatic updates. 35 = Pontardawe RFC (Meirion: "go for it").
AUTO_VENUES = [35]
APPS = ["till", "kitchen", "display"]
USER = "vesopasoftware"
ADMIN = f"/home/{USER}/web/admin.vesopa.com/private/nodeapp"
BACKOFFICE = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"

READ = r"""
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true, quiet: true });
const releases = require('./src/releases');
const { pool } = require('./src/db');
(async () => {
  const out = {};
  for (const app of %APPS%) {
    const r = (await releases.list({ app })).filter((x) => x.file && x.sha256)[0];
    if (r) out[app] = { version: r.version, url: releases.deviceUrl(r), sha256: r.sha256, size: r.size };
  }
  require('fs').writeFileSync('/tmp/.vesopa_pins.json', JSON.stringify(out), { mode: 0o600 });
  for (const [a, r] of Object.entries(out)) console.log(`  newest ${a}: ${r.version}`);
})().catch((e) => { console.error('ERR', e.message); process.exitCode = 1; }).finally(() => pool.end());
"""

PIN = r"""
require('dotenv').config({ quiet: true });
const fs = require('fs');
const mysql = require('mysql2/promise');
const { issueToken } = require('./src/auth');
(async () => {
  const pins = JSON.parse(fs.readFileSync('/tmp/.vesopa_pins.json', 'utf8'));
  fs.rmSync('/tmp/.vesopa_pins.json', { force: true });
  const check = %CHECK%;
  const venues = %VENUES%;
  const db = mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const [[a]] = await db.query("SELECT id, email, name, role, office_id FROM backoffice_users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const t = issueToken({ id: a.id, email: a.email, name: a.name, role: a.role, officeId: a.office_id }, process.env.JWT_SECRET, '5m');
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/admin${p}`, { method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return `${r.status} ${JSON.stringify(await r.json())}`;
  };
  for (const [app, p] of Object.entries(pins)) {
    if (check) { console.log(`  would pin venues ${venues} ${app} to ${p.version}`); continue; }
    console.log(`  pin ${app} ${p.version}: ` + await call('PUT', `/app-versions/${app}`, { offices: venues, version: p.version, url: p.url, sha256: p.sha256, size: p.size, store: true }));
  }
  if (!check) console.log('  update prompts: ' + await call('PUT', '/app-versions-settings', { enabled: true }));
  await db.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
"""


def ssh(*args):
    r = subprocess.run([sys.executable, str(ROOT / "tool" / "cloud_ssh.py"), *args], cwd=str(ROOT), env={**os.environ, "MSYS_NO_PATHCONV": "1"},
                       text=True, encoding="utf-8", errors="replace", capture_output=True)
    if r.stdout.strip():
        print(r.stdout.rstrip())
    if r.returncode != 0:
        print(r.stderr.rstrip(), file=sys.stderr)
        raise SystemExit("failed")


def main():
    check = "--check" in sys.argv
    stage = pathlib.Path(tempfile.mkdtemp(prefix="pins-"))
    (stage / "zz_rel.js").write_text(READ.replace("%APPS%", repr(APPS).replace("'", '"')), encoding="utf-8")
    (stage / "zz_pin.js").write_text(PIN.replace("%CHECK%", "true" if check else "false").replace("%VENUES%", str(AUTO_VENUES)), encoding="utf-8")
    print(f"▶ automatic updates for venues {AUTO_VENUES}")
    ssh("put", str(stage), "/tmp/.pinstage")
    ssh("run", f"cp /tmp/.pinstage/zz_rel.js {ADMIN}/ && cp /tmp/.pinstage/zz_pin.js {BACKOFFICE}/ && rm -rf /tmp/.pinstage && "
               f"chown {USER} {ADMIN}/zz_rel.js {BACKOFFICE}/zz_pin.js && "
               f"(cd {ADMIN} && sudo -u {USER} node zz_rel.js) && (cd {BACKOFFICE} && sudo -u {USER} node zz_pin.js); "
               f"rc=$?; rm -f {ADMIN}/zz_rel.js {BACKOFFICE}/zz_pin.js /tmp/.vesopa_pins.json; exit $rc")


if __name__ == "__main__":
    main()
