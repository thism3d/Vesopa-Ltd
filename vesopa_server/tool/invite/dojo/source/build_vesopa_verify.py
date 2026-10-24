"""Vesopa Software Ltd: online checkout ready for Dojo's review and live API, 24 Oct 2026 (evening).

The owner: "After fixing everything properly send dojo another mail not asking any
issues. And ask them to check and verify our live api." Follows the online checkout
checklist (docs.dojo.tech .../checkout-page/checklist) the way the Pontardawe RFC
review did (build_staging2.py). vesopaepos.com/trial runs on the Vesopa sandbox account.

    python build_vesopa_verify.py <out-dir>
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

SUBJECT = "Vesopa Software Ltd: online checkout ready for your review, please verify and enable our live API"
TO = [("Alex Radzio", "alex.radzio@dojo.tech"), ("Dojo Partner Technology", "partnertech@dojo.tech")]
CC = [("Meirion Davies", "info@vesopasoftware.com"), ("Meirion Davies", "info@vesopa.com")]
ORG = ("Vesopa Developer", "muzahid@vesopa.com")
SITE = "https://vesopaepos.com"
LINK = SITE + "/trial"

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'


def a(href, text, extra=""):
    """A link SMTP2GO leaves alone (data-no-track)."""
    return f'<a href="{href}" data-no-track style="color:#0b1a6b;{extra}">{text}</a>'


CHECKS = [
    ("Contact details", "Business address, email and telephone in the footer of every page."),
    ("Legal entity name", "Vesopa Software Ltd, registered in England and Wales, company number 17362206, Baglan Innovation Centre, Central Avenue, Baglan, Port Talbot SA12 7AX, in every footer and in the terms."),
    ("Refund policy", f"A clearly labelled Refund policy at {a(SITE + '/refund', 'vesopaepos.com/refund')}, with a section on refunds of online card payments."),
    ("Privacy policy", f"{a(SITE + '/privacy', 'vesopaepos.com/privacy')}, which names Dojo (Paymentsense Limited) for online card payments."),
    ("Terms and conditions", f"{a(SITE + '/terms', 'vesopaepos.com/terms')}, naming the legal entity, with Paying online by card and Free trial and subscriptions sections, and links to the refund and privacy policies."),
    ("Card scheme logos", "Visa, Mastercard, Apple Pay and Google Pay in every footer and beside the pay button."),
    ("Secure checkout page", "HTTPS throughout; card details are entered only on Dojo's hosted checkout (pay.dojo.tech)."),
    ("API keys", "Our secret key is held only on our server, never in a web page or an app."),
]

FLOW = [
    "Successful payment: Dojo's checkout returns to vesopaepos.com/trial/done, which reads the result from the payment intent with our key (never from the redirect), starts the trial and refunds the &pound;1 through the API.",
    "Unsuccessful payment: the page shows Payment not finished, with Try again and Cancel. Nothing is started.",
    "Successful payment after an unsuccessful one: Try again refreshes the client session secret before returning to the same checkout.",
    "3-D Secure, successful and unsuccessful: handled on Dojo's checkout page; the result comes back through the payment intent.",
    "Cancel on Dojo's checkout: the intent carries a cancelUrl as well as a redirectUrl; the page says nothing was charged.",
    "Paid, then the browser closed before the redirect: the payment_intent.status_updated webhook starts the trial within seconds, and a check every 5 minutes asks Dojo about any card check still waiting.",
    "Webhooks: https://backoffice.vesopaepos.com/api/webhooks/dojo/sandbox verifies the dojo-signature (a forged or missing one is refused with 401), handles duplicate deliveries by event id, and always confirms the status with Dojo before acting.",
    "Errors (4xx and 5xx): handled as exceptions and logged with Dojo's traceId; the customer is told plainly and can try again.",
    "Refunds: through the API with an idempotency key, automatically for the &pound;1 trial card check and from our admin console.",
]

HOW = [
    f'Open {a(LINK, "vesopaepos.com/trial", "font-weight:700;")} and pick a plan.',
    "Add an extra if you like, then give a venue name and an email address and press <strong>Pay &pound;1 &amp; start my trial</strong>.",
    "Pay on Dojo's checkout with your sandbox test cards (including the 3-D Secure and decline cards), or use its Back option to cancel.",
    "You come back to vesopaepos.com: <strong>Your trial has started</strong> (and the &pound;1 is refunded), or <strong>Payment not finished</strong> with the options to try again or cancel.",
]

ASKS = [
    "Please review vesopaepos.com against the online checkout checklist and let us know if anything needs changing.",
    "Once you are happy, please verify Vesopa Software Ltd for online checkout and issue our live (sk_prod_) key, so we can switch from the sandbox.",
    "We will set the live webhook to https://backoffice.vesopaepos.com/api/webhooks/dojo/live, configured exactly as the sandbox one, and make our first live call straight away.",
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Vesopa Software Ltd: online checkout at vesopaepos.com is ready for your review.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;"><img src="cid:hero@vesopa" width="600" alt="Vesopa Software Ltd: online checkout ready for review at vesopaepos.com." style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hi Alex, and the Partner Technology team,</p>
      <p {P}>Thank you for your help with Pontardawe RFC. We have now built the same online checkout for <strong>Vesopa Software Ltd</strong> itself: venues start a free trial of Vesopa EPOS on our website with a &pound;1 card check on Dojo's hosted checkout, refunded straight away. We have followed your online checkout checklist, and it is ready for your review:</p>
    </td></tr>
    <tr><td style="padding:0 24px 18px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#2f8f00;">
        <a href="{LINK}" data-no-track style="display:inline-block;padding:14px 26px;{F}font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">Open vesopaepos.com/trial&nbsp;&rarr;</a>
      </td></tr></table>
      <p style="margin:12px 0 0;{F}font-size:13px;line-height:1.55;color:#5f5a68;">Everything stays on vesopaepos.com: the sign-up, the terms, refund and privacy pages, and the page Dojo's checkout returns to. Card payments currently run on our Dojo sandbox account (key name Vesopa), so no real money moves until you issue our live key.</p>
    </td></tr>
    <tr><td style="padding:6px 24px 0;">
      <h2 {H2}>How to test</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(HOW, 1))}</table>
    </td></tr>
    <tr><td style="padding:10px 24px 0;">
      <h2 {H2}>Website checklist</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(row(h, t) for h, t in CHECKS)}</table>
    </td></tr>
    <tr><td style="padding:20px 24px 0;">
      <h2 {H2}>Payment handling, ready for your testing</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(FLOW, 1))}</table>
    </td></tr>
    <tr><td style="padding:12px 24px 0;">
      <h2 {H2}>Our request</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(ASKS, 1))}</table>
      <p {P}>We are happy to walk through it on a call at any time; just reply with a time, or ring {a("tel:+447848494341", "+44 7848 494341")}.</p>
      <p {P}>Many thanks for your help.</p>
      <p style="margin:0 0 18px;{F}font-size:16px;line-height:1.6;color:#17141c;">Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:#5f5a68;">Vesopa Developer, Vesopa Software Ltd</span><br>{a("mailto:muzahid@vesopa.com", "muzahid@vesopa.com")} &middot; {a("tel:+447848494341", "+44 7848 494341")}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-left:4px solid #a5c715;margin:0 0 30px;"><tr><td style="padding:2px 0 2px 12px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">
        On behalf of <strong style="color:#17141c;">Meirion Davies</strong>, Director<br>Vesopa Software Ltd and Vesopa Ltd<br>
        {a("mailto:info@vesopasoftware.com", "info@vesopasoftware.com")} &middot; {a("mailto:info@vesopa.com", "info@vesopa.com")}
      </td></tr></table>
    </td></tr>
    <tr><td style="background:#f6f5f9;padding:18px 24px;border-top:4px solid #a5c715;">
      <p style="margin:0;{F}font-size:12px;line-height:1.6;color:#5f5a68;">Vesopa Software Ltd &middot; company number 17362206 &middot; {a("https://vesopaepos.com", "vesopaepos.com", "color:#5f5a68;")} &middot; Software house ID SL942X04 &middot; Copied to Meirion Davies, Director.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
'''

assert all("data-no-track" in tag for tag in re.findall(r"<a [^>]*>", html)), "a link without data-no-track"


def plain(t):
    t = t.replace("&pound;", "£").replace("&nbsp;", " ").replace("&rarr;", "->").replace("&amp;", "&").replace("&middot;", "|")
    return re.sub(r"<[^>]+>", "", t)


text = (
    "Hi Alex, and the Partner Technology team,\n\n"
    "Thank you for your help with Pontardawe RFC. We have now built the same online checkout for Vesopa Software Ltd itself: "
    "venues start a free trial of Vesopa EPOS on our website with a £1 card check on Dojo's hosted checkout, refunded straight away. "
    "We have followed your online checkout checklist, and it is ready for your review:\n\n"
    f"  {LINK}\n\n"
    "Everything stays on vesopaepos.com: the sign-up, the terms, refund and privacy pages, and the page Dojo's checkout returns to. "
    "Card payments currently run on our Dojo sandbox account (key name Vesopa), so no real money moves until you issue our live key.\n\n"
    "HOW TO TEST\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(HOW, 1))
    + "\n\nWEBSITE CHECKLIST\n" + "\n".join(f"- {h}: {plain(t)}" for h, t in CHECKS)
    + "\n\nPAYMENT HANDLING, READY FOR YOUR TESTING\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(FLOW, 1))
    + "\n\nOUR REQUEST\n" + "\n".join(f"{i}. {t}" for i, t in enumerate(ASKS, 1))
    + "\n\nWe are happy to walk through it on a call at any time; just reply with a time, or ring +44 7848 494341.\n\nMany thanks for your help.\n\n"
    "Kind regards,\nMuzahid Islam\nVesopa Developer, Vesopa Software Ltd\nmuzahid@vesopa.com | +44 7848 494341\n\n"
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
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-dojo-review.jpg")
open(os.path.join(OUT, "Vesopa-Dojo-vesopa-verify.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-vesopa-verify.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "hero-epos-live.jpg"))
print("ok")
