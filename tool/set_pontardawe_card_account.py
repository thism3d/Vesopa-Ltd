"""Save Pontardawe RFC's live Paymentsense Connect account as its card settings.

    python tool/set_pontardawe_card_account.py --check   # check the account only
    python tool/set_pontardawe_card_account.py           # check, then save

The owner asked for this on 2026-10-13. Reads LiveLink (the Connect host) and
LiveKey from PontardaweRFC/.env.dojolive (gitignored) and hands them to the
back office on the box over SSH stdin. The box checks them exactly as Back
office > Card payments does (GET /pac/terminals, src/dojo_settings.js
verifyConnect), seals the key with the server's own EXPRESS_SECRET_KEY and
saves it for office info@vesopa.com with platform 'connect'; every till then
picks it up (dojo_office_sync.dart). Neither value is printed or logged.
"""
import json
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
const { verifyConnect, cleanConnectUrl } = require('./src/dojo_settings');
const { seal } = require('./src/express_kiosk');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  const { url, key, office, save } = JSON.parse(raw);
  const baseUrl = cleanConnectUrl(url);
  if (!baseUrl) { console.log('the LiveLink is not a connect.paymentsense.cloud address'); process.exit(1); }
  if (process.env.CARD_DEBUG) {
    for (const hdr of [{}, { 'Installer-Id': 'SL942X04' }]) {
      const r = await fetch(baseUrl + '/pac/terminals', { headers: { Authorization: 'Basic ' + Buffer.from('epos:' + key).toString('base64'),
        Accept: 'application/connect.v2+json', 'Software-House-Id': 'SL942X04', ...hdr } });
      console.log('debug', JSON.stringify(hdr), r.status, (await r.text()).slice(0, 300));
    }
  }
  const check = await verifyConnect({ key, baseUrl });
  console.log('check:', check.message);
  for (const t of check.terminals || []) console.log('  card machine', t.tid || t.id, t.status);
  if (!check.ok || !save) process.exit(check.ok ? 0 : 1);
  const sealed = seal(key);
  if (!sealed) { console.log('EXPRESS_SECRET_KEY is not set: cannot store a card key'); process.exit(1); }
  const db = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const list = check.terminals || [];
  const only = list.length === 1 ? (list[0].tid || list[0].id) : null;
  await db.execute(
    `INSERT INTO epos_dojo_settings (office, api_key_enc, key_hint, environment, terminal_id, result_seconds, updated_by, platform, base_url)
     VALUES (?, ?, ?, 'live', ?, 10, 'owner-setup', 'connect', ?)
     ON DUPLICATE KEY UPDATE api_key_enc = VALUES(api_key_enc), key_hint = VALUES(key_hint), environment = 'live',
       terminal_id = COALESCE(VALUES(terminal_id), terminal_id), platform = 'connect', base_url = VALUES(base_url),
       updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP`,
    [office, sealed, key.slice(-4), only, baseUrl]);
  await db.end();
  console.log('saved: Paymentsense Connect, live' + (only ? ', card machine ' + only : ''));
});
"""


def main():
    vals = {}
    for line in (ROOT / "PontardaweRFC" / ".env.dojolive").read_text(encoding="utf-8").splitlines():
        k, _, v = line.strip().partition("=")
        vals[k.strip()] = v.strip().strip("'\"")
    payload = json.dumps({"url": vals.get("LiveLink", ""), "key": vals.get("LiveKey", ""),
                          "office": OFFICE, "save": "--check" not in sys.argv})
    client = app.vesopa_ssh.connect()
    try:
        name = f".card-setup-{os.getpid()}.js"
        sftp = client.open_sftp()
        with sftp.file(f"{app.BACKOFFICE}/{name}", "w") as f:
            f.write(NODE)
        sftp.close()
        cmd = f"cd {app.BACKOFFICE} && {app.NODE} node ./{name}; s=$?; rm -f ./{name}; exit $s"
        stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
        stdin.write(payload)
        stdin.channel.shutdown_write()
        print(stdout.read().decode("utf-8", "replace").strip())
        err = stderr.read().decode("utf-8", "replace").strip()
        if err:
            print("!", err[-600:])
    finally:
        client.close()


if __name__ == "__main__":
    main()
