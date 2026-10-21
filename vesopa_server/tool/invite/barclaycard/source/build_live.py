"""Builds the Barclaycard Smartpay Fuse live API request (Wed 21 Oct 2026, 11:00 UK call): HTML, text, .ics, .eml.

Vesopa has built Smartpay Fuse into its back office, online menu and EPOS
tills on the sandbox. This asks Barclaycard for live (production) API access,
shows them the Vesopa Kitchen links, and invites them to the call with
Accept / Decline / Maybe (METHOD:REQUEST, RSVP).

    python build_live.py <out-dir> <to-address> [<to-name>]
"""
import os, sys, uuid
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from email.policy import SMTP

OUT = sys.argv[1]
TO = [(sys.argv[3] if len(sys.argv) > 3 else "Barclaycard Smartpay Fuse team", sys.argv[2])]
os.makedirs(OUT, exist_ok=True)

TITLE = "Vesopa x Barclaycard Partner LIVE API meeting for Smartpay Fuse"
SUBJECT = "Vesopa x Barclaycard: live Smartpay Fuse API access, call today 11:00 UK (Google Meet)"
START_LOCAL, END_LOCAL = "20261021T110000", "20261021T113000"
MEET = "https://meet.google.com/qum-eoec-wnf"
DIAL = "+44 20 3957 2080"
PIN = "471279590"
MORE = "https://tel.meet/qum-eoec-wnf?pin=6261463474265"
CC = [("Meirion Davies", "info@vesopasoftware.com"),
      ("Meirion Davies", "info@vesopa.com")]
ORG = ("Vesopa Developer", "muzahid@vesopa.com")
PHONE = "+44 7848 494341"
ORG_ID = "vesopa_uk_1792070796"
MENU = "https://menu.vesopa.com/vesopakitchen"

ASKS = [
    "<strong>Live (production) REST API keys</strong> for Smartpay Fuse, with the merchant (Organization) account for Vesopa Software Ltd",
    "<strong>Unified Checkout</strong> on live, with <strong>Apple Pay, Google Pay</strong> and Click to Pay enabled, and Apple Pay domain registration for our venues' menu domains",
    "<strong>Card payments and refunds</strong> through the REST API (payments, refunds, voids), and Pay by Link",
    "Confirmation of the <strong>go-live / certification steps</strong> for a partner taking payments for many hospitality venues (sub-merchants)",
    "Whether Barclaycard can offer an <strong>in-person card terminal API</strong> (cloud or local) for EPOS tills",
]
ASKS_TXT = [a.replace("<strong>", "").replace("</strong>", "") for a in ASKS]
DESC_TXT = ("Live Smartpay Fuse API access for Vesopa (Vesopa Software Ltd).\\n\\n"
            "Join with Google Meet: " + MEET + "\\nOr dial: " + DIAL + " PIN: " + PIN + "\\nMore phone numbers: " + MORE
            + "\\n\\nWhat we would like to agree:\\n" + "\\n".join(f"{i}. {a}" for i, a in enumerate(ASKS_TXT, 1))
            + "\\n\\nSandbox organisation: " + ORG_ID + "\\nLive demo: " + MENU
            + "\\n\\nVesopa Developer: muzahid@vesopa.com\\, " + PHONE)

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#00395d;"'
BLUE = "#00aeef"
NAVY = "#00395d"


def step(n, text):
    return f'''
    <tr>
      <td valign="top" width="40" style="padding:0 0 12px;">
        <div style="width:28px;height:28px;border-radius:14px;background:{NAVY};color:#fff;{F}font-size:14px;font-weight:800;line-height:28px;text-align:center;">{n}</div>
      </td>
      <td valign="top" style="padding:3px 0 12px;{F}font-size:15px;line-height:1.55;color:#17141c;">{text}</td>
    </tr>'''


