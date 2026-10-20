"""Update a venue to the newest till, kitchen and display, when the owner says so (2026-10-20).

    python tool/update_venue_versions.py --check     # show what it would set
    python tool/update_venue_versions.py             # set VENUES to the newest versions (devices ask on screen)
    python tool/update_venue_versions.py --now       # ... and install now with a 30s countdown, between sales
    python tool/update_venue_versions.py --force     # ... install now even with a bill open (the bill is kept)

The owner: "No automatic update overnight. If I say update then it'll
update. Like Nicky always does." Run only when asked. It sets each venue
below to the newest installer of each app on admin.vesopa.com (Versions) and
leaves update prompts on; each app then downloads it, checks its SHA-256 and
asks on screen: Update now, or On next start. Nothing installs by itself.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_memberships  # noqa: E402,F401  (loads the server login)

# The venues to update when this is run. 35 = Pontardawe RFC.
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
  const when = %WHEN%;
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
    console.log(`  pin ${app} ${p.version}: ` + await call('PUT', `/app-versions/${app}`, { offices: venues, version: p.version, url: p.url, sha256: p.sha256, size: p.size, store: true, ...when }));
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
    (stage / "zz_pin.js").write_text(PIN.replace("%CHECK%", "true" if check else "false").replace("%VENUES%", str(AUTO_VENUES)).replace("%WHEN%", '{"mode":"now","force":true}' if "--force" in sys.argv else ('{"mode":"now"}' if "--now" in sys.argv else '{}')), encoding="utf-8")
    print(f"▶ updating venues {AUTO_VENUES} to the newest versions")
    ssh("put", str(stage), "/tmp/.pinstage")
    ssh("run", f"cp /tmp/.pinstage/zz_rel.js {ADMIN}/ && cp /tmp/.pinstage/zz_pin.js {BACKOFFICE}/ && rm -rf /tmp/.pinstage && "
               f"chown {USER} {ADMIN}/zz_rel.js {BACKOFFICE}/zz_pin.js && "
               f"(cd {ADMIN} && sudo -u {USER} node zz_rel.js) && (cd {BACKOFFICE} && sudo -u {USER} node zz_pin.js); "
               f"rc=$?; rm -f {ADMIN}/zz_rel.js {BACKOFFICE}/zz_pin.js /tmp/.vesopa_pins.json; exit $rc")


if __name__ == "__main__":
    main()
