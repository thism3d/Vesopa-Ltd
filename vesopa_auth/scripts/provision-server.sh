#!/usr/bin/env bash
#
# Provision auth.vesopa.com on the Hestia box (panel.vesopa.com, 34.63.118.67).
#
# Runs AS ROOT on the server. Idempotent: every step checks before it acts, so
# this can be re-run after a change without destroying anything that already
# works. Re-runnability is not a nicety here — the deploy applies it every time.
#
#   bash provision-server.sh
#
# WHAT THIS DELIBERATELY DOES NOT DO
#
# It never calls `v-add-nodejs-app`. That command regenerates the domain's .env
# with a two-line stub, and on the sibling app it has wiped a 57-setting file and
# left the process crash-looping on a missing DB_USER. The nginx side of what it
# would do is done here by hand instead: switch the domain to the NodeJS template
# and write nodeapp.conf with our port.
#
set -euo pipefail

APP_USER="vesopasoftware"
DOMAIN="auth.vesopa.com"
PORT="20003"
APP_DIR="/home/$APP_USER/web/$DOMAIN/private/nodeapp"
CONF_DIR="/home/$APP_USER/conf/web/$DOMAIN"

DB_NAME_SHORT="authdb"
DB_USER_SHORT="authuser"
DB_FULL="${APP_USER}_${DB_NAME_SHORT}"
DB_USER_FULL="${APP_USER}_${DB_USER_SHORT}"

export PATH="$PATH:/usr/local/hestia/bin"

say() { echo "▶ $*"; }
ok()  { echo "  ✓ $*"; }

# The one secret this script needs, passed in rather than written down here.
: "${VESOPA_AUTH_DB_PASSWORD:?VESOPA_AUTH_DB_PASSWORD must be set}"
: "${VESOPA_AUTH_MAIL_PASSWORD:?VESOPA_AUTH_MAIL_PASSWORD must be set}"

# ---------------------------------------------------------------------------
# 1. nginx: the NodeJS template, and the port include it reads
# ---------------------------------------------------------------------------
# It is the PROXY template that has to become NodeJS, not the web template.
#
# Apache is the backend on this box and nginx sits in front of it, so
# `/usr/local/hestia/data/templates/web/nginx/NodeJS.tpl` is a *proxy* template
# and `v-change-web-domain-tpl` cannot see it — it answers "NodeJS web template
# doesn't exist", which reads like a missing file and is a wrong command.
# The live sibling cloud.vesopa.com is TEMPLATE default / PROXY NodeJS.
#
# The empty extension list is deliberate and matches cloud.vesopa.com: with no
# static extensions, nginx hands EVERY path to the Node app. Leaving Hestia's
# default list in place would let nginx answer /assets/… and /favicon.ico itself
# out of an empty public_html, so the app's own branding would 404 while every
# other route worked.
say "proxy template for $DOMAIN"
if v-list-web-domain "$APP_USER" "$DOMAIN" 2>/dev/null | grep -q '^PROXY: *NodeJS'; then
  ok "already NodeJS"
else
  v-change-web-domain-proxy-tpl "$APP_USER" "$DOMAIN" NodeJS ''
  ok "proxy template switched to NodeJS"
fi

say "nodeapp.conf -> 127.0.0.1:$PORT"
mkdir -p "$CONF_DIR"
cat > "$CONF_DIR/nodeapp.conf" <<CONF
location / {
	proxy_pass http://127.0.0.1:$PORT;
	proxy_http_version 1.1;
	proxy_set_header Upgrade \$http_upgrade;
	proxy_set_header Connection \$connection_upgrade;
	proxy_set_header Host \$host;
	proxy_set_header X-Real-IP \$remote_addr;
	proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
	proxy_set_header X-Forwarded-Proto \$scheme;
	proxy_cache_bypass \$http_upgrade;
	proxy_read_timeout 300s;
}
CONF
ok "written"

# ---------------------------------------------------------------------------
# 2. Application directory
# ---------------------------------------------------------------------------
say "application directory"
mkdir -p "$APP_DIR/logs"
chown -R "$APP_USER:$APP_USER" "/home/$APP_USER/web/$DOMAIN/private"
ok "$APP_DIR"

# ---------------------------------------------------------------------------
# 3. Database
# ---------------------------------------------------------------------------
say "database $DB_FULL"
if v-list-databases "$APP_USER" plain 2>/dev/null | cut -f1 | grep -qx "$DB_FULL"; then
  ok "exists"
  # Keep the password in step with .env even on a re-run.
  v-change-database-password "$APP_USER" "$DB_FULL" "$VESOPA_AUTH_DB_PASSWORD" >/dev/null
  ok "password synchronised"
else
  v-add-database "$APP_USER" "$DB_NAME_SHORT" "$DB_USER_SHORT" \
    "$VESOPA_AUTH_DB_PASSWORD" mysql localhost >/dev/null
  ok "created with user $DB_USER_FULL"
fi

# utf8mb4_general_ci, matching every other Vesopa database on purpose.
#
# On this MariaDB a bare `utf8mb4` resolves to `uca1400_ai_ci`, which does not
# compare against `general_ci` — an email column left to the default joins fine
# on a dev machine and silently matches nothing in production. Pinning the
# database default here, and the collation on every column in schema.sql, is
# what stops that. utf8mb4 rather than utf8 because a 3-byte column truncates an
# emoji in a display name into a 500.
mysql -e "ALTER DATABASE \`$DB_FULL\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
ok "utf8mb4_general_ci"

# ---------------------------------------------------------------------------
# 4. Mail accounts
# ---------------------------------------------------------------------------
# no-reply@vesopa.com already exists and is the SPF-verified sender registered
# with Apple for the private-relay service, so it is the From: for every code
# and notification this system sends. account@vesopa.com is the second address
# registered with Apple; info@vesopasoftware.com is the administrator's own.
add_mail() {
  local domain="$1" account="$2"
  if v-list-mail-accounts "$APP_USER" "$domain" plain 2>/dev/null | cut -f1 | grep -qx "$account"; then
    ok "$account@$domain exists"
  else
    v-add-mail-account "$APP_USER" "$domain" "$account" "$VESOPA_AUTH_MAIL_PASSWORD" >/dev/null
    ok "$account@$domain created"
  fi
}

say "mail accounts"
add_mail vesopa.com no-reply
add_mail vesopa.com account
add_mail vesopasoftware.com info

# ---------------------------------------------------------------------------
# 5. Rebuild and reload
# ---------------------------------------------------------------------------
# `v-change-web-domain-tpl` already regenerated this domain's config, so there is
# no rebuild here on purpose: `v-rebuild-web-domains` rebuilds EVERY domain on
# the account, and cloud.vesopa.com is live on the same account.
say "reload nginx"
nginx -t && systemctl reload nginx
ok "nginx reloaded"

echo
echo "auth.vesopa.com provisioned:"
echo "  app dir   $APP_DIR"
echo "  port      $PORT"
echo "  database  $DB_FULL (user $DB_USER_FULL)"
