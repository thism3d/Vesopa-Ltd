"""Switch on Continue with Vesopa for the vesopasoftware.com client area.

    python tool/deploy_client_area_vesopa_connect.py            # check only: show what it would do
    python tool/deploy_client_area_vesopa_connect.py --apply    # do it

Ships the commit that added Continue with Vesopa to vesopasoftware.com/portal
(vesopasoftware/server/routes/vesopa-sso.js) and anything after it that
touches the same files. With --apply, in order, stopping at the first failure:

  1. BACKUP of the live vesopasoftware.com app (no node_modules, uploads or
     logs; .env included) in /home/vesopasoftware/backups/.
  2. AUTH SERVER: uploads vesopa_auth/schema/schema_026_vesopasoftware_portal_client.sql
     into auth.vesopa.com's schema/ folder and applies it to
     vesopasoftware_authdb with `mariadb`, as root, exactly as schema_024 was
     applied (deploy/2026-09-22-vesopa-admin-oauth/remote-deploy.sh). It is
     re-runnable. auth.vesopa.com itself is NOT restarted: no code changed.
  3. SECRET: only if VESOPA_AUTH_CLIENT_SECRET is not already in
     vesopasoftware.com's .env, mints one with
         node scripts/mint-client-secret.js vesopasoftware-portal <file>
     in the auth app's folder, AS THE USER THAT OWNS IT, into a 0600 file in
     a fresh private temp folder. Writes VESOPA_AUTH_CLIENT_ID,
     VESOPA_AUTH_CLIENT_SECRET, VESOPA_AUTH_ISSUER and VESOPA_AUTH_REDIRECT_URI
     into /home/vesopasoftware/web/vesopasoftware.com/private/nodeapp/.env.
     The secret is never printed, never on a command line (`ps` would show it
     to every service on the box), and the temp file is deleted once the .env
     holds it. The client id comes from the auth database.
  4. CODE: the changed vesopasoftware/ files only (from git; .env is never
     sent), chown to vesopasoftware, runs server/test/vesopa-sso.test.js on the
     server (the OIDC client and the sign-in templates) BEFORE restarting, then
     `pm2 restart vesopasoftware.com` as vesopasoftware — never `restart all`,
     never --update-env. The boot migration adds users.vesopa_sub and
     users.vesopa_linked_at.
  5. SMOKE: https://vesopasoftware.com/portal/login draws the Continue with
     Vesopa button, /portal/auth/vesopa/start answers 303 to
     https://auth.vesopa.com/oauth/authorize with this client's id and the
     registered redirect URI, and auth.vesopa.com accepts that request.

Registered redirect URI (the live site is the bare domain, no www):
    https://vesopasoftware.com/portal/auth/vesopa/callback
Post-logout URI:
    https://vesopasoftware.com/portal/login

Credentials: VESOPA_SSH_PASSWORD from .env.claude-tools, exactly like
tool/auth_ssh.py, or else from .env.claude (this checkout, or the main checkout
when run from a worktree) — the same as tool/deploy_websites_cookie_notice.py.
Only the host is overridden (the Cloud box, 34.63.118.67).

TO TURN IT OFF: delete the VESOPA_AUTH_CLIENT_ID and VESOPA_AUTH_CLIENT_SECRET
lines from the .env and `pm2 restart vesopasoftware.com` as vesopasoftware. The
button disappears and the routes answer 404; password sign-in never changed.
To roll the code back: tar -xzf /home/vesopasoftware/backups/<file>.tgz -C <app dir>
then the same restart.
"""
import pathlib
import re
import posixpath
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".claude" / "skills" / "vesopa-ops" / "scripts"))

import vesopa_ssh  # noqa: E402

HOST = "root@34.63.118.67"
USER = "vesopasoftware"
BASE_COMMIT = "3c56816"  # main before Continue with Vesopa reached the client area
BACKUPS = f"/home/{USER}/backups"
PM2 = f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 {{}}'"

DOMAIN = "vesopasoftware.com"
FOLDER = "vesopasoftware"
APP = f"/home/{USER}/web/{DOMAIN}/private/nodeapp"
ENV_FILE = f"{APP}/.env"
AUTH_APP = f"/home/{USER}/web/auth.vesopa.com/private/nodeapp"
AUTH_DB = "vesopasoftware_authdb"
SLUG = "vesopasoftware-portal"
SCHEMA = "vesopa_auth/schema/schema_026_vesopasoftware_portal_client.sql"
ISSUER = "https://auth.vesopa.com"
CALLBACK = "https://vesopasoftware.com/portal/auth/vesopa/callback"
LOGOUT = "https://vesopasoftware.com/portal/login"
NODE = "PATH=/opt/nodejs/24/bin:$PATH"

_settings = vesopa_ssh.settings


