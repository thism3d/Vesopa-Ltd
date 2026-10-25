"""Make Pontardawe RFC members on the club's Vice President scheme (2026-10-25).

    python tool/pontardawe_vp_members.py            # look only
    python tool/pontardawe_vp_members.py --apply    # make or upgrade them

The owner asked on 2026-10-25 for muzahid221@gmail.com, muzahidulislam@icloud.com
and +8801336189116 (name "Muzahid") to be Vice President members. Each is
found by its email or phone at the venue; one not there yet is made like the
club's other app members (a copy of an existing Vice President member's
way the app makes one, with the venue's next card and member number). Then each is put
on the Vice President scheme with the scheme's current expiry, exactly as
tool/pontardawe_test_membership.py does. All show in Back office > Loyalty and
can be changed or taken off there.
"""
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_pontardawe_app as app  # noqa: E402  (loads .env.claude too)

OFFICE = "info@vesopa.com"
PEOPLE = [
    {"email": "muzahid221@gmail.com", "name": "Muzahid Islam"},
    {"email": "muzahidulislam@icloud.com", "name": "Muzahid Islam"},
    {"phone": "+8801336189116", "name": "Muzahid"},
]

NODE = r"""
require('dotenv').config();
const mysql = require('mysql2/promise');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  const { office, people, apply } = JSON.parse(raw);
  const db = mysql.createPool({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectionLimit: 2, dateStrings: true });
  const q = async (sql, args) => (await db.query(sql, args))[0];
  const digits = (s) => String(s || '').replace(/\D/g, '');
  try {
    const schemes = await q('SELECT id, name FROM epos_loyalty_schemes WHERE office = ?', [office]);
    const vp = schemes.find((s) => /vice\s*president/i.test(s.name));
    if (!vp) { console.log('no Vice President scheme; schemes:', schemes.map((s) => s.name).join(', ')); process.exitCode = 1; return; }
    const [until] = await q('SELECT MAX(membership_expiry) AS d, COUNT(*) AS n FROM epos_customers WHERE email_key = ? AND scheme_id = ? AND membership_expiry >= CURDATE()', [office, vp.id]);
    console.log(`scheme: ${vp.name} (#${vp.id}), ${until.n} members, until ${until.d}`);
    const cols = (await q('SHOW COLUMNS FROM epos_customers')).map((c) => c.Field);
    const [model] = await q('SELECT * FROM epos_customers WHERE email_key = ? AND scheme_id = ? AND membership_expiry >= CURDATE() ORDER BY id LIMIT 1', [office, vp.id]);
    for (const p of people) {
      const found = p.email
        ? await q('SELECT id, name, email, phone, scheme_id, membership_expiry, membership_status, card_number, member_no FROM epos_customers WHERE email_key = ? AND LOWER(TRIM(email)) = ?', [office, p.email.toLowerCase()])
        : (await q('SELECT id, name, email, phone, scheme_id, membership_expiry, membership_status, card_number, member_no FROM epos_customers WHERE email_key = ? AND phone IS NOT NULL AND phone <> ""', [office]))
            .filter((r) => digits(r.phone).endsWith(digits(p.phone).slice(-10)));
      const who = p.email || p.phone;
      if (found.length) {
        const c = found[0];
        console.log(`${who}: found #${c.id} ${c.name}, scheme ${c.scheme_id || 'none'}, until ${c.membership_expiry || 'none'}, card ${c.card_number || '-'}`);
        if (apply) {
          await db.execute(`UPDATE epos_customers SET scheme_id = ?, membership_expiry = ?,
              membership_status = IF(membership_status IN ('cancelled', 'pending'), '', membership_status)
            WHERE id = ? AND email_key = ?`, [vp.id, until.d, c.id, office]);
          console.log(`  -> on ${vp.name} until ${until.d}`);
        }
        continue;
      }
      console.log(`${who}: not at the venue yet`);
      if (!apply) continue;
      // As the app makes a member (src/loyalty_app.js joinVenue): its own id,
      // then the venue's next card and member number.
      const id = require('crypto').randomUUID();
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        await conn.execute(
          `INSERT INTO epos_customers (id, email_key, name, email, phone, notes, scheme_id, membership_expiry)
           VALUES (?, ?, ?, ?, ?, 'Vice President, added for the owner', ?, ?)`,
          [id, office, p.name, p.email || null, p.phone || null, vp.id, until.d]);
        await require('./src/loyalty_app').issueLoyaltyNumber(conn, office, id);
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
      const [made] = await q('SELECT name, phone, card_number, member_no, membership_expiry FROM epos_customers WHERE id = ?', [id]);
      console.log(`  -> made ${made.name} ${made.phone}, card ${made.card_number}, member ${made.member_no}, Vice President until ${made.membership_expiry}`);
    }
  } catch (e) {
    console.log('failed: ' + (e.message || e)); process.exitCode = 1;
  } finally {
    await db.end();
  }
});
"""


def main():
    payload = json.dumps({"office": OFFICE, "people": PEOPLE, "apply": "--apply" in sys.argv})
    client = app.vesopa_ssh.connect()
    try:
        name = f".vp-members-{os.getpid()}.js"
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
