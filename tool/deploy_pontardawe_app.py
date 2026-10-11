"""Pontardawe RFC's app: every way in switched on, and the server side live (2026-10-10).

    python tool/deploy_pontardawe_app.py            # check only: show what it would do
    python tool/deploy_pontardawe_app.py --apply    # do it
    python tool/deploy_pontardawe_app.py --apply --no-web   # without the web app

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
  4. AUTH: the `idp` hint (oidc.js) and, since 2026-10-11, POST /oauth/native
     (routes/native.js): the app's own Apple, Google and passkey sheets sign
     in to the Vesopa account with no web page. The files in AUTH_FILES are
     backed up, `npm test` runs on the server BEFORE the restart (all put back
     if it fails), then `pm2 restart auth.vesopa.com`.
  5. vesopa.com/.well-known/apple-app-site-association: Vesopa passkeys
     belong to vesopa.com (WEBAUTHN_RP_ID), so iOS lets the app use them only
     when THAT site names the app. vesopa.com redirects to vesopa.co.uk, and
     Apple does not follow redirects, so an nginx include answers this one
     address before the redirect does. Taken out again if it does not work.
  6. THE WEB APP (member.pontardawerfc.com and every loyalty.vesopa.com
     venue): built here with Flutter (`flutter build web --base-href
     /__SLUG__/`, the shared client id), the live one backed up, then
     uploaded. It now reads its venue from the page on a venue's own host,
     and its links read on the venue's colours. Skipped with --no-web.
  7. CHECKS: the app's branding lists the methods, /oauth/authorize?idp=google
     goes to Google, /oauth/native answers, both well-known files name the
     app, both healths answer.

Credentials: VESOPA_SSH_PASSWORD from .env.claude-tools or .env.claude, as the
other deploy tools. Nothing secret is printed.
"""
import json
import pathlib
import posixpath
import re
import shutil
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

import deploy_client_area_vesopa_connect as base  # noqa: E402
import deploy_memberships  # noqa: E402  (loads .env.claude too)

vesopa_ssh = base.vesopa_ssh
sh = base.sh

USER = "vesopasoftware"
SLUG = "pontardawe-rfc"
BUNDLE = "com.vesopaepos.pontardawerfc"
CLIENT_ID = "12a1047bafa611f185af42010a80000e"  # PontardaweRFC/venue.json vesopa_client_id
METHODS = ["code_email", "password", "passkey", "code_sms", "vesopa"]  # loyalty_auth.js METHODS
BACKOFFICE = f"/home/{USER}/web/backoffice.vesopaepos.com/private/nodeapp"
AUTH_DOMAIN = "auth.vesopa.com"
AUTH = f"/home/{USER}/web/{AUTH_DOMAIN}/private/nodeapp"
AUTH_FILES = [
    "vesopa_auth/src/routes/oidc.js",
    "vesopa_auth/src/routes/native.js",
    "vesopa_auth/src/routes/social.js",
    "vesopa_auth/src/routes/mfa.js",
    "vesopa_auth/src/providers.js",
    "vesopa_auth/src/server.js",
    "vesopa_auth/test/native.test.js",
    "vesopa_auth/package.json",
]
TEAM = "G238FR2ZC9"
IOS_APPS = [f"{TEAM}.{BUNDLE}", f"{TEAM}.com.vesopaepos.thevesopakitchen"]
RP_DOMAIN = "vesopa.com"  # auth's WEBAUTHN_RP_ID
WELL_KNOWN_INCLUDE = "nginx.ssl.conf_0vesopa_wellknown"
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


