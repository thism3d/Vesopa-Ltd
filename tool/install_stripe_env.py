"""Move the back office and The Vesopa Kitchen to the "Vesopa" Stripe sandbox (2026-11-06).

    python tool/install_stripe_env.py            # shows what is on the server
    python tool/install_stripe_env.py --apply    # backs up, sets, restarts

Sets STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET in the
back office .env from the STRIPE_TEST_VESOPA_* lines of .env.stripe (gitignored),
then points the Kitchen's epos_stripe_settings row at its account on that sandbox.
Test keys only: it refuses anything else. Never prints a value. The Kitchen is
the only venue it touches, and it stops if any other venue has a Stripe row.
Only the back office restarts.
"""
import os
import pathlib
import re
import shlex
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_pontardawe_app as app  # noqa: E402

KITCHEN = "manager@vesopa.co.uk"
ACCOUNT = "acct_1UYwyDQdgS0g39i0"
LOCATION = "tml_Guss6QLdF7KApq"
PM2 = "backoffice.vesopaepos.com"

STATE = r"""
require('dotenv').config({ path: '.env' });
const mysql = require('mysql2/promise');
(async () => {
  const pool = mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'vesopa_eposdb' });
  const [rows] = await pool.query('SELECT office, account_id, location_id, enabled, use_tap, card_payments, payouts, requirements_due FROM epos_stripe_settings');
  console.log(JSON.stringify(rows));
  const [kitchen, account, location] = process.argv.slice(2);
  if (kitchen) {
    if (rows.length !== 1 || rows[0].office !== kitchen) throw new Error('another venue has a Stripe row: nothing changed');
    const [r] = await pool.execute("UPDATE epos_stripe_settings SET account_id = ?, location_id = ?, card_payments = 'restricted', payouts = 'restricted', requirements_due = 12 WHERE office = ?", [account, location, kitchen]);
    console.log('kitchen rows updated', r.affectedRows);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
"""

MERGE = r"""
import re, sys
new = dict(l.rstrip("\n").split("=", 1) for l in open(sys.argv[1], encoding="utf-8") if "=" in l)
s = open(sys.argv[2], encoding="utf-8").read()
n = 0
for k, v in new.items():
    s, c = re.subn(r"(?m)^" + k + r"=.*$", lambda m: k + "=" + v, s)
    n += c
if n != 3:
    sys.exit("expected 3 STRIPE_ lines, found %d: nothing changed" % n)
open(sys.argv[2], "w", encoding="utf-8").write(s)
print("env lines set", n)
"""


def keys():
    env = {}
    # A worktree has no gitignored files: they stay in the main checkout.
    path = next(p / ".env.stripe" for p in (ROOT, *ROOT.parents) if (p / ".env.stripe").exists())
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Z_]+)=(.*)", line)
        if m:
            env[m[1]] = m[2].strip().strip("'\"")
    out = {
        "STRIPE_SECRET_KEY": env["STRIPE_TEST_VESOPA_SECRET_KEY"],
        "STRIPE_PUBLISHABLE_KEY": env["STRIPE_TEST_VESOPA_PUBLISHABLE_KEY"],
        "STRIPE_WEBHOOK_SECRET": env["STRIPE_TEST_VESOPA_WEBHOOK_SECRET"],
    }
    if not out["STRIPE_SECRET_KEY"].startswith("sk_test_") or not out["STRIPE_PUBLISHABLE_KEY"].startswith("pk_test_"):
        raise SystemExit("those are not test keys: stopping")
    return out


def run(c, cmd):
    _, out, err = c.exec_command(cmd)
    code = out.channel.recv_exit_status()
    print(out.read().decode("utf-8", "replace").strip())
    e = err.read().decode("utf-8", "replace").strip()
    if e:
        print(e)
    if code:
        raise SystemExit(f"stopped: exit {code}")


def main():
    apply = "--apply" in sys.argv
    new = keys()
    c = app.vesopa_ssh.connect()
    try:
        tag = os.getpid()
        tmp, merge, state = f"/tmp/.stripe-{tag}", f"/tmp/.stripe-merge-{tag}.py", f"{app.BACKOFFICE}/.stripe-state-{tag}.js"
        s = c.open_sftp()
        with s.file(state, "w") as f:
            f.write(STATE)
        try:
            if not apply:
                run(c, f"cd {app.BACKOFFICE} && node {state}")
                print("Add --apply to change it.")
                return
            with s.file(tmp, "w") as f:
                f.write("".join(f"{k}={v}\n" for k, v in new.items()))
            with s.file(merge, "w") as f:
                f.write(MERGE)
            env = f"{app.BACKOFFICE}/.env"
            run(c, f"cp -p {env} /root/backoffice.env.bak-2026-11-06-stripe && chmod 600 /root/backoffice.env.bak-2026-11-06-stripe")
            run(c, f"python3 {merge} {tmp} {env}")
            run(c, f"cd {app.BACKOFFICE} && node {state} {KITCHEN} {ACCOUNT} {LOCATION}")
            restart = shlex.quote(f"pm2 restart {PM2} --update-env")
            run(c, f"su - vesopasoftware -c {restart} | grep -c online")
        finally:
            run(c, f"rm -f {tmp} {merge} {state}")
    finally:
        c.close()


if __name__ == "__main__":
    main()
