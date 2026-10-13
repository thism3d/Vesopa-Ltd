"""Turn on the till's Cashback key for Pontardawe RFC.

    python tool/enable_pontardawe_cashback.py          # turn it on, then read it back
    python tool/enable_pontardawe_cashback.py --off    # turn it off again

The owner asked for this on 2026-10-13: the same as ticking Back office >
Tender settings > "Show a Cashback key on the till" for office
info@vesopa.com. Card on its own still goes straight to the card machine.
"""
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_pontardawe_app as app  # noqa: E402  (loads .env.claude too)

OFFICE = "info@vesopa.com"

NODE = r"""
require('dotenv').config();
const mysql = require('mysql2/promise');
(async () => {
  const [office, on] = process.argv.slice(2);
  const db = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await db.execute(
    'INSERT INTO epos_tender_settings (office, allow_cashback) VALUES (?, ?) ON DUPLICATE KEY UPDATE allow_cashback = VALUES(allow_cashback)',
    [office, Number(on)]);
  const [rows] = await db.execute('SELECT allow_cashback FROM epos_tender_settings WHERE office = ?', [office]);
  console.log('allow_cashback for ' + office + ' is now ' + (rows[0] ? rows[0].allow_cashback : '?'));
  await db.end();
})().catch((e) => { console.log('failed: ' + e.message); process.exit(1); });
"""


def main():
    on = "0" if "--off" in sys.argv else "1"
    client = app.vesopa_ssh.connect()
    try:
        name = f".cashback-{os.getpid()}.js"
        sftp = client.open_sftp()
        with sftp.file(f"{app.BACKOFFICE}/{name}", "w") as f:
            f.write(NODE)
        sftp.close()
        cmd = f"cd {app.BACKOFFICE} && {app.NODE} node ./{name} '{OFFICE}' {on}; s=$?; rm -f ./{name}; exit $s"
        _stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
        print(stdout.read().decode("utf-8", "replace").strip())
        err = stderr.read().decode("utf-8", "replace").strip()
        if err:
            print("!", err[-600:])
    finally:
        client.close()


if __name__ == "__main__":
    main()
