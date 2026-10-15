"""Put Pontardawe RFC's live Dojo online-payments key on the back office.

    python tool/install_pontardawe_dojo_key.py

The owner, 2026-10-15: pay at the table on menu.pontardawerfc.com with the
club's live Dojo key (developer.dojo.tech, "API keys are enabled for in-person
and remote payment requests"). Read from .env.pontardawe-dojo (gitignored),
never printed. It is sealed with EXPRESS_SECRET_KEY into
epos_express_settings.dojo_key_enc for office info@vesopa.com -- the venue key
the online menu, tickets and memberships use (memberships.js paymentKeyFor),
NOT the server's .env, which would make it every venue's key. The tills keep
their Paymentsense Connect key in epos_dojo_settings, untouched.

Then asks Dojo about a payment intent that cannot exist: 404 means the key is
accepted, 401 means it is not. Nothing is created or charged.
"""
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_pontardawe_app as app  # noqa: E402

OFFICE = "info@vesopa.com"

NODE = r"""
require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');
const { seal } = require('./src/express_kiosk');
(async () => {
  const file = process.argv[2];
  const key = fs.readFileSync(file, 'utf8').trim();
  fs.unlinkSync(file);
  if (!/^sk_prod_[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error('that is not a live Dojo secret key');
  const sealed = seal(key);
  if (!sealed) throw new Error('EXPRESS_SECRET_KEY is not set, so the key cannot be sealed');
  const db = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await db.query(
    'INSERT INTO epos_express_settings (office, dojo_key_enc, dojo_key_hint) VALUES (?, ?, ?)' +
    ' ON DUPLICATE KEY UPDATE dojo_key_enc = VALUES(dojo_key_enc), dojo_key_hint = VALUES(dojo_key_hint)',
    [process.argv[3], sealed, key.slice(-4)]);
  const { paymentKeyFor } = require('./src/memberships');
  const back = await paymentKeyFor(db, process.argv[3]);
  await db.end();
  console.log('stored, ending ' + key.slice(-4) + '; the menu reads it back:', back === key ? 'yes' : 'NO');
  const r = await fetch('https://api.dojo.tech/payment-intents/pi_vesopa_key_check', {
    headers: { Authorization: 'Basic ' + key, version: '2024-02-05', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  console.log('Dojo says', r.status, r.status === 404 ? '(key accepted)' : r.status === 401 || r.status === 403 ? '(key REFUSED)' : '');
})().catch((e) => { console.log('failed: ' + e.message); process.exit(1); });
"""


def main():
    env = {}
    for line in (ROOT / ".env.pontardawe-dojo").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    key = env.get("PONTARDAWE_DOJO_KEY", "")
    if not key.startswith("sk_prod_"):
        raise SystemExit("no live key in .env.pontardawe-dojo")
    c = app.vesopa_ssh.connect()
    try:
        pid = os.getpid()
        tmp = f"/tmp/.pk-{pid}"
        script = f"{app.BACKOFFICE}/.pk-{pid}.js"
        s = c.open_sftp()
        with s.file(tmp, "w") as f:
            f.write(key)
        s.chmod(tmp, 0o600)
        with s.file(script, "w") as f:
            f.write(NODE)
        s.close()
        _, o, e = c.exec_command(
            f"chown {app.USER} {tmp}; cd {app.BACKOFFICE} && {app.NODE} node ./.pk-{pid}.js {tmp} {OFFICE} 2>&1 | grep -v 'injected env'; "
            f"rm -f ./.pk-{pid}.js {tmp}", timeout=90)
        print(o.read().decode().strip())
    finally:
        c.close()


if __name__ == "__main__":
    main()
