"""Builds the Dojo accreditation review email (12 Oct 21:00): HTML, plain text, .ics invite and an Outlook-ready .eml."""
import os, sys, uuid, urllib.parse
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from email.policy import SMTP

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

SUBJECT = "Vesopa + Dojo accreditation review tonight, 21:00 UK time: UAT round 2 fixes in EPOS 1.16.3"
START_UTC, END_UTC = "20261012T200000Z", "20261012T204500Z"  # 21:00-21:45 BST
START_LOCAL, END_LOCAL = "20261012T210000", "20261012T214500"
MEET = "https://meet.google.com/bpa-fqef-rpz"
PHONE, PIN = "+1 401-830-3638", "899656638"
MORE_PHONES = "https://tel.meet/bpa-fqef-rpz?pin=6859843447630"
LOCATION = MEET
TO = [("Alex Radzio", "alex.radzio@dojo.tech"),
      ("Fintan Bridger", "fintan.bridger@paymentsense.com")]
CC = [("Meirion Davies", "info@vesopasoftware.com"),
      ("Meirion Davies", "info@vesopa.com")]
ORG = ("Muzahid Islam", "muzahid@vesopa.com")

AGENDA = [
    "A quick walk through the UAT round 2 fixes in Vesopa EPOS 1.16.3",
    "Retest the signature flow: accepted, rejected, and Dojo's 80-second auto-accept",
    "Retest matched and unlinked refunds, including expired results",
    "Sign-off, live API access and the go-live date",
]
DESC_TXT = ("Vesopa Dojo accreditation review of Vesopa EPOS 1.16.3.\\n\\nJoin with Google Meet: " + MEET + "\\nOr dial: " + PHONE + " PIN: " + PIN + "\\nMore phone numbers: " + MORE_PHONES + "\\n\\nAgenda:\\n"
            + "\\n".join(f"{i}. {a}" for i, a in enumerate(AGENDA, 1))
            + "\\n\\nIf this time does not suit, reply to muzahid@vesopa.com with a time that does.")

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'

gcal = "https://calendar.google.com/calendar/render?" + urllib.parse.urlencode({
    "action": "TEMPLATE", "text": "Vesopa Dojo Accreditation Review",
    "dates": f"{START_UTC}/{END_UTC}", "location": LOCATION,
    "details": DESC_TXT.replace("\\n", "\n").replace("\\,", ","),
    "add": ",".join(e for _, e in TO + CC)})
outlook = "https://outlook.office.com/calendar/0/deeplink/compose?" + urllib.parse.urlencode({
    "subject": "Vesopa Dojo Accreditation Review", "startdt": "2026-10-12T20:00:00Z",
    "enddt": "2026-10-12T20:45:00Z", "location": LOCATION,
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
    ready_card("FIXED", "Signature", "The till keeps checking the machine during the signature. If Dojo accepts it after 80 seconds, the real result shows."),
    ready_card("FIXED", "Paid means paid", "If the card was charged, the sale is recorded as paid whatever button was pressed. Rejected only shows when Dojo declines."),
    ready_card("FIXED", "Refunds", "Matched and unlinked refunds now run like payments: signature prompt, Cancel and the full result screen."),
])
cards2 = "".join([
    ready_card("FIXED", "Expired results", "Shows Check status, Record and Try again, and keeps asking Dojo every 5 seconds for 5 minutes."),
    ready_card("NEW", "Failed payments", "Failed card payments get their own tab on the till and in the back office, with Dojo's reference and reason."),
    ready_card("UPDATED", "Customer display", "Display 1.6.22 shows card refunds too, as well as the payment status full screen."),
])

