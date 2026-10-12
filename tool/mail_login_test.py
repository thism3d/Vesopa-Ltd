"""Prove a mailbox on the Cloud box works: IMAP sign-in, SMTP sign-in, one send.

    $env:MAIL_PW = '<password>'
    python tool/mail_login_test.py info@pontardawerfc.com [--send-to someone@example.com]

Run from the owner's PC (the cloud sessions can't reach the mail ports). The
password comes only from $MAIL_PW and is never printed. Checks IMAP 993 (SSL),
SMTP 465 (SSL) and SMTP 587 (STARTTLS) on mail.<domain>, and with --send-to
sends one short test message through 587 so the server log shows whether the
SMTP2GO relay took it.
"""
import argparse
import imaplib
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

parser = argparse.ArgumentParser()
parser.add_argument("address")
parser.add_argument("--host", help="default mail.<domain>")
parser.add_argument("--send-to")
args = parser.parse_args()

password = os.environ.get("MAIL_PW")
if not password:
    sys.exit("set $env:MAIL_PW first")
domain = args.address.split("@", 1)[1]
host = args.host or f"mail.{domain}"
ctx = ssl.create_default_context()
ok = True


def report(name, fn):
    global ok
    try:
        print(f"  ✓ {name}: {fn()}")
    except Exception as e:  # noqa: BLE001 - report every failure the same way
        ok = False
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def imap():
    with imaplib.IMAP4_SSL(host, 993, ssl_context=ctx, timeout=20) as m:
        m.login(args.address, password)
        _, data = m.select("INBOX", readonly=True)
        return f"signed in, INBOX has {data[0].decode()} messages"


def smtp465():
    with smtplib.SMTP_SSL(host, 465, context=ctx, timeout=20) as s:
        s.login(args.address, password)
        return "signed in"


def smtp587():
    with smtplib.SMTP(host, 587, timeout=20) as s:
        s.starttls(context=ctx)
        s.login(args.address, password)
        if not args.send_to:
            return "signed in"
        msg = EmailMessage()
        msg["From"] = args.address
        msg["To"] = args.send_to
        msg["Subject"] = f"Test from {args.address}"
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain=domain)
        msg.set_content(f"A test message sent through {host}:587 as {args.address}.")
        refused = s.send_message(msg)
        return f"signed in, sent to {args.send_to}" + (f" (refused: {refused})" if refused else "")


print(f"{args.address} on {host}")
report("IMAP 993", imap)
report("SMTP 465", smtp465)
report("SMTP 587", smtp587)
sys.exit(0 if ok else 1)
