"""Builds the Dojo kick-off email: HTML, plain text, .ics invite and an Outlook-ready .eml."""
import os, sys, uuid, urllib.parse
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from email.policy import SMTP

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

SUBJECT = "Please confirm: Vesopa + Dojo final testing today, Monday 12 October, 10:30 UK time"
START_UTC, END_UTC = "20261012T093000Z", "20261012T101500Z"  # 10:30-11:15 BST
START_LOCAL, END_LOCAL = "20261012T103000", "20261012T111500"
LOCATION = "Online meeting (joining link to follow)"
TO = [("Alex Radzio", "alex.radzio@dojo.tech"),
      ("Fintan Bridger", "fintan.bridger@paymentsense.com"),
      ("Oliver England", "oliver.england@paymentsense.com")]
CC = [("Meirion Davies", "info@vesopasoftware.com"),
      ("Meirion Davies", "info@vesopa.com")]
ORG = ("Muzahid Islam", "muzahid@vesopa.com")

AGENDA = [
    "A quick walk through the fixes in Vesopa EPOS 1.16.0",
    "Your final test run against the accreditation sheet",
    "Retests of matched refunds and signature verification",
    "Sign-off, live API access and the go-live date",
]
DESC_TXT = ("Final accreditation testing of Vesopa EPOS 1.16.0 with Dojo.\\n\\nAgenda:\\n"
            + "\\n".join(f"{i}. {a}" for i, a in enumerate(AGENDA, 1))
            + "\\n\\nIf this time does not suit, reply to muzahid@vesopa.com with a time that does.")

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'

gcal = "https://calendar.google.com/calendar/render?" + urllib.parse.urlencode({
    "action": "TEMPLATE", "text": "Vesopa + Dojo final testing",
    "dates": f"{START_UTC}/{END_UTC}", "location": LOCATION,
    "details": DESC_TXT.replace("\\n", "\n"),
    "add": ",".join(e for _, e in TO + CC)})
outlook = "https://outlook.office.com/calendar/0/deeplink/compose?" + urllib.parse.urlencode({
    "subject": "Vesopa + Dojo final testing", "startdt": "2026-10-12T09:30:00Z",
    "enddt": "2026-10-12T10:15:00Z", "location": LOCATION,
    "body": DESC_TXT.replace("\\n", "\n"), "to": ",".join(e for _, e in TO + CC)})


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
    ready_card("FIXED", "Software house ID", "SL942X04 is now sent on every Dojo call, from the till and the Express kiosk."),
    ready_card("FIXED", "API key check", "Saving the Dojo settings checks with Dojo first, so a wrong key or offline machine is caught straight away."),
    ready_card("FIXED", "Result screens", "Results stay up for 5, 10 or 15 seconds. Expired or unknown results never close on their own."),
])
cards2 = "".join([
    ready_card("FIXED", "Refunds", "Refund from the card payments list or from a receipt, with manager approval for unlinked refunds."),
    ready_card("FIXED", "Card log", "Every card payment is logged and shown on a new Card Payments page in the back office."),
    ready_card("FIXED", "Payment steps", "Steps only ever move forward, and the customer display shows the card status full screen."),
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Every point from the accreditation sheet is fixed in Vesopa EPOS 1.16.0. Final testing proposed for Monday 12 October at 10:30 UK time.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;">
      <img src="cid:hero@vesopa" width="600" alt="Vesopa EPOS and Dojo: accreditation fixes done, final testing on Monday 12 October 2026 at 10:30 UK time." style="display:block;width:100%;max-width:600px;height:auto;border:0;">
    </td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hi Finn, Alex and Oliver,</p>
      <p {P}>Following our email last night, could you please <strong>confirm that today's final testing at 10:30 UK time still works for you</strong>? A quick reply to this email, or accepting the attached calendar invite, is all we need.</p>
      <p {P}>If today does not suit, just reply with a time that works better and we will fit around it. If you would prefer to use your own meeting link, please send it over and we will join from that.</p>
      <p {P}>As a reminder, every point from the accreditation sheet is fixed in <strong>Vesopa EPOS 1.16.0</strong> and <strong>Customer Display 1.6.20</strong>:</p>
    </td></tr>
    <tr><td style="padding:0 18px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{cards}
      </tr><tr>{cards2}
      </tr></table>
    </td></tr>
    <tr><td style="padding:8px 24px 0;">
      <h2 {H2}>Final testing</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e3ea;border-radius:14px;">
        <tr>
          <td valign="top" width="96" style="padding:18px 0 18px 18px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="78" style="border-radius:12px;overflow:hidden;background:#ffffff;border:1px solid #d9def0;">
              <tr><td align="center" style="background:#0b1a6b;padding:5px 0;{F}font-size:11px;font-weight:800;letter-spacing:1.5px;color:#a5c715;">OCT</td></tr>
              <tr><td align="center" style="padding:6px 0 0;{F}font-size:30px;font-weight:800;line-height:1;color:#0b1a6b;">12</td></tr>
              <tr><td align="center" style="padding:2px 0 8px;{F}font-size:11px;font-weight:700;color:#5f5a68;">MONDAY</td></tr>
            </table>
          </td>
          <td valign="top" style="padding:18px 18px 18px 6px;">
            <div style="{F}font-size:17px;font-weight:800;color:#0b1a6b;">Vesopa + Dojo final testing</div>
            <div style="margin-top:6px;{F}font-size:14px;line-height:1.6;color:#17141c;"><strong>Monday 12 October 2026</strong><br>10:30 to 11:15 UK time (BST)<br>{LOCATION}</div>
            <div style="margin-top:6px;{F}font-size:13px;line-height:1.5;color:#5f5a68;">Hosted by Muzahid Islam, with Meirion Davies, Director</div>
          </td>
        </tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 6px;"><tr>
        <td style="border-radius:12px;background:#0b1a6b;">
          <a href="{gcal}" style="display:inline-block;padding:13px 20px;{F}font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">Add to Google Calendar&nbsp;<span style="color:#5ad400;">&rarr;</span></a>
        </td>
        <td width="10"></td>
        <td style="border-radius:12px;background:#ffffff;border:2px solid #0b1a6b;">
          <a href="{outlook}" style="display:inline-block;padding:11px 20px;{F}font-size:15px;font-weight:800;color:#0b1a6b;text-decoration:none;border-radius:12px;">Add to Outlook</a>
        </td>
      </tr></table>
      <p style="margin:6px 0 26px;{F}font-size:13px;line-height:1.5;color:#5f5a68;">The calendar invite is attached as well, so you can accept it straight from your inbox.</p>
    </td></tr>
    <tr><td style="padding:0 24px 0;">
      <h2 {H2}>What we would like to do</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, a) for i, a in enumerate(AGENDA, 1))}
      </table>
    </td></tr>
    <tr><td style="padding:12px 24px 34px;">
      <p {P}>Once the testing is signed off, we are ready to move to live API access and launch.</p>
      <p {P}>Thank you, and we look forward to hearing from you.</p>
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

