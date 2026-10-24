"""Certification request: Vesopa EPOS live online payments and subscription billing, 24 Oct 2026.

The owner: "ask Dojo for certification for the live API for Vesopa EPOS
sending mail to Alex and Dojo partner and send a branded mail to get that
online payment API for Vesopa Software Ltd cc Meirion from Vesopa Developer
muzahid@vesopa.com." Built on the Dojo sandbox (vesopa_web/src/dojo-billing.js,
vesopa_web/src/subscriptions.js), the same way as the menu checkout Dojo
already passed for Pontardawe RFC on 20 Oct.

    python build_epos_live.py <out-dir>
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

SUBJECT = "Vesopa EPOS: certification and live API access for online payments and subscription billing (Vesopa Software Ltd)"
TO = [("Alex Radzio", "alex.radzio@dojo.tech"), ("Dojo Partner Technology", "partnertech@dojo.tech")]
CC = [("Meirion Davies", "info@vesopasoftware.com"), ("Meirion Davies", "info@vesopa.com")]
ORG = ("Vesopa Developer", "muzahid@vesopa.com")
TRIAL = "https://vesopaepos.com/trial"
HW = "https://vesopaepos.com/hardware"

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'


def a(href, text, extra=""):
    """A link SMTP2GO leaves alone (data-no-track)."""
    return f'<a href="{href}" data-no-track style="color:#0b1a6b;{extra}">{text}</a>'


ALREADY = [
    ("Card machines", "Vesopa EPOS drives Dojo card machines from the till: sales, refunds, tips, split bills and cashback. Accredited with you in October."),
    ("Online checkout", f"Pontardawe RFC's online menu ({a('https://menu.pontardawerfc.com', 'menu.pontardawerfc.com')}) passed your online checkout review on 20 October and is live on Dojo."),
]

BUILT = [
    f"<strong>Sign-up and trial:</strong> a venue picks a plan on {a(TRIAL, 'vesopaepos.com/trial')}. A £1 payment on Dojo's hosted checkout confirms the card, Apple Pay or Google Pay, and is refunded through the API straight away. A 14-day free trial then starts.",
    "<strong>First charge and renewals:</strong> a payment intent per invoice, paid on Dojo's hosted checkout (pay.dojo.tech) from an emailed link, by card, Apple Pay or Google Pay. Card details are only ever entered on Dojo's page.",
    "<strong>Failed or unpaid payments:</strong> retried on day 2, 4 and 7, with an email each time and a fresh payment link. After that the subscription is suspended, and the venue's tills pause after a 48-hour grace period. They come back on as soon as the payment is captured.",
    "<strong>Status:</strong> we only treat Captured as paid. The webhook names the payment intent, and we always re-read its status from the API before acting. Every POST carries an idempotency key.",
    "<strong>Refunds:</strong> full or partial, through the API, from our admin console. Each one is recorded with who made it.",
    "<strong>Sandbox checks done:</strong> payment intents created and read back, a setup intent created (Unscheduled), and a refund before capture refused as expected.",
]

ASKS = [
    "<strong>Live API access for Vesopa Software Ltd</strong>, so we can take subscription payments for Vesopa EPOS on our own merchant account. Please tell us what you need from us for the review and onboarding.",
    "<strong>Certification of this integration.</strong> We are happy to run any test script you use, as we did for the menu checkout.",
    "<strong>Recurring card-on-file:</strong> setup intents are single-use, so today each renewal is a payment link. Can recurring merchant-initiated payments be enabled for our account, or which Dojo product do you recommend for subscriptions, so renewals can be charged automatically with the customer's consent?",
    "<strong>The sandbox checkout page:</strong> today pay.dojo.tech/checkout/pi_sandbox_... showed \"upstream connect error or disconnect/reset before headers\" on reload, and the card fields did not load. Is this a known sandbox issue?",
]


def step(n, text):
    return f'''<tr><td valign="top" width="40" style="padding:0 0 12px;">
        <div style="width:28px;height:28px;border-radius:14px;background:#0b1a6b;color:#fff;{F}font-size:14px;font-weight:800;line-height:28px;text-align:center;">{n}</div></td>
      <td valign="top" style="padding:3px 0 12px;{F}font-size:15px;line-height:1.55;color:#17141c;">{text}</td></tr>'''


def row(h, t):
    return f'''<tr><td valign="top" width="26" style="padding:9px 0;{F}font-size:15px;color:#2f8f00;font-weight:800;">&#10003;</td>
      <td style="padding:9px 0;border-bottom:1px solid #eef0f7;{F}font-size:14px;line-height:1.55;color:#17141c;"><strong style="color:#0b1a6b;">{h}</strong><br>{t}</td></tr>'''


html = f'''<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>{SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Vesopa EPOS subscriptions on Dojo: built and tested on the sandbox, ready for certification and live access.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;"><img src="cid:hero@vesopa" width="600" alt="Vesopa EPOS: live online payments and subscriptions. Certification request for Dojo." style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hi Alex, and the Partner Technology team,</p>
      <p {P}>Thank you again for taking Pontardawe RFC's online checkout live. We are now launching Vesopa EPOS to new venues, and we want them to pay for their subscription with Dojo too.</p>
      <p {P}>We have built this on the Dojo sandbox. Please could you <strong>certify the integration</strong> and give <strong>Vesopa Software Ltd</strong> access to the <strong>live online payments API</strong>?</p>
    </td></tr>
    <tr><td style="padding:0 24px 8px;">
      <h2 {H2}>Already live with Dojo</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(row(h, t) for h, t in ALREADY)}</table>
    </td></tr>
    <tr><td style="padding:14px 24px 0;">
      <h2 {H2}>What we have built on the sandbox</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(BUILT, 1))}</table>
    </td></tr>
    <tr><td style="padding:0 24px 18px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#2f8f00;">
        <a href="{TRIAL}" data-no-track style="display:inline-block;padding:14px 26px;{F}font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">See the sign-up page&nbsp;&rarr;</a>
      </td></tr></table>
      <p style="margin:12px 0 0;{F}font-size:13px;line-height:1.55;color:#5f5a68;">It runs on our Dojo sandbox key and is marked as a sandbox, so no real money moves. We also sell the venue's hardware on {a(HW, 'vesopaepos.com/hardware')}; card machines come from Dojo on the venue's own merchant account.</p>
    </td></tr>
    <tr><td style="padding:6px 24px 0;">
      <h2 {H2}>What we are asking for</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(ASKS, 1))}</table>
      <p {P}>We would be glad to go through it on a short call whenever suits you. Just reply with a time, or call me on {a("tel:+447848494341", "+44 7848 494341")}.</p>
      <p {P}>Many thanks for your help.</p>
      <p style="margin:0 0 18px;{F}font-size:16px;line-height:1.6;color:#17141c;">Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:#5f5a68;">Vesopa Developer, Vesopa Software Ltd</span><br>{a("mailto:muzahid@vesopa.com", "muzahid@vesopa.com")} &middot; {a("tel:+447848494341", "+44 7848 494341")}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-left:4px solid #a5c715;margin:0 0 30px;"><tr><td style="padding:2px 0 2px 12px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">
        On behalf of <strong style="color:#17141c;">Meirion Davies</strong>, Director<br>Vesopa Software Ltd and Vesopa Ltd<br>
        {a("mailto:info@vesopasoftware.com", "info@vesopasoftware.com")} &middot; {a("mailto:info@vesopa.com", "info@vesopa.com")}
      </td></tr></table>
    </td></tr>
    <tr><td style="background:#f6f5f9;padding:18px 24px;border-top:4px solid #a5c715;">
      <p style="margin:0;{F}font-size:12px;line-height:1.6;color:#5f5a68;">Vesopa Software Ltd &middot; {a("https://vesopa.com", "vesopa.com", "color:#5f5a68;")} &middot; Software house ID SL942X04 &middot; Copied to Meirion Davies, Director.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
'''

assert all("data-no-track" in tag for tag in re.findall(r"<a [^>]*>", html)), "a link without data-no-track"


def plain(t):
    t = t.replace("&pound;", "£").replace("&nbsp;", " ").replace("&rarr;", "->").replace("&middot;", "|")
    return re.sub(r"<[^>]+>", "", t)


text = (
    "Hi Alex, and the Partner Technology team,\n\n"
    "Thank you again for taking Pontardawe RFC's online checkout live. We are now launching Vesopa EPOS to new venues, and we want them to pay for their subscription with Dojo too.\n\n"
    "We have built this on the Dojo sandbox. Please could you certify the integration and give Vesopa Software Ltd access to the live online payments API?\n\n"
    "ALREADY LIVE WITH DOJO\n" + "\n".join(f"- {h}: {plain(t)}" for h, t in ALREADY)
    + "\n\nWHAT WE HAVE BUILT ON THE SANDBOX\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(BUILT, 1))
    + f"\n\nSign-up page: {TRIAL} (sandbox; no real money moves). Hardware: {HW}\n\n"
    "WHAT WE ARE ASKING FOR\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(ASKS, 1))
    + "\n\nWe would be glad to go through it on a short call whenever suits you. Just reply with a time, or call me on +44 7848 494341.\n\n"
    "Many thanks for your help.\n\nKind regards,\nMuzahid Islam\nVesopa Developer, Vesopa Software Ltd\nmuzahid@vesopa.com | +44 7848 494341\n\n"
    "On behalf of Meirion Davies, Director\nVesopa Software Ltd and Vesopa Ltd\ninfo@vesopasoftware.com | info@vesopa.com\n"
)

now = datetime.now(timezone.utc)
hero = open(os.path.join(HERE, "..", "hero-epos-live.jpg"), "rb").read()
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
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-epos-live.jpg")
open(os.path.join(OUT, "Vesopa-Dojo-epos-live.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-epos-live.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "hero-epos-live.jpg"))
print("ok")
