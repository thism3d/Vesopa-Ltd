#!/usr/bin/env bash
#
# Vesopa Cloud — the pages a website serves before anybody has written one.
#
#     bash install-site-defaults.sh              # new sites only
#     bash install-site-defaults.sh --existing   # ...and refresh existing ones
#
# WHAT A NEW SITE GETS. Hestia copies a skeleton into every website it creates:
# a "Coming Soon" holding page and four error pages, all of them unbranded grey.
# This replaces that skeleton, so every site made from now on starts as ours.
#
# THE ONE RULE THIS SCRIPT WILL NOT BREAK
# ---------------------------------------
# It never overwrites a website's index.html unless that file is still, byte for
# byte, a default nobody has touched. A customer's home page is the single most
# destructive thing on this machine to get wrong, and "refresh the defaults"
# must never mean "delete somebody's website". Error pages are different — they
# are ours by default and replaced by anyone who wants their own — but even
# those are only touched with --existing.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HESTIA="${HESTIA:-/usr/local/hestia}"
TPL="$HESTIA/data/templates/web"
STAMP="$(date +%Y%m%d-%H%M%S)"
DO_EXISTING=0
[ "${1:-}" = "--existing" ] && DO_EXISTING=1

BOLD=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
step() { echo "${BLU}${BOLD}▶ $*${RST}"; }
ok()   { echo "${GRN}✓ $*${RST}"; }
warn() { echo "${YLW}! $*${RST}"; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run this as root."
[ -d "$TPL/skel/public_html" ] || die "No Hestia web skeleton at $TPL/skel — is this the right machine?"

# ---------------------------------------------------------------------------
step "Backing up Hestia's originals"
# ---------------------------------------------------------------------------
# Kept, and kept USABLE: the checksums of the originals are what lets the
# --existing pass below tell an untouched default from somebody's real website.
BACKUP="$TPL/vesopa-originals"
if [ ! -d "$BACKUP" ]; then
  mkdir -p "$BACKUP"
  cp -a "$TPL/skel" "$BACKUP/skel"
  [ -d "$TPL/suspend" ] && cp -a "$TPL/suspend" "$BACKUP/suspend"
  ok "originals saved to $BACKUP (first run only — not overwritten again)"
else
  ok "originals already saved at $BACKUP"
fi
cp -a "$TPL/skel" "$TPL/skel.bak-$STAMP"

# ---------------------------------------------------------------------------
step "Installing the skeleton a new website gets"
# ---------------------------------------------------------------------------
install -m 0644 "$SRC/public_html/index.html" "$TPL/skel/public_html/index.html"
ok "start page"
for f in "$SRC"/document_errors/*.html; do
  install -m 0644 "$f" "$TPL/skel/document_errors/$(basename "$f")"
  ok "$(basename "$f")"
done

if [ -d "$TPL/suspend" ]; then
  cp -a "$TPL/suspend/index.html" "$TPL/suspend/index.html.bak-$STAMP" 2>/dev/null || true
  install -m 0644 "$SRC/suspend/index.html" "$TPL/suspend/index.html"
  ok "suspended-account page"
fi

# ---------------------------------------------------------------------------
if [ "$DO_EXISTING" = 1 ]; then
  step "Refreshing sites that already exist"
  # The checksums of every index.html Hestia has ever shipped that we have a
  # copy of. A live site whose home page matches one of these has never been
  # touched by its owner and is safe to replace; anything else is somebody's
  # website and is left completely alone.
  KNOWN_DEFAULTS="$(
    { [ -f "$BACKUP/skel/public_html/index.html" ] && md5sum "$BACKUP/skel/public_html/index.html"
      md5sum "$SRC/public_html/index.html"
    } | awk '{print $1}'
  )"

  touched=0; skipped=0; errors=0
  for userdir in /home/*/; do
    user="$(basename "$userdir")"
    [ -d "$HESTIA/data/users/$user" ] || continue
    for site in "$userdir"web/*/; do
      [ -d "$site" ] || continue
      domain="$(basename "$site")"

      # Error pages: ours by default, and replaced by anyone who wants their own.
      if [ -d "$site/document_errors" ]; then
        for f in "$SRC"/document_errors/*.html; do
          install -o "$user" -g "$user" -m 0644 "$f" "$site/document_errors/$(basename "$f")" 2>/dev/null || errors=$((errors+1))
        done
      fi

      # The home page: only if untouched.
      index="$site/public_html/index.html"
      if [ -f "$index" ]; then
        sum="$(md5sum "$index" | awk '{print $1}')"
        if grep -qx "$sum" <<< "$KNOWN_DEFAULTS"; then
          install -o "$user" -g "$user" -m 0644 "$SRC/public_html/index.html" "$index"
          echo "    replaced holding page  $domain"
          touched=$((touched+1))
        else
          skipped=$((skipped+1))
        fi
      fi
    done
  done
  ok "$touched holding pages replaced, $skipped real websites left alone"
  [ "$errors" -gt 0 ] && warn "$errors error-page copies failed — check ownership on those sites"
else
  warn "Existing sites were NOT touched. Re-run with --existing to refresh their"
  warn "error pages and replace holding pages that nobody has edited."
fi

echo
ok "Done. New websites now start as Vesopa Cloud."
echo "  Revert with:  cp -a $BACKUP/skel/. $TPL/skel/"
