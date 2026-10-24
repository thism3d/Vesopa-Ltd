"""Vesopa's own Dojo account ("Vesopa") for vesopaepos.com subscriptions (2026-10-24).

    python tool/deploy_vesopa_dojo.py --check   # what it would change; changes nothing
    python tool/deploy_vesopa_dojo.py           # do it

From .env.dojo-vesopa (gitignored), never printed:
  vesopaepos.com .env     DOJO_SUBS_KEY := DOJO_VESOPA_SANDBOX_KEY (replaces the shared demo key)
                          DOJO_SUBS_WEBHOOK_SECRET := DOJO_VESOPA_SANDBOX_WEBHOOK_SECRET
  back office .env        DOJO_WEBHOOK_SECRET_SANDBOX gains that secret (comma list;
                          the owner registered the webhook at
                          https://backoffice.vesopaepos.com/api/webhooks/dojo/sandbox)
  back office src/server.js  forwards verified Dojo events for subscription payments to
                          vesopaepos.com (refused if the live file changed since BASE)
Both .env files are copied to /home/vesopasoftware/backups first. Both apps restart.
"""
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import deploy_websites_cookie_notice as base  # noqa: E402

ROOT = base.ROOT
USER = base.USER
WEB = f"/home/{USER}/web/vesopaepos.com/private/nodeapp"
BO = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"
BASE = "b1bad2b4"  # vesopa_server/src/server.js as last deployed


def local():
    vals = {}
    for line in (ROOT / ".env.dojo-vesopa").read_text(encoding="utf-8").splitlines():
        k, sep, v = line.partition("=")
        if sep and not k.startswith("#"):
            vals[k.strip()] = v.strip().strip("'\"")
    key, secret = vals.get("DOJO_VESOPA_SANDBOX_KEY", ""), vals.get("DOJO_VESOPA_SANDBOX_WEBHOOK_SECRET", "")
    if not key.startswith("sk_sandbox_") or not secret:
        sys.exit("! .env.dojo-vesopa needs a sk_sandbox_ key and the webhook secret")
    return key, secret


def set_env(text, key, value, append_csv=False):
    lines, done = text.splitlines(), False
    for i, line in enumerate(lines):
        if line.split("=", 1)[0].strip() == key:
            if append_csv:
                cur = [x.strip() for x in line.split("=", 1)[1].strip().strip("'\"").split(",") if x.strip()]
                if value in cur:
                    return text, False
                cur.append(value)
                lines[i] = f"{key}={','.join(cur)}"
            else:
                if line.split("=", 1)[1].strip().strip("'\"") == value:
                    return text, False
                lines[i] = f"{key}={value}"
            done = True
    if not done:
        lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n", True


def main():
    check = "--check" in sys.argv
    key, secret = local()
    client = base.vesopa_ssh.connect()
    try:
        sftp = client.open_sftp()
        read = lambda p: sftp.open(p).read().decode("utf-8")  # noqa: E731
        web_env, bo_env = read(f"{WEB}/.env"), read(f"{BO}/.env")
        web_new, c1 = set_env(web_env, "DOJO_SUBS_KEY", key)
        web_new, c2 = set_env(web_new, "DOJO_SUBS_WEBHOOK_SECRET", secret)
        bo_new, c3 = set_env(bo_env, "DOJO_WEBHOOK_SECRET_SANDBOX", secret, append_csv=True)
        live_server = sftp.open(f"{BO}/src/server.js").read().replace(b"\r\n", b"\n")
        base_server = subprocess.run(["git", "show", f"{BASE}:vesopa_server/src/server.js"], cwd=ROOT, capture_output=True).stdout.replace(b"\r\n", b"\n")
        drift = live_server != base_server
        print(f"vesopaepos.com .env: key {'changes' if c1 else 'already set'}, webhook secret {'added' if c2 else 'already set'}")
        print(f"back office .env: sandbox webhook secrets {'gain the Vesopa one' if c3 else 'already have it'}")
        print(f"back office src/server.js: {'CHANGED ON SERVER since ' + BASE + ', not overwritten' if drift else 'matches ' + BASE + ', safe to update'}")
        if check:
            print("\ncheck only: nothing changed.")
            return
        if drift:
            sys.exit("! stopped: server.js on the box differs from the last deployed version")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base.sh(client, f"mkdir -p {base.BACKUPS} && cp {WEB}/.env {base.BACKUPS}/vesopaepos-env-{stamp} && cp {BO}/.env {base.BACKUPS}/backoffice-env-{stamp} "
                        f"&& cp {BO}/src/server.js {base.BACKUPS}/backoffice-server-js-{stamp} && chmod 600 {base.BACKUPS}/*-env-{stamp}", quiet=True)
        print(f"backups: {base.BACKUPS}/*-{stamp}")
        for path, text in ((f"{WEB}/.env", web_new), (f"{BO}/.env", bo_new)):
            with sftp.open(path, "w") as fh:
                fh.write(text)
        sftp.put(str(ROOT / "vesopa_server" / "src" / "server.js"), f"{BO}/src/server.js")
        sftp.close()
        base.sh(client, f"chown {USER}:{USER} {WEB}/.env {BO}/.env {BO}/src/server.js && chmod 600 {WEB}/.env {BO}/.env", quiet=True)
        base.sh(client, base.PM2.format("restart backoffice.vesopaepos.com --update-env") + " >/dev/null && echo 'back office restarted'")
        base.sh(client, base.PM2.format("restart vesopaepos.com") + " >/dev/null && echo 'vesopaepos.com restarted'")
    finally:
        client.close()
    time.sleep(5)
    for url, needle in (("https://backoffice.vesopaepos.com/api/health", ""), ("https://vesopaepos.com/trial", "Try Vesopa EPOS")):
        try:
            code, body = base.fetch(url)
            print(f"   {'ok ' if code == 200 and needle in body else 'BAD'} {url} -> {code}")
        except Exception as e:  # noqa: BLE001
            print(f"   BAD {url} -> {e}")


if __name__ == "__main__":
    main()