def _env_claude():
    """VESOPA_SSH_PASSWORD from a gitignored .env.claude, when .env.claude-tools
    is not there. Looks in this checkout and, from a git worktree, in the main
    checkout it belongs to."""
    roots = [ROOT]
    try:
        common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT,
                                capture_output=True, text=True, check=True).stdout.strip()
        roots.append((ROOT / common).resolve().parent)
    except Exception:  # noqa: BLE001
        pass
    for root in roots:
        f = pathlib.Path(root) / ".env.claude"
        if not f.is_file():
            continue
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.strip() == "VESOPA_SSH_PASSWORD":
                return value.strip().strip("'\"")
    return None


def settings():
    try:
        values = _settings()
    except SystemExit:
        values = {}
    if not values.get("VESOPA_SSH_PASSWORD"):
        pw = _env_claude()
        if pw:
            values["VESOPA_SSH_PASSWORD"] = pw
    values["VESOPA_SSH_HOST"] = HOST
    return values


vesopa_ssh.settings = settings


def changed_files(folder):
    out = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=AM", f"{BASE_COMMIT}..HEAD", "--", folder],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split()
    keep = []
    for f in out:
        name = posixpath.basename(f)
        if name.startswith(".env") or "/node_modules/" in f:
            continue
        keep.append(f)
    return keep


def sh(client, command, quiet=False):
    stdin, stdout, stderr = client.exec_command(command, timeout=900)
    stdin.close()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    status = stdout.channel.recv_exit_status()
    if not quiet and out.strip():
        print("    " + out.strip().replace("\n", "\n    "))
    if err.strip() and status != 0:
        print("    ! " + err.strip().replace("\n", "\n    ! "))
    return status, out


def sql(query):
    """A read-only query against the auth database, as root over the socket."""
    q = query.replace('"', '\\"')
    return f'$(command -v mariadb || command -v mysql) -N {AUTH_DB} -e "{q}"'


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401
        return None


def fetch(url, follow=True):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 vesopa-deploy-check"})
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace"), r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace"), url


# The remote half of step 3. No secret is in this text: it reads the minted
# file on the box and writes the .env with shell builtins (printf), so the
# value never appears in a process list, and it never echoes it.
ENV_SCRIPT = r"""#!/bin/bash
set -euo pipefail
AUTH="__AUTH__"; ENVF="__ENVF__"; SLUG="__SLUG__"; DB="__DB__"
DBCLI=$(command -v mariadb || command -v mysql)
[ -f "$ENVF" ] || { echo "! $ENVF is missing; refusing to create one"; exit 1; }
CLIENT_ID=$("$DBCLI" -N "$DB" -e "SELECT client_id FROM applications WHERE slug='$SLUG' AND deleted_at IS NULL LIMIT 1")
[ -n "$CLIENT_ID" ] || { echo "! no $SLUG client in $DB; the schema did not apply"; exit 1; }

set_env() { # name value: replace or append; printf is a builtin, so not in ps
  local name=$1 value=$2
  if grep -qE "^$name=" "$ENVF"; then sed -i "/^$name=/d" "$ENVF"; fi
  printf '%s=%s\n' "$name" "$value" >> "$ENVF"
}

if grep -qE '^VESOPA_AUTH_CLIENT_SECRET=.+' "$ENVF"; then
  echo "secret: already in .env, not minted again"
else
  OWNER=$(stat -c %U "$AUTH")
  DIR=$(su - "$OWNER" -c 'mktemp -d')
  FILE="$DIR/$SLUG.secret"
  echo "secret: minting as $OWNER into a 0600 file"
  su - "$OWNER" -c "cd '$AUTH' && __NODE__ node scripts/mint-client-secret.js '$SLUG' '$FILE'"
  [ -s "$FILE" ] || { echo "! the mint wrote nothing; .env unchanged"; rm -rf "$DIR"; exit 1; }
  MINTED_ID=$(sed -n 1p "$FILE" | tr -d '\r\n')
  if [ "$MINTED_ID" != "$CLIENT_ID" ]; then
    echo "! the minted secret is for $MINTED_ID, not $CLIENT_ID; left in $FILE"; exit 1
  fi
  SECRET=$(sed -n 2p "$FILE" | tr -d '\r\n')
  [ -n "$SECRET" ] || { echo "! no secret in the minted file; left in $FILE"; exit 1; }
  set_env VESOPA_AUTH_CLIENT_SECRET "$SECRET"
  unset SECRET
  if grep -qE '^VESOPA_AUTH_CLIENT_SECRET=.+' "$ENVF"; then
    rm -rf "$DIR"
    echo "secret: written to .env; temp file deleted"
  else
    echo "! .env does not hold the secret; the minted file is kept at $FILE"; exit 1
  fi
fi

set_env VESOPA_AUTH_CLIENT_ID "$CLIENT_ID"
set_env VESOPA_AUTH_ISSUER "__ISSUER__"
set_env VESOPA_AUTH_REDIRECT_URI "__CALLBACK__"
chown __USER__:__USER__ "$ENVF"
chmod 600 "$ENVF"
echo "env: VESOPA_AUTH_CLIENT_ID=${CLIENT_ID:0:8}... ISSUER, REDIRECT_URI set (600, __USER__)"
"""


