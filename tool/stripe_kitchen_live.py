"""The Vesopa Kitchen on LIVE Stripe, into Vesopa Software Ltd's own account (owner, 2026-11-08).

    python tool/stripe_kitchen_live.py            # shows the Kitchen's row and what would change
    python tool/stripe_kitchen_live.py --apply    # live location + webhook, keys on the server, Kitchen live
    python tool/stripe_kitchen_live.py --sandbox  # puts the Kitchen back on its sandbox account

--apply, in order:
  1. A live Terminal location for the Kitchen (its sandbox location's address),
     made once and reused.
  2. A live webhook to https://backoffice.vesopaepos.com/api/stripe/webhook,
     made once; its secret goes into .env.stripe (STRIPE_LIVE_WEBHOOK_SECRET).
  3. BACKUP of the back office .env (/root/backoffice.env.bak-<stamp>), then
     STRIPE_LIVE_SECRET_KEY, STRIPE_LIVE_PUBLISHABLE_KEY, STRIPE_LIVE_WEBHOOK_SECRET
     set in it. The sandbox keys stay: every other venue stays in the sandbox.
  4. The Kitchen's epos_stripe_settings row: environment live, account
     "platform", the live location. Its sandbox values are kept in
     /root/kitchen-stripe-sandbox.json for --sandbox.
  5. RESTART backoffice.vesopaepos.com only.
Only the Kitchen's row is touched. Never prints a key.
"""
import base64
import json
import os
import pathlib
import re
import shlex
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))
import deploy_pontardawe_app as app  # noqa: E402

KITCHEN = "manager@vesopa.co.uk"
PM2 = "backoffice.vesopaepos.com"
HOOK = "https://backoffice.vesopaepos.com/api/stripe/webhook"
EVENTS = [
    "payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled",
    "payment_intent.processing", "payment_intent.requires_action", "payment_intent.amount_capturable_updated",
    "charge.refunded", "terminal.reader.action_succeeded", "terminal.reader.action_failed",
    "terminal.reader.action_updated", "account.updated",
]
ENV_PATH = next(p / ".env.stripe" for p in (ROOT, *ROOT.parents) if (p / ".env.stripe").exists())

ROW = r"""
require('dotenv').config({ path: '.env' });
const mysql = require('mysql2/promise');
(async () => {
  const pool = mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'vesopa_eposdb' });
  const [mode, office, account, location, env] = process.argv.slice(2);
  const [[row]] = await pool.query('SELECT office, account_id, location_id, environment, enabled, use_tap, card_payments, payouts FROM epos_stripe_settings WHERE office = ?', [office]);
  console.log(JSON.stringify(row || null));
  if (mode === 'set') {
    if (!row) throw new Error('the Kitchen has no Stripe row: nothing changed');
    const ready = env === 'live' ? 'active' : 'restricted';
    const [r] = await pool.execute('UPDATE epos_stripe_settings SET account_id = ?, location_id = ?, environment = ?, card_payments = ?, payouts = ? WHERE office = ?',
      [account, location, env, ready, ready, office]);
    console.log('kitchen rows updated', r.affectedRows);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
"""

MERGE = r"""
import re, sys
new = dict(l.rstrip("\n").split("=", 1) for l in open(sys.argv[1], encoding="utf-8") if "=" in l)
s = open(sys.argv[2], encoding="utf-8").read()
for k, v in new.items():
    s, c = re.subn(r"(?m)^" + k + r"=.*$", lambda m: k + "=" + v, s)
    if not c:
        s = s.rstrip("\n") + "\n" + k + "=" + v + "\n"
open(sys.argv[2], "w", encoding="utf-8").write(s)
print("env lines set", len(new))
"""


def env_stripe():
    out = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Z_]+)=(.*)", line)
        if m:
            out[m[1]] = m[2].strip().strip("'\"")
    return out


