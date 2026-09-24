#!/bin/bash
#
# Create one HestiaCP user package per active plan, from the limits in the
# `plans` table.
#
# WHY THIS EXISTS
#
# `plans.hestia_package` names the package Hestia applies to a new account, and
# `v-add-user` fails outright if that package is not on the node. The failure
# lands AFTER the customer has paid — the payment settles, activateOrder() runs,
# and provisioning throws — so the symptom is a paid order with no hosting
# behind it, which is the single worst way for this to break.
#
# The three shipped plans name `starter`, `business` and `pro`; a fresh Hestia
# has only `system` and `default`. So this has to be run once on any node before
# it takes an order, and again whenever a plan's limits change — the package is
# a copy of those numbers, not a reference to them, and nothing keeps the two in
# step on its own. `npm run check:packages` will tell you when they have drifted.
#
# RUN IT ON THE NODE, as root:
#
#     bash scripts/create-hestia-packages.sh          # create or update
#     bash scripts/create-hestia-packages.sh --dry-run
#
# It is additive and re-runnable: it writes only the packages the plans name,
# and touches no other package, no template and no existing account. Existing
# users on a package are NOT retro-fitted — Hestia needs `v-change-user-package`
# for that, deliberately, because widening a live account's limits is a decision
# rather than a side effect of running a script.
#
set -euo pipefail

HESTIA_BIN=/usr/local/hestia/bin
DB=${DB_NAME:-vesopa_hostingdb}
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# The nameservers customers are handed. Same two the app hands to the registrar
# — see NS1/NS2 in .env. A package carrying the node's own default would put
# somebody else's nameservers on our customers' zones.
NS_PAIR=${NS_PAIR:-ns1.vesopa.com,ns2.vesopa.com}

[ -x "$HESTIA_BIN/v-add-user-package" ] || {
  echo "This has to run on the Hestia node — $HESTIA_BIN/v-add-user-package is not here." >&2
  exit 1
}

# `databases` is a reserved word in MySQL and a column on this table, so it is
# backticked. Bandwidth of 0 in the plans table means unmetered, not zero.
SQL="SELECT hestia_package, websites, storage_gb, bandwidth_gb, \`databases\`, mailboxes, daily_backups
     FROM plans WHERE active = 1 AND hestia_package <> ''"

mysql "$DB" -sN -e "$SQL" | while IFS=$'\t' read -r pkg web storage_gb bw_gb dbs mail backups; do
  [ -n "$pkg" ] || continue

  disk=$(( storage_gb * 1024 ))
  if [ "$bw_gb" -eq 0 ]; then bandwidth='unlimited'; else bandwidth=$(( bw_gb * 1024 )); fi
  # Hestia keeps N rotating backups; daily backups are worth keeping more of.
  if [ "$backups" -eq 1 ]; then keep=3; else keep=1; fi

  echo "$pkg: ${web} site(s), ${storage_gb}GB disk, ${dbs} db, ${mail} mailboxes, ${keep} backups"
  [ "$DRY_RUN" = "1" ] && continue

  tmp=$(mktemp /tmp/hestia-pkg.XXXXXX)

  # SHELL='bash' below is what grants shell access on every plan. Hestia hides
  # the web terminal, and refuses SSH/SFTP-with-shell, for any account whose
  # shell is nologin — so that one field decides whether the Terminal and File
  # Manager entries in the panel do anything for a customer.
  #
  # It is a real widening of the blast radius: a shell can read anything its own
  # user can, run arbitrary binaries, and spend CPU. The account is still
  # confined to its own home by ownership, and v-add-user-ssh-jail can bwrap it
  # further if that becomes necessary. Chosen deliberately, not defaulted into.
  #
  # This comment lives out here rather than inside the heredoc on purpose. The
  # heredoc is UNQUOTED — it has to be, it interpolates $web, $disk and the rest
  # — so backticks inside it are command substitution, not punctuation. An
  # earlier version wrote this note in there with `nologin` and
  # `v-add-user-ssh-jail` in backticks, and the shell duly tried to run both,
  # printing "command not found" and standing ready to splice any real command's
  # output straight into a package definition.
  cat > "$tmp" <<EOF
WEB_TEMPLATE='default'
PROXY_TEMPLATE='default'
BACKEND_TEMPLATE='default'
DNS_TEMPLATE='default'
WEB_DOMAINS='$web'
WEB_ALIASES='unlimited'
DNS_DOMAINS='$web'
DNS_RECORDS='unlimited'
MAIL_DOMAINS='$web'
MAIL_ACCOUNTS='$mail'
RATE_LIMIT='200'
DATABASES='$dbs'
CRON_JOBS='unlimited'
DISK_QUOTA='$disk'
CPU_QUOTA='unlimited'
CPU_QUOTA_PERIOD='unlimited'
MEMORY_LIMIT='unlimited'
SWAP_LIMIT='unlimited'
BANDWIDTH='$bandwidth'
NS='$NS_PAIR'
SHELL='bash'
BACKUPS='$keep'
BACKUPS_INCREMENTAL='no'
TIME='$(date +%H:%M:%S)'
DATE='$(date +%Y-%m-%d)'
EOF

  # The third argument is REWRITE, and it is NOT a "create or update" flag —
  # it selects which precondition is checked. With `yes`, Hestia calls
  # is_package_valid() and refuses a package that does not exist yet; without
  # it, is_package_new() refuses one that does. So the caller has to know which
  # case it is in, and passing `yes` unconditionally fails on a fresh node with
  # "Error: package starter doesn't exist" — which reads like the script asking
  # for something rather than creating it.
  #
  # stdin closed deliberately: this loop is fed by a pipe from mysql, and any
  # child that read stdin would eat the rest of the plan list, leaving the loop
  # to process one row and stop.
  if [ -f "/usr/local/hestia/data/packages/$pkg.pkg" ]; then
    "$HESTIA_BIN/v-add-user-package" "$tmp" "$pkg" yes < /dev/null
    echo "  updated $pkg"
  else
    "$HESTIA_BIN/v-add-user-package" "$tmp" "$pkg" < /dev/null
    echo "  created $pkg"
  fi
  rm -f "$tmp"
done

echo
echo "Packages on the node now:"
"$HESTIA_BIN/v-list-user-packages"
