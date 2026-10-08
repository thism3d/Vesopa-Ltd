"""Give one address full Vesopa administration, from the owner's PC.

    python tool/grant_staff_admin.py support@vesopa.com "Vesopa Support"

Run from the repository root on the machine that deploys (it uses the same SSH
settings as MetricMembership/server/scripts/deploy.py). On the Cloud box it:

  1. creates the Vesopa Auth account with scripts/create-person.js, address
     verified on the owner's word and NO password (it signs in with an emailed
     code). An account that already exists is left as it is;
  2. sets users.is_staff = 1, which opens auth.vesopa.com/admin to it;
  3. makes it an Owner of every app on admin.vesopa.com (adm_admins, role
     'owner', apps '*'), the same row the Admins page writes;
  4. makes it a full Admin of vesopaepos.com/admin (admin_table, status
     'Admin', enabled 'Y'). That panel has no password form, only Connect with
     Vesopa, which links the row by this verified email on first sign-in. The
     row's password column is a hash of random bytes nobody knows.

Idempotent. Sends no email and sets no password. Added 2026-10-08 when the
owner asked for support@vesopa.com with full administration and no password.
"""

import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "MetricMembership", "server", "scripts"))
from deploy import connect, vesopa_ssh  # noqa: E402

W = "/home/vesopasoftware/web"
AUTH = f"{W}/auth.vesopa.com/private/nodeapp"
ADMIN = f"{W}/admin.vesopa.com/private/nodeapp"
WEB = f"{W}/vesopaepos.com/private/nodeapp"
USER = "vesopasoftware"

STAFF = r"""
const db = require('../src/db');
(async () => {
  const r = await db.execute(
    "UPDATE users u JOIN user_identities i ON i.user_id = u.id " +
    "SET u.is_staff = 1 WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL",
    [process.argv[2]]);
  if (!r.affectedRows) {
    const ok = await db.one(
      "SELECT u.is_staff FROM users u JOIN user_identities i ON i.user_id = u.id " +
      "WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL", [process.argv[2]]);
    if (!ok) { console.error('  no Auth account for that address'); process.exit(1); }
  }
  console.log('  auth.vesopa.com administration: on');
  await db.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
"""

OWNER = r"""
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true, quiet: true });
const db = require('../src/db');
(async () => {
  await db.run(
    "INSERT INTO adm_admins (email, name, role, apps, status, added_by) VALUES (?, ?, 'owner', '*', 'active', 'owner (script)') " +
    "ON DUPLICATE KEY UPDATE role = 'owner', apps = '*', status = 'active'",
    [process.argv[2], process.argv[3] || null]);
  console.log('  admin.vesopa.com: Owner of every app');
  await db.pool.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
"""

EPOS_ADMIN = r"""
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
(async () => {
  const email = process.argv[2];
  const name = process.argv[3] || email;
  const [rows] = await pool.query('SELECT id FROM admin_table WHERE LOWER(email) = ? LIMIT 1', [email]);
  if (rows[0]) {
    await pool.query("UPDATE admin_table SET status = 'Admin', enabled = 'Y' WHERE id = ?", [rows[0].id]);
  } else {
    const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      "INSERT INTO admin_table (fullname, username, email, status, password, enabled) VALUES (?, ?, ?, 'Admin', ?, 'Y')",
      [name, email, email, unusable]);
  }
  console.log('  vesopaepos.com/admin: full Admin');
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
"""


def run(client, cmd):
    if vesopa_ssh.run(client, cmd) != 0:
        raise SystemExit("failed on the box")


def node_snippet(client, sftp, app, code, args):
    path = f"{app}/scripts/.grant-{secrets.token_hex(6)}.js"
    run(client, f"test -d {app}/scripts || install -d -o {USER} -g {USER} {app}/scripts")
    with sftp.open(path, "w") as f:
        f.write(code)
    try:
        run(client, f"chown {USER}:{USER} {path} && su - {USER} -c \"cd {app} && node {path} {args}\"")
    finally:
        vesopa_ssh.run(client, f"rm -f {path}")


def main():
    if len(sys.argv) < 2 or "@" not in sys.argv[1]:
        raise SystemExit(__doc__)
    email = sys.argv[1].strip().lower()
    name = (sys.argv[2] if len(sys.argv) > 2 else "").strip()
    for s in (email, name):
        if any(c in s for c in "'\"`$\\;&|<>"):
            raise SystemExit("no quotes or shell characters in the address or name, please")

    client = connect()
    sftp = client.open_sftp()
    try:
        print(f"Vesopa Auth: account for {email}")
        sftp.put(os.path.join(REPO, "vesopa_auth", "scripts", "create-person.js"), f"{AUTH}/scripts/create-person.js")
        run(client, f"chown {USER}:{USER} {AUTH}/scripts/create-person.js && "
                    f"su - {USER} -c \"cd {AUTH} && node scripts/create-person.js '{email}' '{name}'\"")
        node_snippet(client, sftp, AUTH, STAFF, f"'{email}'")
        node_snippet(client, sftp, ADMIN, OWNER, f"'{email}' '{name}'")
        node_snippet(client, sftp, WEB, EPOS_ADMIN, f"'{email}' '{name}'")
        print(f"\ndone. {email} signs in with an emailed code (no password) at "
              "https://auth.vesopa.com/admin, https://admin.vesopa.com and https://vesopaepos.com/admin")
    finally:
        sftp.close()
        client.close()


if __name__ == "__main__":
    main()
