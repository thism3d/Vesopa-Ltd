#!/usr/bin/env bash
#
# admin.vesopa.com on the Cloud box. Runs ON the box as root, from the
# directory `python tool/deploy_memberships.py --admin` uploaded (the "bundle").
#
#   bash remote-install.sh              first-time setup if needed, then deploy
#   bash remote-install.sh --check      say what exists and what would be done
#
# IDEMPOTENT, like MetricMembership/server/scripts/remote-install.sh, which it
# follows step for step: the same script sets the domain up the first time and
# only ships code after that.
#
# It also connects the three apps admin.vesopa.com changes things through:
#   back office  backoffice.vesopaepos.com   ADMIN_SERVICE_KEY  <- EPOS_SERVICE_KEY
#   Gift         gift.vesopaepos.com         ADMIN_SERVICE_KEY  <- GIFT_SERVICE_KEY
#   Hosting      cloud.vesopa.com            ADMIN_SERVICE_KEY  <- HOSTING_SERVICE_KEY
# A key is made once with openssl and written straight into both .env files.
# No key or password is ever printed.
#
# WHAT IT NEVER DOES
#   * overwrite an existing .env, or a key an app already has
#   * call v-add-nodejs-app (it rewrites .env as a two-line stub)
#   * restart anything but the four apps above, each by name
#   * run pm2 as root (pm2 is per Hestia user; root would start a second daemon)
#
# The bundle holds: admin/ (vesopa_admin without node_modules), gift/ (its
# admin API, server.js, admin.js, config.js and Venues page), hosting/ (its
# admin API and server.js), schema_027_admin_console_client.sql.

set -euo pipefail

DOMAIN=admin.vesopa.com
ZONE=vesopa.com
SUB=admin
APPUSER=vesopasoftware
W=/home/$APPUSER/web
APP=$W/$DOMAIN/private/nodeapp
AUTH=$W/auth.vesopa.com/private/nodeapp
BO=$W/backoffice.vesopaepos.com/private/nodeapp
GIFT=$W/gift.vesopaepos.com/private/nodeapp
HOST_APP=$W/cloud.vesopa.com/private/nodeapp
# Its own port under its own name, never PORT (pm2's daemon carries Auth's
# PORT=20003). 5085 is Metric's, 5090 vesopasoftware.com's.
readonly APORT=${ADMIN_CONSOLE_PORT:-5095}
SLUG=vesopa-admin-console
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
export PATH=$PATH:/usr/local/hestia/bin
STAMP=$(date +%Y%m%d_%H%M%S)

