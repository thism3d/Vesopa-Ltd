"""Pontardawe RFC's app: every way in switched on, and the server side live (2026-10-10).

    python tool/deploy_pontardawe_app.py            # check only: show what it would do
    python tool/deploy_pontardawe_app.py --apply    # do it

Run from the repository root on the owner's PC (cloud sessions cannot reach
port 22). With --apply, in order, stopping at the first failure:

  1. SIGN-IN METHODS for the venue whose Loyalty App slug is pontardawe-rfc:
     an emailed code, email and password, a passkey, a texted code and
     Continue with Vesopa all on (epos_loyalty_app_methods, the same rows the
     back office's Loyalty App > Sign-in switches write). The server still
     drops any its .env cannot do (texting with no SMS key). Apple, Google and
     the phone reach the app through Continue with Vesopa.
  2. BACK OFFICE .env: APNS_TOPICS gains pontardawe-rfc=com.vesopaepos.pontardawerfc
     (kept as it is when already there), so the club's own iPhone app gets
     notifications. Backed up first.
  3. BACK OFFICE CODE: tool/deploy_memberships.py --backoffice's own step
     (vesopa_server/src and public, re-runnable schema, restart by name).
  4. AUTH: vesopa_auth/src/routes/oidc.js (the `idp` hint: the app's Apple,
     Google, phone and passkey buttons go straight there), backed up, `npm
     test` on the server BEFORE the restart, then `pm2 restart auth.vesopa.com`.
  5. CHECKS: the app's branding lists the methods, /oauth/authorize?idp=google
     goes to Google, both healths answer.

Credentials: VESOPA_SSH_PASSWORD from .env.claude-tools or .env.claude, as the
other deploy tools. Nothing secret is printed.
"""
import pathlib
import posixpath
import re
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

import deploy_client_area_vesopa_connect as base  # noqa: E402
import deploy_memberships  # noqa: E402  (loads .env.claude too)

vesopa_ssh = base.vesopa_ssh
sh = base.sh

USER = "vesopasoftware"
SLUG = "pontardawe-rfc"
BUNDLE = "com.vesopaepos.pontardawerfc"
METHODS = ["code_email", "password", "passkey", "code_sms", "vesopa"]  # loyalty_auth.js METHODS
BACKOFFICE = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"
AUTH_DOMAIN = "auth.vesopa.com"
AUTH = f"/home/{USER}/web/{AUTH_DOMAIN}/private/nodeapp"
AUTH_FILES = ["vesopa_auth/src/routes/oidc.js"]
BACKUPS = f"/home/{USER}/backups"
PM2 = f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 {{}}'"
NODE = "PATH=/opt/nodejs/24/bin:$PATH"
DB = f"cd {BACKOFFICE} && mariadb $(grep -E '^DB_NAME=' .env | cut -d= -f2)"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "vesopa-deploy-check"})

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as r:
            return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, ""


def office(client):
    st, out = sh(client, f"{DB} -N -e \"SELECT office FROM epos_loyalty_app WHERE slug = '{SLUG}'\"", quiet=True)
    found = out.strip().splitlines()
    if st != 0 or len(found) != 1:
        raise SystemExit(f"! could not find the one venue with slug {SLUG} (got {len(found)}); nothing was changed")
    return found[0].strip()


def show(client, venue):
    sh(client, f"{DB} -e \"SELECT method, enabled, sort_order FROM epos_loyalty_app_methods "
               f"WHERE office = '{venue}' ORDER BY sort_order\"")
    st, out = sh(client, f"grep -E '^APNS_TOPICS=' {BACKOFFICE}/.env || echo 'APNS_TOPICS not set'", quiet=True)
    print("   " + out.strip())


def checks():
    ok = True
    results = []
    st, _, body = fetch(f"https://loyalty.vesopa.com/loyalty/v1/app/{SLUG}?check={int(time.time())}")
    methods = re.search(r'"methods"\s*:\s*\[([^\]]*)\]', body)
    listed = methods.group(1) if methods else ""
    print(f"   app's sign-in methods now: [{listed}]")
    results.append(("the app offers email and password", '"password"' in listed))
    results.append(("the app offers Continue with Vesopa (Apple, Google, phone, passkey)", '"vesopa"' in listed))
    st, headers, _ = fetch(
        f"https://{AUTH_DOMAIN}/oauth/authorize?response_type=code&client_id=x&redirect_uri=http://127.0.0.1/&idp=google")
    where = (headers or {}).get("Location", "") if headers else ""
    print(f"   /oauth/authorize?idp=google answers {st} -> {where[:60]}")
    st, _, _ = fetch(f"https://{AUTH_DOMAIN}/health")
    results.append(("auth health", st == 200))
    st, _, _ = fetch("https://backoffice.vesopaepos.com/health")
    results.append(("back office health", st == 200))
    for label, passed in results:
        print(f"   {'ok ' if passed else 'BAD'} {label}")
        ok = ok and passed
    return ok


