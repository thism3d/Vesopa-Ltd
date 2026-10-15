"""Builds the Remote Payments request to Dojo (Fri 16 Oct 2026, 10am UK call): HTML, text, .ics, .eml.

Pontardawe RFC's live key answers 403 "not enabled for Remote Payments" when the
online menu opens Dojo's hosted checkout. This asks Alex to enable it, and
invites him to a short call with Accept / Decline (METHOD:REQUEST).

    python build_remote.py <out-dir>
"""
import os, sys, uuid
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from email.policy import SMTP

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

TITLE = "Vesopa × Dojo: Remote Payments for Pontardawe RFC"
SUBJECT = "Please enable Remote Payments for Pontardawe RFC (Vesopa Software Ltd), quick call tomorrow 10am UK?"
START_LOCAL, END_LOCAL = "20261016T100000", "20261016T103000"
LOCATION = "Google Meet (link to follow) or phone"
TO = [("Alex Radzio", "alex.radzio@dojo.tech")]
CC = [("Meirion Davies", "info@vesopasoftware.com"),
      ("Meirion Davies", "info@vesopa.com")]
ORG = ("Vesopa Developer", "muzahid@vesopa.com")
ACCOUNT = "acc_oyRNdfHOu0ORmqQq_uV2lw"

ASKS = [
    "Remote Payments (online checkout on pay.dojo.tech, card not present) on the account",
    "Apple Pay and Google Pay on that checkout",
    "Refunds through the API, so the till and kitchen screen can refund a cancelled order",
    "The same for the Vesopa Software Ltd product, so every venue on Vesopa can switch it on",
]
DESC_TXT = ("Enabling Remote Payments for Pontardawe RFC on Dojo, so guests can pay at their table on "
            "menu.pontardawerfc.com.\\n\\nAccount: " + ACCOUNT + "\\n\\nWhat we would like enabled:\\n"
            + "\\n".join(f"{i}. {a}" for i, a in enumerate(ASKS, 1))
            + "\\n\\nIf this time does not suit\\, reply to muzahid@vesopa.com with a time that does.")

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'


def step(n, text):
    return f'''
    <tr>
      <td valign="top" width="40" style="padding:0 0 12px;">
        <div style="width:28px;height:28px;border-radius:14px;background:#0b1a6b;color:#fff;{F}font-size:14px;font-weight:800;line-height:28px;text-align:center;">{n}</div>
      </td>
      <td valign="top" style="padding:3px 0 12px;{F}font-size:15px;line-height:1.55;color:#17141c;">{text}</td>
    </tr>'''


html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{SUBJECT}</title>
</head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Pontardawe RFC's live key is not enabled for Remote Payments yet. Could you switch it on? Quick call tomorrow at 10am UK time.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;">
      <img src="cid:hero@vesopa" width="600" alt="Vesopa and Dojo: please enable Remote Payments so guests can pay at their table on menu.pontardawerfc.com. Friday 16 October, 10am UK time." style="display:block;width:100%;max-width:600px;height:auto;border:0;">
    </td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hi Alex,</p>
      <p {P}>Thank you for today's call. The online menu with Dojo's hosted checkout is ready for Pontardawe RFC at <a href="https://menu.pontardawerfc.com/" style="color:#0b1a6b;font-weight:700;">menu.pontardawerfc.com</a>: guests order at their table and pay on Dojo's secure page, and the order reaches the till already paid.</p>
      <p {P}>It works end to end on our sandbox account. On Pontardawe's live account, though, Dojo refuses the payment intent with:</p>
    </td></tr>
    <tr><td style="padding:0 24px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff4f2;border-left:4px solid #C41414;border-radius:10px;">
        <tr><td style="padding:14px 16px;{F}font-size:14px;line-height:1.6;color:#17141c;">
          <strong>403</strong> &middot; &ldquo;Your api key for account <strong>{ACCOUNT}</strong> is not enabled for Remote Payments.&rdquo;
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 24px 6px;">
      <h2 {H2}>Could you please enable</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, a) for i, a in enumerate(ASKS, 1))}
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;border:1px solid #e6e3ea;border-radius:14px;">
        <tr><td style="padding:14px 16px;{F}font-size:14px;line-height:1.7;color:#17141c;">
          <strong style="color:#0b1a6b;">Account</strong> Pontardawe RUGBY Football Club Limited<br>
          <strong style="color:#0b1a6b;">Location</strong> Pontardawe Rugby Club<br>
          <strong style="color:#0b1a6b;">Account id</strong> {ACCOUNT}<br>
          <strong style="color:#0b1a6b;">API key</strong> ag_DXWGB2Zj6&hellip; (product: Vesopa Software Ltd), live<br>
          <strong style="color:#0b1a6b;">Website</strong> menu.pontardawerfc.com
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 24px 0;">
      <h2 {H2}>A quick call tomorrow?</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e3ea;border-radius:14px;">
        <tr>
          <td valign="top" width="96" style="padding:18px 0 18px 18px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="78" style="border-radius:12px;overflow:hidden;background:#ffffff;border:1px solid #d9def0;">
              <tr><td align="center" style="background:#0b1a6b;padding:5px 0;{F}font-size:11px;font-weight:800;letter-spacing:1.5px;color:#a5c715;">OCT</td></tr>
              <tr><td align="center" style="padding:6px 0 0;{F}font-size:30px;font-weight:800;line-height:1;color:#0b1a6b;">16</td></tr>
              <tr><td align="center" style="padding:2px 0 8px;{F}font-size:11px;font-weight:700;color:#5f5a68;">FRIDAY</td></tr>
            </table>
          </td>
          <td valign="top" style="padding:18px 18px 18px 6px;">
            <div style="{F}font-size:17px;font-weight:800;color:#0b1a6b;">{TITLE}</div>
            <div style="margin-top:6px;{F}font-size:14px;line-height:1.6;color:#17141c;"><strong>Friday 16 October 2026</strong><br>10am to 10:30am UK time (BST)<br>Google Meet link to follow, or by phone</div>
            <div style="margin-top:6px;{F}font-size:13px;line-height:1.5;color:#5f5a68;">With Meirion Davies, Director, and the Vesopa developer team</div>
          </td>
        </tr>
      </table>
      <p style="margin:12px 0 26px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">The calendar invite is attached, so you can accept or decline it straight from your inbox. If another time is better for you, just reply with it and we will fit around you, or if it is easier to switch it on without a call, that is perfect too.</p>
    </td></tr>
    <tr><td style="padding:0 24px 34px;">
      <p {P}>Once Remote Payments is on, we will run one small live payment and refund it to confirm, and then open it to Pontardawe's members.</p>
      <p {P}>Thank you again for all your help.</p>
      <p style="margin:0 0 18px;{F}font-size:16px;line-height:1.6;color:#17141c;">Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:#5f5a68;">Vesopa Developer, Vesopa Software Ltd</span><br><a href="mailto:muzahid@vesopa.com" style="color:#0b1a6b;">muzahid@vesopa.com</a></p>
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

