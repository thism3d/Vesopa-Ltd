#!/bin/bash
# info@pontardawerfc.com: the club's address on its own domain, forwarded to
# the club's old address. Run as root on the Cloud box by
# tool/deploy_pontardawe_site.py (owner's ask, 2026-10-11).
#
#   bash mail-forward.sh [--check] <to-address>
#
# NOT A MAILBOX (the owner never wants mailboxes on the server): one Exim
# redirect router at the top of the routers sends info@ and contact@ on to
# <to-address>. Nothing is stored here.
#
# WHY THE FROM LINE IS REWRITTEN. The box cannot send on port 25; all mail
# leaves through the SMTP2GO relay, which refuses any From domain not verified
# there ("550 From header sender domain not verified"). A forwarded message
# keeps its sender's From (gmail.com, outlook.com...), so it would be refused.
# So the forwarded copy comes From "<sender> via pontardawerfc.com"
# <info@pontardawerfc.com> with Reply-To the sender, the way mailing lists do:
# Reply still answers the person who wrote. pontardawerfc.com must be a
# verified sender domain in SMTP2GO for the relay to take it.
#
# Idempotent; backs up the template and puts it back if any check fails.
set -euo pipefail

CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; shift; fi
TO="${1:?the address to forward to}"
DOMAIN=pontardawerfc.com
C=/etc/exim4/exim4.conf.template

ok() { echo "  ✓ $*"; }
warn() { echo "  ! $*"; }

case "$TO" in *@*.*) ;; *) echo "not an email address: $TO"; exit 1 ;; esac
case "$TO" in *[!A-Za-z0-9.@_+-]*) echo "unexpected characters in $TO"; exit 1 ;; esac

OWNER=$(v-search-domain-owner "$DOMAIN" mail 2>/dev/null || v-search-domain-owner "$DOMAIN" 2>/dev/null || true)
if [ -n "$OWNER" ] && v-list-mail-domain "$OWNER" "$DOMAIN" >/dev/null 2>&1; then
  ok "$DOMAIN takes mail here (panel user $OWNER)"
elif [ -n "$OWNER" ]; then
  if [ $CHECK = 1 ]; then warn "would add $DOMAIN as a mail domain (no mailboxes) for $OWNER"
  else v-add-mail-domain "$OWNER" "$DOMAIN" no no no >/dev/null && ok "added $DOMAIN as a mail domain for $OWNER (no mailboxes)"; fi
else
  echo "  ✗ $DOMAIN is not on the panel"; exit 1
fi

if grep -q "^pontardawe_forward:" "$C"; then
  CURRENT=$(sed -n '/^pontardawe_forward:/,/^$/p' "$C" | sed -n 's/^  data = //p')
  if [ "$CURRENT" = "$TO" ]; then ok "forwarder already in place, to $TO"; exit 0; fi
  [ $CHECK = 1 ] && { warn "would change the forward from $CURRENT to $TO"; exit 0; }
  ACTION=replace
else
  [ $CHECK = 1 ] && { warn "would add the forwarder info@$DOMAIN -> $TO"; exit 0; }
  ACTION=add
fi

B="$C.bak_pre_pontardawe_forward_$(date +%Y%m%d_%H%M%S)"
cp -p "$C" "$B"
python3 - "$C" "$TO" "$ACTION" <<'PY'
import re
import sys
path, to, action = sys.argv[1:]
s = open(path).read()
if action == "replace":
    s = re.sub(r"# info@pontardawerfc\.com.*?\npontardawe_forward:\n.*?\n\n", "", s, flags=re.S)
rule = r"""# info@pontardawerfc.com and contact@ go on to the club's old address; no
# mailbox here. From is rewritten so the SMTP2GO relay takes it, Reply-To is
# the sender; a bounce of a bounce is dropped, never forwarded again.
# PontardaweRFC/website/scripts/mail-forward.sh, 2026-10-11.
pontardawe_forward:
  driver = redirect
  domains = pontardawerfc.com
  local_parts = info : contact
  data = TO_ADDRESS
  errors_to = ${if eq{$sender_address}{}{}{info@pontardawerfc.com}}
  headers_remove = From : Reply-To : Sender : DKIM-Signature
  headers_add = From: ${if def:h_from: {${quote:${if eq{${sg{${sg{$h_from:}{\N\s*<[^>]*>\s*$\N}{}}}{\N["']\N}{}}}{}{${address:$h_from:}}{${sg{${sg{$h_from:}{\N\s*<[^>]*>\s*$\N}{}}}{\N["']\N}{}}}} via pontardawerfc.com} <info@pontardawerfc.com>}{Pontardawe RFC <info@pontardawerfc.com>}}
  headers_add = ${if def:h_from: {Reply-To: $h_from:}}
  no_more

""".replace("TO_ADDRESS", to)
i = s.index("begin routers\n") + len("begin routers\n")
open(path, "w").write(s[:i] + "\n" + rule + s[i:])
PY
update-exim4.conf
if ! exim -bV >/dev/null 2>&1 || ! exim -bt "info@$DOMAIN" 2>&1 | grep -q "$TO"; then
  cp -p "$B" "$C"
  update-exim4.conf
  echo "  ✗ check failed: the backup is back in place and nothing changed"
  exim -bt "info@$DOMAIN" 2>&1 | head -5
  exit 1
fi
systemctl restart exim4
ok "info@$DOMAIN and contact@$DOMAIN forward to $TO (backup $B)"
exim -bt "info@$DOMAIN" 2>&1 | grep -E "router|transport|$TO" | head -4 | sed 's/^/    /'