say()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pm2u() { su - "$APPUSER" -c "PM2_HOME=/home/$APPUSER/.pm2 pm2 $*"; }
act()  { if [ $CHECK = 1 ]; then warn "would: $*"; else "$@"; fi; }
# One value from an .env file, without sourcing it (sourcing would overwrite
# this script's own variables with another app's).
# A missing key is an empty answer, not a failure (pipefail would stop here).
envget() { { grep -E "^$2=" "$1" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//'; }
# Set KEY=VALUE in an .env: replace an empty line, add a missing one, and leave
# a filled one alone. Prints nothing of the value.
envfill() {
  local file=$1 key=$2 value=$3
  if grep -qE "^$key=.+" "$file"; then return 1; fi
  if grep -qE "^$key=" "$file"; then
    local tmp; tmp=$(mktemp); chmod 600 "$tmp"
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$file" > "$tmp"
    cat "$tmp" > "$file"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
newkey() { openssl rand -hex 32; }
# The port an app's .env names, or its usual one.
portof() { local p; p=$(envget "$1/.env" PORT); echo "${p:-$2}"; }
# mysql as the database user an .env names, from a 0600 file given as
# --defaults-file, so `ps` never shows the password AND root's own ~/.my.cnf is
# not read. MYSQL_PWD was used before and lost to that file: the client took
# root's saved password for the app's user, and every login here was refused
# (2026-10-05, "Access denied for vesopasoftware_admindb@localhost").
sqlas() {
  local f=$1 cmd=$2 cnf rc=0 h; shift 2
  h=$(envget "$f" DB_HOST)
  cnf=$(mktemp); chmod 600 "$cnf"
  printf '[client]\nuser=%s\npassword="%s"\nhost=%s\n' \
    "$(envget "$f" DB_USER)" "$(envget "$f" DB_PASSWORD)" "${h:-127.0.0.1}" > "$cnf"
  "$cmd" --defaults-file="$cnf" "$@" "$(envget "$f" DB_NAME)" || rc=$?
  rm -f "$cnf"
  return $rc
}

[ -d "$HERE/admin/src" ] || die "no admin/ in the bundle"
for d in "$AUTH" "$BO" "$GIFT" "$HOST_APP"; do [ -f "$d/.env" ] || die "no .env at $d"; done

# ------------------------------------------------------------------ port
if ss -ltn | grep -q ":$APORT "; then
  pm2u "describe $DOMAIN" >/dev/null 2>&1 || die "port $APORT is taken by something else -- set ADMIN_CONSOLE_PORT"
fi

# ------------------------------------------------------------------ DNS
IP=$(v-list-sys-ips plain 2>/dev/null | awk '{print $1; exit}')
PUBLIC_IP=$(curl -fsS https://api.ipify.org 2>/dev/null || echo "")
if v-list-dns-domains "$APPUSER" plain 2>/dev/null | cut -f1 | grep -qx "$ZONE"; then
  if v-list-dns-records "$APPUSER" "$ZONE" plain | awk -F'\t' -v s="$SUB" '$2==s' | grep -q .; then
    ok "DNS: $SUB.$ZONE exists"
  else
    say "DNS: adding $SUB A ${PUBLIC_IP:-$IP} to $ZONE"
    act v-add-dns-record "$APPUSER" "$ZONE" "$SUB" A "${PUBLIC_IP:-$IP}"
  fi
else
  warn "DNS: $ZONE is not a zone on this box. Add '$SUB A ${PUBLIC_IP:-<this box>}' where vesopa.com's DNS is hosted, then run again."
fi

# ------------------------------------------------------------------ web domain
if v-list-web-domains "$APPUSER" plain | cut -f1 | grep -qx "$DOMAIN"; then
  ok "web domain exists"
else
  say "adding web domain $DOMAIN"
  act v-add-web-domain "$APPUSER" "$DOMAIN" "$IP"
fi
if [ $CHECK = 0 ] || v-list-web-domains "$APPUSER" plain | cut -f1 | grep -qx "$DOMAIN"; then
  CUR=$(v-list-web-domain "$APPUSER" "$DOMAIN" shell 2>/dev/null | awk '/^PROXY:/{print $2}')
  if [ "$CUR" != "NodeJS" ]; then
    say "proxy template $CUR -> NodeJS"
    act v-change-web-domain-proxy-tpl "$APPUSER" "$DOMAIN" NodeJS
  fi
fi
CONF=/home/$APPUSER/conf/web
if [ -f "$CONF/auth.vesopa.com/nodeapp.conf" ]; then
  if ! grep -qs "127.0.0.1:$APORT" "$CONF/$DOMAIN/nodeapp.conf"; then
    say "nginx include $CONF/$DOMAIN/nodeapp.conf -> 127.0.0.1:$APORT"
    if [ $CHECK = 0 ]; then
      mkdir -p "$CONF/$DOMAIN"
      sed -E "s/127\.0\.0\.1:[0-9]+/127.0.0.1:$APORT/g; s/localhost:[0-9]+/127.0.0.1:$APORT/g; s/auth\.vesopa\.com/$DOMAIN/g" \
        "$CONF/auth.vesopa.com/nodeapp.conf" > "$CONF/$DOMAIN/nodeapp.conf"
    fi
  fi
else
  warn "no $CONF/auth.vesopa.com/nodeapp.conf to model the nginx include on: point $DOMAIN at 127.0.0.1:$APORT by hand"
fi

# ------------------------------------------------------------------ certificate
if [ -z "$(v-list-web-domain "$APPUSER" "$DOMAIN" shell 2>/dev/null | awk '/^SSL:/{print $2}' | grep -i yes)" ]; then
  say "Let's Encrypt certificate (needs the DNS above to resolve here)"
  act v-add-letsencrypt-domain "$APPUSER" "$DOMAIN" "" || warn "certificate not issued yet -- DNS may not have spread; run again later"
  act v-add-web-domain-ssl-force "$APPUSER" "$DOMAIN" || true
else
  ok "certificate present"
fi

# ------------------------------------------------------------------ database
DBNAME=${APPUSER}_admindb
if v-list-databases "$APPUSER" plain | cut -f1 | grep -qx "$DBNAME"; then
  ok "database $DBNAME exists"
  NEWDB=0
  # A database with no .env beside the app is one an earlier run created and
  # then stopped before writing the .env (2026-10-05): nothing can be using it
  # yet, so give its user a new password and let the .env below be written.
  if [ ! -f "$APP/.env" ]; then
    say "database exists but the app has no .env: new password for $DBNAME"
    DBPASS=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 28)
    act v-change-database-password "$APPUSER" "$DBNAME" "$DBPASS"
    NEWDB=1
  fi
else
  say "creating database $DBNAME"
  DBPASS=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 28)
  act v-add-database "$APPUSER" admindb admindb "$DBPASS" mysql
  NEWDB=1
fi

# ------------------------------------------------------------------ Vesopa Auth client
# As root over the socket, the way vesopa_auth/scripts/deploy.py applies its
# own schema: the login in Auth's .env was refused by the mysql client on the
# live box (2026-10-05, "Access denied for vesopasoftware_authuser@localhost").
AUTHDBNAME=$(envget "$AUTH/.env" DB_NAME); AUTHDBNAME=${AUTHDBNAME:-vesopasoftware_authdb}
authsql() { mysql "$@" "$AUTHDBNAME"; }
say "Vesopa Auth: applying schema_027_admin_console_client.sql (re-runnable)"
if [ $CHECK = 0 ]; then
  cp "$HERE/schema_027_admin_console_client.sql" "$AUTH/schema/" 2>/dev/null || true
  authsql < "$HERE/schema_027_admin_console_client.sql"
fi
CLIENT_ID=$(authsql -N -e "SELECT client_id FROM applications WHERE slug='$SLUG' AND deleted_at IS NULL" 2>/dev/null || true)
[ -n "$CLIENT_ID" ] && ok "client id $CLIENT_ID" || warn "no $SLUG client yet"

[ $CHECK = 1 ] && { ok "check done: nothing changed"; exit 0; }
[ -n "$CLIENT_ID" ] || die "the Auth client did not appear -- see the schema output above"

# ------------------------------------------------------------------ code
say "shipping code to $APP"
mkdir -p "$APP" "$APP/logs" "$APP/backup"
if [ -f "$APP/.env" ] && [ $NEWDB = 0 ]; then
  sqlas "$APP/.env" mysqldump --single-transaction > "$APP/backup/pre_deploy_$STAMP.sql" && ok "database backed up"
fi
LOCK_OLD=$(sha256sum "$APP/package-lock.json" 2>/dev/null | cut -d' ' -f1 || true)
rm -rf "$APP/src" "$APP/public" "$APP/schema" "$APP/views" "$APP/scripts"
cp -a "$HERE/admin/src" "$HERE/admin/public" "$HERE/admin/schema" "$HERE/admin/views" "$HERE/admin/scripts" \
  "$HERE/admin/package.json" "$HERE/admin/package-lock.json" "$APP/"

if [ ! -f "$APP/.env" ]; then
  say "writing .env (first deploy)"
  [ -n "${DBPASS:-}" ] || die "no .env and no new database password: set the .env by hand"
  ( umask 077; cat > "$APP/.env" <<ENV
NODE_ENV=production
ADMIN_PORT=$APORT
BASE_URL=https://$DOMAIN
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=$DBNAME
DB_USER=$DBNAME
DB_PASSWORD=$DBPASS
VESOPA_AUTH_ISSUER=https://auth.vesopa.com
VESOPA_AUTH_CLIENT_ID=$CLIENT_ID
VESOPA_AUTH_CLIENT_SECRET=
OWNER_EMAIL=info@vesopasoftware.com
EPOS_API=http://127.0.0.1:$(portof "$BO" 5060)
EPOS_SERVICE_KEY=
GIFT_API=http://127.0.0.1:$(portof "$GIFT" 5070)
GIFT_SERVICE_KEY=
HOSTING_API=http://127.0.0.1:$(portof "$HOST_APP" 5075)
HOSTING_SERVICE_KEY=
ENV
  )
  # Mail through the same relay the back office uses (SMTP2GO). Its From
  # domain must be verified there, or SMTP2GO refuses the message.
  for k in SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD MAIL_FROM; do
    printf '%s=%s\n' "$k" "$(envget "$BO/.env" "$k")" >> "$APP/.env"
  done
fi
grep -qE '^ADMIN_PORT=' "$APP/.env" || echo "ADMIN_PORT=$APORT" >> "$APP/.env"
grep -qE "^VESOPA_AUTH_CLIENT_ID=$CLIENT_ID\$" "$APP/.env" || \
  { sed -i "s/^VESOPA_AUTH_CLIENT_ID=.*/VESOPA_AUTH_CLIENT_ID=$CLIENT_ID/" "$APP/.env"; grep -q '^VESOPA_AUTH_CLIENT_ID=' "$APP/.env" || echo "VESOPA_AUTH_CLIENT_ID=$CLIENT_ID" >> "$APP/.env"; }

# The client secret: minted by Auth's own script straight into a 0600 file,
# then moved into the .env without being printed. Only when the .env has none.
if ! grep -qE '^VESOPA_AUTH_CLIENT_SECRET=.+' "$APP/.env"; then
  SECRET_FILE=/root/$SLUG-client.$STAMP.secret
  say "minting the Auth client secret"
  (cd "$AUTH" && node scripts/mint-client-secret.js "$SLUG" "$SECRET_FILE") | tail -1
  envfill "$APP/.env" VESOPA_AUTH_CLIENT_SECRET "$(sed -n 2p "$SECRET_FILE")" || true
  shred -u "$SECRET_FILE" 2>/dev/null || rm -f "$SECRET_FILE"
  ok "client secret in .env"
fi

# ------------------------------------------------------------------ service keys
# One key per app. When the app already has ADMIN_SERVICE_KEY it is reused, so
# a second run changes nothing; otherwise a new one goes into both files.
RESTART=()
connect() {
  local name=$1 dir=$2 ours=$3 key
  key=$(envget "$dir/.env" ADMIN_SERVICE_KEY)
  if [ -z "$key" ]; then
    key=$(newkey)
    cp -p "$dir/.env" "$dir/.env.pre-admin-$STAMP"
    envfill "$dir/.env" ADMIN_SERVICE_KEY "$key" || true
    RESTART+=("$name")
    ok "$name: new ADMIN_SERVICE_KEY"
  fi
  if [ "$(envget "$APP/.env" "$ours")" != "$key" ]; then
    local tmp; tmp=$(mktemp); chmod 600 "$tmp"
    grep -vE "^$ours=" "$APP/.env" > "$tmp"; printf '%s=%s\n' "$ours" "$key" >> "$tmp"
    cat "$tmp" > "$APP/.env"; rm -f "$tmp"
    ok "admin: $ours matches $name"
  fi
}
connect backoffice.vesopaepos.com "$BO" EPOS_SERVICE_KEY
connect gift.vesopaepos.com "$GIFT" GIFT_SERVICE_KEY
connect cloud.vesopa.com "$HOST_APP" HOSTING_SERVICE_KEY

# Our own Windows installers (Downloads and Versions, 2026-10-05): kept beside
# the app, never inside it, because every deploy replaces the app's folders.
# The secret signs the download addresses devices are given; made once.
mkdir -p "$W/$DOMAIN/private/releases"
envfill "$APP/.env" RELEASES_SECRET "$(newkey)" && ok "admin: new RELEASES_SECRET" || true
chown -R "$APPUSER:$APPUSER" "$W/$DOMAIN/private"
chmod 600 "$APP/.env"

# ------------------------------------------------------------------ Gift and Hosting code
# Only their admin API and the server.js that mounts it. The replaced files are
# kept beside the originals for a roll back.
ship() {
  local name=$1 dir=$2; shift 2
  local changed=0 pair src dst
  for pair in "$@"; do
    src=${pair%%:*}; [[ $src != *.js ]] || node --check "$src" || die "$name: $src does not parse -- nothing of it shipped"
  done
  for pair in "$@"; do
    src=${pair%%:*}; dst=$dir/${pair#*:}
    if ! cmp -s "$src" "$dst"; then
      [ -f "$dst" ] && cp -p "$dst" "$dst.pre-admin-$STAMP"
      install -o "$APPUSER" -g "$APPUSER" -m 0644 "$src" "$dst"
      changed=1
    fi
  done
  if [ $changed = 1 ]; then
    ok "$name: admin API shipped"
    [[ " ${RESTART[*]} " == *" $name "* ]] || RESTART+=("$name")
  fi
}
ship gift.vesopaepos.com "$GIFT" "$HERE/gift/admin_api.js:src/admin_api.js" "$HERE/gift/server.js:src/server.js" \
  "$HERE/gift/admin.js:src/admin.js" "$HERE/gift/config.js:src/config.js" "$HERE/gift/venues.ejs:views/admin/venues.ejs"
ship cloud.vesopa.com "$HOST_APP" "$HERE/hosting/admin_api.js:src/routes/admin_api.js" "$HERE/hosting/server.js:src/server.js"

# Restart by name, without --update-env: the daemon carries Auth's PORT, and
# each app reads its own .env when it starts.
code() { curl -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo "---"; }
# Where each app answers when it is up, to put the old files back if not.
declare -A PROBE=(
  [backoffice.vesopaepos.com]="http://127.0.0.1:$(portof "$BO" 5060)/health"
  [gift.vesopaepos.com]="http://127.0.0.1:$(portof "$GIFT" 5070)/health"
  [cloud.vesopa.com]="http://127.0.0.1:$(portof "$HOST_APP" 5075)/robots.txt"
)
declare -A DIROF=([backoffice.vesopaepos.com]=$BO [gift.vesopaepos.com]=$GIFT [cloud.vesopa.com]=$HOST_APP)
for name in "${RESTART[@]}"; do
  pm2u "restart $name" >/dev/null && ok "restarted $name"
  sleep 4
  c=$(code "${PROBE[$name]}")
  if [[ $c != 2* && $c != 3* ]]; then
    warn "$name answered $c after the restart: putting its old files back"
    dir=${DIROF[$name]}
    find "$dir/src" "$dir/views" "$dir" -maxdepth 3 -name "*.pre-admin-$STAMP" 2>/dev/null | sort -u | while read -r old; do
      cp -p "$old" "${old%.pre-admin-$STAMP}"
    done
    pm2u "restart $name" >/dev/null
    die "$name did not come back with the admin API -- it is back as it was; nothing else was changed after it"
  fi
done

# ------------------------------------------------------------------ the admin app
cd "$APP"
LOCK_NEW=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$LOCK_OLD" != "$LOCK_NEW" ]; then
  say "npm ci"
  su - "$APPUSER" -c "cd $APP && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2"
fi

for i in 1 2; do
  sqlas "$APP/.env" mysql < schema/schema.sql
done
ok "schema applied twice"

if pm2u "describe $DOMAIN" >/dev/null 2>&1; then
  pm2u "restart $DOMAIN" >/dev/null && ok "restarted $DOMAIN"
else
  su - "$APPUSER" -c "cd $APP && PM2_HOME=/home/$APPUSER/.pm2 pm2 start $APP/src/server.js --name $DOMAIN --cwd $APP --max-memory-restart 300M" >/dev/null && ok "started $DOMAIN"
  pm2u save >/dev/null
fi

v-restart-proxy >/dev/null 2>&1 || systemctl reload nginx || true
sleep 5
echo "admin, local health          $(code "http://127.0.0.1:$APORT/healthz")"
echo "admin, https health          $(code "https://$DOMAIN/healthz")"
echo "back office admin, no key    $(code "http://127.0.0.1:$(portof "$BO" 5060)/api/admin/overview") (expect 401)"
echo "gift admin, no key           $(code "http://127.0.0.1:$(portof "$GIFT" 5070)/api/admin/venues") (expect 401)"
echo "hosting admin, no key        $(code "http://127.0.0.1:$(portof "$HOST_APP" 5075)/api/admin/services") (expect 401)"
# The old admin pages point here only once this answers over https, so a
# certificate still on its way never sends anybody to a page that is not there.
if [ "$(code "https://$DOMAIN/healthz")" = "200" ]; then
  for pair in "backoffice.vesopaepos.com:$BO" "gift.vesopaepos.com:$GIFT"; do
    name=${pair%%:*}; dir=${pair#*:}
    if envfill "$dir/.env" ADMIN_CONSOLE_URL "https://$DOMAIN"; then
      pm2u "restart $name" >/dev/null && ok "$name now points its admin pages at $DOMAIN"
    fi
  done
else
  warn "the old admin pages keep working as before until https://$DOMAIN answers; run this again then"
fi
tail -5 "$APP/logs/error-0.log" 2>/dev/null || pm2u "logs $DOMAIN --lines 5 --nostream" 2>/dev/null | tail -8 || true
ok "done"
