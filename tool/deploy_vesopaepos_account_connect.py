"""Switch on Continue with Vesopa for vesopaepos.com/account (2026-10-24).

    python tool/deploy_vesopaepos_account_connect.py            # check only
    python tool/deploy_vesopaepos_account_connect.py --apply    # do it

The same routine as tool/deploy_client_area_vesopa_connect.py (whose helpers
it reuses), for the "Vesopa EPOS customer account" application, owned by
info@vesopasoftware.com. With --apply, stopping at the first failure:

  1. BACKUP of vesopaepos.com's .env in /home/vesopasoftware/backups/.
  2. AUTH SERVER: uploads vesopa_auth/schema/schema_028_vesopaepos_account_client.sql
     to auth.vesopa.com's schema/ folder and applies it to vesopasoftware_authdb
     (re-runnable). auth.vesopa.com is not restarted: no code changed.
  3. SECRET: only if VESOPA_AUTH_ACCOUNT_CLIENT_SECRET is not already in
     vesopaepos.com's .env, mints one with scripts/mint-client-secret.js
     vesopaepos-account <file> as the auth app's owner into a 0600 file, and
     writes VESOPA_AUTH_ACCOUNT_CLIENT_ID and _SECRET into the .env. Never
     printed, never on a command line; the temp file is deleted.
  4. RESTART vesopaepos.com by name (--update-env), then SMOKE: /account draws
     the button and /account/auth/vesopa/start answers 302 to auth.vesopa.com
     with this client's id and the registered redirect URI.

TO TURN IT OFF: delete the two VESOPA_AUTH_ACCOUNT_CLIENT_* lines and restart
vesopaepos.com. The button disappears; the emailed sign-in link never changed.
"""
import posixpath
import sys
import time
import urllib.parse

import deploy_client_area_vesopa_connect as portal  # noqa: E402  (ssh settings and helpers)

USER = portal.USER
APP = f"/home/{USER}/web/vesopaepos.com/private/nodeapp"
ENV_FILE = f"{APP}/.env"
AUTH_APP = portal.AUTH_APP
AUTH_DB = portal.AUTH_DB
SLUG = "vesopaepos-account"
SCHEMA = "vesopa_auth/schema/schema_028_vesopaepos_account_client.sql"
CALLBACK = "https://vesopaepos.com/account/auth/vesopa/callback"

ENV_SCRIPT = r"""#!/bin/bash
set -euo pipefail
AUTH="__AUTH__"; ENVF="__ENVF__"; SLUG="__SLUG__"; DB="__DB__"
DBCLI=$(command -v mariadb || command -v mysql)
[ -f "$ENVF" ] || { echo "! $ENVF is missing; refusing to create one"; exit 1; }
CLIENT_ID=$("$DBCLI" -N "$DB" -e "SELECT client_id FROM applications WHERE slug='$SLUG' AND deleted_at IS NULL LIMIT 1")
[ -n "$CLIENT_ID" ] || { echo "! no $SLUG client in $DB; the schema did not apply"; exit 1; }
set_env() { local name=$1 value=$2
  if grep -qE "^$name=" "$ENVF"; then sed -i "/^$name=/d" "$ENVF"; fi
  printf '%s=%s\n' "$name" "$value" >> "$ENVF"; }
if grep -qE '^VESOPA_AUTH_ACCOUNT_CLIENT_SECRET=.+' "$ENVF"; then
  echo "secret: already in .env, not minted again"
else
  OWNER=$(stat -c %U "$AUTH")
  DIR=$(su - "$OWNER" -c 'mktemp -d')
  FILE="$DIR/$SLUG.secret"
  su - "$OWNER" -c "cd '$AUTH' && PATH=/opt/nodejs/24/bin:\$PATH node scripts/mint-client-secret.js '$SLUG' '$FILE'" >/dev/null
  [ -s "$FILE" ] || { echo "! the mint wrote nothing; .env unchanged"; rm -rf "$DIR"; exit 1; }
  MINTED_ID=$(sed -n 1p "$FILE" | tr -d '\r\n')
  [ "$MINTED_ID" = "$CLIENT_ID" ] || { echo "! minted for another client; left in $FILE"; exit 1; }
  SECRET=$(sed -n 2p "$FILE" | tr -d '\r\n')
  [ -n "$SECRET" ] || { echo "! no secret in the minted file; left in $FILE"; exit 1; }
  set_env VESOPA_AUTH_ACCOUNT_CLIENT_SECRET "$SECRET"
  unset SECRET
  grep -qE '^VESOPA_AUTH_ACCOUNT_CLIENT_SECRET=.+' "$ENVF" && rm -rf "$DIR" && echo "secret: minted and written to .env; temp file deleted"
fi
set_env VESOPA_AUTH_ACCOUNT_CLIENT_ID "$CLIENT_ID"
chown __USER__:__USER__ "$ENVF"; chmod 600 "$ENVF"
echo "env: VESOPA_AUTH_ACCOUNT_CLIENT_ID=${CLIENT_ID:0:8}... set"
"""