def env_script():
    s = ENV_SCRIPT
    for k, v in {
        "__AUTH__": AUTH_APP, "__ENVF__": ENV_FILE, "__SLUG__": SLUG, "__DB__": AUTH_DB,
        "__NODE__": NODE, "__ISSUER__": ISSUER, "__CALLBACK__": CALLBACK, "__USER__": USER,
    }.items():
        s = s.replace(k, v)
    return s


def report_state(client):
    """Read-only: what is on the box now. Never prints a secret."""
    print("\n== auth.vesopa.com client")
    status, out = sh(client, sql(
        f"SELECT client_id, client_type, is_first_party, show_consent, allow_self_enroll, auth_policy "
        f"FROM applications WHERE slug='{SLUG}' AND deleted_at IS NULL"), quiet=True)
    row = out.strip().split("\t") if out.strip() else []
    if status != 0:
        print("   ! could not read the auth database")
    elif not row:
        print(f"   {SLUG}: not registered yet (schema_026 will add it)")
    else:
        print(f"   {SLUG}: client {row[0][:8]}..., type {row[1]}, first-party {row[2]}, "
              f"consent {row[3]}, self-enrol {row[4]}, {row[5]}")
        _, uris = sh(client, sql(
            "SELECT CONCAT(r.kind, ' ', r.uri) FROM application_redirect_uris r "
            f"JOIN applications a ON a.id = r.application_id WHERE a.slug='{SLUG}'"), quiet=True)
        for line in uris.strip().splitlines():
            print(f"   {line}")
    print("\n== vesopasoftware.com .env (names only)")
    for name in ("VESOPA_AUTH_CLIENT_ID", "VESOPA_AUTH_CLIENT_SECRET", "VESOPA_AUTH_ISSUER", "VESOPA_AUTH_REDIRECT_URI"):
        st, _ = sh(client, f"grep -qE '^{name}=.+' {ENV_FILE}", quiet=True)
        print(f"   {name}: {'set' if st == 0 else 'not set'}")
    _, base = sh(client, f"grep -E '^BASE_URL=' {ENV_FILE} | head -1", quiet=True)
    print(f"   {base.strip() or 'BASE_URL not set'}")
    return row[0] if row else None


def smoke(client_id):
    ok = True
    print("\n== smoke checks")
    try:
        code, _, body, _ = fetch(f"https://{DOMAIN}/portal/login")
        good = code == 200 and "Continue with Vesopa" in body and 'href="/portal/auth/vesopa/start' in body
    except Exception as e:  # noqa: BLE001
        code, good = str(e), False
    print(f"   {'ok ' if good else 'BAD'} /portal/login -> {code}, Continue with Vesopa button {'present' if good else 'MISSING'}")
    ok &= good

    authorize = None
    try:
        code, headers, _, _ = fetch(f"https://{DOMAIN}/portal/auth/vesopa/start", follow=False)
        location = headers.get("Location") or headers.get("location") or ""
        parsed = urllib.parse.urlparse(location)
        params = urllib.parse.parse_qs(parsed.query)
        good = (code == 303
                and f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == f"{ISSUER}/oauth/authorize"
                and params.get("redirect_uri") == [CALLBACK]
                and (client_id is None or params.get("client_id") == [client_id])
                and params.get("code_challenge_method") == ["S256"])
        authorize = location if good else None
        print(f"   {'ok ' if good else 'BAD'} /portal/auth/vesopa/start -> {code} {location[:90]}{'...' if len(location) > 90 else ''}")
    except Exception as e:  # noqa: BLE001
        good = False
        print(f"   BAD /portal/auth/vesopa/start -> {e}")
    ok &= good

    if authorize:
        # auth.vesopa.com must accept the request: an unknown client or an
        # unregistered redirect URI is a 400 page there, and any other
        # refusal is a redirect straight back to our callback with ?error=.
        # Accepted means we are left on an auth.vesopa.com sign-in page.
        try:
            code, _, _, final = fetch(authorize)
            good = code < 400 and urllib.parse.urlparse(final).netloc == urllib.parse.urlparse(ISSUER).netloc
            print(f"   {'ok ' if good else 'BAD'} auth.vesopa.com authorize -> {code} {final[:80]}")
        except Exception as e:  # noqa: BLE001
            good = False
            print(f"   BAD auth.vesopa.com authorize -> {e}")
        ok &= good
    return ok


