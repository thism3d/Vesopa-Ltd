#!/usr/bin/env bash
#
# Stand up the staging back office, once.
#
#   scp tool/provision-staging.sh root@server:/tmp/ && ssh root@server bash /tmp/provision-staging.sh
#
# After this, staging is deployed by the ordinary deploy:
#
#   VESOPA_TARGET=staging ./deploy.sh --schema
#   VESOPA_TARGET=staging ./deploy.sh --seed-staging
#
# WHAT STAGING IS FOR
#
# "A separate database where we first do anything isolated from the main
# database." A release is run here, against the shapes real venues actually
# have, before a customer's till ever sees it.
#
# WHAT THIS SCRIPT WILL NOT DO
#
# Touch live. It never writes to vesopa_eposdb, never restarts
# vesopa_backoffice, and never edits the live vhost. Every step is guarded and
# every step is idempotent — running it twice is a no-op, which matters because
# the second run is usually somebody checking whether the first one worked.
#
# It does NOT issue the TLS certificate. Hestia does that from its panel (port
# 2083) once the subdomain resolves, and doing it from here would mean this
# script racing Hestia's own nginx config — which is how the box ended up
# serving a dangling symlink and a 502 on 11 September.
set -euo pipefail

DOMAIN="staging.backoffice.vesopaepos.com"
APP_USER="vesopa"
APP_DIR="/home/$APP_USER/web/$DOMAIN/private/nodeapp"
PM2_APP="vesopa_backoffice_staging"
DB_NAME="vesopa_eposdb_staging"
DB_USER="vesopa_staging"
PORT=5061          # live is 5060; these must never collide
LIVE_DIR="/home/$APP_USER/web/backoffice.vesopaepos.com/private/nodeapp"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# ---- Guards ---------------------------------------------------------------

if [[ "$DB_NAME" != *_staging ]]; then
  echo "The staging database name must end in _staging. Refusing." >&2
  exit 1
fi
if [[ ! -d "$LIVE_DIR" ]]; then
  echo "Cannot find the live app at $LIVE_DIR — is this the right server?" >&2
  exit 1
fi

# ---- The database ---------------------------------------------------------

step "Database"
if mysql -N -e "SHOW DATABASES LIKE '$DB_NAME';" | grep -q "$DB_NAME"; then
  note "$DB_NAME already exists — left alone."
else
  # utf8mb4_general_ci to match live. Getting this wrong is the "Illegal mix of
  # collations" that only ever shows up on the server, joining an office column
  # to a customer key.
  mysql -e "CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"
  note "Created $DB_NAME."
fi

if mysql -N -e "SELECT 1 FROM mysql.user WHERE user='$DB_USER';" | grep -q 1; then
  note "User $DB_USER already exists — password left as it is."
else
  DB_PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
  mysql -e "CREATE USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';"
  mysql -e "GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';"
  mysql -e "FLUSH PRIVILEGES;"
  note "Created $DB_USER."
  echo "$DB_PASS" > /root/.vesopa_staging_db_password
  chmod 600 /root/.vesopa_staging_db_password
  note "Its password is in /root/.vesopa_staging_db_password (root only)."
fi

# ---- The app directory ----------------------------------------------------

step "Application directory"
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "/home/$APP_USER/web/$DOMAIN"
note "$APP_DIR ready."

# ---- Its .env -------------------------------------------------------------
#
# Copied from live and then overridden, so staging has every key live has —
# SMTP, Dojo, wallet certificates — without any of them having to be remembered
# and re-entered. The overrides are what make it staging.

step "Environment"
if [[ -f "$APP_DIR/.env" ]]; then
  note ".env already exists — left alone (it may have been edited by hand)."
else
  cp "$LIVE_DIR/.env" "$APP_DIR/.env"

  set_env() {
    local key="$1" value="$2"
    if grep -q "^$key=" "$APP_DIR/.env"; then
      sed -i "s|^$key=.*|$key=$value|" "$APP_DIR/.env"
    else
      echo "$key=$value" >> "$APP_DIR/.env"
    fi
  }

  set_env PORT "$PORT"
  set_env DB_NAME "$DB_NAME"
  set_env DB_USER "$DB_USER"
  if [[ -f /root/.vesopa_staging_db_password ]]; then
    set_env DB_PASSWORD "$(cat /root/.vesopa_staging_db_password)"
  fi
  set_env PUBLIC_URL "https://$DOMAIN"

  # Staging must not be able to reach a real customer or take a real payment.
  # The scrub (tool/scrub-staging.sql) empties the data; these close the doors
  # the data came through.
  set_env SMTP_HOST ""
  set_env DOJO_ENV sandbox
  set_env DOJO_WEBHOOK_SECRET_LIVE ""

  # A different session secret, or a staging token would be a live one.
  set_env JWT_SECRET "$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)"

  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  note "Wrote $APP_DIR/.env (port $PORT, database $DB_NAME, mail off, Dojo sandbox)."
fi

# ---- pm2 ------------------------------------------------------------------

step "pm2"
if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  note "$PM2_APP is already registered — left running."
else
  note "Not started: there is no code here yet."
  note "Deploy it first, which starts it:  VESOPA_TARGET=staging ./deploy.sh --schema"
fi

# ---- What is left for a person --------------------------------------------

step "Still to do, by hand"
cat <<'EOF'
  1. DNS: point staging.backoffice.vesopaepos.com at this server.
  2. Hestia (port 2083): add the web domain, then issue its Let's Encrypt
     certificate. Do this AFTER DNS resolves or the certificate will fail.
  3. Proxy the domain to 127.0.0.1:5061, the same way live proxies to 5060.
  4. Deploy:   VESOPA_TARGET=staging ./deploy.sh --schema
  5. Seed it:  VESOPA_TARGET=staging ./deploy.sh --seed-staging
  6. pm2 save  — so staging comes back after a reboot. This box has
     unattended upgrades switched off, so nothing else will do it for you.
EOF

step "Done"
note "Nothing on live was touched."
