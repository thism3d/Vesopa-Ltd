#!/usr/bin/env bash
#
# Metric Membership on the Cloud box (metric.vesopa.com). Runs ON the box as
# root, from the directory scripts/deploy.py uploaded (the "bundle").
#
#   bash remote-install.sh              first-time setup if needed, then deploy
#   bash remote-install.sh --check      say what exists and what would be done
#
# IDEMPOTENT: every step checks before it acts, so the same script sets the
# domain up the first time and only ships code after that.
#
# WHAT IT NEVER DOES
#   * overwrite an existing .env (secrets live only on the box)
#   * call v-add-nodejs-app (it rewrites .env as a two-line stub)
#   * restart anything but metric.vesopa.com by name
#   * run pm2 as root (pm2 is per Hestia user; root would start a second daemon)
#
# The bundle holds: server/ (MetricMembership/server without node_modules),
# web_app/ (the Flutter web build), schema_025_metric_client.sql.

set -euo pipefail

DOMAIN=metric.vesopa.com
ZONE=vesopa.com
APPUSER=vesopasoftware
W=/home/$APPUSER/web
APP=$W/$DOMAIN/private/nodeapp
AUTH=$W/auth.vesopa.com/private/nodeapp
PORT=${METRIC_PORT:-5085}
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

[ -d "$HERE/server/src" ] || die "no server/ in the bundle"
[ -d "$AUTH" ] || die "auth.vesopa.com is not at $AUTH"

# ------------------------------------------------------------------ port
if ss -ltn | grep -q ":$PORT "; then
  if ! pm2u "describe $DOMAIN" >/dev/null 2>&1; then
    die "port $PORT is taken by something else -- set METRIC_PORT"
  fi
fi

# ------------------------------------------------------------------ DNS
IP=$(v-list-sys-ips plain 2>/dev/null | awk '{print $1; exit}')
PUBLIC_IP=$(curl -fsS https://api.ipify.org 2>/dev/null || echo "")
if v-list-dns-domains "$APPUSER" plain 2>/dev/null | cut -f1 | grep -qx "$ZONE"; then
  if v-list-dns-records "$APPUSER" "$ZONE" plain | awk -F'\t' '$2=="metric"' | grep -q .; then
    ok "DNS: metric.$ZONE exists"
  else
    say "DNS: adding metric A ${PUBLIC_IP:-$IP} to $ZONE"
    act v-add-dns-record "$APPUSER" "$ZONE" metric A "${PUBLIC_IP:-$IP}"
  fi
else
  warn "DNS: $ZONE is not a zone on this box. Add 'metric A ${PUBLIC_IP:-<this box>}' where vesopa.com's DNS is hosted, then run again."
fi

# ------------------------------------------------------------------ web domain
if v-list-web-domains "$APPUSER" plain | cut -f1 | grep -qx "$DOMAIN"; then
  ok "web domain exists"
else
  say "adding web domain $DOMAIN"
  act v-add-web-domain "$APPUSER" "$DOMAIN" "$IP"
fi

# The proxy template must be NodeJS (vesopa_auth/README.md: it is the PROXY
# template, v-change-web-domain-proxy-tpl), like every app on this box.
if [ $CHECK = 0 ] || v-list-web-domains "$APPUSER" plain | cut -f1 | grep -qx "$DOMAIN"; then
  CUR=$(v-list-web-domain "$APPUSER" "$DOMAIN" shell 2>/dev/null | awk '/^PROXY:/{print $2}')
  if [ "$CUR" != "NodeJS" ]; then
    say "proxy template $CUR -> NodeJS"
    act v-change-web-domain-proxy-tpl "$APPUSER" "$DOMAIN" NodeJS
  fi
fi

# The NodeJS template reads the upstream from a per-domain include,
# /home/<user>/conf/web/<domain>/nodeapp.conf (found on the live box
# 2026-09-27). Model it on auth.vesopa.com's, with our port.
CONF=/home/$APPUSER/conf/web
if [ -f "$CONF/auth.vesopa.com/nodeapp.conf" ]; then
  if ! grep -qs "127.0.0.1:$PORT" "$CONF/$DOMAIN/nodeapp.conf"; then
    say "nginx include $CONF/$DOMAIN/nodeapp.conf -> 127.0.0.1:$PORT"
    if [ $CHECK = 0 ]; then
      mkdir -p "$CONF/$DOMAIN"
      sed -E "s/127\.0\.0\.1:[0-9]+/127.0.0.1:$PORT/g; s/localhost:[0-9]+/127.0.0.1:$PORT/g; s/auth\.vesopa\.com/$DOMAIN/g" \
        "$CONF/auth.vesopa.com/nodeapp.conf" > "$CONF/$DOMAIN/nodeapp.conf"
    fi
  fi
else
  warn "no $CONF/auth.vesopa.com/nodeapp.conf to model the nginx include on: point $DOMAIN at 127.0.0.1:$PORT by hand"
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
DBNAME=${APPUSER}_metricdb
if v-list-databases "$APPUSER" plain | cut -f1 | grep -qx "$DBNAME"; then
  ok "database $DBNAME exists"
  NEWDB=0
else
  say "creating database $DBNAME"
  DBPASS=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 28)
  act v-add-database "$APPUSER" metricdb metricdb "$DBPASS" mysql
  NEWDB=1
