"""vesopaepos.com takes its own payments with LIVE Stripe (owner, 2026-11-08).

    python tool/stripe_vesopaepos_live.py            # what is set now; changes nothing
    python tool/stripe_vesopaepos_live.py --apply    # webhook, wallet domains, keys, restart

--apply, in order:
  1. A live webhook to https://vesopaepos.com/webhooks/stripe, made once; its
     secret goes into .env.stripe (STRIPE_VESOPAEPOS_WEBHOOK_SECRET).
  2. Payment method domains vesopaepos.com and www.vesopaepos.com on the live
     account, so Apple Pay and Google Pay show on vesopaepos.com/pay.
  3. BACKUP of the site's .env (/root/vesopaepos.env.bak-<stamp>), then
     STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET set in it.
     Dojo's keys stay; PAYMENTS_PROVIDER=dojo there switches back.
  4. RESTART vesopaepos.com only.
Never prints a key.
"""
import os
import shlex
import sys
import time

import stripe_kitchen_live as k  # same folder: env, Stripe calls, ssh helpers

APP = "/home/vesopasoftware/web/vesopaepos.com/private/nodeapp"
HOOK = "https://vesopaepos.com/webhooks/stripe"
EVENTS = ["payment_intent.succeeded", "payment_intent.processing", "payment_intent.payment_failed",
          "payment_intent.canceled", "charge.refunded", "charge.dispute.created"]
DOMAINS = ["vesopaepos.com", "www.vesopaepos.com"]


def webhook(live, env):
    for w in k.stripe(live, "GET", "/v1/webhook_endpoints?limit=100")["data"]:
        if w["url"] == HOOK:
            if not env.get("STRIPE_VESOPAEPOS_WEBHOOK_SECRET"):
                raise SystemExit("a live webhook exists but its secret is not in .env.stripe: roll it in the dashboard")
            return w["id"], env["STRIPE_VESOPAEPOS_WEBHOOK_SECRET"]
    w = k.stripe(live, "POST", "/v1/webhook_endpoints", {
        "url": HOOK, "enabled_events[]": EVENTS, "description": "vesopaepos.com: shop and subscriptions (live)",
    })
    text = k.ENV_PATH.read_text(encoding="utf-8").rstrip("\n")
    text += f"\n\n# Live webhook {w['id']} for vesopaepos.com, made {time.strftime('%Y-%m-%d')}\nSTRIPE_VESOPAEPOS_WEBHOOK_SECRET={w['secret']}\n"
    k.ENV_PATH.write_bytes(text.encode("utf-8"))
    return w["id"], w["secret"]


def domains(live):
    have = {d["domain_name"]: d for d in k.stripe(live, "GET", "/v1/payment_method_domains?limit=100")["data"]}
    for name in DOMAINS:
        d = have.get(name) or k.stripe(live, "POST", "/v1/payment_method_domains", {"domain_name": name, "enabled": "true"})
        ap = (d.get("apple_pay") or {}).get("status")
        gp = (d.get("google_pay") or {}).get("status")
        print(f"domain {name}: apple pay {ap}, google pay {gp}")


def main():
    apply = "--apply" in sys.argv
    env = k.env_stripe()
    live, pk = env["STRIPE_LIVE_SECRET_KEY"], env.get("STRIPE_LIVE_PUBLISHABLE_KEY", "")
    if not live.startswith("sk_live_") or not pk.startswith("pk_live_"):
        raise SystemExit("the live keys in .env.stripe are not live keys: stopping")
    c = k.app.vesopa_ssh.connect()
    tag = os.getpid()
    tmp, merge = f"/tmp/.vs-{tag}", f"/tmp/.vs-merge-{tag}.py"
    try:
        k.run(c, f"cd {APP} && grep -c '^STRIPE_' .env || true")
        if not apply:
            print("Add --apply to set it.")
            return
        hook, secret = webhook(live, env)
        print("live webhook", hook)
        domains(live)
        sftp = c.open_sftp()
        with sftp.file(tmp, "w") as f:
            f.write(f"STRIPE_SECRET_KEY={live}\nSTRIPE_PUBLISHABLE_KEY={pk}\nSTRIPE_WEBHOOK_SECRET={secret}\n")
        with sftp.file(merge, "w") as f:
            f.write(k.MERGE)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        k.run(c, f"cp -p {APP}/.env /root/vesopaepos.env.bak-{stamp} && chmod 600 /root/vesopaepos.env.bak-{stamp} && echo backed up .env")
        k.run(c, f"python3 {merge} {tmp} {APP}/.env")
        restart = shlex.quote("pm2 restart vesopaepos.com --update-env")
        k.run(c, f"su - vesopasoftware -c {restart} | grep -c online")
    finally:
        k.run(c, f"rm -f {tmp} {merge}")
        c.close()


if __name__ == "__main__":
    main()
