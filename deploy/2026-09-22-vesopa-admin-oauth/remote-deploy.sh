#!/usr/bin/env bash
#
# Continue with Vesopa for vesopaepos.com/admin + venues as organisations.
# Runs ON the live box as root, from the uploaded bundle directory.
#
#   bash remote-deploy.sh            deploy, then a DRY RUN of venue provisioning
#   bash remote-deploy.sh --rollback put the replaced files back and restart
#
# GUARDS, in order, each of which stops the deploy with nothing changed:
#   - the files it replaces must still be the ones reviewed (sha256 below);
#   - the files it adds must not already exist;
#   - both apps must be where Hestia put them.
#
# pm2 runs PER HESTIA USER on this box. Everything goes through
# `su - vesopasoftware`; running pm2 as root would start a second copy of each
# app beside the running one and the two would fight over the port.

set -euo pipefail

W=/home/vesopasoftware/web
AUTH=$W/auth.vesopa.com/private/nodeapp
WEB=$W/vesopaepos.com/private/nodeapp
APPUSER=vesopasoftware
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP=$(date +%Y%m%d_%H%M%S)
BK=/root/vesopa-backups/deploy_oauth_admin_$STAMP
SECRET_FILE=/root/vesopa-epos-admin-client.secret

say()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pm2u() { su - "$APPUSER" -c "pm2 $*"; }

REPLACED_AUTH=(src/routes/appapi.js schema/schema.sql)
REPLACED_WEB=(src/admin/index.js src/admin/users.js views/admin/login.ejs public/admin-library/panel.css)
ADDED_AUTH=(src/venues.js schema/schema_024_venue_orgs_and_admin_client.sql test/venues.test.js)
ADDED_WEB=(src/vesopa-oidc.js src/vesopa-venues.js src/admin/vesopa-auth.js schema_admin_vesopa.sql
           scripts/provision-venue-orgs.js test/vesopa-auth.test.js test/vesopa-venues.test.js)

# The live files as they were when this change was written (2026-09-22).
declare -A EXPECT=(
  [auth:src/routes/appapi.js]=a5d8b93cb70fb08b7df71eb2e8ebe2d0cebd6b7ce539210adb6214d7874a5d47
  [auth:schema/schema.sql]=376d2b2902ac19827e9a6452d8b27ec579e4f28769155822a9a1db2cbf432525
  [web:src/admin/index.js]=01bdca9b7a4979f48fa79f8c5a34f89938d7a383964781c085585a87d080cbcc
  [web:src/admin/users.js]=04c45e6eb26f8abc49150f9c55aa69b043ba384a9d7804529b98a7c27413085a
  [web:views/admin/login.ejs]=d44fc995095bdbfec156e8349094b950221cd88b3359b4d01f62fade95497cd9
  [web:public/admin-library/panel.css]=8804611435c2f9d2cca95c230b5fa6153fb7c282919c12d6ea6803698aa7fdfe
)

# ---------------------------------------------------------------- rollback
if [ "${1:-}" = "--rollback" ]; then
  LAST=$(ls -d /root/vesopa-backups/deploy_oauth_admin_* 2>/dev/null | tail -1)
  [ -n "$LAST" ] || die "no deploy backup to roll back to"
  say "Rolling back from $LAST"
  for f in "${REPLACED_AUTH[@]}"; do cp -a "$LAST/auth/$f" "$AUTH/$f"; done
  for f in "${REPLACED_WEB[@]}";  do cp -a "$LAST/web/$f"  "$WEB/$f";  done
  for f in "${ADDED_AUTH[@]}"; do rm -f "$AUTH/$f"; done
  for f in "${ADDED_WEB[@]}";  do rm -f "$WEB/$f";  done
  [ -f "$LAST/web/.env" ] && cp -a "$LAST/web/.env" "$WEB/.env"
  pm2u "restart auth.vesopa.com --update-env" >/dev/null
  pm2u "restart vesopaepos.com --update-env" >/dev/null
  ok "Rolled back. Schema additions are left in place: new nullable columns and an app row, harmless unused."
  exit 0
