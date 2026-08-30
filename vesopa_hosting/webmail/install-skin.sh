#!/usr/bin/env bash
#
# Install or refresh the Vesopa Mail skin. Run as root, on the node.
#
#     bash install-skin.sh
#
# Idempotent and safe to re-run: it replaces the skin's stylesheet and
# templates and leaves its images alone, so re-running after a logo change does
# not undo the logo change.
#
# WHAT IT TOUCHES
#
#   /var/lib/roundcube/skins/vesopa/styles/      the stylesheet (new)
#   /var/lib/roundcube/skins/vesopa/templates/   about.html
#
# It does NOT edit /etc/roundcube/config.inc.php — the skin is already selected
# there and forced for every user with $config['dont_override'].
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skin"
RC_DIR="${RC_DIR:-/var/lib/roundcube}"
RC_CONF="${RC_CONF:-/etc/roundcube/config.inc.php}"
SKIN="$RC_DIR/skins/vesopa"
STAMP="$(date +%Y%m%d-%H%M%S)"

BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
step() { echo "${BLU}${BOLD}▶ $*${RST}"; }
ok()   { echo "${GRN}✓ $*${RST}"; }
warn() { echo "${YLW}! $*${RST}"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run this as root."
[ -d "$RC_DIR/skins/elastic" ] || die "No elastic skin at $RC_DIR/skins/elastic — this skin extends it and cannot work without it."
[ -d "$SKIN" ] || die "No vesopa skin at $SKIN. The logos and meta.json live there; this only refreshes styles and templates."

# Own everything the way Roundcube owns its own config. Getting this wrong is
# not loud: an unreadable skin file makes Roundcube fall back to elastic with
# only a line in errors.log to say so.
RC_OWNER="$(stat -c '%U:%G' "$RC_CONF" 2>/dev/null || echo root:www-data)"
RC_USER="${RC_OWNER%%:*}"

step "Backing up what is there"
for f in styles templates; do
  [ -e "$SKIN/$f" ] && cp -a "$SKIN/$f" "$SKIN/$f.bak-$STAMP"
done
ok "kept as *.bak-$STAMP"

step "Installing the stylesheet"
install -d -m 0755 "$SKIN/styles"
# Both names, because Roundcube prefers the minified one outside devel_mode and
# there is no build step here — the file is hand-written and small.
install -m 0644 "$SRC/styles/styles.css" "$SKIN/styles/styles.css"
install -m 0644 "$SRC/styles/styles.min.css" "$SKIN/styles/styles.min.css"
ok "styles.css and styles.min.css"

step "Installing templates"
install -d -m 0755 "$SKIN/templates"
for t in "$SRC"/templates/*.html; do
  [ -e "$t" ] || continue
  install -m 0644 "$t" "$SKIN/templates/$(basename "$t")"
  ok "$(basename "$t")"
done

chown -R "$RC_OWNER" "$SKIN/styles" "$SKIN/templates"

step "Checking Roundcube can read it"
su -s /bin/sh "$RC_USER" -c "head -c 1 '$SKIN/styles/styles.min.css' >/dev/null" 2>/dev/null \
  || die "$RC_USER cannot read the skin. Roundcube would fall back to elastic with only a line in errors.log."
ok "$RC_USER can read the skin"

step "Checking the import resolves"
grep -q 'elastic/styles/styles.min.css' "$SKIN/styles/styles.css" \
  || die "The stylesheet does not import elastic. It would render an unstyled page."
[ -f "$RC_DIR/skins/elastic/styles/styles.min.css" ] \
  || die "elastic/styles/styles.min.css is missing — the import would 404 and the page would be unstyled."
ok "elastic is where the import expects it"

echo
ok "Vesopa Mail skin installed."
warn "Browsers cache CSS hard. Reload webmail with a shift-refresh, or in a"
warn "private window, before deciding whether it worked."