def built(title, text):
    return f'''
        <tr><td style="padding:0 0 10px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dbe7ef;border-radius:12px;">
            <tr><td style="padding:12px 14px;{F}font-size:14px;line-height:1.55;color:#17141c;">
              <span style="display:inline-block;width:18px;height:18px;border-radius:9px;background:#a5c715;color:#0b1a00;text-align:center;font-weight:800;font-size:12px;line-height:18px;">&#10003;</span>
              &nbsp;<strong style="color:{NAVY};">{title}</strong><br><span style="color:#4a5560;">{text}</span>
            </td></tr>
          </table>
        </td></tr>'''


BUILT = [
    ("Online menu: Barclaycard's Unified Checkout", f'Guests order at their table and pay on Barclaycard\'s secure card form, which opens straight away. Paid orders reach the till and kitchen already paid. Live demo on our sandbox: <a href="{MENU}" style="color:{NAVY};font-weight:700;">menu.vesopa.com/vesopakitchen</a>.'),
    ("EPOS till: pay on the customer's phone", "Card on the till shows a QR code (on the till and the customer display). The customer pays by card, Apple Pay or Google Pay on Barclaycard's form, and the sale closes on the till by itself. Cancel, status check and refunds to the card from the till."),
    ("Back office: per venue, sandbox and live", "Each venue saves its own Smartpay Fuse keys (checked with Barclaycard before saving, shared secret stored encrypted) and chooses Dojo, Teya or Barclaycard for its tills and its online menu in one tap."),
    ("Tested on the sandbox", "Payments, refunds, voids and capture contexts (HTTP Signature, REST) against api.smartpayfuse-test.barclaycard, on our test venue The Vesopa Kitchen."),
]

