"""Ship the auth.vesopa.com homepage refresh and the reCAPTCHA-loads-once fix.

    python tool/deploy_auth_home_recaptcha.py            # check only: show what it would do
    python tool/deploy_auth_home_recaptcha.py --apply    # do it

Ships commit 021b7e3 and anything after it under vesopa_auth/ (diffed from
BASE_COMMIT, the main that was live: its captcha.js, nav.js, auth.css and
code.js are byte-identical to what auth.vesopa.com serves). With --apply, in
order, stopping at the first failure:

  1. BACKUP of the live auth app (no node_modules or logs; .env included) in
     /home/vesopasoftware/backups/.
  2. CODE: the changed vesopa_auth/ files only (from git; .env is never sent),
     chown to vesopasoftware, `npm test` on the server (every template
     compiles) BEFORE restarting, then `pm2 restart auth.vesopa.com` as
     vesopasoftware. Never `restart all`, never --update-env. No schema change.
  3. SMOKE: / is the new homepage (home.css, body class "home"), the fonts
     answer 200, /login still carries the captcha field, and /health is ok.

Credentials: VESOPA_SSH_PASSWORD from .env.claude-tools or .env.claude, as
tool/deploy_client_area_vesopa_connect.py. Host: the Cloud box, 34.63.118.67.

To roll back: tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>,
then `pm2 restart auth.vesopa.com` as vesopasoftware.
"""
import pathlib
import posixpath
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tool"))

# Same credentials and host handling as the client-area deploy.
import deploy_client_area_vesopa_connect as base  # noqa: E402

vesopa_ssh = base.vesopa_ssh
sh = base.sh

USER = "vesopasoftware"
DOMAIN = "auth.vesopa.com"
FOLDER = "vesopa_auth"
APP = f"/home/{USER}/web/{DOMAIN}/private/nodeapp"
BACKUPS = f"/home/{USER}/backups"
BASE_COMMIT = "97d2054"
PM2 = f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 {{}}'"
NODE = "PATH=/opt/nodejs/24/bin:$PATH"
SITE = "https://auth.vesopa.com"


def changed_files():
    out = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=AM", f"{BASE_COMMIT}..HEAD", "--", FOLDER],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split()
    return [f for f in out if not posixpath.basename(f).startswith(".env") and "/node_modules/" not in f]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 vesopa-deploy-check"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""


def smoke():
    ok = True
    checks = []
    st, home = fetch(f"{SITE}/?deploycheck={int(time.time())}")
    checks.append(("homepage answers 200", st == 200))
    checks.append(("homepage is the new one (home.css)", "/css/home.css" in home))
    checks.append(('body class="home" (not escaped)', '<body class="home"' in home))
    for font in ("archivo-latin", "martian-mono-latin", "source-serif-4-latin"):
        fst, _ = fetch(f"{SITE}/fonts/{font}.woff2")
        checks.append((f"/fonts/{font}.woff2 answers 200", fst == 200))
    st, login = fetch(f"{SITE}/login")
    checks.append(("/login answers 200", st == 200))
    checks.append(("/login still carries the captcha field", 'id="captcha-token"' in login))
    st, nav = fetch(f"{SITE}/js/nav.js?v=check{int(time.time())}")
    checks.append(("nav.js keeps reCAPTCHA across navigation", "replaceBody" in nav))
    st, health = fetch(f"{SITE}/health")
    checks.append(("/health is ok", st == 200 and '"ok"' in health))
    for label, passed in checks:
        print(f"   {'ok ' if passed else 'BAD'} {label}")
        ok = ok and passed
    return ok


def main():
    apply = "--apply" in sys.argv
    files = changed_files()
    print(f"auth.vesopa.com homepage + reCAPTCHA once  ({'APPLY' if apply else 'check only; --apply to do it'})")
    print(f"\n== {len(files)} changed files from {FOLDER}/ since {BASE_COMMIT}")
    for f in files:
        print("   " + f)

    client = vesopa_ssh.connect()
    try:
        st, _ = sh(client, f"test -d {APP}", quiet=True)
        if st != 0:
            raise SystemExit(f"! {APP} does not exist on the server; nothing was changed")
        sh(client, f"cd {APP} && grep -m1 '\"version\"' package.json")

        if not apply:
            print("\nCheck only. Live site now:")
            smoke()
            print("\nRun again with --apply to do it.")
            return

        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = f"{BACKUPS}/{DOMAIN}-{stamp}.tgz"
        print("\n== 1. backup")
        st, _ = sh(client, (
            f"mkdir -p {BACKUPS} && tar -czf {backup} -C {APP} "
            "--exclude=./node_modules --exclude=./logs . && chmod 600 " + backup +
            " && ls -lh " + backup + " | awk '{print $5}'"
        ))
        if st != 0:
            raise SystemExit("! backup failed; nothing was changed")
        print(f"   {backup}")

        print(f"\n== 2. code ({len(files)} files)")
        sftp = client.open_sftp()
        try:
            for f in files:
                dest = posixpath.join(APP, f[len(FOLDER) + 1:])
                vesopa_ssh._mkdirs(sftp, posixpath.dirname(dest))
                sftp.put(str(ROOT / f), dest)
        finally:
            sftp.close()
        sh(client, f"chown -R {USER}:{USER} {APP}", quiet=True)
        print("   uploaded and chowned")

        st, out = sh(client, f"su - {USER} -c 'cd {APP} && {NODE} npm test 2>&1 | tail -12'", quiet=True)
        if not re.search(r"^\s*(#|ℹ) fail 0\s*$", out, re.M):
            print("    " + out.strip().replace("\n", "\n    "))
            raise SystemExit(
                "! REFUSING TO RESTART: the tests failed on the server. The previous version is still "
                f"running. Roll the files back with: tar -xzf {backup} -C {APP}")
        print("   npm test passes on the server")

        st, _ = sh(client, PM2.format(f"restart {DOMAIN}") + " >/dev/null && echo '   restarted'")
        if st != 0:
            raise SystemExit(f"! pm2 restart failed; roll back with: tar -xzf {backup} -C {APP}")
        time.sleep(6)
        sh(client, f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 logs {DOMAIN} --nostream --lines 20 2>&1' "
                   "| grep -E 'boot|listening|Error' | tail -6")

        print("\n== 3. smoke")
        ok = smoke()
        print(f"\n{'OK' if ok else 'FAILED'}: {DOMAIN}")
        if not ok:
            print(f"   To roll back: tar -xzf {backup} -C {APP}, then pm2 restart {DOMAIN} as {USER}.")
            sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
