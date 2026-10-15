"""Builds the hosted payments meeting email (Thu 15 Oct 2026, 1:30pm UK): HTML, plain text and an .eml.

No calendar invite attached: Meirion's Google Calendar event already invites Alex,
and a second invite would put the meeting in his calendar twice."""
import os, sys, uuid, urllib.parse
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from email.policy import SMTP

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

SUBJECT = "Vesopa \u00d7 Dojo: Hosted Payments for EPOS, Online Menu, Android & iOS, today 1:30pm UK time"
START_UTC, END_UTC = "20261015T123000Z", "20261015T130000Z"  # 13:30-14:00 BST
START_LOCAL, END_LOCAL = "20261015T133000", "20261015T140000"
MEET = "https://meet.google.com/bfd-qjtp-xkt"
PHONE, PIN = "(US) +1 617-675-4444", "462 307 910 8918#"
MORE_PHONES = "https://tel.meet/bfd-qjtp-xkt?pin=4623079108918"
LOCATION = MEET
TO = [("Alex Radzio", "alex.radzio@dojo.tech")]
CC = [("Meirion Davies", "info@vesopasoftware.com"),
      ("Meirion Davies", "info@vesopa.com")]
ORG = ("Muzahid Islam", "muzahid@vesopa.com")

TITLE = "Vesopa \u00d7 Dojo: Hosted Payments for EPOS, Online Menu, Android & iOS"
AGENDA = [
    "A short demo: an order on our online menu paid on Dojo's hosted checkout, reaching the till only once it is paid",
    "Hosted payments in Vesopa EPOS: a pay link or QR code from the till for table, phone and collection orders",
    "Paying in our Android and iOS apps: memberships, top-ups and orders, with Apple Pay and Google Pay on Dojo's page",
    "Webhooks for payment intents, refunds from the back office, reporting, and live keys for go-live",
]
DESC_TXT = ("Vesopa and Dojo: hosted payments for EPOS, the online menu, Android and iOS.\\n\\nJoin with Google Meet: " + MEET + "\\nOr dial: " + PHONE + " PIN: " + PIN + "\\nMore phone numbers: " + MORE_PHONES + "\\n\\nAgenda:\\n"
            + "\\n".join(f"{i}. {a}" for i, a in enumerate(AGENDA, 1))
            + "\\n\\nIf this time does not suit, reply to muzahid@vesopa.com with a time that does.")

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'

gcal = "https://calendar.google.com/calendar/render?" + urllib.parse.urlencode({
    "action": "TEMPLATE", "text": TITLE,
    "dates": f"{START_UTC}/{END_UTC}", "location": LOCATION,
    "details": DESC_TXT.replace("\\n", "\n").replace("\\,", ","),
    "add": ",".join(e for _, e in TO + CC)})
outlook = "https://outlook.office.com/calendar/0/deeplink/compose?" + urllib.parse.urlencode({
    "subject": TITLE, "startdt": "2026-10-15T12:30:00Z",
    "enddt": "2026-10-15T13:00:00Z", "location": LOCATION,
    "body": DESC_TXT.replace("\\n", "\n").replace("\\,", ","), "to": ",".join(e for _, e in TO + CC)})


def ready_card(label, title, body):
    return f'''
    <td valign="top" width="33%" style="padding:6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6ff;border-radius:14px;">
        <tr><td style="padding:16px 14px 14px;">
          <div style="{F}font-size:11px;font-weight:800;letter-spacing:1.5px;color:#2f8f00;">&#10003; {label}</div>
          <div style="margin:6px 0 6px;{F}font-size:16px;font-weight:800;color:#0b1a6b;">{title}</div>
          <div style="{F}font-size:13px;line-height:1.5;color:#5f5a68;">{body}</div>
        </td></tr>
      </table>
    </td>'''


def step(n, text):
    return f'''
    <tr>
      <td valign="top" width="40" style="padding:0 0 12px;">
        <div style="width:28px;height:28px;border-radius:14px;background:#0b1a6b;color:#fff;{F}font-size:14px;font-weight:800;line-height:28px;text-align:center;">{n}</div>
      </td>
      <td valign="top" style="padding:3px 0 12px;{F}font-size:15px;line-height:1.55;color:#17141c;">{text}</td>
    </tr>'''


