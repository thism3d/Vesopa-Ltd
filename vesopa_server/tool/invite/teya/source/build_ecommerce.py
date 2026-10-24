"""Teya: enable Vesopa Software Ltd for the eCommerce API, demo link, 12-month device rental (24 Oct 2026).

The owner: "send Teya a mail partner@ teya globalpartner@teya from info@vesopasoftware.com
to enable the Vesopa Software Ltd (full company information) with the ecommerce API and send
the demo link of The Vesopa Kitchen enabling the Teya payments. Also can we go with Teya Device
Renting program for 12 months." The company details are the Companies House ones (17362206).

    python build_ecommerce.py <out-dir>
"""
import os
import re
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime, make_msgid

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

SUBJECT = "Vesopa Software Ltd: please enable our Teya eCommerce API, and our interest in 12-month device rental"
TO = [("Teya Partnerships", "partner@teya.com"), ("Teya Global Partnerships", "globalpartner@teya.com")]
CC = [("Vesopa EPOS", "info@vesopa.com"), ("Muzahid Islam", "muzahid@vesopa.com")]
ORG = ("Vesopa Software Ltd", "info@vesopasoftware.com")
DEMO = "https://menu.vesopa.com/vesopakitchen"
CH = "https://find-and-update.company-information.service.gov.uk/company/17362206"

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'


def a(href, text, extra=""):
    """A link the mail relay leaves alone (data-no-track)."""
    return f'<a href="{href}" data-no-track style="color:#0b1a6b;{extra}">{text}</a>'


COMPANY = [
    ("Legal name", "Vesopa Software Ltd"),
    ("Company number", f"17362206, registered in England and Wales ({a(CH, 'Companies House record')})"),
    ("Registered address", "Baglan Innovation Centre, Central Avenue, Baglan, Port Talbot SA12 7AX, Wales, United Kingdom"),
    ("Director", "Meirion Davies"),
    ("Business", "Vesopa EPOS: point of sale, kitchen screens, self-service kiosks, online ordering and member apps for UK hospitality"),
    ("Websites", f"{a('https://vesopaepos.com', 'vesopaepos.com')} &middot; {a('https://vesopasoftware.com', 'vesopasoftware.com')}"),
    ("Contact", f"{a('mailto:info@vesopasoftware.com', 'info@vesopasoftware.com')} &middot; {a('tel:+441792316282', '+44 1792 316282')}"),
    ("Technical contact", f"Muzahid Islam, Vesopa Developer &middot; {a('mailto:muzahid@vesopa.com', 'muzahid@vesopa.com')} &middot; {a('tel:+447848494341', '+44 7848 494341')}"),
]

BUILT = [
    "<strong>On the till:</strong> Vesopa EPOS takes card payments through Teya's SDK on Windows (POSLink on Android), chosen per venue from our back office beside Dojo and Barclaycard.",
    f"<strong>Online:</strong> our online menu takes payment on Teya's hosted checkout. The Vesopa Kitchen, our demo venue, runs it on the Teya sandbox: {a(DEMO, 'menu.vesopa.com/vesopakitchen', 'font-weight:700;')}.",
    "<strong>Results:</strong> the outcome is read from Teya after the redirect and from Teya's webhook, so an order is paid exactly once, and a cancelled order is refunded through the API.",
]

HOW = [
    f'Open {a(DEMO, "menu.vesopa.com/vesopakitchen", "font-weight:700;")} and add something to the basket.',
    "Choose to pay by card. You go to Teya's checkout; pay with a Teya sandbox test card.",
    "You return to the order page, which shows the payment result; the order goes to the venue's till and kitchen screen only once it is paid.",
]

ASKS = [
    "<strong>eCommerce API:</strong> please enable Vesopa Software Ltd for Teya's eCommerce (online payments) API, sandbox and live, and tell us what you need from us to onboard and certify the integration.",
    "<strong>Device rental:</strong> we would like to offer Teya card machines to our venues through your device rental programme, on a 12-month term. Could you send the terms, the monthly price per device, the models that work with your SDK and POSLink, and how we place orders for our venues?",
    "<strong>Partner set-up:</strong> if there is a partner agreement or referral programme for software providers like us, we would be glad to join it.",
]


def step(n, text):
    return f'''<tr><td valign="top" width="40" style="padding:0 0 12px;">
        <div style="width:28px;height:28px;border-radius:14px;background:#0b1a6b;color:#fff;{F}font-size:14px;font-weight:800;line-height:28px;text-align:center;">{n}</div></td>
      <td valign="top" style="padding:3px 0 12px;{F}font-size:15px;line-height:1.55;color:#17141c;">{text}</td></tr>'''


def row(h, t):
    return f'''<tr><td valign="top" style="padding:8px 14px 8px 0;border-bottom:1px solid #eef0f7;{F}font-size:13px;line-height:1.5;color:#5f5a68;white-space:nowrap;">{h}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eef0f7;{F}font-size:14px;line-height:1.5;color:#17141c;">{t}</td></tr>'''