def stripe(key, method, path, body=None):
    data = urllib.parse.urlencode(body, doseq=True).encode() if body else None
    req = urllib.request.Request("https://api.stripe.com" + path, data=data, method=method, headers={
        "Authorization": "Basic " + base64.b64encode((key + ":").encode()).decode(),
        "Stripe-Version": "2025-09-30.clover",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def live_location(live, test):
    for loc in stripe(live, "GET", "/v1/terminal/locations?limit=100")["data"]:
        if (loc.get("metadata") or {}).get("vesopa_office") == KITCHEN:
            return loc["id"]
    # The sandbox location sits on the Kitchen's sandbox connected account.
    req = urllib.request.Request("https://api.stripe.com/v1/terminal/locations/tml_Guss6QLdF7KApq", headers={
        "Authorization": "Basic " + base64.b64encode((test + ":").encode()).decode(),
        "Stripe-Account": "acct_1UYwyDQdgS0g39i0",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        sandbox = json.load(r)
    a = sandbox["address"]
    body = {
        "display_name": sandbox.get("display_name") or "The Vesopa Kitchen",
        "address[line1]": a.get("line1") or "", "address[city]": a.get("city") or "",
        "address[postal_code]": a.get("postal_code") or "", "address[country]": a.get("country") or "GB",
        "metadata[vesopa_office]": KITCHEN,
    }
    if a.get("line2"):
        body["address[line2]"] = a["line2"]
    return stripe(live, "POST", "/v1/terminal/locations", body)["id"]


def live_webhook(live, env):
    for w in stripe(live, "GET", "/v1/webhook_endpoints?limit=100")["data"]:
        if w["url"] == HOOK:
            if not env.get("STRIPE_LIVE_WEBHOOK_SECRET"):
                raise SystemExit("a live webhook exists but its secret is not in .env.stripe: roll it in the dashboard")
            return w["id"], env["STRIPE_LIVE_WEBHOOK_SECRET"]
    w = stripe(live, "POST", "/v1/webhook_endpoints", {
        "url": HOOK, "enabled_events[]": EVENTS, "description": "Vesopa EPOS back office (live): The Vesopa Kitchen",
    })
    text = ENV_PATH.read_text(encoding="utf-8").rstrip("\n")
    text += f"\n\n# Live webhook {w['id']} for the back office, made {time.strftime('%Y-%m-%d')}\nSTRIPE_LIVE_WEBHOOK_SECRET={w['secret']}\n"
    ENV_PATH.write_bytes(text.encode("utf-8"))
    return w["id"], w["secret"]


def run(c, cmd):
    _, out, err = c.exec_command(cmd)
    code = out.channel.recv_exit_status()
    o = out.read().decode("utf-8", "replace").strip()
    if o:
        print(o)
    e = err.read().decode("utf-8", "replace").strip()
    if e:
        print(e)
    if code:
        raise SystemExit(f"stopped: exit {code}")
    return o


def main():
    apply, back = "--apply" in sys.argv, "--sandbox" in sys.argv
    env = env_stripe()
    live, test = env["STRIPE_LIVE_SECRET_KEY"], env["STRIPE_TEST_VESOPA_SECRET_KEY"]
    if not live.startswith("sk_live_") or not env.get("STRIPE_LIVE_PUBLISHABLE_KEY", "").startswith("pk_live_"):
        raise SystemExit("the live keys in .env.stripe are not live keys: stopping")
    c = app.vesopa_ssh.connect()
    tag = os.getpid()
    sftp = c.open_sftp()
    rowjs = f"{app.BACKOFFICE}/.stripe-row-{tag}.js"
    tmp, merge = f"/tmp/.stripe-{tag}", f"/tmp/.stripe-merge-{tag}.py"
    with sftp.file(rowjs, "w") as f:
        f.write(ROW)
    try:
        now = run(c, f"cd {app.BACKOFFICE} && node {rowjs} show {KITCHEN}")
        if not (apply or back):
            print("Add --apply to put the Kitchen live, --sandbox to put it back.")
            return
        if back:
            saved = json.loads(run(c, "cat /root/kitchen-stripe-sandbox.json"))
            run(c, f"cd {app.BACKOFFICE} && node {rowjs} set {KITCHEN} {saved['account_id']} {saved['location_id']} sandbox")
        else:
            loc = live_location(live, test)
            print("live location", loc)
            hook, secret = live_webhook(live, env)
            print("live webhook", hook)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            with sftp.file(tmp, "w") as f:
                f.write(f"STRIPE_LIVE_SECRET_KEY={live}\nSTRIPE_LIVE_PUBLISHABLE_KEY={env['STRIPE_LIVE_PUBLISHABLE_KEY']}\nSTRIPE_LIVE_WEBHOOK_SECRET={secret}\n")
            with sftp.file(merge, "w") as f:
                f.write(MERGE)
            envf = f"{app.BACKOFFICE}/.env"
            run(c, f"cp -p {envf} /root/backoffice.env.bak-{stamp} && chmod 600 /root/backoffice.env.bak-{stamp} && echo backed up .env")
            run(c, f"python3 {merge} {tmp} {envf}")
            row = json.loads(now.strip().splitlines()[-1])
            if row and row.get("environment") != "live":
                with sftp.file("/root/kitchen-stripe-sandbox.json", "w") as f:
                    f.write(json.dumps({"account_id": row["account_id"], "location_id": row["location_id"]}))
            run(c, f"cd {app.BACKOFFICE} && node {rowjs} set {KITCHEN} platform {loc} live")
        restart = shlex.quote(f"pm2 restart {PM2} --update-env")
        run(c, f"su - vesopasoftware -c {restart} | grep -c online")
    finally:
        run(c, f"rm -f {tmp} {merge} {rowjs}")
        c.close()


if __name__ == "__main__":
    main()