def main():
    apply = "--apply" in sys.argv
    print(f"Pontardawe RFC app: sign-in methods, APNS topic, back office and auth  "
          f"({'APPLY' if apply else 'check only; --apply to do it'})")
    client = vesopa_ssh.connect()
    try:
        venue = office(client)
        print(f"\n== venue {SLUG}: office {venue}")
        show(client, venue)
        if not apply:
            print("\nCheck only. Live now:")
            checks()
            print("\nRun again with --apply to do it.")
            return

        stamp = time.strftime("%Y%m%d-%H%M%S")
        sh(client, f"mkdir -p {BACKUPS}", quiet=True)

        print("\n== 1. sign-in methods")
        rows = ", ".join(f"('{venue}', '{m}', 1, {i})" for i, m in enumerate(METHODS))
        st, _ = sh(client, (
            f"{DB} -e \"INSERT INTO epos_loyalty_app_methods (office, method, enabled, sort_order) VALUES {rows} "
            "ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), sort_order = VALUES(sort_order)\""
        ))
        if st != 0:
            raise SystemExit("! could not write the sign-in methods; nothing else was changed")
        show(client, venue)

        print("\n== 2. back office .env: APNS_TOPICS")
        env = f"{BACKOFFICE}/.env"
        st, out = sh(client, f"grep -E '^APNS_TOPICS=' {env} || true", quiet=True)
        line = out.strip()
        if f"{SLUG}={BUNDLE}" in line:
            print("   already there")
        else:
            sh(client, f"cp -p {env} {BACKUPS}/backoffice-env-{stamp} && chmod 600 {BACKUPS}/backoffice-env-{stamp}", quiet=True)
            if line:
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                new = f"{value},{SLUG}={BUNDLE}" if value else f"{SLUG}={BUNDLE}"
                sh(client, f"sed -i 's|^APNS_TOPICS=.*$|APNS_TOPICS={new}|' {env}")
            else:
                sh(client, f"printf '\\nAPNS_TOPICS={SLUG}={BUNDLE}\\n' >> {env}")
            sh(client, f"grep -E '^APNS_TOPICS=' {env}")

        print("\n== 3. back office code (deploy_memberships.py --backoffice)")
        deploy_memberships.backoffice()

        print(f"\n== 4. {AUTH_DOMAIN}")
        backup = f"{BACKUPS}/{AUTH_DOMAIN}-{stamp}.tgz"
        st, _ = sh(client, f"tar -czf {backup} -C {AUTH} --exclude=./node_modules --exclude=./logs . && chmod 600 {backup}")
        if st != 0:
            raise SystemExit("! auth backup failed; auth was not changed")
        print(f"   backup {backup}")
        sftp = client.open_sftp()
        try:
            for f in AUTH_FILES:
                sftp.put(str(ROOT / f), posixpath.join(AUTH, f[len("vesopa_auth/"):]))
        finally:
            sftp.close()
        sh(client, f"chown -R {USER}:{USER} {AUTH}/src", quiet=True)
        st, out = sh(client, f"su - {USER} -c 'cd {AUTH} && {NODE} npm test 2>&1 | tail -12'", quiet=True)
        if not re.search(r"^\s*(#|ℹ) fail 0\s*$", out, re.M):
            print("    " + out.strip().replace("\n", "\n    "))
            sh(client, f"tar -xzf {backup} -C {AUTH} ./src/routes/oidc.js", quiet=True)
            raise SystemExit("! auth tests failed on the server: oidc.js put back, auth NOT restarted")
        print("   npm test passes on the server")
        st, _ = sh(client, PM2.format(f"restart {AUTH_DOMAIN}") + " >/dev/null && echo '   restarted'")
        if st != 0:
            raise SystemExit(f"! pm2 restart failed; roll back with: tar -xzf {backup} -C {AUTH}")

        print("\n== 5. checks")
        time.sleep(6)
        ok = checks()
        print(f"\n{'OK' if ok else 'CHECK THE LINES MARKED BAD'}")
        if not ok:
            sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
