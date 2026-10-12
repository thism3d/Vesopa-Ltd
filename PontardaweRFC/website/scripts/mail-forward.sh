#!/bin/bash
# info@pontardawerfc.com and contact@: forwarded on, with a copy kept in the
# mailbox when one exists. Run as root on the Cloud box by
# tool/deploy_pontardawe_site.py and tool/pontardawe_mail_fix.py.
#
#   bash mail-forward.sh [--check] <to-address> [from-address]
#
# 2026-10-11: a forwarder only (no mailbox), to the club's old Hotmail address.
# 2026-10-12: the owner made info@ a real mailbox (Hestia, password set in the
# panel) and asked for mail to go on to info@vesopasoftware.com. The old
# router caught every message for info@ first ("no_more", no copy kept), so
# the new mailbox never received anything. Now:
#   * a local part that has a Hestia mailbox (accounts file) keeps its copy
#     ("unseen") and is also forwarded; one without a mailbox is only forwarded;
#   * the forwarded copy leaves by the SMTP2GO relay through its own router,
#     pontardawe_forward_out. Without it a copy for a domain this box also
#     hosts (vesopasoftware.com, vesopa.com: backup MX here) would be delivered
#     to the local mailbox on this box instead of the real one at Google/M365;
#   * a per-domain relay login for pontardawerfc.com that SMTP2GO refuses
#     (535) is removed so Exim falls back to the box-wide login, which
#     SMTP2GO accepts for From pontardawerfc.com since the owner verified the
#     domain there (2026-10-12).
#
# WHY THE FROM LINE IS REWRITTEN. All mail leaves through SMTP2GO, which
# refuses any From domain not verified there. A forwarded message keeps its
# sender's From (gmail.com, outlook.com...), so it would be refused. The
# forwarded copy comes From "<sender> via pontardawerfc.com" <from-address>
# with Reply-To the sender, the way mailing lists do: Reply still answers the
# person who wrote. from-address must be on a verified domain.
#
# Idempotent; backs up the template and puts it back if any check fails.
# Never test an Exim redirect with an unconditional errors_to (bounce loop).
set -euo pipefail
# The panel's commands (v-*) are not on a plain ssh session's PATH.
export PATH="$PATH:/usr/local/hestia/bin"

CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; shift; fi
TO="${1:?the address to forward to}"
FROM="${2:-info@pontardawerfc.com}"
DOMAIN=pontardawerfc.com
C=/etc/exim4/exim4.conf.template

ok() { echo "  ✓ $*"; }
warn() { echo "  ! $*"; }

case "$TO" in *@*.*) ;; *) echo "not an email address: $TO"; exit 1 ;; esac
case "$TO$FROM" in *[!A-Za-z0-9.@_+-]*) echo "unexpected characters in $TO or $FROM"; exit 1 ;; esac
case "$FROM" in *@*.*) ;; *) echo "not an email address: $FROM"; exit 1 ;; esac

OWNER=$(v-search-domain-owner "$DOMAIN" mail 2>/dev/null || v-search-domain-owner "$DOMAIN" 2>/dev/null || true)
if [ -n "$OWNER" ] && v-list-mail-domain "$OWNER" "$DOMAIN" >/dev/null 2>&1; then
  ok "$DOMAIN takes mail here (panel user $OWNER)"
elif [ -n "$OWNER" ]; then
  if [ $CHECK = 1 ]; then warn "would add $DOMAIN as a mail domain (no mailboxes) for $OWNER"
  else v-add-mail-domain "$OWNER" "$DOMAIN" no no no >/dev/null && ok "added $DOMAIN as a mail domain for $OWNER (no mailboxes)"; fi
else
  echo "  ✗ $DOMAIN is not on the panel"; exit 1
fi
for lp in info contact; do
  if grep -q "^$lp:" "/etc/exim4/domains/$DOMAIN/accounts" 2>/dev/null; then
    ok "$lp@$DOMAIN is a mailbox: it keeps a copy and forwards"
  else
    ok "$lp@$DOMAIN has no mailbox: forward only"
  fi
done

# ---------------------------------------------------------------- relay login
RELAY="/etc/exim4/domains/$DOMAIN/smtp_relay.conf"
if [ -f "$RELAY" ]; then
  if python3 - "$RELAY" <<'PY'
import smtplib, ssl, sys
c = dict(l.strip().split(":", 1) for l in open(sys.argv[1]) if ":" in l)
try:
    with smtplib.SMTP(c["host"], int(c["port"]), timeout=20) as s:
        s.starttls(context=ssl.create_default_context())
        s.login(c["user"], c["pass"])
except smtplib.SMTPAuthenticationError:
    sys.exit(1)
