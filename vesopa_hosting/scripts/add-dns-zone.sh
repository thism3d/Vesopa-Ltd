#!/bin/bash
# Give a domain a DNS zone on this box when its nameservers already point here
# but nothing answers for it (SERVFAIL), as vesopa.site did on 2026-10-10.
#
#   bash scripts/add-dns-zone.sh vesopa.site [hestia-user]
#
# Without a user it takes the Hestia account that holds the domain's web site,
# else vesopasoftware. Does nothing if a zone already exists. The IP is the
# box's public address (never blank: a blank IP gives a zone of empty records).
set -euo pipefail
DOMAIN="${1:?domain}"
BIN=/usr/local/hestia/bin
IP=34.63.118.67

for u in $($BIN/v-list-users plain | cut -f1); do
  if $BIN/v-list-dns-domain "$u" "$DOMAIN" plain >/dev/null 2>&1; then
    echo "zone already exists under $u"; $BIN/v-list-dns-records "$u" "$DOMAIN" | head -20; exit 0
  fi
done

USER_="${2:-}"
if [ -z "$USER_" ]; then
  for u in $($BIN/v-list-users plain | cut -f1); do
    if $BIN/v-list-web-domain "$u" "$DOMAIN" plain >/dev/null 2>&1; then USER_="$u"; break; fi
  done
fi
USER_="${USER_:-vesopasoftware}"

echo "adding $DOMAIN zone under $USER_ at $IP"
$BIN/v-add-dns-domain "$USER_" "$DOMAIN" "$IP" ns1.vesopa.com ns2.vesopa.com
$BIN/v-list-dns-records "$USER_" "$DOMAIN" | head -20
sleep 2
echo "local answer: $(dig +short @127.0.0.1 "$DOMAIN" A 2>/dev/null || true)"