VERSIONS = [
    ("Vesopa EPOS", "1.16.3", "Till, with all the Dojo fixes"),
    ("Vesopa Customer Display", "1.6.22", "Card status and refunds on the customer screen"),
    ("Vesopa Kitchen", "1.7.6", "Kitchen screen"),
    ("Vesopa Express", "1.0.13", "Self-service kiosk, also on Dojo"),
]
versions = "".join(f'''
        <tr><td style="padding:12px 16px;border-bottom:1px solid #eef0f7;{F}font-size:15px;color:#17141c;"><strong style="color:#0b1a6b;">{n}</strong> <span style="color:#2f8f00;font-weight:800;">{v}</span><br><span style="font-size:13px;color:#5f5a68;">{d}</span></td>
          <td align="right" valign="middle" style="padding:12px 16px;border-bottom:1px solid #eef0f7;{F}font-size:11px;font-weight:800;letter-spacing:1px;color:#2f8f00;">&#10003; LIVE</td></tr>''' for n, v, d in VERSIONS)

html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{SUBJECT}</title>
</head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Every UAT round 2 point is fixed in Vesopa EPOS 1.16.3, now live on the Microsoft Store. Accreditation review tonight, 21:00 UK time.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;">
      <img src="cid:hero@vesopa" width="600" alt="Vesopa EPOS and Dojo: UAT round 2 fixed in EPOS 1.16.3, accreditation review on Monday 12 October 2026 at 21:00 UK time." style="display:block;width:100%;max-width:600px;height:auto;border:0;">
    </td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hi Alex and Finn,</p>
      <p {P}>Thank you for the UAT round 2 feedback. <strong>We have fixed the signature flow and the expired results on matched and unlinked refunds</strong>, and added a few more improvements along the way. Everything is in <strong>Vesopa EPOS 1.16.3</strong> and <strong>Customer Display 1.6.22</strong>.</p>
      <p {P}>Here is what changed:</p>
    </td></tr>
    <tr><td style="padding:0 18px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{cards}
      </tr><tr>{cards2}
      </tr></table>
    </td></tr>
    <tr><td style="padding:8px 24px 6px;">
      <h2 {H2}>Live on the Microsoft Store</h2>
      <p {P}>All of our Windows apps have been updated and are published on the Microsoft Store today:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e3ea;border-radius:14px;">{versions}
      </table>
      <p style="margin:12px 0 22px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">This release also reads member cards and QR codes at the till, closes the apps straight away on Exit, and makes secure connections more reliable on new PCs.</p>
    </td></tr>
    <tr><td style="padding:8px 24px 0;">
      <h2 {H2}>Accreditation review</h2>
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
            <div style="{F}font-size:17px;font-weight:800;color:#0b1a6b;">Vesopa Dojo Accreditation Review</div>
            <div style="margin-top:6px;{F}font-size:14px;line-height:1.6;color:#17141c;"><strong>Monday 12 October 2026</strong><br>21:00 to 21:45 UK time (BST)<br>Google Meet: <a href="{MEET}" style="color:#0b1a6b;font-weight:700;">meet.google.com/bpa-fqef-rpz</a><br>Or dial: {PHONE}, PIN {PIN}<br><a href="{MORE_PHONES}" style="color:#0b1a6b;">More phone numbers</a></div>
            <div style="margin-top:6px;{F}font-size:13px;line-height:1.5;color:#5f5a68;">Hosted by Muzahid Islam, with Meirion Davies, Director</div>
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
      <p style="margin:6px 0 26px;{F}font-size:13px;line-height:1.5;color:#5f5a68;">The calendar invite is attached as well, so you can accept it straight from your inbox.</p>
    </td></tr>
    <tr><td style="padding:0 24px 0;">
      <h2 {H2}>What we would like to do</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, a) for i, a in enumerate(AGENDA, 1))}
      </table>
    </td></tr>
    <tr><td style="padding:12px 24px 34px;">
      <p {P}>If the time does not suit, just reply with one that works better and we will fit around it. Once the review is signed off, we are ready to move to live API access and launch.</p>
      <p {P}>Thank you again for your help with the accreditation. We look forward to speaking with you tonight.</p>
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