def post_json(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers={
        "User-Agent": "vesopa-deploy-check", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode("utf-8", "replace")


def well_known(client, stamp):
    """vesopa.com's apple-app-site-association, ahead of its redirect."""
    st, out = sh(client, f"ls -d /home/*/conf/web/{RP_DOMAIN} 2>/dev/null | head -1", quiet=True)
    conf = out.strip()
    if not conf:
        print(f"   ! no Hestia web domain {RP_DOMAIN} on this server; passkeys in the app need this file at")
        print(f"     https://{RP_DOMAIN}/.well-known/apple-app-site-association: {aasa()}")
        return
    path = f"{conf}/{WELL_KNOWN_INCLUDE}"
    body = aasa()
    include = "\n".join([
        "# Vesopa: iOS apps may use vesopa.com passkeys (tool/deploy_pontardawe_app.py).",
        "# Answered before this domain's redirect: Apple does not follow redirects.",
        r"rewrite ^/\.well-known/apple-app-site-association$ /.well-known/vesopa-aasa last;",
        "location = /.well-known/vesopa-aasa {",
        "    default_type application/json;",
        f"    return 200 '{body}';",
        "}",
        "",
    ])
    sh(client, f"[ -f {path} ] && cp -p {path} {BACKUPS}/vesopa-wellknown-{stamp} || true", quiet=True)
    sftp = client.open_sftp()
    try:
        with sftp.open(path, "w") as f:
            f.write(include)
    finally:
        sftp.close()
    st, out = sh(client, "nginx -t 2>&1 | tail -2", quiet=True)
    if "successful" not in out:
        print("    " + out.strip())
        sh(client, f"rm -f {path}", quiet=True)
        raise SystemExit("! nginx refused the vesopa.com include; it was taken out again (nginx not reloaded)")
    sh(client, "systemctl reload nginx", quiet=True)
    time.sleep(2)
    st, headers, got = fetch(f"https://{RP_DOMAIN}/.well-known/apple-app-site-association")
    if st == 200 and f"{TEAM}.{BUNDLE}" in got:
        print(f"   https://{RP_DOMAIN}/.well-known/apple-app-site-association answers 200 with the app")
        return
    print(f"   ! it answered {st} {(headers or {}).get('Location', '') if headers else ''}: the redirect runs first.")
    sh(client, f"rm -f {path} && nginx -t >/dev/null 2>&1 && systemctl reload nginx", quiet=True)
    sh(client, f"ls {conf}; grep -rn 'return 30\\|rewrite' {conf}/nginx* 2>/dev/null | head -5")
    print("   taken out again; nothing else changed. Send this output to Claude.")


def web_app(client, stamp):
    """The shared loyalty web build, built here and uploaded with a backup."""
    app = ROOT / "vesopa_loyalty"
    flutter = shutil.which("flutter") or shutil.which("flutter.bat")
    if not flutter:
        raise SystemExit("! Flutter is not on this PC's PATH; run again with --no-web to skip the web app")
    subprocess.run([flutter, "build", "web", "--release", "--base-href", "/__SLUG__/",
                    f"--dart-define=VESOPA_LOYALTY_CLIENT_ID={CLIENT_ID}"], cwd=str(app), check=True)
    web = app / "build" / "web"
    if '<base href="/__SLUG__/">' not in (web / "index.html").read_text(encoding="utf-8"):
        raise SystemExit("! the web build has no /__SLUG__/ base; nothing was uploaded")
    st, _ = sh(client, f"cd {BACKOFFICE} && tar -czf {BACKUPS}/loyalty_web-{stamp}.tgz loyalty_web", quiet=True)
    if st != 0:
        raise SystemExit("! could not back up the live web app; nothing was uploaded")
    print(f"   backup {BACKUPS}/loyalty_web-{stamp}.tgz")
    sftp = client.open_sftp()
    try:
        for path in sorted(web.rglob("*")):
            remote = posixpath.join(BACKOFFICE, "loyalty_web", path.relative_to(web).as_posix())
            if path.is_dir():
                try:
                    sftp.mkdir(remote)
                except OSError:
                    pass
            else:
                sftp.put(str(path), remote)
    finally:
        sftp.close()
    sh(client, f"chown -R {USER}:{USER} {BACKOFFICE}/loyalty_web", quiet=True)
    print("   uploaded (pages are served no-cache, so members get it on their next visit)")


def aasa():
    return json.dumps({"webcredentials": {"apps": IOS_APPS}}, separators=(",", ":"))


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
        # The app's own request (vesopa_sso_io.dart): its client, a loopback
        # /callback and PKCE. A made-up client is refused with 400 first.
        f"https://{AUTH_DOMAIN}/oauth/authorize?response_type=code&client_id={CLIENT_ID}"
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A53123%2Fcallback&scope=openid%20profile%20email"
        "&code_challenge=abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrs&code_challenge_method=S256&state=x&idp=google")
    where = (headers or {}).get("Location", "") if headers else ""
    print(f"   /oauth/authorize?idp=google answers {st} -> {where[:60]}")
    results.append(("the app's Google button goes straight to Google", st == 303 and where.startswith("/auth/google")))
    st, _, body = post_json(f"https://{AUTH_DOMAIN}/oauth/native", {"client_id": CLIENT_ID})
    print(f"   /oauth/native answers {st} {body[:80]}")
    results.append(("auth takes the app's native sign-ins (/oauth/native)", st == 400 and "invalid_request" in body))
    st, _, body = fetch("https://member.pontardawerfc.com/")
    results.append(("member.pontardawerfc.com says which venue it is", f'name="loyalty-venue" content="{SLUG}"' in body))
    for site in (RP_DOMAIN, "loyalty.vesopa.com"):
        st, headers, body = fetch(f"https://{site}/.well-known/apple-app-site-association")
        print(f"   {site} apple-app-site-association: {st} {body[:90]}")
        results.append((f"{site} names the app for passkeys", st == 200 and f"{TEAM}.{BUNDLE}" in body))
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
        sh(client, f"chown -R {USER}:{USER} {AUTH}/src {AUTH}/test {AUTH}/package.json", quiet=True)
        st, out = sh(client, f"su - {USER} -c 'cd {AUTH} && {NODE} npm test 2>&1 | tail -12'", quiet=True)
        if not re.search(r"^\s*(#|ℹ) fail 0\s*$", out, re.M):
            print("    " + out.strip().replace("\n", "\n    "))
            back = " ".join("./" + f[len("vesopa_auth/"):] for f in AUTH_FILES if f != "vesopa_auth/test/native.test.js")
            sh(client, f"tar -xzf {backup} -C {AUTH} {back}; rm -f {AUTH}/test/native.test.js", quiet=True)
            raise SystemExit("! auth tests failed on the server: its files were put back, auth NOT restarted")
        print("   npm test passes on the server")
        st, _ = sh(client, PM2.format(f"restart {AUTH_DOMAIN}") + " >/dev/null && echo '   restarted'")
        if st != 0:
            raise SystemExit(f"! pm2 restart failed; roll back with: tar -xzf {backup} -C {AUTH}")

        print(f"\n== 5. {RP_DOMAIN}/.well-known/apple-app-site-association")
        well_known(client, stamp)

        print("\n== 6. the web app")
        if "--no-web" in sys.argv:
            print("   skipped (--no-web)")
        else:
            web_app(client, stamp)

        print("\n== 7. checks")
        time.sleep(6)
        ok = checks()
        print(f"\n{'OK' if ok else 'CHECK THE LINES MARKED BAD'}")
        if not ok:
            sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