html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{SUBJECT}</title>
</head>
<body style="margin:0;padding:0;background:#eef3f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Smartpay Fuse is built into Vesopa's online menu and EPOS tills on the sandbox. We would like to go live. Call today 11:00 UK on Google Meet.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:{NAVY};background-image:linear-gradient(135deg,{NAVY} 0%,#00639e 60%,{BLUE} 100%);padding:28px 28px 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="{F}font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.3px;">vesopa</td>
        <td style="padding:0 12px;{F}font-size:20px;font-weight:700;color:#a5c715;">&times;</td>
        <td style="{F}font-size:22px;font-weight:700;color:#ffffff;">barclaycard</td>
      </tr></table>
      <div style="margin-top:18px;{F}font-size:11px;font-weight:800;letter-spacing:2px;color:#a5c715;">SMARTPAY FUSE &middot; PARTNER</div>
      <div style="margin-top:6px;{F}font-size:28px;line-height:1.15;font-weight:800;color:#ffffff;">Ready to go live with<br>Smartpay Fuse</div>
      <div style="margin-top:10px;{F}font-size:14px;line-height:1.5;color:#d4ecf8;">Online menu, EPOS tills and back office, built and tested on your sandbox.</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>
        <td style="background:#a5c715;border-radius:20px;padding:6px 12px;{F}font-size:12px;font-weight:800;color:{NAVY};">Today 11:00 UK</td>
        <td width="8"></td>
        <td style="background:rgba(255,255,255,0.16);border-radius:20px;padding:6px 12px;{F}font-size:12px;font-weight:700;color:#ffffff;">Google Meet</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:32px 24px 6px;">
      <p {P}>Hello Barclaycard team,</p>
      <p {P}>I am the developer at <strong>Vesopa Software Ltd</strong>, which makes the Vesopa EPOS, back office and online ordering used by hospitality venues and clubs in the UK. A client asked us to offer Barclaycard, so we have built <strong>Smartpay Fuse</strong> into Vesopa on our sandbox account (Organization ID <strong>{ORG_ID}</strong>), and we would now like to take it live.</p>
    </td></tr>
    <tr><td style="padding:0 24px 8px;">
      <h2 {H2}>What is built</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(built(t, x) for t, x in BUILT)}
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;"><tr>
        <td style="background:{NAVY};border-radius:10px;"><a href="{MENU}" style="display:inline-block;padding:12px 18px;{F}font-size:15px;font-weight:800;color:#ffffff;text-decoration:none;">Open The Vesopa Kitchen menu &rarr;</a></td>
      </tr></table>
      <p style="margin:-8px 0 20px;{F}font-size:13px;line-height:1.55;color:#5f5a68;">Sandbox: choose a table, order, Pay by card, and use test card 4111 1111 1111 1111 (any future expiry, CVV 123). Test orders never reach a till or the takings.</p>
    </td></tr>
    <tr><td style="padding:0 24px 6px;">
      <h2 {H2}>What we would like to agree</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, a) for i, a in enumerate(ASKS, 1))}
      </table>
    </td></tr>
    <tr><td style="padding:6px 24px 0;">
      <h2 {H2}>Our call today</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dbe7ef;border-radius:14px;">
        <tr>
          <td valign="top" width="96" style="padding:18px 0 18px 18px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="78" style="border-radius:12px;overflow:hidden;background:#ffffff;border:1px solid #cfe3ef;">
              <tr><td align="center" style="background:{NAVY};padding:5px 0;{F}font-size:11px;font-weight:800;letter-spacing:1.5px;color:#a5c715;">OCT</td></tr>
              <tr><td align="center" style="padding:6px 0 0;{F}font-size:30px;font-weight:800;line-height:1;color:{NAVY};">21</td></tr>
              <tr><td align="center" style="padding:2px 0 8px;{F}font-size:11px;font-weight:700;color:#5f5a68;">WEDNESDAY</td></tr>
            </table>
          </td>
          <td valign="top" style="padding:18px 18px 18px 6px;">
            <div style="{F}font-size:16px;font-weight:800;color:{NAVY};">{TITLE}</div>
            <div style="margin-top:6px;{F}font-size:14px;line-height:1.6;color:#17141c;"><strong>Wednesday 21 October 2026</strong><br>11:00 to 11:30 UK time (BST)</div>
            <div style="margin-top:10px;"><a href="{MEET}" style="display:inline-block;background:{BLUE};color:#ffffff;border-radius:10px;padding:10px 16px;{F}font-size:14px;font-weight:800;text-decoration:none;">Join Google Meet</a></div>
            <div style="margin-top:10px;{F}font-size:13px;line-height:1.6;color:#4a5560;">{MEET.replace("https://", "")}<br>Or dial {DIAL}, PIN {PIN}<br><a href="{MORE}" style="color:{NAVY};">More phone numbers</a></div>
            <div style="margin-top:8px;{F}font-size:13px;line-height:1.5;color:#5f5a68;">With Meirion Davies, Director, and the Vesopa developer</div>
          </td>
        </tr>
      </table>
      <p style="margin:12px 0 26px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">The calendar invite is attached: <strong>Accept, Decline or Maybe</strong> straight from your inbox and the answer comes back to us. If 11:00 does not suit, reply with a better time, or call me on <a href="tel:+447848494341" style="color:{NAVY};font-weight:700;">{PHONE}</a>.</p>
    </td></tr>
    <tr><td style="padding:0 24px 34px;">
      <p {P}>Thank you, and we look forward to speaking with you.</p>
      <p style="margin:0 0 18px;{F}font-size:16px;line-height:1.6;color:#17141c;">Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:#5f5a68;">Vesopa Developer, Vesopa Software Ltd</span><br><a href="mailto:muzahid@vesopa.com" style="color:{NAVY};">muzahid@vesopa.com</a> &middot; <a href="tel:+447848494341" style="color:{NAVY};">{PHONE}</a></p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-left:4px solid #a5c715;"><tr><td style="padding:2px 0 2px 12px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">
        On behalf of <strong style="color:#17141c;">Meirion Davies</strong>, Director<br>Vesopa Software Ltd and Vesopa Ltd<br>
        <a href="mailto:info@vesopasoftware.com" style="color:{NAVY};">info@vesopasoftware.com</a> &middot; <a href="mailto:info@vesopa.com" style="color:{NAVY};">info@vesopa.com</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="background:#f4f8fb;padding:18px 24px;border-top:4px solid {BLUE};">
      <p style="margin:0;{F}font-size:12px;line-height:1.6;color:#5f5a68;">Vesopa Software Ltd &middot; <a href="https://vesopa.com" style="color:#5f5a68;">vesopa.com</a> &middot; Copied to Meirion Davies, Director (info@vesopasoftware.com, info@vesopa.com).</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
