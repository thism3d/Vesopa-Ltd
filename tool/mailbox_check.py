"""Read-only health check of one mailbox on the Cloud box (34.63.118.67).

    python tool/mailbox_check.py rk@onzep.uk

Run from the repository root on the owner's PC (needs .env.claude-tools, like
tool/route-vesopa-com-by-mx.py). Changes nothing on the box. Never prints a
password: only whether the account exists and how mail for it was handled.

It answers "the mailbox signs in but mail is not sent, received or synced":
  1. the Hestia mail domain and account (exists, suspended, quota, Maildir);
  2. what Exim and Dovecot logged for the address lately (auth, deliveries,
     relay refusals such as SMTP2GO's "sender domain not verified");
  3. how Exim would route mail TO it and FROM it to an outside address;
  4. which mail ports listen and the certificate each one shows for
     mail.vesopa.com (IMAP 993, POP3 995, SMTP 465/587, 25, 143, 110);
  5. the outgoing relay (host and port only), Exim's queue, Roundcube's SMTP
     setting, and the domain's DKIM record as Hestia has it.
"""

import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "MetricMembership", "server", "scripts"))
from deploy import connect, vesopa_ssh  # noqa: E402

REMOTE = r'''
ADDR=__ADDR__
LOCAL=${ADDR%@*}
DOM=${ADDR#*@}
H=/usr/local/hestia/bin
sec() { echo; echo "=== $* ==="; }

sec "Hestia owner of $DOM"
OWNER=$(grep -l "DOMAIN='$DOM'" /usr/local/hestia/data/users/*/mail.conf 2>/dev/null | head -1 | xargs -r dirname | xargs -r basename)
echo "owner: ${OWNER:-NOT FOUND}"
if [ -n "$OWNER" ]; then
  $H/v-list-mail-domain "$OWNER" "$DOM" shell 2>&1 | head -30
  sec "account $LOCAL"
  $H/v-list-mail-account "$OWNER" "$DOM" "$LOCAL" shell 2>&1 | grep -v -i -E "^(MD5|PASSWORD)" | head -30
  sec "Maildir"
  M=/home/$OWNER/mail/$DOM/$LOCAL
  ls -ld "$M" 2>&1
  for d in new cur tmp; do echo "$d: $(ls "$M/$d" 2>/dev/null | wc -l) files, newest $(ls -t "$M/$d" 2>/dev/null | head -1 | xargs -r -I{} stat -c %y "$M/$d/{}")"; done
  du -sh "$M" 2>/dev/null
  ls -la "$M" 2>/dev/null | head -20
  sec "passwd and dovecot user lookup"
  grep -c "^$LOCAL:" /home/$OWNER/conf/mail/$DOM/passwd 2>/dev/null
  ls -la /home/$OWNER/conf/mail/$DOM/ 2>&1 | head
  doveadm user "$ADDR" 2>&1 | head -12
  sec "DKIM as Hestia has it"
  $H/v-list-mail-domain-dkim-dns "$OWNER" "$DOM" 2>&1 | head -6
fi

sec "Exim routes"
echo "-- to $ADDR (as from outside):"
exim -bt "$ADDR" 2>&1 | head -6
echo "-- from $ADDR to an outside address:"
exim -bt -f "$ADDR" check@gmail.com 2>&1 | head -6
echo "-- relay (host and port only):"
sed -E 's/(pass(word)?[^:=]*[:=]).*/\1 ***/I' /etc/exim4/smtp_relay.conf 2>/dev/null | grep -v -i pass
grep -n -E "^(smtp_relay|vesopa_com_by_mx|send_via_smtp_relay|dnslookup)" /etc/exim4/exim4.conf.template | head

sec "Exim log for $ADDR (last 60)"
grep -h -F "$ADDR" /var/log/exim4/mainlog.1 /var/log/exim4/mainlog 2>/dev/null | tail -60
sec "Exim log for @$DOM other addresses (last 15)"
grep -h -F "@$DOM" /var/log/exim4/mainlog 2>/dev/null | grep -v -F "$ADDR" | tail -15
sec "Exim reject log for $DOM (last 20)"
grep -h -F "$DOM" /var/log/exim4/rejectlog 2>/dev/null | tail -20
sec "Exim panic log (last 10)"
tail -10 /var/log/exim4/paniclog 2>/dev/null
sec "Exim queue for $DOM"
exim -bp 2>/dev/null | grep -B1 -A2 -F "$DOM" | head -30
echo "total queued: $(exim -bpc 2>/dev/null)"

sec "Dovecot log for $ADDR (last 40)"
( grep -h -F "$ADDR" /var/log/dovecot.log 2>/dev/null; journalctl -u dovecot --since "-2 days" --no-pager 2>/dev/null | grep -F "$ADDR" ) | tail -40
sec "Dovecot auth failures (last 10)"
( grep -h -i -E "auth.*(fail|mismatch)" /var/log/dovecot.log 2>/dev/null; journalctl -u dovecot --since "-1 day" --no-pager 2>/dev/null | grep -i -E "auth.*(fail|mismatch)" ) | tail -10

sec "Listening mail ports"
ss -ltnp 2>/dev/null | grep -E ":(25|110|143|465|587|993|995)\b"
sec "Firewall rules for mail ports"
$H/v-list-firewall plain 2>/dev/null | grep -E "\b(25|110|143|465|587|993|995)\b|MAIL|IMAP|POP|SMTP" | head
iptables -S INPUT 2>/dev/null | grep -E "dport (25|110|143|465|587|993|995)|multiport" | head

sec "Certificates shown for mail.vesopa.com"
for p in 993 995 465; do
  echo "-- $p"; echo | timeout 8 openssl s_client -connect 127.0.0.1:$p -servername mail.vesopa.com 2>/dev/null | openssl x509 -noout -subject -enddate -ext subjectAltName 2>&1 | tr '\n' ' '; echo
done
for p in 587 25; do
  echo "-- $p STARTTLS"; echo | timeout 8 openssl s_client -starttls smtp -connect 127.0.0.1:$p -servername mail.vesopa.com 2>/dev/null | openssl x509 -noout -subject -enddate -ext subjectAltName 2>&1 | tr '\n' ' '; echo
done
for p in 143; do
  echo "-- $p STARTTLS"; echo | timeout 8 openssl s_client -starttls imap -connect 127.0.0.1:$p -servername mail.vesopa.com 2>/dev/null | openssl x509 -noout -subject -enddate -ext subjectAltName 2>&1 | tr '\n' ' '; echo
done
for p in 110; do
  echo "-- $p STARTTLS"; echo | timeout 8 openssl s_client -starttls pop3 -connect 127.0.0.1:$p -servername mail.vesopa.com 2>/dev/null | openssl x509 -noout -subject -enddate -ext subjectAltName 2>&1 | tr '\n' ' '; echo
done
echo "-- dovecot ssl settings"
doveconf -n 2>/dev/null | grep -E "^ *(ssl|ssl_cert|ssl_key|local_name|protocols|disable_plaintext|auth_mechanisms)" | head -20
doveconf -n 2>/dev/null | grep -n -E "local_name" -A2 | head -30
echo "-- exim tls settings"
grep -n -E "^ *(tls_certificate|tls_privatekey|tls_advertise_hosts|daemon_smtp_ports|tls_on_connect_ports|auth_advertise_hosts)" /etc/exim4/exim4.conf.template | head

sec "Roundcube SMTP setting"
grep -h -E "smtp_(server|host|port|user|pass)|default_host|imap_host" /etc/roundcube/config.inc.php /var/lib/roundcube/config/config.inc.php 2>/dev/null | grep -v -E "^\s*//" | sed -E "s/(smtp_pass'\]\s*=).*/\1 ***;/" | head
'''


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", sys.argv[1]):
        raise SystemExit(__doc__)
    client = connect()
    try:
        vesopa_ssh.run(client, "bash -c " + shlex.quote(REMOTE.replace("__ADDR__", shlex.quote(sys.argv[1]))))
    finally:
        client.close()


if __name__ == "__main__":
    main()