cards = "".join([
    ready_card("LIVE", "Online menu", "Customers pay on Dojo's hosted checkout before the order is sent. The till and kitchen only see it once Dojo confirms the payment."),
    ready_card("LIVE", "Back office switch", "Each venue turns it on in its online menu settings, and can make card payment the only way to order."),
    ready_card("LIVE", "Safe by design", "The result is always read from the payment intent, never the redirect. Failed or abandoned payments cancel the order."),
])
cards2 = "".join([
    ready_card("IN USE", "Match tickets", "Tickets sold on the club website are paid on Dojo's hosted checkout."),
    ready_card("IN USE", "Memberships", "Members join and renew online through the same checkout."),
    ready_card("NEXT", "EPOS and apps", "The same flow for the till, and inside our Android and iOS apps."),
])

html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{SUBJECT}</title>
</head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Hosted checkout is live on our online menu. Today at 1:30pm UK time: the till and our Android and iOS apps.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;">
      <img src="cid:hero@vesopa" width="600" alt="Vesopa and Dojo hosted payments: the online menu paying on Dojo checkout. Thursday 15 October 2026, 1:30pm UK time, Google Meet." style="display:block;width:100%;max-width:600px;height:auto;border:0;">
    </td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hi Alex,</p>
      <p {P}>Thank you for making time today. Ahead of our call at <strong>1:30pm UK time</strong>, here is where we are with hosted payments.</p>
      <p {P}><strong>Dojo's hosted checkout is now built into our online menu</strong> (menu.vesopa.com), so customers can order from their table and pay securely on Dojo's page. We would like to take the same approach to the till and to our Android and iOS apps, and to agree the right way to do it with you.</p>
      <p {P}>What is in place today:</p>
    </td></tr>
    <tr><td style="padding:0 18px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{cards}
      </tr><tr>{cards2}
      </tr></table>
    </td></tr>
    <tr><td style="padding:8px 24px 0;">
      <h2 {H2}>Today's call</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e3ea;border-radius:14px;">
        <tr>
          <td valign="top" width="96" style="padding:18px 0 18px 18px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="78" style="border-radius:12px;overflow:hidden;background:#ffffff;border:1px solid #d9def0;">
              <tr><td align="center" style="background:#0b1a6b;padding:5px 0;{F}font-size:11px;font-weight:800;letter-spacing:1.5px;color:#a5c715;">OCT</td></tr>
              <tr><td align="center" style="padding:6px 0 0;{F}font-size:30px;font-weight:800;line-height:1;color:#0b1a6b;">15</td></tr>
              <tr><td align="center" style="padding:2px 0 8px;{F}font-size:11px;font-weight:700;color:#5f5a68;">THURSDAY</td></tr>
            </table>
          </td>
          <td valign="top" style="padding:18px 18px 18px 6px;">
            <div style="{F}font-size:17px;font-weight:800;color:#0b1a6b;">{TITLE}</div>
            <div style="margin-top:6px;{F}font-size:14px;line-height:1.6;color:#17141c;"><strong>Thursday 15 October 2026</strong><br>1:30pm to 2pm UK time (BST)<br>Google Meet: <a href="{MEET}" style="color:#0b1a6b;font-weight:700;">meet.google.com/bfd-qjtp-xkt</a><br>Or dial: {PHONE}, PIN {PIN}<br><a href="{MORE_PHONES}" style="color:#0b1a6b;">More phone numbers</a></div>
            <div style="margin-top:6px;{F}font-size:13px;line-height:1.5;color:#5f5a68;">With Meirion Davies, Director, and Muzahid Islam</div>
          </td>
        </tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 0;"><tr>
        <td style="border-radius:12px;background:#2f8f00;">
          <a href="{MEET}" style="display:inline-block;padding:13px 22px;{F}font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">Join with Google Meet&nbsp;&rarr;</a>
        </td>
      </tr></table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 6px;"><tr>
        <td style="border-radius:12px;background:#0b1a6b;">
          <a href="{gcal}" style="display:inline-block;padding:13px 20px;{F}font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">Add to Google Calendar&nbsp;<span style="color:#5ad400;">&rarr;</span></a>
        </td>
        <td width="10"></td>
        <td style="border-radius:12px;background:#ffffff;border:2px solid #0b1a6b;">
          <a href="{outlook}" style="display:inline-block;padding:11px 20px;{F}font-size:15px;font-weight:800;color:#0b1a6b;text-decoration:none;border-radius:12px;">Add to Outlook</a>
        </td>
      </tr></table>
      <p style="margin:6px 0 26px;{F}font-size:13px;line-height:1.5;color:#5f5a68;">The calendar invite comes separately from Google Calendar.</p>
    </td></tr>
    <tr><td style="padding:0 24px 0;">
      <h2 {H2}>What we would like to cover</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, a) for i, a in enumerate(AGENDA, 1))}
      </table>
    </td></tr>
    <tr><td style="padding:12px 24px 34px;">
      <p {P}>If anything else would help to see on the call, just reply and we will have it ready.</p>
      <p {P}>Thank you again for all your help. We look forward to speaking with you at 1:30pm.</p>
      <p style="margin:0 0 18px;{F}font-size:16px;line-height:1.6;color:#17141c;">Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:#5f5a68;">Developer, Vesopa Software Ltd</span><br><a href="mailto:muzahid@vesopa.com" style="color:#0b1a6b;">muzahid@vesopa.com</a></p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-left:4px solid #a5c715;"><tr><td style="padding:2px 0 2px 12px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">
        On behalf of <strong style="color:#17141c;">Meirion Davies</strong>, Director<br>Vesopa Software Ltd and Vesopa Ltd<br>
        <a href="mailto:info@vesopasoftware.com" style="color:#0b1a6b;">info@vesopasoftware.com</a> &middot; <a href="mailto:info@vesopa.com" style="color:#0b1a6b;">info@vesopa.com</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="background:#f6f5f9;padding:18px 24px;border-top:4px solid #a5c715;">
      <p style="margin:0;{F}font-size:12px;line-height:1.6;color:#5f5a68;">Vesopa Software Ltd &middot; <a href="https://vesopa.com" style="color:#5f5a68;">vesopa.com</a> &middot; Copied to Meirion Davies, Director (info@vesopasoftware.com, info@vesopa.com).</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
