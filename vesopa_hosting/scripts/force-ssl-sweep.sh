#!/bin/bash
# Turn force-SSL on for every web domain that has a certificate but is still
# answering on plain HTTP.
#
# Installed on the node as /usr/local/sbin/vesopa-force-ssl-sweep and run daily
# by /etc/cron.d/vesopa-force-ssl. It is the safety net for domains added
# straight in Hestia; domains created through the Vesopa Cloud panel are forced
# at the moment their certificate is issued (src/integrations/hestia.js,
# enableSSL). Run with --dry-run to see what it would change.
#
# The owner's standing instruction (2026-09-17): every Vesopa-hosted domain
# redirects HTTP to HTTPS. Hestia does not do this by itself -- issuing a
# certificate sets SSL='yes' and leaves SSL_FORCE='no' -- so 39 of the 45
# domains on this box were still serving port 80 with no redirect.
#
# The web server is restarted ONCE at the end, not once per domain: passing
# "no" as the third argument defers the restart.
set -uo pipefail

DRY=${1:-}
changed=0
skipped=0
failed=0

for u in $(/usr/local/hestia/bin/v-list-users plain 2>/dev/null | cut -f1); do
  conf="/usr/local/hestia/data/users/$u/web.conf"
  [ -f "$conf" ] || continue
  while IFS= read -r raw; do
    [ -n "$raw" ] || continue
    d=$(printf '%s' "$raw"    | grep -o "DOMAIN='[^']*'"     | head -1 | cut -d"'" -f2)
    ssl=$(printf '%s' "$raw"  | grep -o "SSL='[^']*'"        | head -1 | cut -d"'" -f2)
    force=$(printf '%s' "$raw"| grep -o "SSL_FORCE='[^']*'"  | head -1 | cut -d"'" -f2)
    susp=$(printf '%s' "$raw" | grep -o "SUSPENDED='[^']*'"  | head -1 | cut -d"'" -f2)
    [ -n "$d" ] || continue

    if [ "$ssl" != "yes" ]; then
      printf '  %-34s no certificate -- left alone\n' "$d"; skipped=$((skipped+1)); continue
    fi
    if [ "$susp" = "yes" ]; then
      printf '  %-34s suspended -- left alone\n' "$d"; skipped=$((skipped+1)); continue
    fi
    if [ "$force" = "yes" ]; then
      skipped=$((skipped+1)); continue
    fi

    if [ "$DRY" = "--dry-run" ]; then
      printf '  %-34s WOULD force ssl\n' "$d"; changed=$((changed+1)); continue
    fi

    if /usr/local/hestia/bin/v-add-web-domain-ssl-force "$u" "$d" no yes >/dev/null 2>&1; then
      printf '  %-34s force ssl on\n' "$d"; changed=$((changed+1))
    else
      printf '  %-34s FAILED\n' "$d"; failed=$((failed+1))
    fi
  done < <(grep "^DOMAIN=" "$conf")
done

echo
echo "changed=$changed already-on-or-skipped=$skipped failed=$failed"

if [ "$DRY" != "--dry-run" ] && [ "$changed" -gt 0 ]; then
  # One restart for the lot.
  /usr/local/hestia/bin/v-restart-web >/dev/null 2>&1 && echo "web server restarted" || echo "WEB RESTART FAILED"
  /usr/local/hestia/bin/v-restart-proxy >/dev/null 2>&1 && echo "proxy restarted" || true
fi