PY
  then
    ok "$DOMAIN's own relay login signs in"
  elif [ $CHECK = 1 ]; then
    warn "$DOMAIN's own relay login is refused by SMTP2GO (535): would remove it so the box-wide login is used"
  else
    cp -p "$RELAY" "/root/smtp_relay.conf.$DOMAIN.bak_$(date +%Y%m%d_%H%M%S)"
    if v-delete-mail-domain-smtp-relay "$OWNER" "$DOMAIN" >/dev/null 2>&1 || rm -f "$RELAY"; then
      [ -f "$RELAY" ] && rm -f "$RELAY"
      ok "removed $DOMAIN's refused relay login (backup in /root); mail now uses the box-wide login"
    fi
  fi
else
  ok "$DOMAIN uses the box-wide relay login"
fi

# ---------------------------------------------------------------- routers
BLOCK=$(cat <<EOF
# >>> pontardawe mail forward (PontardaweRFC/website/scripts/mail-forward.sh)
# info@ and contact@$DOMAIN go on to $TO. A local part with a mailbox here
# keeps its copy (unseen). From is rewritten to a verified domain so the
# SMTP2GO relay takes it, Reply-To is the sender; a bounce of a bounce is
# dropped, never forwarded again.
pontardawe_forward:
  driver = redirect
  domains = $DOMAIN
  local_parts = info : contact
  data = $TO
  unseen = \${lookup{\$local_part}lsearch{/etc/exim4/domains/\$domain/accounts}{yes}{no}}
  errors_to = \${if eq{\$sender_address}{}{}{info@$DOMAIN}}
  headers_remove = From : Reply-To : Sender : DKIM-Signature
  headers_add = From: \${if def:h_from: {\${quote:\${if eq{\${sg{\${sg{\$h_from:}{\\N\\s*<[^>]*>\\s*\$\\N}{}}}{\\N["']\\N}{}}}{}{\${address:\$h_from:}}{\${sg{\${sg{\$h_from:}{\\N\\s*<[^>]*>\\s*\$\\N}{}}}{\\N["']\\N}{}}}} via $DOMAIN} <$FROM>}{Pontardawe RFC <$FROM>}}
  headers_add = \${if def:h_from: {Reply-To: \$h_from:}}

# The forwarded copy always leaves by the relay, even to a domain this box
# also lists (vesopasoftware.com is backup MX here).
pontardawe_forward_out:
  driver = manualroute
  domains = !$DOMAIN
  condition = \${if eq{\$parent_domain}{$DOMAIN}}
  address_data = SMTP_RELAY_HOST:SMTP_RELAY_PORT
  require_files = SMTP_RELAY_FILE
  transport = smtp_relay_smtp
  route_list = * \${extract{1}{:}{\$address_data}}::\${extract{2}{:}{\$address_data}}
  no_more
  no_verify
# <<< pontardawe mail forward
EOF
)

CURRENT=$(sed -n '/^# >>> pontardawe mail forward/,/^# <<< pontardawe mail forward/p' "$C")
if [ "$CURRENT" = "$BLOCK" ]; then
  ok "forwarder already in place, to $TO, sent as $FROM"
  NEED=0
elif [ $CHECK = 1 ]; then
  warn "would set the forwarder: info@ and contact@$DOMAIN -> $TO, sent as $FROM, mailbox copy kept"
  NEED=0
else
  NEED=1
fi

if [ $NEED = 1 ]; then
  B="$C.bak_pre_pontardawe_forward_$(date +%Y%m%d_%H%M%S)"
  cp -p "$C" "$B"
  BLOCK="$BLOCK" python3 - "$C" <<'PY'
import os, re, sys
path = sys.argv[1]
s = open(path).read()
# the 2026-10-11 block (no markers) and any marked block
s = re.sub(r"# info@pontardawerfc\.com and contact@ go on.*?\npontardawe_forward:\n.*?\n\n", "", s, flags=re.S)
s = re.sub(r"# >>> pontardawe mail forward.*?# <<< pontardawe mail forward\n\n?", "", s, flags=re.S)
i = s.index("begin routers\n") + len("begin routers\n")
open(path, "w").write(s[:i] + "\n" + os.environ["BLOCK"] + "\n\n" + s[i:])
PY
  update-exim4.conf
  R=$(exim -bt "info@$DOMAIN" 2>&1 || true)
  if ! exim -bV >/dev/null 2>&1 || ! grep -q "router = pontardawe_forward_out" <<<"$R" || ! grep -qF "$TO" <<<"$R"; then
    cp -p "$B" "$C"
    update-exim4.conf
    echo "  ✗ check failed: the backup is back in place and nothing changed"
    echo "$R" | head -12
    exit 1
  fi
  systemctl restart exim4
  ok "info@ and contact@$DOMAIN forward to $TO, sent as $FROM (backup $B)"
fi

echo "  routes for info@$DOMAIN:"
exim -bt "info@$DOMAIN" 2>&1 | grep -E "router|transport|@" | head -8 | sed 's/^/    /' || true
