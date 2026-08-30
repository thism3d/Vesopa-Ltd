#!/usr/bin/env bash
#
# Install one-click webmail on a Vesopa Cloud node. Run as root, on the node.
#
#     bash install-sso.sh
#
# It is idempotent: run it again to rotate both secrets. Every file it touches
# is backed up beside itself first, and it refuses to continue if Dovecot would
# not start with what it wrote.
#
# WHAT IT CHANGES, so that this is reviewable before it runs:
#
#   /etc/dovecot/master-users                     created  one master account
#   /etc/dovecot/conf.d/auth-vesopa-master.conf.ext created  the master passdb
#   /etc/dovecot/conf.d/10-auth.conf              edited   one !include line
#   /var/lib/roundcube/plugins/vesopa_sso/        created  the plugin
#   /etc/roundcube/config.inc.php                 edited   adds vesopa_sso to $config['plugins']
#
# The master account can open any mailbox on this node without its password.
# That is the point, and it is why both secrets live in root-owned files and
# nowhere else — not in the database, not in a backup of the panel.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC_DIR="${RC_DIR:-/var/lib/roundcube}"
RC_CONF="${RC_CONF:-/etc/roundcube/config.inc.php}"
DOVECOT_D="${DOVECOT_D:-/etc/dovecot/conf.d}"
MASTER_USER="${MASTER_USER:-vesopasso}"
STAMP="$(date +%Y%m%d-%H%M%S)"

BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
step() { echo "${BLU}${BOLD}▶ $*${RST}"; }
ok()   { echo "${GRN}✓ $*${RST}"; }
warn() { echo "${YLW}! $*${RST}"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run this as root — it edits Dovecot's authentication config."
[ -d "$RC_DIR/plugins" ] || die "No Roundcube at $RC_DIR. Set RC_DIR if it lives elsewhere."
[ -f "$RC_CONF" ] || die "No Roundcube config at $RC_CONF. Set RC_CONF if it lives elsewhere."
command -v doveadm >/dev/null || die "doveadm not found — is Dovecot installed?"

# ---------------------------------------------------------------------------
step "Minting the secrets"
# ---------------------------------------------------------------------------
# Generated here and never transmitted: the key is printed once, for the panel,
# and the master password never leaves this machine at all.
SSO_KEY="$(openssl rand -hex 32)"
MASTER_PASS="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
[ ${#MASTER_PASS} -ge 24 ] || die "Could not generate a master password."
MASTER_HASH="$(doveadm pw -s SHA512-CRYPT -p "$MASTER_PASS")"
ok "Key and master password generated"

# ---------------------------------------------------------------------------
step "Dovecot: the master user"
# ---------------------------------------------------------------------------
[ -f /etc/dovecot/master-users ] && cp -a /etc/dovecot/master-users "/etc/dovecot/master-users.bak-$STAMP"
printf '%s:%s\n' "$MASTER_USER" "$MASTER_HASH" > /etc/dovecot/master-users
chown root:dovecot /etc/dovecot/master-users 2>/dev/null || chown root:root /etc/dovecot/master-users
chmod 640 /etc/dovecot/master-users
ok "/etc/dovecot/master-users"

install -m 0644 "$SRC/auth-vesopa-master.conf.ext" "$DOVECOT_D/auth-vesopa-master.conf.ext"
ok "$DOVECOT_D/auth-vesopa-master.conf.ext"

AUTH_CONF="$DOVECOT_D/10-auth.conf"
cp -a "$AUTH_CONF" "$AUTH_CONF.bak-$STAMP"
if grep -q 'auth-vesopa-master' "$AUTH_CONF"; then
  ok "10-auth.conf already includes it"
else
  # BEFORE the normal passdb. A master passdb is consulted for the
  # authenticating identity and has to be reached first; listed after, it is
  # never tried and every SSO login fails as a plain authentication failure.
  grep -q '^!include auth-passwdfile.conf.ext' "$AUTH_CONF" \
    || die "10-auth.conf does not include auth-passwdfile.conf.ext — this node is not laid out the way we expect. Stopping rather than guessing."
  sed -i 's|^!include auth-passwdfile.conf.ext|!include auth-vesopa-master.conf.ext\n!include auth-passwdfile.conf.ext|' "$AUTH_CONF"
  ok "10-auth.conf includes the master passdb, before the normal one"
fi

step "Checking Dovecot would still start"
doveconf -n >/dev/null 2>&1 || { cp -a "$AUTH_CONF.bak-$STAMP" "$AUTH_CONF"; die "Dovecot rejected the config. Reverted 10-auth.conf; nothing is broken."; }
systemctl restart dovecot
sleep 2
systemctl is-active --quiet dovecot || { cp -a "$AUTH_CONF.bak-$STAMP" "$AUTH_CONF"; systemctl restart dovecot; die "Dovecot did not come back. Reverted and restarted; mail is unaffected."; }
ok "Dovecot restarted and running"

# ---------------------------------------------------------------------------
step "Roundcube: the plugin"
# ---------------------------------------------------------------------------
install -d -m 0755 "$RC_DIR/plugins/vesopa_sso"
install -m 0644 "$SRC/vesopa_sso/vesopa_sso.php" "$RC_DIR/plugins/vesopa_sso/vesopa_sso.php"

# The config holds two secrets that between them open every mailbox, so it is
# readable by the web server and by nobody else.
WEB_GROUP="$(stat -c '%G' "$RC_CONF" 2>/dev/null || echo www-data)"
cat > "$RC_DIR/plugins/vesopa_sso/config.inc.php" <<EOF
<?php
// Written by webmail/install-sso.sh on $(date -Is). Re-run it to rotate.
\$config['vesopa_sso_key'] = '$SSO_KEY';
\$config['vesopa_sso_master_user'] = '$MASTER_USER';
\$config['vesopa_sso_master_pass'] = '$MASTER_PASS';
\$config['vesopa_sso_host'] = 'localhost:143';
EOF
chown "root:$WEB_GROUP" "$RC_DIR/plugins/vesopa_sso/config.inc.php"
chmod 640 "$RC_DIR/plugins/vesopa_sso/config.inc.php"
ok "$RC_DIR/plugins/vesopa_sso/"

php -l "$RC_DIR/plugins/vesopa_sso/vesopa_sso.php" >/dev/null || die "The plugin does not parse."

step "Roundcube: enabling it"
cp -a "$RC_CONF" "$RC_CONF.bak-$STAMP"
if grep -q "'vesopa_sso'" "$RC_CONF" || grep -q '"vesopa_sso"' "$RC_CONF"; then
  ok "already in \$config['plugins']"
else
  # Append to the existing plugins array rather than replacing it: this node's
  # list (password, managesieve and the rest) is Hestia's and must survive.
  php -r '
    $f = $argv[1];
    $s = file_get_contents($f);
    $new = preg_replace(
      "/(\\\$config\\[[\"\x27]plugins[\"\x27]\\]\\s*=\\s*(?:array\\(|\\[))/",
      "$1\"vesopa_sso\", ",
      $s, 1, $n
    );
    if (!$n) { fwrite(STDERR, "could not find the plugins array\n"); exit(1); }
    file_put_contents($f, $new);
  ' "$RC_CONF" || die "Could not add the plugin to $RC_CONF. Add 'vesopa_sso' to \$config['plugins'] by hand."
  php -l "$RC_CONF" >/dev/null || { cp -a "$RC_CONF.bak-$STAMP" "$RC_CONF"; die "Edit broke $RC_CONF. Reverted."; }
  ok "added to \$config['plugins']"
fi

# ---------------------------------------------------------------------------
step "Proving it works"
# ---------------------------------------------------------------------------
# A real master authentication against a real mailbox, before anybody clicks a
# button. `doveadm auth test -M` is the same path Roundcube will take.
PROBE="$(/usr/local/hestia/bin/v-list-mail-domains "$(ls /usr/local/hestia/data/users | head -1)" plain 2>/dev/null | awk 'NR==1{print $1}')" || true
if [ -n "${PROBE:-}" ]; then
  MBOX="$(/usr/local/hestia/bin/v-list-mail-accounts "$(ls /usr/local/hestia/data/users | head -1)" "$PROBE" plain 2>/dev/null | awk 'NR==1{print $1}')" || true
  if [ -n "${MBOX:-}" ]; then
    if doveadm auth test -x service=imap -M "$MASTER_USER" "$MBOX@$PROBE" "$MASTER_PASS" 2>&1 | grep -q 'auth succeeded'; then
      ok "master authentication works — opened $MBOX@$PROBE without its password"
    else
      warn "master authentication did NOT succeed for $MBOX@$PROBE."
      warn "Run it yourself and read the output:"
      warn "  doveadm auth test -x service=imap -M $MASTER_USER $MBOX@$PROBE '<the password below>'"
    fi
  fi
fi

echo
echo "${BOLD}Put this in the panel's .env and restart it:${RST}"
echo
echo "    WEBMAIL_SSO_KEY=$SSO_KEY"
echo
echo "${BOLD}The master password is on this node only, at:${RST}"
echo "    $RC_DIR/plugins/vesopa_sso/config.inc.php"
echo
warn "Without WEBMAIL_SSO_KEY in the panel, nothing is signed, the plugin"
warn "refuses everything, and mailbox links go to the ordinary login page."