fi

# ---------------------------------------------------------------- guards
say "Checking the live box is as reviewed"
[ -d "$AUTH" ] && [ -d "$WEB" ] || die "app directories not where expected"
for key in "${!EXPECT[@]}"; do
  app=${key%%:*}; f=${key#*:}; root=$([ "$app" = auth ] && echo "$AUTH" || echo "$WEB")
  got=$(sha256sum "$root/$f" | cut -d' ' -f1)
  [ "$got" = "${EXPECT[$key]}" ] || die "$app/$f changed on the server since this was written — stopping, nothing changed"
done
for f in "${ADDED_AUTH[@]}"; do [ ! -e "$AUTH/$f" ] || die "auth/$f already exists — stopping"; done
for f in "${ADDED_WEB[@]}";  do [ ! -e "$WEB/$f"  ] || die "web/$f already exists — stopping";  done
ok "Live files match; nothing to be added exists yet"

# ---------------------------------------------------------------- backup
say "Backing up what will be replaced → $BK"
mkdir -p "$BK" && chmod 700 "$BK"
for f in "${REPLACED_AUTH[@]}"; do mkdir -p "$BK/auth/$(dirname "$f")"; cp -a "$AUTH/$f" "$BK/auth/$f"; done
for f in "${REPLACED_WEB[@]}";  do mkdir -p "$BK/web/$(dirname "$f")";  cp -a "$WEB/$f"  "$BK/web/$f";  done
cp -a "$WEB/.env" "$BK/web/.env"
mariadb-dump --single-transaction vesopasoftware_authdb organisations applications application_members \
  application_redirect_uris application_roles | gzip > "$BK/authdb-touched-tables.sql.gz"
mariadb-dump --single-transaction vesopasoftware_eposdb admin_table offices | gzip > "$BK/eposdb-touched-tables.sql.gz"
chmod -R go-rwx "$BK"
ok "Backed up"

# ---------------------------------------------------------------- code
say "Installing code"
tar -xzf "$HERE/auth.tgz" -C "$AUTH"
tar -xzf "$HERE/web.tgz"  -C "$WEB"
for f in "${REPLACED_AUTH[@]}" "${ADDED_AUTH[@]}"; do chown "$APPUSER:$APPUSER" "$AUTH/$f"; done
for f in "${REPLACED_WEB[@]}"  "${ADDED_WEB[@]}";  do chown "$APPUSER:$APPUSER" "$WEB/$f";  done
chown "$APPUSER:$APPUSER" "$WEB/scripts" "$WEB/test" 2>/dev/null || true
ok "Code in place"

# ---------------------------------------------------------------- schema
say "Schema: auth (organisations columns, admin client)"
mariadb vesopasoftware_authdb < "$AUTH/schema/schema_024_venue_orgs_and_admin_client.sql"
say "Schema: EPOS (admin_table.vesopa_sub; info@ on the vesopaepos login)"
mariadb vesopasoftware_eposdb < "$WEB/schema_admin_vesopa.sql"
mariadb -t -e "SELECT id, slug, LEFT(client_id,8) cid, is_first_party, allow_self_enroll FROM vesopasoftware_authdb.applications WHERE slug='vesopa-epos-admin';
               SELECT COUNT(*) AS admin_app_members FROM vesopasoftware_authdb.application_members m JOIN vesopasoftware_authdb.applications a ON a.id=m.application_id WHERE a.slug='vesopa-epos-admin';
               SELECT id, username, email, vesopa_sub FROM vesopasoftware_eposdb.admin_table;"
ok "Schema applied"

# ---------------------------------------------------------------- secret + env
if [ ! -f "$SECRET_FILE" ]; then
  say "Minting the admin client secret straight into $SECRET_FILE (0600)"
  (cd "$AUTH" && node scripts/mint-client-secret.js vesopa-epos-admin "$SECRET_FILE")
fi
[ -s "$SECRET_FILE" ] || die "no client secret file"
CLIENT_ID=$(mariadb -N -e "SELECT client_id FROM vesopasoftware_authdb.applications WHERE slug='vesopa-epos-admin'")
[ -n "$CLIENT_ID" ] || die "admin client not found after migration"

say "Writing Vesopa sign-in settings into vesopaepos.com .env (and closing it to other accounts)"
chmod 600 "$WEB/.env"
set_env() { # name value — replace or append, value never on a command line visible to ps
  local name=$1 value=$2
  if grep -qE "^$name=" "$WEB/.env"; then sed -i "/^$name=/d" "$WEB/.env"; fi
  printf '%s=%s\n' "$name" "$value" >> "$WEB/.env"
}
set_env VESOPA_AUTH_ISSUER https://auth.vesopa.com
set_env VESOPA_AUTH_ADMIN_CLIENT_ID "$CLIENT_ID"
# mint-client-secret.js writes TWO lines: the client id, then the secret.
set_env VESOPA_AUTH_ADMIN_CLIENT_SECRET "$(sed -n 2p "$SECRET_FILE" | tr -d '\r\n')"
set_env VESOPA_AUTH_ADMIN_ENABLED on
# Both doors during the soak — the owner's decision. Switch to `on` later.
set_env VESOPA_AUTH_ADMIN_ONLY off
chown "$APPUSER:$APPUSER" "$WEB/.env"
ok ".env updated (client ${CLIENT_ID:0:8}…, secret …$(tail -c 5 "$SECRET_FILE" | tr -d '\n'))"

# ---------------------------------------------------------------- restart
say "Restarting, as $APPUSER"
pm2u "restart auth.vesopa.com --update-env" >/dev/null
pm2u "restart vesopaepos.com --update-env" >/dev/null
sleep 4
pm2u "jlist" | python3 -c '
import sys, json
for p in json.load(sys.stdin):
    if p["name"] in ("auth.vesopa.com", "vesopaepos.com"):
        print("  %-18s %s  restarts=%s" % (p["name"], p["pm2_env"]["status"], p["pm2_env"]["restart_time"]))'

# ---------------------------------------------------------------- checks
say "Health checks"
fail=0
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1"; }
[ "$(code https://auth.vesopa.com/.well-known/openid-configuration)" = 200 ] && ok "auth discovery 200" || { echo "  auth discovery NOT 200"; fail=1; }
[ "$(code https://vesopaepos.com/)" = 200 ] && ok "vesopaepos.com 200" || { echo "  home NOT 200"; fail=1; }
curl -s --max-time 15 https://vesopaepos.com/admin | grep -q 'Continue with Vesopa' && ok "/admin shows Continue with Vesopa" || { echo "  button missing"; fail=1; }
loc=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 https://vesopaepos.com/admin/auth/vesopa/start)
case "$loc" in https://auth.vesopa.com/oauth/authorize?client_id=${CLIENT_ID}*) ok "start → auth.vesopa.com with the admin client";; *) echo "  start went to: $loc"; fail=1;; esac
# A signed-out visitor is sent to /login carrying the authorize request; an
# unknown client or unregistered redirect is RENDERED as an error instead.
authz=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "$loc")
case "$authz" in "303 https://auth.vesopa.com/login?return_to="*"$CLIENT_ID"*) ok "auth accepts the admin client (303 to sign-in)";; *) echo "  authorize answered: ${authz:0:120}"; fail=1;; esac
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' --max-time 15 https://auth.vesopa.com/api/app/venues/provision)" = 401 ] \
  && ok "venue provisioning refuses an unauthenticated call (401)" || { echo "  provision did not answer 401"; fail=1; }

if [ $fail -ne 0 ]; then
  echo; die "A check failed. Roll back with:  bash $HERE/remote-deploy.sh --rollback"
fi

# ---------------------------------------------------------------- phase 2 preview
say "Venues as organisations — DRY RUN (nothing is changed)"
su - "$APPUSER" -c "cd $WEB && node scripts/provision-venue-orgs.js" || true

ok "Deployed. Backup: $BK"
