"""Ask Teya's partner technology team to begin certification (2026-10-22).

The Teya integration is built and tested end to end on the sandbox (the test
store partner support set up). This asks to start partner certification for
POSLink (card machines) and Online Payments, and for the next steps and
production credentials.

    python build_certify.py <out-dir>
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

SUBJECT = "Vesopa Software Ltd: ready to begin Teya partner certification (POSLink and Online Payments)"
TO = [("Teya Partner Support", "partnersupport@teya.com")]
CC = [("Meirion Davies", "info@vesopasoftware.com"), ("Meirion Davies", "info@vesopa.com")]
ORG = ("Vesopa Developer", "muzahid@vesopa.com")

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'


def a(href, text, extra=""):
    """A link the mail relay leaves alone (data-no-track)."""
    return f'<a href="{href}" data-no-track style="color:#0b1a6b;{extra}">{text}</a>'


ACCOUNT = [
    ("Company", "Vesopa Software Ltd (Vesopa EPOS, UK hospitality ePOS)"),
    ("Sandbox login", "muzahid@vesopa.com (partner.teya.xyz and the sandbox sign-in)"),
    ("Device Code application", "Client ID c8fb0c2a-081e-49e5-83d2-76731652f1c8"),
    ("Web application", "Client ID be31f2c2-93b6-4074-b472-c5f2fce3ccc8"),
    ("Test store", "\"Vesopa\" (b5244164-f4e7-4a85-b3df-ddc1ded9fefc), card machine \"OTHER\""),
]

# The scenarios in your Windows "Test Your Integration" checklist, all passing.
TESTED = [
    "<strong>Install and start the SDK:</strong> Vesopa EPOS downloads and runs the Teya SDK app 1.9.0 as a sub-process over JSON-RPC, checks the signing certificate first, and initialises on the sandbox.",
    "<strong>Authenticate the merchant:</strong> Device Code flow with our credentials; the back office then lists the store's card machines and lets each till pick its machine.",
    "<strong>Make a payment:</strong> makePaymentAndSubscribe with the live state changes shown on the till (present card, PIN, approved).",
    "<strong>Cancel a payment:</strong> cancelPayment during an in-progress payment, with the result reflected on the till.",
    "<strong>Refund:</strong> full and partial refundPayment back to the card, by the gateway payment id.",
    "<strong>Lost connection:</strong> COMMUNICATION_FAILED and no answer are shown as “not confirmed” with a check-the-machine prompt, never as declined.",
    "<strong>Pay at counter:</strong> once Cloud communication is enabled on the machine (Settings &rarr; POS integrations &rarr; External ePOS integrations), the machine actions the ePOS request as your guide describes.",
]

ONLINE = [
    "Hosted checkout for our table-ordering menu, with plugin registration (pluginType TESTING), a signed registration webhook and payments webhook, and online refunds — all working on the sandbox.",
]

ASKS = [
    "<strong>Begin certification</strong> for POSLink (card machines) and for Online Payments. Please point us at the certification checklist or test script you would like us to evidence, or book a certification call.",
    "<strong>Production credentials:</strong> when should we request the live Device Code and web application credentials, and our own pluginType for online payments (in place of TESTING)?",
    "<strong>Our physical card machine:</strong> Teya has delivered a live card machine for our test venue. Is there anything you need from us to approve it for live ePOS payments once certified?",
    "<strong>Go-live:</strong> the steps and any paperwork to move a venue from sandbox to live once certification passes.",
]


def row(h, t):
    return f'''<tr><td width="34%" valign="top" style="padding:9px 10px 9px 0;border-bottom:1px solid #eef0f7;{F}font-size:13px;font-weight:800;color:#0b1a6b;">{h}</td>
      <td valign="top" style="padding:9px 0;border-bottom:1px solid #eef0f7;{F}font-size:14px;line-height:1.5;color:#17141c;">{t}</td></tr>'''


def step(n, text):
    return f'''<tr><td valign="top" width="40" style="padding:0 0 12px;">
        <div style="width:28px;height:28px;border-radius:14px;background:#0b1a6b;color:#fff;{F}font-size:14px;font-weight:800;line-height:28px;text-align:center;">{n}</div></td>
      <td valign="top" style="padding:3px 0 12px;{F}font-size:15px;line-height:1.55;color:#17141c;">{text}</td></tr>'''


def tick(text):
    return f'''<tr><td valign="top" width="26" style="padding:8px 0;{F}font-size:15px;color:#2f8f00;font-weight:800;">&#10003;</td>
      <td style="padding:8px 0;border-bottom:1px solid #eef0f7;{F}font-size:14px;line-height:1.55;color:#17141c;">{text}</td></tr>'''


html = f'''<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>{SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Our Teya integration is built and tested end to end on the sandbox. We would like to begin partner certification.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;"><img src="cid:hero@vesopa" width="600" alt="Vesopa and Teya: Vesopa EPOS is built and tested on Teya's SDK. Ready to begin partner certification." style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hello Teya Partner Team,</p>
      <p {P}>Thank you again for setting up our sandbox store. We have now built <strong>Teya into Vesopa EPOS</strong> end to end &mdash; card machines on the tills and online payments on our table-ordering menu &mdash; and run the scenarios in your &ldquo;Test Your Integration&rdquo; checklist on the sandbox. <strong>We would like to begin partner certification.</strong></p>
      <p {P}>If this is better handled by your partner technology or integrations team, please forward this on, or point me to the right contact and I will pick it up from there.</p>
    </td></tr>
    <tr><td style="padding:0 24px 8px;">
      <h2 {H2}>Our account</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(row(h, t) for h, t in ACCOUNT)}</table>
    </td></tr>
    <tr><td style="padding:18px 24px 0;">
      <h2 {H2}>POSLink: tested on the sandbox</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(tick(t) for t in TESTED)}</table>
    </td></tr>
    <tr><td style="padding:16px 24px 0;">
      <h2 {H2}>Online Payments: tested on the sandbox</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(tick(t) for t in ONLINE)}</table>
    </td></tr>
    <tr><td style="padding:18px 24px 0;">
      <h2 {H2}>What we would like to agree</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(ASKS, 1))}</table>
    </td></tr>
    <tr><td style="padding:22px 24px 0;">
      <p {P}>We can share a short screen recording of each scenario, or run them live with you on a call &mdash; whichever your certification process prefers. We are ready to go whenever you are.</p>
      <p {P}>Many thanks for your help.</p>
      <p style="margin:0 0 18px;{F}font-size:16px;line-height:1.6;color:#17141c;">Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:#5f5a68;">Vesopa Developer, Vesopa Software Ltd</span><br>{a("mailto:muzahid@vesopa.com", "muzahid@vesopa.com")}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-left:4px solid #a5c715;margin:0 0 30px;"><tr><td style="padding:2px 0 2px 12px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">
        On behalf of <strong style="color:#17141c;">Meirion Davies</strong>, Director<br>Vesopa Software Ltd and Vesopa Ltd<br>
        {a("mailto:info@vesopasoftware.com", "info@vesopasoftware.com")} &middot; {a("mailto:info@vesopa.com", "info@vesopa.com")}
      </td></tr></table>
    </td></tr>
    <tr><td style="background:#f6f5f9;padding:18px 24px;border-top:4px solid #a5c715;">
      <p style="margin:0;{F}font-size:12px;line-height:1.6;color:#5f5a68;">Vesopa Software Ltd &middot; {a("https://vesopa.com", "vesopa.com", "color:#5f5a68;")} &middot; Copied to Meirion Davies, Director.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
'''

assert all("data-no-track" in tag for tag in re.findall(r"<a [^>]*>", html)), "a link without data-no-track"


def plain(t):
    t = t.replace("&nbsp;", " ").replace("&quot;", '"').replace("&mdash;", "-").replace("&rarr;", ">").replace("&ldquo;", '"').replace("&rdquo;", '"').replace("—", "-")
    return re.sub(r"<[^>]+>", "", t)


text = (
    "Hello Teya Partner Team,\n\n"
    "Thank you again for setting up our sandbox store. We have now built Teya into Vesopa EPOS end to end - card machines on the "
    "tills and online payments on our table-ordering menu - and run the scenarios in your \"Test Your Integration\" checklist on "
    "the sandbox. We would like to begin partner certification.\n\n"
    "If this is better handled by your partner technology or integrations team, please forward this on, or point me to the right "
    "contact and I will pick it up from there.\n\n"
    "OUR ACCOUNT\n" + "\n".join(f"- {h}: {plain(t)}" for h, t in ACCOUNT)
    + "\n\nPOSLINK: TESTED ON THE SANDBOX\n" + "\n".join(f"- {plain(t)}" for t in TESTED)
    + "\n\nONLINE PAYMENTS: TESTED ON THE SANDBOX\n" + "\n".join(f"- {plain(t)}" for t in ONLINE)
    + "\n\nWHAT WE WOULD LIKE TO AGREE\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(ASKS, 1))
    + "\n\nWe can share a short screen recording of each scenario, or run them live with you on a call - whichever your "
    "certification process prefers. We are ready to go whenever you are.\n\n"
    "Many thanks for your help.\n\n"
    "Kind regards,\nMuzahid Islam\nVesopa Developer, Vesopa Software Ltd\nmuzahid@vesopa.com\n\n"
    "On behalf of Meirion Davies, Director\nVesopa Software Ltd and Vesopa Ltd\ninfo@vesopasoftware.com | info@vesopa.com\n"
)

hero = open(os.path.join(HERE, "hero-store.jpg"), "rb").read()
msg = EmailMessage(policy=SMTP)
msg["X-Unsent"] = "1"
msg["From"] = f"{ORG[0]} <{ORG[1]}>"
msg["To"] = ", ".join(f"{n} <{e}>" for n, e in TO)
msg["Cc"] = ", ".join(f"{n} <{e}>" for n, e in CC)
msg["Reply-To"] = f"{ORG[0]} <{ORG[1]}>"
msg["Subject"] = SUBJECT
msg["Date"] = format_datetime(datetime.now(timezone.utc))
msg["Message-ID"] = make_msgid(domain="vesopa.com")
msg.set_content(text)
msg.add_alternative(html, subtype="html")
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-teya.jpg")
open(os.path.join(OUT, "Vesopa-Teya-certify.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-certify.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "vesopa-teya.jpg"))
open(os.path.join(OUT, "vesopa-teya.jpg"), "wb").write(hero)
print("ok", TO[0][1])
