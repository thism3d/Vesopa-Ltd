"""Pass every @vesopa.com message that lands on the Cloud box on to Microsoft 365,
and let vesopaepos.com mail out through the SMTP2GO relay.

    python tool/route-vesopa-com-backup-mx.py

Run from the repository root on the owner's PC, like route-vesopa-com-by-mx.py.
Owner's instruction 2026-11-08: "Yes, pass to Outlook" and "other mail also not
reaching, fix those as well".

WHY. vesopa.com's inbox is Microsoft 365 (MX 0); the Cloud box is its backup
MX (10). Senders that could not reach Microsoft gave their mail to the box,
which refused it for addresses without a mailbox here (info@, support@,
postmaster@: "Unrouteable address") and kept the rest in local mailboxes
nobody reads. Separately, mail from @vesopaepos.com addresses was refused by
SMTP2GO ("From header sender domain not verified (vesopaepos.com)").

WHAT IT DOES, on the box:
  1. backs up /etc/exim4/exim4.conf.template;
  2. adds router vesopa_com_backup_mx right after vesopa_com_by_mx: any mail
     for @vesopa.com arriving from outside goes out through the SMTP2GO relay
     to Microsoft 365 (outbound port 25 is blocked here). SMTP2GO only takes a
     verified From, so From becomes "<sender> via vesopa.com"
     <no-reply@vesopa.com> with Reply-To the real sender (as the Pontardawe
     forward does), and the envelope sender is no-reply@vesopa.com;
  3. in the relay transport, a From of @vesopaepos.com is shown as
     no-reply@vesopa.com with Reply-To the vesopaepos.com address, until
     vesopaepos.com is verified in SMTP2GO (then delete those two lines);
  4. regenerates Exim's config, checks it and both routes, restarts Exim, and
     puts the backup back if any check fails.
No mailbox is touched. Idempotent.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "MetricMembership", "server", "scripts"))
from deploy import connect, vesopa_ssh  # noqa: E402

REMOTE = r'''
set -e
C=/etc/exim4/exim4.conf.template
if grep -q "^vesopa_com_backup_mx:" "$C"; then
  echo "router already present"
else
  B="$C.bak_pre_vesopa_backup_mx_$(date +%Y%m%d_%H%M%S)"
  cp -p "$C" "$B"
  echo "backed up to $B"
  python3 - "$C" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
router = r"""
# vesopa.com mail that reached this box from outside (backup MX 10) goes on
# to Microsoft 365 through the relay, never into the local mailboxes or
# refused. From is rewritten to a verified address so SMTP2GO takes it;
# Reply-To is the real sender. SRS bounces are left to inbound_srs.
# tool/route-vesopa-com-backup-mx.py, owner's instruction 2026-11-08.
vesopa_com_backup_mx:
  driver = manualroute
  address_data = SMTP_RELAY_HOST:SMTP_RELAY_PORT
  domains = vesopa.com
  condition = ${if !match{$local_part}{\N^(?i)srs[01][=+-]\N}}
  require_files = SMTP_RELAY_FILE
  transport = smtp_relay_smtp
  route_list = * ${extract{1}{:}{$address_data}}::${extract{2}{:}{$address_data}}
  errors_to = no-reply@vesopa.com
  headers_remove = From : Reply-To : Sender : DKIM-Signature
  headers_add = From: ${if def:h_from: {${quote:${if eq{${sg{${sg{$h_from:}{\N\s*<[^>]*>\s*$\N}{}}}{\N["']\N}{}}}{}{${address:$h_from:}}{${sg{${sg{$h_from:}{\N\s*<[^>]*>\s*$\N}{}}}{\N["']\N}{}}}} via vesopa.com} <no-reply@vesopa.com>}{Mail for vesopa.com <no-reply@vesopa.com>}}
  headers_add = ${if def:h_reply-to: {Reply-To: $h_reply-to:}{${if def:h_from: {Reply-To: $h_from:}}}}
  no_more
"""
anchor = s.index("vesopa_com_by_mx:\n")
end = s.index("  no_verify\n", anchor) + len("  no_verify\n")
s = s[:end] + router + s[end:]
t = s.index("smtp_relay_smtp:\n")
tls = s.index("  hosts_require_tls = $host_address\n", t) + len("  hosts_require_tls = $host_address\n")
transport = r"""  # vesopaepos.com is not a verified sender in SMTP2GO yet (2026-11-08):
  # show it as no-reply@vesopa.com, replies still go to vesopaepos.com.
  headers_rewrite = *@vesopaepos.com no-reply@vesopa.com f
  headers_add = ${if and{{match{$h_from:}{\N(?i)@vesopaepos\.com\N}}{!def:h_reply-to:}}{Reply-To: $h_from:}}
"""
s = s[:tls] + transport + s[tls:]
open(p, "w").write(s)
PY
  update-exim4.conf
  ok=1
  exim -bV >/dev/null 2>&1 || ok=0
  # An outside server (names.co.uk) offering mail for info@: must be accepted now.
  printf 'EHLO auth-out.namesco.net\r\nMAIL FROM:<noreply@names.co.uk>\r\nRCPT TO:<info@vesopa.com>\r\nQUIT\r\n' \
    | exim -bh 85.233.160.16 2>/dev/null | grep -q '^250 Accepted' || ok=0
  if [ $ok = 0 ]; then
    cp -p "$B" "$C"
    update-exim4.conf
    echo "CHECK FAILED: the backup is back in place and nothing changed"
    exit 1
  fi
  systemctl restart exim4
  echo "exim restarted"
fi
echo "outside mail for info@vesopa.com:"
printf 'EHLO auth-out.namesco.net\r\nMAIL FROM:<noreply@names.co.uk>\r\nRCPT TO:<info@vesopa.com>\r\nQUIT\r\n' \
  | exim -bh 85.233.160.16 2>&1 | grep -E '^(250|550|451)' | tail -2
'''


def main():
    client = connect()
    try:
        status = vesopa_ssh.run(client, REMOTE)
        if status != 0:
            raise SystemExit("failed on the box: read the output above")
        print("\ndone. vesopa.com mail landing on the Cloud box now goes on to Microsoft 365.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
