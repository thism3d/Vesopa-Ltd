"""A sign-in for the app stores' reviewers: one member of a venue with a password (2026-10-12).

    $env:REVIEW_PASSWORD = '...'; python tool/make_review_member.py test@test.com
    python tool/make_review_member.py test@test.com --slug pontardawe-rfc --name "App Review"

Apple and Google sign in to a members-only app with an email and password they
are given in the review notes. This makes that member at the venue whose
Loyalty App slug is --slug (default pontardawe-rfc), or gives an existing one
the password, so the app's "Use a password" works for them at once. The card
number comes on first sign-in, as for any member (loyalty_account.js ensureCard).

The password comes from REVIEW_PASSWORD and is hashed on the server with the
back office's own bcryptjs; it is never printed. The app's 8-character minimum
is for members choosing their own (loyalty_auth.js passwordProblem): sign-in
only checks the hash, so a shorter one the reviewers were given still works.

Run from the repository root on the owner's PC, like the other deploy tools.
"""
import json
import os
import pathlib
import re
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

import deploy_client_area_vesopa_connect as base  # noqa: E402
import deploy_memberships  # noqa: E402,F401  (loads .env.claude too)

USER = "vesopasoftware"
BACKOFFICE = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"
NODE = "PATH=/opt/nodejs/24/bin:$PATH"


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    emails = [a for a in sys.argv[1:] if "@" in a]
    if len(emails) != 1:
        raise SystemExit(__doc__)
    email = emails[0].strip().lower()
    slug = arg("--slug", "pontardawe-rfc")
    name = arg("--name", "App Review")
    password = os.environ.get("REVIEW_PASSWORD", "")
    if not password:
        raise SystemExit("! set REVIEW_PASSWORD first (it is never printed)")
    if not re.fullmatch(r"[a-z0-9-]+", slug) or not re.fullmatch(r"[^@\s'\"]+@[^@\s'\"]+\.[^@\s'\"]+", email):
        raise SystemExit("! that slug or email does not look right")

    # Everything the server needs, as JSON on stdin: nothing on a command line.
    job = json.dumps({"slug": slug, "email": email, "name": name, "password": password})
    script = r"""
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config();
(async () => {
  const job = JSON.parse(fs.readFileSync(0, 'utf8'));
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306, charset: 'utf8mb4',
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'vesopa_eposdb',
  });
  const [apps] = await db.query('SELECT office FROM epos_loyalty_app WHERE slug = ?', [job.slug]);
  if (apps.length !== 1) throw new Error(`no single venue with slug ${job.slug} (${apps.length})`);
  const office = apps[0].office;
  const hash = await bcrypt.hash(job.password, 10);
  const [rows] = await db.query(
    'SELECT id FROM epos_customers WHERE email_key = ? AND LOWER(email) = ? ORDER BY created_at LIMIT 1',
    [office, job.email]);
  if (rows.length) {
    await db.execute('UPDATE epos_customers SET password_hash = ?, password_set_at = NOW() WHERE id = ?', [hash, rows[0].id]);
    console.log(`   existing member at office ${office}: password set`);
  } else {
    await db.execute(
      `INSERT INTO epos_customers (id, email_key, name, email, notes, password_hash, password_set_at)
       VALUES (?, ?, ?, ?, 'App store review account', ?, NOW())`,
      [crypto.randomUUID(), office, job.name, job.email, hash]);
    console.log(`   new member "${job.name}" at office ${office}, password set`);
  }
  const [m] = await db.query(
    "SELECT method, enabled FROM epos_loyalty_app_methods WHERE office = ? AND method = 'password'", [office]);
  console.log(`   password sign-in for the venue: ${m.length && m[0].enabled ? 'on' : 'OFF'}`);
  await db.end();
})().catch((e) => { console.error('! ' + e.message); process.exit(1); });
"""
    client = base.vesopa_ssh.connect()
    try:
        sftp = client.open_sftp()
        remote = f"{BACKOFFICE}/.review_member.js"
        try:
            with sftp.open(remote, "w") as f:
                f.write(script)
        finally:
            sftp.close()
        stdin, stdout, stderr = client.exec_command(
            f"chown {USER}:{USER} {remote} && su - {USER} -c 'cd {BACKOFFICE} && {NODE} node .review_member.js'; "
            f"rc=$?; rm -f {remote}; exit $rc")
        stdin.write(job)
        stdin.channel.shutdown_write()
        out, err = stdout.read().decode(), stderr.read().decode()
        rc = stdout.channel.recv_exit_status()
        print(out.rstrip())
        if rc != 0:
            raise SystemExit(err.strip() or f"! failed ({rc})")
    finally:
        client.close()

    # The app's own request, as a reviewer's phone sends it.
    time.sleep(1)
    req = urllib.request.Request(
        f"https://loyalty.vesopa.com/loyalty/v1/app/{slug}/password",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ok = r.status == 200 and "token" in json.loads(r.read())
    except urllib.error.HTTPError as e:
        ok = False
        print(f"   sign-in answered {e.code}")
    print(f"   {'ok ' if ok else 'BAD'} {email} signs in to the {slug} app with that password")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
