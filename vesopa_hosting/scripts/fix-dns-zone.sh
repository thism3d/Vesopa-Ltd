#!/bin/bash
# Make this box answer for a zone it holds but SERVFAILs on.
#
#   bash scripts/fix-dns-zone.sh vesopa.site
#
# vesopa.site (2026-10-10): the registry delegates to ns1/ns2.vesopa.com
# (this box), but on 2026-09-21 the zone was edited for deSEC: its apex NS
# records say ns1.desec.io / ns2.desec.org and a DNSKEY record was pasted in by
# hand. The registry has no DS, so DNSSEC is not wanted here. This script:
#   1. shows the zone check (named-checkzone) and the local answer, before
#   2. turns Hestia's DNSSEC off for the zone, if on
#   3. deletes the hand-added DNSKEY and the apex NS records not ours
#   4. adds ns1/ns2.vesopa.com as apex NS, rebuilds and reloads the zone
#   5. shows the check and the local answer again
# Every other record (A, MX, mail, DKIM, SPF) is left as it is.
set -uo pipefail
DOMAIN="${1:?domain}"
BIN=/usr/local/hestia/bin
OWNER=""
for u in $($BIN/v-list-users plain | cut -f1); do
  if $BIN/v-list-dns-domain "$u" "$DOMAIN" plain >/dev/null 2>&1; then OWNER="$u"; break; fi
done
[ -n "$OWNER" ] || { echo "no zone for $DOMAIN on this box"; exit 1; }
ZONE=/home/$OWNER/conf/dns/$DOMAIN.db

check() {
  echo "-- $1"
  named-checkzone "$DOMAIN" "$ZONE" 2>&1 | tail -3
  echo "local A: $(dig +short @127.0.0.1 "$DOMAIN" A 2>&1 | head -2 | tr '\n' ' ')"
  echo "local NS: $(dig +short @127.0.0.1 "$DOMAIN" NS 2>&1 | head -3 | tr '\n' ' ')"
}

echo "zone $DOMAIN, owner $OWNER, file $ZONE"
check before

$BIN/v-change-dns-domain-dnssec "$OWNER" "$DOMAIN" no >/dev/null 2>&1 && echo "dnssec off"

$BIN/v-list-dns-records "$OWNER" "$DOMAIN" plain | while IFS=$'\t' read -r id rec type _ value _; do
  if [ "$type" = "DNSKEY" ] || { [ "$type" = "NS" ] && [ "$rec" = "@" ] && [[ "$value" != ns1.vesopa.com* && "$value" != ns2.vesopa.com* ]]; }; then
    $BIN/v-delete-dns-record "$OWNER" "$DOMAIN" "$id" no && echo "deleted $id $rec $type $value"
  fi
done

have=$($BIN/v-list-dns-records "$OWNER" "$DOMAIN" plain | awk -F'\t' '$3=="NS"{print $5}')
for ns in ns1.vesopa.com. ns2.vesopa.com.; do
  echo "$have" | grep -qx "$ns" || { $BIN/v-add-dns-record "$OWNER" "$DOMAIN" @ NS "$ns" '' '' no && echo "added NS $ns"; }
done

$BIN/v-rebuild-dns-domain "$OWNER" "$DOMAIN" yes yes >/dev/null 2>&1 || $BIN/v-rebuild-dns-domains "$OWNER" yes >/dev/null 2>&1
rndc reload "$DOMAIN" >/dev/null 2>&1 || rndc reload >/dev/null 2>&1
sleep 3
check after