text = f"""Hi Alex and Finn,

Thank you for the UAT round 2 feedback. We have fixed the signature flow and the expired results on matched and unlinked refunds, and added a few more improvements along the way. Everything is in Vesopa EPOS 1.16.3 and Customer Display 1.6.22.

What changed:
- Signature: the till keeps checking the machine during the signature. If Dojo accepts it after 80 seconds, the real result shows.
- Paid means paid: if the card was charged, the sale is recorded as paid whatever button was pressed. Rejected only shows when Dojo declines.
- Refunds: matched and unlinked refunds now run like payments: signature prompt, Cancel and the full result screen.
- Expired results: shows Check status, Record and Try again, and keeps asking Dojo every 5 seconds for 5 minutes.
- Failed payments: failed card payments get their own tab on the till and in the back office, with Dojo's reference and reason.
- Customer display: Display 1.6.22 shows card refunds too, as well as the payment status full screen.

LIVE ON THE MICROSOFT STORE
All of our Windows apps have been updated and are published on the Microsoft Store today:
""" + "\n".join(f"- {n} {v}" for n, v, _ in VERSIONS) + f"""
This release also reads member cards and QR codes at the till, closes the apps straight away on Exit, and makes secure connections more reliable on new PCs.

ACCREDITATION REVIEW
Vesopa Dojo Accreditation Review
Monday 12 October 2026, 21:00 to 21:45 UK time (BST)
Join with Google Meet: {MEET}
Or dial: {PHONE} PIN: {PIN}
More phone numbers: {MORE_PHONES}
The calendar invite is attached, so you can accept it from your inbox.
Add to Google Calendar: {gcal}

What we would like to do:
""" + "\n".join(f"{i}. {a}" for i, a in enumerate(AGENDA, 1)) + """

If the time does not suit, just reply with one that works better and we will fit around it. Once the review is signed off, we are ready to move to live API access and launch.

Thank you again for your help with the accreditation. We look forward to speaking with you tonight.

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
    f"UID:{uuid.uuid4()}@vesopa.com",
    f"DTSTAMP:{now.strftime('%Y%m%dT%H%M%SZ')}",
    f"DTSTART;TZID=Europe/London:{START_LOCAL}",
    f"DTEND;TZID=Europe/London:{END_LOCAL}",
    "SUMMARY:Vesopa Dojo Accreditation Review",
    f"URL:{MEET}",
    f"X-GOOGLE-CONFERENCE:{MEET}",
    f"DESCRIPTION:{DESC_TXT}",
    f"LOCATION:{LOCATION.replace(',', chr(92) + ',')}",
    f'ORGANIZER;CN="{ORG[0]}":mailto:{ORG[1]}',
    *[att(n, e) for n, e in TO],
    *[att(n, e, "OPT-PARTICIPANT") for n, e in CC],
    "SEQUENCE:0", "STATUS:CONFIRMED", "TRANSP:OPAQUE", "CLASS:PUBLIC",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "X-MICROSOFT-CDO-IMPORTANCE:1",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Vesopa Dojo Accreditation Review", "TRIGGER:-PT15M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
]
ics = "\r\n".join(fold(l) for l in ics_lines) + "\r\n"

hero = open(os.path.join(HERE, "hero-review.jpg"), "rb").read()

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
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-dojo-review.jpg")
msg.add_alternative(ics.encode(), maintype="text", subtype="calendar",
                    params={"method": "REQUEST", "charset": "utf-8"})
msg.add_attachment(ics.encode(), maintype="application", subtype="ics",
                   filename="Vesopa-Dojo-review.ics")

open(os.path.join(OUT, "Vesopa-Dojo-review.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "Vesopa-Dojo-review.ics"), "w", newline="").write(ics)
open(os.path.join(OUT, "email-review.html"), "w").write(html.replace("cid:hero@vesopa", "vesopa-dojo-review.jpg"))
open(os.path.join(OUT, "vesopa-dojo-review.jpg"), "wb").write(hero)
open(os.path.join(OUT, "email-review.txt"), "w").write(text)
print("ok")