fi

# ------------------------------------------------------------------ Vesopa Auth client
set -a; . "$AUTH/.env"; set +a
AUTHDB=(mysql -h"${DB_HOST:-127.0.0.1}" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME")
say "Vesopa Auth: applying schema_025_metric_client.sql (re-runnable)"
if [ $CHECK = 0 ]; then
  cp "$HERE/schema_025_metric_client.sql" "$AUTH/schema/" 2>/dev/null || true
  "${AUTHDB[@]}" < "$HERE/schema_025_metric_client.sql"
fi
CLIENT_ID=$("${AUTHDB[@]}" -N -e "SELECT client_id FROM applications WHERE slug='vesopa-metric'" 2>/dev/null || true)
[ -n "$CLIENT_ID" ] && ok "client id $CLIENT_ID" || warn "no vesopa-metric client yet"
echo "$CLIENT_ID" > "$HERE/client_id.txt"
unset DB_HOST DB_USER DB_PASSWORD DB_NAME DB_PORT

[ $CHECK = 1 ] && { ok "check done: nothing changed"; exit 0; }

# ------------------------------------------------------------------ code
say "shipping code to $APP"
mkdir -p "$APP" "$APP/logs" "$APP/backup"
if [ -f "$APP/.env" ] && [ $NEWDB = 0 ]; then
  set -a; . "$APP/.env"; set +a
  mysqldump --single-transaction -h127.0.0.1 -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" > "$APP/backup/pre_deploy_$STAMP.sql" && ok "database backed up"
fi
LOCK_OLD=$(sha256sum "$APP/package-lock.json" 2>/dev/null | cut -d' ' -f1 || true)
rm -rf "$APP/src" "$APP/public" "$APP/schema" "$APP/web_app.new"
cp -a "$HERE/server/src" "$HERE/server/public" "$HERE/server/schema" "$HERE/server/package.json" "$HERE/server/package-lock.json" "$APP/"
cp -a "$HERE/web_app" "$APP/web_app.new" && rm -rf "$APP/web_app" && mv "$APP/web_app.new" "$APP/web_app"

if [ ! -f "$APP/.env" ]; then
  say "writing .env (first deploy)"
  [ -n "${DBPASS:-}" ] || die "no .env and no new database password: set the .env by hand"
  cat > "$APP/.env" <<ENV
NODE_ENV=production
PORT=$PORT
BASE_URL=https://$DOMAIN
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=$DBNAME
DB_USER=$DBNAME
DB_PASSWORD=$DBPASS
VESOPA_AUTH_ISSUER=https://auth.vesopa.com
VESOPA_METRIC_CLIENT_ID=$CLIENT_ID
SESSION_SECRET=$(openssl rand -hex 32)
METRIC_ADMIN_EMAILS=${METRIC_ADMIN_EMAILS:-info@vesopasoftware.com}
METRIC_AUTO_APPROVE=false
LOG_DIR=$APP/logs
ENV
fi
grep -q '^VESOPA_METRIC_CLIENT_ID=.\+' "$APP/.env" || sed -i "s/^VESOPA_METRIC_CLIENT_ID=.*/VESOPA_METRIC_CLIENT_ID=$CLIENT_ID/" "$APP/.env"
chown -R "$APPUSER:$APPUSER" "$W/$DOMAIN/private"
chmod 600 "$APP/.env"

cd "$APP"
LOCK_NEW=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$LOCK_OLD" != "$LOCK_NEW" ]; then
  say "npm ci"
  su - "$APPUSER" -c "cd $APP && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2"
fi

set -a; . ./.env; set +a
for i in 1 2; do mysql -h127.0.0.1 -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < schema/schema.sql; done
ok "schema applied twice"

if pm2u "describe $DOMAIN" >/dev/null 2>&1; then
  su - "$APPUSER" -c "cd $APP && PORT=$PORT PM2_HOME=/home/$APPUSER/.pm2 pm2 restart $DOMAIN --update-env" >/dev/null && ok "restarted $DOMAIN"
else
  su - "$APPUSER" -c "cd $APP && PORT=$PORT PM2_HOME=/home/$APPUSER/.pm2 pm2 start $APP/src/server.js --name $DOMAIN --cwd $APP --max-memory-restart 300M" >/dev/null && ok "started $DOMAIN"
  pm2u save >/dev/null
fi

v-restart-proxy >/dev/null 2>&1 || systemctl reload nginx || true
sleep 4
curl -fsS "http://127.0.0.1:$PORT/health" && echo
curl -fsS "https://$DOMAIN/health" && echo || warn "https://$DOMAIN/health not answering yet (DNS or certificate)"
ok "done"
