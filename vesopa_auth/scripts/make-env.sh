#!/usr/bin/env bash
#
# Create the live .env if it is missing, generating the four secrets.
#
#   VESOPA_AUTH_DB_PASSWORD=… bash make-env.sh
#
# Idempotent, and idempotent in the way that matters: if .env already exists it
# is LEFT ALONE and only missing keys are appended. Regenerating a secret is not
# a harmless re-run — a new ENCRYPTION_KEY makes every stored TOTP seed and
# every signing key undecryptable, which logs out everyone with an authenticator
# and invalidates every token in flight.
#
# Nothing generated here is ever printed.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"

: "${VESOPA_AUTH_DB_PASSWORD:?VESOPA_AUTH_DB_PASSWORD must be set}"

if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
  echo "▶ created a new .env"
else
  echo "▶ .env exists — filling in only what is missing"
fi
chmod 600 "$ENV_FILE"

# Append `key=value` only when the key is absent. A key that is present but
# empty is treated as absent, because a half-written file is the common case.
set_if_missing() {
  local key="$1" value="$2"
  if grep -qE "^${key}=.+" "$ENV_FILE"; then
    echo "  · $key already set"
  else
    # Remove an empty version of the key first, so the file does not end up
    # with both.
    sed -i "/^${key}=\s*$/d" "$ENV_FILE"
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "  ✓ $key"
  fi
}

set_if_missing NODE_ENV production
set_if_missing PORT 20003
set_if_missing ISSUER https://auth.vesopa.com

set_if_missing DB_HOST 127.0.0.1
set_if_missing DB_PORT 3306
set_if_missing DB_NAME vesopasoftware_authdb
set_if_missing DB_USER vesopasoftware_authuser
set_if_missing DB_PASSWORD "$VESOPA_AUTH_DB_PASSWORD"
set_if_missing DB_POOL 10

set_if_missing CODE_PEPPER      "$(openssl rand -hex 32)"
set_if_missing PASSWORD_PEPPER  "$(openssl rand -hex 32)"
set_if_missing ENCRYPTION_KEY   "$(openssl rand -hex 32)"
set_if_missing SUBJECT_PEPPER   "$(openssl rand -hex 32)"

set_if_missing WEBAUTHN_RP_ID vesopa.com
set_if_missing WEBAUTHN_RP_NAME Vesopa
set_if_missing WEBAUTHN_ORIGINS https://auth.vesopa.com

set_if_missing SESSION_IDLE_HOURS 12
set_if_missing SESSION_ABSOLUTE_DAYS 30
set_if_missing SESSION_REMEMBERED_DAYS 30
set_if_missing DEVICE_TRUST_DAYS 30

set_if_missing SMTP_HOST localhost
set_if_missing SMTP_PORT 587
set_if_missing SMTP_SECURE false
set_if_missing SMTP_USER no-reply@vesopa.com
set_if_missing MAIL_REPLY_TO info@vesopasoftware.com
set_if_missing ADMIN_EMAIL info@vesopasoftware.com

set_if_missing SMS_PROVIDER postcoder
set_if_missing SMS_COUNTRIES GB

echo
echo ".env is at $ENV_FILE (mode 600, owner $(stat -c '%U' "$ENV_FILE"))"
echo "Still to fill in by hand: SMTP_PASSWORD, POSTCODER_API_KEY, and the"
echo "social provider secrets."
