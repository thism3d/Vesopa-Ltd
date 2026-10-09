"""Let the Cloud box accept mail FROM domains whose mailboxes live elsewhere.

    python tool/allow-external-mx-senders.py           # fix, test, restart Exim
    python tool/allow-external-mx-senders.py --check   # report only, change nothing

Run from the repository root on the owner's PC (needs .env.claude-tools, like
tool/route-vesopa-com-by-mx.py).

WHY. HestiaCP refuses outside mail whose SENDER domain is one of the box's own
mail domains unless the sender signs in ("smtp auth required"), to stop
spoofing. vesopa.com (Microsoft 365) and vesopasoftware.com (Google) are listed
as mail domains here too, but their real mailboxes are elsewhere, so their
genuine mail arrives from Microsoft's and Google's servers without signing in
here and is refused. On 2026-10-08 20:47 a message from info@vesopasoftware.com
(sent through Google) to rk@onzep.uk was rejected exactly so.

WHAT IT DOES, on the box:
  1. lists every Hestia mail domain whose MX records exist and none of them
     points at this box, into /etc/exim4/vesopa_external_mx_domains;
  2. backs up /etc/exim4/exim4.conf.template and adds
     `!sender_domains = lsearch;/etc/exim4/vesopa_external_mx_domains`
     to the ACL statement that says "smtp auth required", so only those
     domains are exempt; spoofed mail "from" domains hosted here (onzep.uk…)
     is still refused;
  3. regenerates Exim's config, simulates a Google server delivering
     info@vesopasoftware.com -> rk@onzep.uk (must be accepted) and a stranger
     claiming to be @onzep.uk (must still be refused), restarts Exim, and puts
     the backup back if any check fails.
It also reports how SMTP2GO answered mail sent from @onzep.uk addresses.
Idempotent: re-running refreshes the domain list and re-tests.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "MetricMembership", "server", "scripts"))
from deploy import connect, vesopa_ssh  # noqa: E402

REMOTE = r'''
set -e
CHECK=__CHECK__
C=/etc/exim4/exim4.conf.template
L=/etc/exim4/vesopa_external_mx_domains
BOX=34.63.118.67
MARK="lsearch;$L"

command -v dig >/dev/null || { echo "dig is not installed; stopping"; exit 1; }
echo "=== mail domains on this box whose MX points elsewhere ==="
TMP=$(mktemp)
# The box's own resolver first; 1.1.1.1 only if that gives nothing.
q() { r=$(dig +short +time=3 +tries=2 "$1" "$2" 2>/dev/null) || true; [ -n "$r" ] || r=$(dig +short +time=3 +tries=2 "$1" "$2" @1.1.1.1 2>/dev/null) || true; echo "$r"; }
# Exim's own list of local mail domains (/etc/exim4/domains) plus Hestia's.
{ ls /etc/exim4/domains 2>/dev/null
  for f in /usr/local/hestia/data/users/*/mail.conf; do
    sed -n "s/^DOMAIN='\([^']*\)'.*/\1/p" "$f"
  done; } | sort -u > "$TMP.all"
echo "  $(wc -l < "$TMP.all") local mail domains"
while read -r d; do
  mx=$(q MX "$d" | awk '{print $2}' | sed 's/\.$//')
  if [ -z "$mx" ]; then echo "  $d  (no MX answer)"; continue; fi
  here=no
  for h in $mx; do
    for ip in $(q A "$h"); do [ "$ip" = "$BOX" ] && here=yes; done
  done
  if [ "$here" = no ]; then echo "$d" >> "$TMP"; echo "  $d  EXTERNAL (MX: $(echo $mx | tr '\n' ' '))"; fi
done < "$TMP.all"
rm -f "$TMP.all"

echo
echo "=== every 'smtp auth required' statement in the template ==="
grep -n -B4 -A6 "smtp auth required" "$C" || echo "  none"

if ! grep -q . "$TMP"; then
  echo; echo "NOTHING CHANGED: no local mail domain has its MX elsewhere (see the list above)"
  rm -f "$TMP"; exit 3
fi

grep -q "smtp auth required" "$C" || { echo "no 'smtp auth required' statement found; stopping"; exit 1; }

simulate() { # $1 sender, $2 recipient
  printf 'EHLO mail-lf1-f44.google.com\r\nMAIL FROM:<%s>\r\nRCPT TO:<%s>\r\nQUIT\r\n' "$1" "$2" \
    | exim -bh 209.85.167.44 2>/dev/null | grep -E "^(250|5[0-9][0-9]|4[0-9][0-9])" | tail -1
}

echo
echo "=== how SMTP2GO answered mail from @onzep.uk lately ==="
zgrep -h -E "F=<[^>]*@onzep\.uk>" /var/log/exim4/mainlog* 2>/dev/null | grep -E "smtp2go|R=send_via_smtp_relay|\*\*|==" | tail -8 || true
for id in $(zgrep -h -E "<= [^ ]*@onzep\.uk " /var/log/exim4/mainlog* 2>/dev/null | awk '{print $3}' | tail -40); do
  zgrep -h "$id" /var/log/exim4/mainlog* 2>/dev/null | grep -E "R=send_via_smtp_relay|\*\* " | head -1
done | tail -8

if [ "$CHECK" = 1 ]; then
  echo; echo "=== simulation as it is now (check only) ==="
  echo "info@vesopasoftware.com -> rk@onzep.uk:"; simulate info@vesopasoftware.com rk@onzep.uk
  rm -f "$TMP"; exit 0
fi

install -m 644 "$TMP" "$L"; rm -f "$TMP"
chgrp Debian-exim "$L" 2>/dev/null || true
if grep -qF "$MARK" "$C"; then
  echo; echo "exemption already in the ACL; domain list refreshed"
else
  B="$C.bak_pre_external_mx_$(date +%Y%m%d_%H%M%S)"
  cp -p "$C" "$B"
  echo; echo "backed up to $B"
  # Add the exemption after each "smtp auth required" line; inside a deny
  # every condition must hold, so this only narrows who is refused.
  sed -i "/smtp auth required/a\\
          !sender_domains = $MARK" "$C"
  update-exim4.conf
  OK=1
  exim -bV >/dev/null 2>&1 || OK=0
  A=$(simulate info@vesopasoftware.com rk@onzep.uk); echo "info@vesopasoftware.com -> rk@onzep.uk: $A"
  echo "$A" | grep -q "^250" || OK=0
  S=$(simulate someone@onzep.uk rk@onzep.uk); echo "stranger as someone@onzep.uk -> rk@onzep.uk: $S"
  echo "$S" | grep -q "auth required" || OK=0
  if [ "$OK" != 1 ]; then
    cp -p "$B" "$C"; update-exim4.conf
    echo "CHECK FAILED: the backup is back in place and nothing changed"
    exit 1
  fi
  systemctl restart exim4
  echo "exim restarted"
fi
echo
echo "=== the ACL statement now ==="
awk '/smtp auth required/{f=1} f{print} f&&/^[[:space:]]*$/{exit}' "$C" | head -12
echo "info@vesopasoftware.com -> rk@onzep.uk: $(simulate info@vesopasoftware.com rk@onzep.uk)"
'''


def main():
    check = "--check" in sys.argv[1:]
    client = connect()
    try:
        status = vesopa_ssh.run(client, "bash -c " + __import__("shlex").quote(REMOTE.replace("__CHECK__", "1" if check else "0")))
        if status == 3:
            raise SystemExit("nothing changed on the box: read the output above")
        if status != 0:
            raise SystemExit("failed on the box: read the output above")
        if not check:
            print("\ndone. Outside mail from domains hosted elsewhere is accepted again.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