text = f"""Hi Finn, Alex and Oliver,

Following our email last night, could you please confirm that today's final testing at 10:30 UK time still works for you? A quick reply to this email, or accepting the attached calendar invite, is all we need.

If today does not suit, just reply with a time that works better and we will fit around it. If you would prefer to use your own meeting link, please send it over and we will join from that.

As a reminder, every point from the accreditation sheet is fixed in Vesopa EPOS 1.16.0 and Customer Display 1.6.20:
- Software house ID: SL942X04 is now sent on every Dojo call, from the till and the Express kiosk.
- API key check: saving the Dojo settings checks with Dojo first, so a wrong key or offline machine is caught straight away.
- Result screens: results stay up for 5, 10 or 15 seconds. Expired or unknown results never close on their own.
- Refunds: refund from the card payments list or from a receipt, with manager approval for unlinked refunds.
- Card log: every card payment is logged and shown on a new Card Payments page in the back office.
- Payment steps: steps only ever move forward, and the customer display shows the card status full screen.

FINAL TESTING
Vesopa + Dojo final testing
Monday 12 October 2026, 10:30 to 11:15 UK time (BST)
{LOCATION}
The calendar invite is attached, so you can accept it from your inbox.
Add to Google Calendar: {gcal}

What we would like to do:
""" + "\n".join(f"{i}. {a}" for i, a in enumerate(AGENDA, 1)) + """

Once the testing is signed off, we are ready to move to live API access and launch.

Thank you, and we look forward to hearing from you.

Kind regards,
Muzahid Islam
Developer, Vesopa Software Ltd
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
    "UID:5885c584-039e-4ee7-8225-16a22f4e8667@vesopa.com",
    f"DTSTAMP:{now.strftime('%Y%m%dT%H%M%SZ')}",
    f"DTSTART;TZID=Europe/London:{START_LOCAL}",
    f"DTEND;TZID=Europe/London:{END_LOCAL}",
    "SUMMARY:Vesopa + Dojo final testing",
    f"DESCRIPTION:{DESC_TXT}",
    f"LOCATION:{LOCATION.replace(',', chr(92) + ',')}",
    f'ORGANIZER;CN="{ORG[0]}":mailto:{ORG[1]}',
    *[att(n, e) for n, e in TO],
    *[att(n, e, "OPT-PARTICIPANT") for n, e in CC],
    "SEQUENCE:1", "STATUS:CONFIRMED", "TRANSP:OPAQUE", "CLASS:PUBLIC",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "X-MICROSOFT-CDO-IMPORTANCE:1",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Vesopa + Dojo final testing", "TRIGGER:-PT15M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
]
ics = "\r\n".join(fold(l) for l in ics_lines) + "\r\n"

hero = open(os.path.join(HERE, "hero-fixes.jpg"), "rb").read()

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
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-dojo-final-testing.jpg")
msg.add_alternative(ics.encode(), maintype="text", subtype="calendar",
                    params={"method": "REQUEST", "charset": "utf-8"})
msg.add_attachment(ics.encode(), maintype="application", subtype="ics",
                   filename="Vesopa-Dojo-confirm.ics")

open(os.path.join(OUT, "Vesopa-Dojo-confirm.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "Vesopa-Dojo-confirm.ics"), "w", newline="").write(ics)
open(os.path.join(OUT, "email-confirm.html"), "w").write(html.replace("cid:hero@vesopa", "vesopa-dojo-final-testing.jpg"))
open(os.path.join(OUT, "vesopa-dojo-final-testing.jpg"), "wb").write(hero)
open(os.path.join(OUT, "email-confirm.txt"), "w").write(text)
print("ok")