'''

text = f"""Hi Alex,

Thank you for making time today. Ahead of our call at 1:30pm UK time, here is where we are with hosted payments.

Dojo's hosted checkout is now built into our online menu (menu.vesopa.com), so customers can order from their table and pay securely on Dojo's page. We would like to take the same approach to the till and to our Android and iOS apps, and to agree the right way to do it with you.

What is in place today:
- Online menu (live): customers pay on Dojo's hosted checkout before the order is sent. The till and kitchen only see it once Dojo confirms the payment.
- Back office switch (live): each venue turns it on in its online menu settings, and can make card payment the only way to order.
- Safe by design (live): the result is always read from the payment intent, never the redirect. Failed or abandoned payments cancel the order.
- Match tickets and memberships: already paid on Dojo's hosted checkout.
- Next: the same flow for the till, and inside our Android and iOS apps.

TODAY'S CALL
{TITLE}
Thursday 15 October 2026, 1:30pm to 2pm UK time (BST)
Join with Google Meet: {MEET}
Or dial: {PHONE} PIN: {PIN}
More phone numbers: {MORE_PHONES}
The calendar invite comes separately from Google Calendar.

What we would like to cover:
""" + "\n".join(f"{i}. {a}" for i, a in enumerate(AGENDA, 1)) + """

If anything else would help to see on the call, just reply and we will have it ready.

Thank you again for all your help. We look forward to speaking with you at 1:30pm.

Kind regards,
Muzahid Islam
Developer, Vesopa Software Ltd
muzahid@vesopa.com

On behalf of Meirion Davies, Director
Vesopa Software Ltd and Vesopa Ltd
info@vesopasoftware.com | info@vesopa.com
"""

now = datetime.now(timezone.utc)


hero = open(os.path.join(HERE, "hero-hosted.jpg"), "rb").read()

msg = EmailMessage(policy=SMTP)
msg["X-Unsent"] = "1"
msg["From"] = f"{ORG[0]} <{ORG[1]}>"
msg["To"] = ", ".join(f"{n} <{e}>" for n, e in TO)
msg["Cc"] = ", ".join(f"{n} <{e}>" for n, e in CC)
msg["Subject"] = SUBJECT
msg["Date"] = format_datetime(now)
msg["Message-ID"] = make_msgid(domain="vesopa.com")
msg.set_content(text)
msg.add_alternative(html, subtype="html")
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-dojo-hosted-payments.jpg")
open(os.path.join(OUT, "Vesopa-Dojo-hosted.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-hosted.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "vesopa-dojo-hosted.jpg"))
open(os.path.join(OUT, "vesopa-dojo-hosted.jpg"), "wb").write(hero)
open(os.path.join(OUT, "email-hosted.txt"), "w", encoding="utf-8").write(text)
print("ok")
