"""Check the Cloud box's SMTP2GO relay logins, and which From domains they take.

    python tool/smtp2go_relay_check.py                       # sign-in only
    python tool/smtp2go_relay_check.py --from info@pontardawerfc.com --to info@vesopasoftware.com

Run from the repository root on the owner's PC (needs .env.claude-tools, like
tool/mailbox_check.py). Exim picks the relay login by the sender's domain:
/etc/exim4/domains/<domain>/smtp_relay.conf when it exists, else the box-wide
/etc/exim4/smtp_relay.conf. This signs in with every one of those logins
(never printing a password) and, with --from/--to, sends one short test
message From that address through each login, so SMTP2GO's answer ("250 OK",
"535 authentication failed", "550 From header sender domain not verified")
shows exactly which login and which From domain work. Changes nothing.
"""
import argparse
import re
import shlex
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "MetricMembership", "server", "scripts"))
from deploy import connect, vesopa_ssh  # noqa: E402

REMOTE = r'''
import glob, smtplib, ssl, sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
frm, to = sys.argv[1], sys.argv[2]
def conf(path):
    d = {}
    for line in open(path):
        k, _, v = line.strip().partition(":")
        d[k] = v
    return d
for path in ["/etc/exim4/smtp_relay.conf"] + sorted(glob.glob("/etc/exim4/domains/*/smtp_relay.conf")):
    c = conf(path)
    print(f"-- {path}: user {c.get('user')} on {c.get('host')}:{c.get('port')}")
    try:
        with smtplib.SMTP(c["host"], int(c["port"]), timeout=20) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(c["user"], c["pass"])
            print("   sign-in: OK")
            if frm and to:
                m = EmailMessage()
                m["From"], m["To"] = frm, to
                m["Subject"] = f"Relay test: From {frm} via login {c['user']}"
                m["Date"], m["Message-ID"] = formatdate(localtime=True), make_msgid(domain=frm.split('@')[1])
                m.set_content(f"Sent from the Cloud box through SMTP2GO login {c['user']} to check From {frm}.")
                try:
                    s.send_message(m)
                    print(f"   send From {frm}: accepted")
                except smtplib.SMTPException as e:
                    print(f"   send From {frm}: REFUSED {e}")
    except smtplib.SMTPAuthenticationError as e:
        print(f"   sign-in: FAILED {e.smtp_code} {e.smtp_error.decode(errors='replace')}")
    except Exception as e:
        print(f"   error: {type(e).__name__}: {e}")
'''

ADDR = r"[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="frm", default="")
    p.add_argument("--to", default="")
    a = p.parse_args()
    for v in (a.frm, a.to):
        if v and not re.fullmatch(ADDR, v):
            raise SystemExit(f"not an email address: {v}")
    client = connect()
    try:
        cmd = "python3 - {} {} <<'PY'\n{}\nPY".format(shlex.quote(a.frm), shlex.quote(a.to), REMOTE)
        vesopa_ssh.run(client, "bash -c " + shlex.quote(cmd))
    finally:
        client.close()


if __name__ == "__main__":
    main()