def main():
    apply = "--apply" in sys.argv
    files = changed_files(FOLDER)
    print(f"Continue with Vesopa for {DOMAIN}/portal  ({'APPLY' if apply else 'check only; --apply to do it'})")
    print(f"   redirect URI {CALLBACK}")
    print(f"   logout URI   {LOGOUT}")
    print(f"\n== {len(files)} changed files from {FOLDER}/ since {BASE_COMMIT}")
    for f in files:
        print("   " + f)

    client = vesopa_ssh.connect()
    try:
        for path in (APP, AUTH_APP):
            st, _ = sh(client, f"test -d {path}", quiet=True)
            if st != 0:
                raise SystemExit(f"! {path} does not exist on the server; nothing was changed")
        st, _ = sh(client, f"test -f {ENV_FILE}", quiet=True)
        if st != 0:
            raise SystemExit(f"! {ENV_FILE} does not exist; nothing was changed")

        client_id = report_state(client)

        if not apply:
            print("\nCheck only. Live page now:")
            smoke(client_id)
            print("\nRun again with --apply to do it.")
            return

        # 1. backup
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = f"{BACKUPS}/{DOMAIN}-{stamp}.tgz"
        print(f"\n== 1. backup")
        st, _ = sh(client, (
            f"mkdir -p {BACKUPS} && tar -czf {backup} -C {APP} "
            "--exclude=./node_modules --exclude=./uploads --exclude=./logs --exclude=./backup "
            "--exclude=./site/assets/video_frames . && chmod 600 " + backup +
            " && ls -lh " + backup + " | awk '{print $5}'"
        ))
        if st != 0:
            raise SystemExit("! backup failed; nothing was changed")
        print(f"   {backup}")

        # 2. auth schema
        print("\n== 2. auth.vesopa.com: schema_026")
        remote_schema = f"{AUTH_APP}/schema/{posixpath.basename(SCHEMA)}"
        sftp = client.open_sftp()
        try:
            sftp.put(str(ROOT / SCHEMA), remote_schema)
        finally:
            sftp.close()
        sh(client, f"chown {USER}:{USER} {remote_schema}", quiet=True)
        st, _ = sh(client, f'$(command -v mariadb || command -v mysql) {AUTH_DB} < {remote_schema} && echo "   applied"')
        if st != 0:
            raise SystemExit("! schema_026 failed; vesopasoftware.com was not changed")
        client_id = report_state(client)
        if not client_id:
            raise SystemExit("! the client is not there after the schema; stopping")

        # 3. secret + .env
        print("\n== 3. client secret and .env")
        script = f"/root/.vesopa-portal-env-{stamp}.sh"
        sftp = client.open_sftp()
        try:
            with sftp.open(script, "w") as fh:
                fh.write(env_script())
            sftp.chmod(script, 0o700)
        finally:
            sftp.close()
        st, _ = sh(client, f"bash {script}; rc=$?; rm -f {script}; exit $rc")
        if st != 0:
            raise SystemExit("! .env was not completed; vesopasoftware.com code was not changed or restarted")

        # 4. code
        print(f"\n== 4. code ({len(files)} files)")
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

        st, out = sh(client, f"su - {USER} -c 'cd {APP} && {NODE} node --test --test-reporter=tap server/test/vesopa-sso.test.js 2>&1 | tail -12'", quiet=True)
        # TAP prints "# fail 0"; Node's default reporter prints "ℹ fail 0".
        # Accept either, so the server's Node version cannot fail a green run.
        if not re.search(r"^\s*(#|ℹ) fail 0\s*$", out, re.M):
            print("    " + out.strip().replace("\n", "\n    "))
            raise SystemExit(
                "! REFUSING TO RESTART: the sign-in tests failed on the server. The previous version is still "
                f"running. Roll the files back with: tar -xzf {backup} -C {APP}")
        print("   server/test/vesopa-sso.test.js passes on the server")

        st, _ = sh(client, PM2.format(f"restart {DOMAIN}") + " >/dev/null && echo '   restarted'")
        if st != 0:
            raise SystemExit(f"! pm2 restart failed — roll back with: tar -xzf {backup} -C {APP}")
        time.sleep(5)
        sh(client, f"su - {USER} -c 'PM2_HOME=/home/{USER}/.pm2 pm2 logs {DOMAIN} --nostream --lines 15 2>&1' "
                   "| grep -E 'vesopa-sign-in|users\\.vesopa|Error' | tail -5")

        # 5. smoke
        ok = smoke(client_id)
        print(f"\n{'OK' if ok else 'FAILED'}: Continue with Vesopa on {DOMAIN}/portal")
        if not ok:
            print(f"   To switch it off: remove VESOPA_AUTH_CLIENT_ID/SECRET from {ENV_FILE} and restart.")
            print(f"   To roll the code back: tar -xzf {backup} -C {APP}, then restart.")
            sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