Thank you for today's call. The online menu with Dojo's hosted checkout is ready for Pontardawe RFC at https://menu.pontardawerfc.com/ : guests order at their table and pay on Dojo's secure page, and the order reaches the till already paid.

It works end to end on our sandbox account. On Pontardawe's live account, though, Dojo refuses the payment intent with:

  403 "Your api key for account {ACCOUNT} is not enabled for Remote Payments."

Could you please enable:
""" + "\n".join(f"{i}. {a}" for i, a in enumerate(ASKS, 1)) + f"""

Account: Pontardawe RUGBY Football Club Limited
Location: Pontardawe Rugby Club
Account id: {ACCOUNT}
API key: ag_DXWGB2Zj6... (product: Vesopa Software Ltd), live
Website: menu.pontardawerfc.com

A QUICK CALL TOMORROW?
{TITLE}
Friday 16 October 2026, 10am to 10:30am UK time (BST)
Google Meet link to follow, or by phone.
The calendar invite is attached, so you can accept or decline it from your inbox. If another time is better, just reply with it, or if it is easier to switch it on without a call, that is perfect too.

Once Remote Payments is on, we will run one small live payment and refund it to confirm, and then open it to Pontardawe's members.

Thank you again for all your help.

Kind regards,
Muzahid Islam
Vesopa Developer, Vesopa Software Ltd
muzahid@vesopa.com

On behalf of Meirion Davies, Director
Vesopa Software Ltd and Vesopa Ltd
info@vesopasoftware.com | info@vesopa.com
"""

now = datetime.now(timezone.utc)


def fold(line):
    b = line.encode()
    out = []
    while len(b) > 74:
        cut = 74
        while (b[cut] & 0xC0) == 0x80:
            cut -= 1
        out.append(b[:cut].decode()); b = b[cut:]
    out.append(b.decode())
    return "\r\n ".join(out)


def att(name, email, role="REQ-PARTICIPANT"):
    return f'ATTENDEE;CN="{name}";ROLE={role};PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{email}'


esc = lambda t: t.replace(",", "\\,").replace(";", "\\;")
ics_lines = [
    "BEGIN:VCALENDAR", "PRODID:-//Vesopa Software Ltd//Vesopa Mail//EN", "VERSION:2.0",
    "CALSCALE:GREGORIAN", "METHOD:REQUEST",
    "BEGIN:VTIMEZONE", "TZID:Europe/London",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0100", "TZNAME:BST",
    "DTSTART:19700329T010000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0000", "TZNAME:GMT",
    "DTSTART:19701025T020000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    f"UID:{uuid.uuid4()}@vesopa.com",
    f"DTSTAMP:{now.strftime('%Y%m%dT%H%M%SZ')}",
    f"DTSTART;TZID=Europe/London:{START_LOCAL}",
    f"DTEND;TZID=Europe/London:{END_LOCAL}",
    "SUMMARY:" + esc(TITLE),
    f"DESCRIPTION:{DESC_TXT}",
    "LOCATION:" + esc(LOCATION),
    f'ORGANIZER;CN="{ORG[0]}":mailto:{ORG[1]}',
    *[att(n, e) for n, e in TO],
    *[att(n, e, "OPT-PARTICIPANT") for n, e in CC],
    "SEQUENCE:0", "STATUS:CONFIRMED", "TRANSP:OPAQUE", "CLASS:PUBLIC",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "X-MICROSOFT-CDO-IMPORTANCE:1",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(TITLE), "TRIGGER:-PT15M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
]
ics = "\r\n".join(fold(l) for l in ics_lines) + "\r\n"

hero = open(os.path.join(HERE, "hero-remote.jpg"), "rb").read()

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
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-dojo-remote-payments.jpg")
msg.add_alternative(ics.encode(), maintype="text", subtype="calendar",
                    params={"method": "REQUEST", "charset": "utf-8"})
msg.add_attachment(ics.encode(), maintype="application", subtype="ics",
                   filename="Vesopa-Dojo-remote-payments.ics")

open(os.path.join(OUT, "Vesopa-Dojo-remote.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "Vesopa-Dojo-remote.ics"), "w", newline="", encoding="utf-8").write(ics)
open(os.path.join(OUT, "email-remote.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "vesopa-dojo-remote.jpg"))
open(os.path.join(OUT, "vesopa-dojo-remote.jpg"), "wb").write(hero)
print("ok")