def main():
    apply = "--apply" in sys.argv
    client = portal.vesopa_ssh.connect()
    try:
        st, out = portal.sh(client, portal.sql(
            f"SELECT client_id, allow_self_enroll, created_by FROM applications WHERE slug='{SLUG}' AND deleted_at IS NULL"), quiet=True)
        print(f"auth client {SLUG}: {'registered ' + out.split()[0][:8] + '...' if out.strip() else 'not registered yet'}")
        st, out = portal.sh(client, f"grep -cE '^VESOPA_AUTH_ACCOUNT_CLIENT_(ID|SECRET)=.+' {ENV_FILE} || true", quiet=True)
        print(f"vesopaepos.com .env: {out.strip()} of 2 settings present")
        if not apply:
            print("\ncheck only: nothing changed. Add --apply.")
            return
        stamp = time.strftime("%Y%m%d-%H%M%S")
        portal.sh(client, f"mkdir -p {portal.BACKUPS} && cp {ENV_FILE} {portal.BACKUPS}/vesopaepos-env-{stamp} && chmod 600 {portal.BACKUPS}/vesopaepos-env-{stamp}", quiet=True)
        print(f"1. backup: {portal.BACKUPS}/vesopaepos-env-{stamp}")
        sftp = client.open_sftp()
        remote_schema = f"{AUTH_APP}/schema/{posixpath.basename(SCHEMA)}"
        sftp.put(str(portal.ROOT / SCHEMA), remote_schema)
        st, _ = portal.sh(client, f"chown {USER}:{USER} {remote_schema} && $(command -v mariadb || command -v mysql) {AUTH_DB} < {remote_schema} && echo '2. schema applied'")
        if st != 0:
            sys.exit("! schema failed; nothing else changed")
        script = ENV_SCRIPT
        for k, v in {"__AUTH__": AUTH_APP, "__ENVF__": ENV_FILE, "__SLUG__": SLUG, "__DB__": AUTH_DB, "__USER__": USER}.items():
            script = script.replace(k, v)
        tmp = f"/root/.acct-connect-{stamp}.sh"
        with sftp.open(tmp, "w") as fh:
            fh.write(script)
        sftp.close()
        st, _ = portal.sh(client, f"chmod 700 {tmp} && bash {tmp}; rc=$?; rm -f {tmp}; exit $rc")
        if st != 0:
            sys.exit("! secret step failed; .env backup kept")
        portal.sh(client, portal.PM2.format("restart vesopaepos.com --update-env") + " >/dev/null && echo '4. vesopaepos.com restarted'")
        _, cid = portal.sh(client, portal.sql(f"SELECT client_id FROM applications WHERE slug='{SLUG}' LIMIT 1"), quiet=True)
        cid = cid.strip()
    finally:
        client.close()
    time.sleep(6)
    code, _, body, _ = portal.fetch("https://vesopaepos.com/account")
    print(f"   /account {code}, button {'shown' if 'Continue with Vesopa' in body else 'MISSING'}")
    code, headers, _, _ = portal.fetch("https://vesopaepos.com/account/auth/vesopa/start", follow=False)
    loc = headers.get("Location") or headers.get("location") or ""
    q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
    ok = code == 302 and loc.startswith("https://auth.vesopa.com/oauth/authorize") and q.get("client_id") == [cid] and q.get("redirect_uri") == [CALLBACK]
    print(f"   start -> {code} {'ok: auth.vesopa.com with this client and redirect' if ok else 'BAD ' + loc[:120]}")
    if ok:
        code, _, body, _ = portal.fetch(loc)
        print(f"   auth.vesopa.com accepts the request: {code}{' (error page)' if 'invalid' in body.lower() and 'client' in body.lower() else ''}")


if __name__ == "__main__":
    main()
