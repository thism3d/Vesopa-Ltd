"""Give the Pontardawe RFC app's test account a paid membership.

    python tool/pontardawe_test_membership.py            # look only
    python tool/pontardawe_test_membership.py --apply    # make it a paid member

The owner asked for this on 2026-10-15 for test@test.com, so the app's
paid-member side can be tried. Pontardawe's app is members-only
(epos_loyalty_app.members_only) and its paid members are the club's
Vice President scheme: on the scheme, with a membership expiry and no plan
status (src/loyalty_members_only.js, paidUpRow). The test account is made
exactly like them: the same scheme and the same expiry as the members
already on it. It shows in Back office > Loyalty like any other member, and
can be taken off there.
"""
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_pontardawe_app as app  # noqa: E402  (loads .env.claude too)

OFFICE = "info@vesopa.com"
EMAIL = "test@test.com"

NODE = r"""
require('dotenv').config();
const mysql = require('mysql2/promise');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  const { office, email, apply } = JSON.parse(raw);
  const db = mysql.createPool({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectionLimit: 2, dateStrings: true });
  const q = async (sql, args) => (await db.query(sql, args))[0];
  try {
    const rows = await q('SELECT id, name, scheme_id, membership_status, membership_expiry FROM epos_customers WHERE email_key = ? AND LOWER(TRIM(email)) = ? ORDER BY created_at', [office, email]);
    if (!rows.length) { console.log('no app account with that email at this venue'); process.exitCode = 1; return; }
    const c = rows[0];
    // The paid members: the scheme most customers are on, and their expiry.
    const [top] = await q(`SELECT scheme_id, MAX(membership_expiry) AS until, COUNT(*) AS n FROM epos_customers
       WHERE email_key = ? AND scheme_id IS NOT NULL AND membership_expiry >= CURDATE()
       GROUP BY scheme_id ORDER BY n DESC LIMIT 1`, [office]);
    const [scheme] = top ? await q('SELECT id, name FROM epos_loyalty_schemes WHERE id = ? AND email_key = ?', [top.scheme_id, office]).catch(() => [{ id: top.scheme_id, name: `scheme ${top.scheme_id}` }]) : [];
    console.log(`${c.name}: scheme ${c.scheme_id || 'none'}, status "${c.membership_status || ''}", expiry ${c.membership_expiry || 'none'}`);
    if (!top) { console.log('no paid members to copy at this venue'); process.exitCode = 1; return; }
    console.log(`paid members: ${top.n} on ${scheme ? scheme.name : top.scheme_id}, until ${top.until}`);
    if (!apply) return;
    await db.execute(
      `UPDATE epos_customers SET scheme_id = ?, membership_expiry = ?,
              membership_status = IF(membership_status IN ('cancelled', 'pending'), '', membership_status)
        WHERE id = ? AND email_key = ?`, [top.scheme_id, top.until, c.id, office]);
    const [after] = await q('SELECT name, scheme_id, membership_status, membership_expiry FROM epos_customers WHERE id = ?', [c.id]);
    console.log(`now: ${after.name}: scheme ${after.scheme_id}, expiry ${after.membership_expiry}: a paid member`);
  } catch (e) {
    console.log('failed: ' + (e.message || e)); process.exitCode = 1;
  } finally {
    await db.end();
  }
});
"""


def main():
    payload = json.dumps({"office": OFFICE, "email": EMAIL, "apply": "--apply" in sys.argv})
    client = app.vesopa_ssh.connect()
    try:
        name = f".test-member-{os.getpid()}.js"
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
        if err and "injected env" not in err:
            print("!", err[-600:])
    finally:
        client.close()


if __name__ == "__main__":
    main()