'''

text = f"""Hello Barclaycard team,

I am the developer at Vesopa Software Ltd, which makes the Vesopa EPOS, back office and online ordering used by hospitality venues and clubs in the UK. A client asked us to offer Barclaycard, so we have built Smartpay Fuse into Vesopa on our sandbox account (Organization ID {ORG_ID}), and we would now like to take it live.

WHAT IS BUILT
""" + "\n".join(f"- {t}: " + x.replace(f'<a href="{MENU}" style="color:{NAVY};font-weight:700;">menu.vesopa.com/vesopakitchen</a>', MENU) for t, x in BUILT) + f"""

Live demo (sandbox): {MENU}
Choose a table, order, Pay by card, test card 4111 1111 1111 1111 (any future expiry, CVV 123). Test orders never reach a till or the takings.

WHAT WE WOULD LIKE TO AGREE
""" + "\n".join(f"{i}. {a}" for i, a in enumerate(ASKS_TXT, 1)) + f"""

OUR CALL TODAY
{TITLE}
Wednesday 21 October 2026, 11:00 to 11:30 UK time (BST)
Google Meet: {MEET}
Or dial {DIAL}, PIN {PIN}
More phone numbers: {MORE}

The calendar invite is attached: Accept, Decline or Maybe from your inbox. If 11:00 does not suit, reply with a better time, or call me on {PHONE}.

Thank you, and we look forward to speaking with you.

Kind regards,
Muzahid Islam
Vesopa Developer, Vesopa Software Ltd
muzahid@vesopa.com | {PHONE}

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
    "LOCATION:" + esc(MEET),
    f"URL:{MEET}",
    "CONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL=Google Meet:" + MEET,
    f'ORGANIZER;CN="{ORG[0]}":mailto:{ORG[1]}',
    *[att(n, e) for n, e in TO],
    *[att(n, e, "OPT-PARTICIPANT") for n, e in CC],
    "SEQUENCE:0", "STATUS:CONFIRMED", "TRANSP:OPAQUE", "CLASS:PUBLIC",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "X-MICROSOFT-CDO-IMPORTANCE:1",
    "X-GOOGLE-CONFERENCE:" + MEET,
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(TITLE), "TRIGGER:-PT15M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
]
ics = "\r\n".join(fold(l) for l in ics_lines) + "\r\n"

msg = EmailMessage(policy=SMTP)
msg["X-Unsent"] = "1"
msg["From"] = f"{ORG[0]} <{ORG[1]}>"
msg["To"] = ", ".join(f"{n} <{e}>" for n, e in TO)
msg["Cc"] = ", ".join(f"{n} <{e}>" for n, e in CC)
msg["Reply-To"] = f"{ORG[0]} <{ORG[1]}>"
msg["Subject"] = SUBJECT
msg["Date"] = format_datetime(now)
msg["Message-ID"] = make_msgid(domain="vesopa.com")
msg.set_content(text)
msg.add_alternative(html, subtype="html")
msg.add_alternative(ics.encode(), maintype="text", subtype="calendar",
                    params={"method": "REQUEST", "charset": "utf-8"})
msg.add_attachment(ics.encode(), maintype="application", subtype="ics",
                   filename="Vesopa-Barclaycard-live-API.ics")

open(os.path.join(OUT, "Vesopa-Barclaycard-live.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "Vesopa-Barclaycard-live.ics"), "w", newline="", encoding="utf-8").write(ics)
open(os.path.join(OUT, "email-live.html"), "w", encoding="utf-8").write(html)
print("ok", TO[0][1])