html = f'''<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>{SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Please enable Vesopa Software Ltd for Teya's eCommerce API; demo at menu.vesopa.com/vesopakitchen; 12-month device rental.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;"><img src="cid:hero@vesopa" width="600" alt="Vesopa and Teya" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hello Teya Partnerships team,</p>
      <p {P}>We are <strong>Vesopa Software Ltd</strong>, the company behind Vesopa EPOS, a point of sale used by pubs, clubs, cafés and restaurants across Wales. We already work with Teya on the till and on our online menus, and we would now like to take the next steps with you.</p>
    </td></tr>
    <tr><td style="padding:0 24px 8px;">
      <h2 {H2}>Our company</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(row(h, t) for h, t in COMPANY)}</table>
    </td></tr>
    <tr><td style="padding:18px 24px 0;">
      <h2 {H2}>What we have built with Teya</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(BUILT, 1))}</table>
    </td></tr>
    <tr><td style="padding:0 24px 18px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#2f8f00;">
        <a href="{DEMO}" data-no-track style="display:inline-block;padding:14px 26px;{F}font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">Open The Vesopa Kitchen demo&nbsp;&rarr;</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:6px 24px 0;">
      <h2 {H2}>Trying the demo</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(HOW, 1))}</table>
    </td></tr>
    <tr><td style="padding:12px 24px 0;">
      <h2 {H2}>What we would like</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(ASKS, 1))}</table>
      <p {P}>We would be glad to talk it through on a call; just reply with a time that suits, or ring {a("tel:+441792316282", "+44 1792 316282")}.</p>
      <p {P}>Many thanks,</p>
      <p style="margin:0 0 30px;{F}font-size:16px;line-height:1.6;color:#17141c;"><strong>Meirion Davies</strong><br><span style="color:#5f5a68;">Director, Vesopa Software Ltd</span><br>{a("mailto:info@vesopasoftware.com", "info@vesopasoftware.com")} &middot; {a("tel:+441792316282", "+44 1792 316282")}<br><span style="color:#5f5a68;">Technical: Muzahid Islam, {a("mailto:muzahid@vesopa.com", "muzahid@vesopa.com")}</span></p>
    </td></tr>
    <tr><td style="background:#f6f5f9;padding:18px 24px;border-top:4px solid #a5c715;">
      <p style="margin:0;{F}font-size:12px;line-height:1.6;color:#5f5a68;">Vesopa Software Ltd &middot; company number 17362206, registered in England and Wales &middot; Baglan Innovation Centre, Central Avenue, Baglan, Port Talbot SA12 7AX</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
'''

assert all("data-no-track" in tag for tag in re.findall(r"<a [^>]*>", html)), "a link without data-no-track"


def plain(t):
    t = t.replace("&nbsp;", " ").replace("&rarr;", "->").replace("&amp;", "&").replace("&middot;", "|")
    return re.sub(r"<[^>]+>", "", t)


text = (
    "Hello Teya Partnerships team,\n\n"
    "We are Vesopa Software Ltd, the company behind Vesopa EPOS, a point of sale used by pubs, clubs, cafés and restaurants across Wales. "
    "We already work with Teya on the till and on our online menus, and we would now like to take the next steps with you.\n\n"
    "OUR COMPANY\n" + "\n".join(f"- {h}: {plain(t)}" for h, t in COMPANY) + f"\n  Companies House: {CH}\n"
    + "\nWHAT WE HAVE BUILT WITH TEYA\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(BUILT, 1))
    + f"\n\nDemo: {DEMO}\n\nTRYING THE DEMO\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(HOW, 1))
    + "\n\nWHAT WE WOULD LIKE\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(ASKS, 1))
    + "\n\nWe would be glad to talk it through on a call; just reply with a time that suits, or ring +44 1792 316282.\n\nMany thanks,\n\n"
    "Meirion Davies\nDirector, Vesopa Software Ltd\ninfo@vesopasoftware.com | +44 1792 316282\nTechnical: Muzahid Islam, muzahid@vesopa.com\n"
)

now = datetime.now(timezone.utc)
hero = open(os.path.join(HERE, "..", "vesopa-teya.jpg"), "rb").read()
msg = EmailMessage(policy=SMTP)
msg["X-Unsent"] = "1"
msg["From"] = f"{ORG[0]} <{ORG[1]}>"
msg["To"] = ", ".join(f"{n} <{e}>" for n, e in TO)
msg["Cc"] = ", ".join(f"{n} <{e}>" for n, e in CC)
msg["Reply-To"] = "Vesopa Software Ltd <info@vesopasoftware.com>"
msg["Subject"] = SUBJECT
msg["Date"] = format_datetime(now)
msg["Message-ID"] = make_msgid(domain="vesopasoftware.com")
msg.set_content(text)
msg.add_alternative(html, subtype="html")
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-teya.jpg")
open(os.path.join(OUT, "Vesopa-Teya-ecommerce.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-ecommerce.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "vesopa-teya.jpg"))
print("ok")
