"""Save the Barclaycard Smartpay Fuse SANDBOX keys from .env.barclaycard for
The Vesopa Kitchen (manager@vesopa.co.uk), the test venue, and turn its
online menu onto Barclaycard sandbox (2026-10-20).

    python tool/install_barclaycard_venue.py

Run after `tool/deploy_memberships.py --backoffice` (which creates the
tables). Never prints a value. The shared secret is sealed on the server with
EXPRESS_SECRET_KEY, exactly as saving the keys in the back office does.
Sandbox orders are test orders: they never reach a till, kitchen or takings.
"""
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_pontardawe_app as app  # noqa: E402  (loads .env.claude)

OFFICE = "manager@vesopa.co.uk"

SAVE = r"""
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env'), quiet: true });
const fs = require('fs');
const { seal } = require('./src/express_kiosk');
const mysql = require('mysql2/promise');
const pool = mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, charset: 'utf8mb4' });
(async () => {
  const v = {};
  for (const l of fs.readFileSync(process.argv[2], 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0) v[l.slice(0, i)] = l.slice(i + 1); }
  const sealed = seal(v.SECRET);
  if (!sealed) throw new Error('EXPRESS_SECRET_KEY is not set');
  await pool.execute(
    `INSERT INTO epos_barclaycard_keys (office, environment, merchant_id, key_id, secret_enc, updated_by) VALUES (?, 'sandbox', ?, ?, ?, 'install_barclaycard_venue')
     ON DUPLICATE KEY UPDATE merchant_id = VALUES(merchant_id), key_id = VALUES(key_id), secret_enc = VALUES(secret_enc), updated_by = VALUES(updated_by)`,
    [process.argv[3], v.MERCHANT, v.KEY, sealed]);
  await pool.execute(
    `INSERT INTO epos_barclaycard_settings (office, enabled, environment, updated_by) VALUES (?, 1, 'sandbox', 'install_barclaycard_venue')
     ON DUPLICATE KEY UPDATE enabled = 1, environment = 'sandbox', updated_by = VALUES(updated_by)`,
    [process.argv[3]]);
  console.log('saved sandbox keys and turned the menu onto Barclaycard sandbox for', process.argv[3]);
  await pool.end();
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
"""


def main():
    vals = {}
    for line in (ROOT / ".env.barclaycard").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    need = {"MERCHANT": "BARCLAYCARD_SANDBOX_MERCHANT_ID", "KEY": "BARCLAYCARD_SANDBOX_KEY_ID", "SECRET": "BARCLAYCARD_SANDBOX_SHARED_SECRET"}
    lines = {}
    for short, name in need.items():
        if not vals.get(name):
            raise SystemExit(f"{name} is missing from .env.barclaycard")
        lines[short] = vals[name]
    c = app.vesopa_ssh.connect()
    try:
        tmp = f"/tmp/.bc-{os.getpid()}"
        script = f"{app.BACKOFFICE}/.bc-save-{os.getpid()}.js"
        s = c.open_sftp()
        with s.file(tmp, "w") as f:
            f.write("\n".join(f"{k}={v}" for k, v in lines.items()) + "\n")
        s.chmod(tmp, 0o644)
        with s.file(script, "w") as f:
            f.write(SAVE)
        s.close()
        cmd = (f"cd {app.BACKOFFICE} && chown vesopasoftware {tmp} {script} && "
               f"sudo -u vesopasoftware node {script} {tmp} {OFFICE}; rc=$?; rm -f {tmp} {script}; exit $rc")
        _, o, e = c.exec_command(cmd, timeout=120)
        print(o.read().decode().strip())
        err = e.read().decode().strip()
        if err:
            print(err)
    finally:
        c.close()


if __name__ == "__main__":
    main()
