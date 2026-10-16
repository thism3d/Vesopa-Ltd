"""Builds the staging link email to Dojo (Alex, customer support and integration support), 16 Oct 2026: HTML, text, .eml.

Alex: "Online checkout testing for a Partner product is not performed over a
call, we just ask that you supply us with a link to a staging site where we can
test that everything on this checklist is met." This sends that link.

    python build_staging.py <out-dir>
"""
import os, sys
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from email.policy import SMTP

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

SUBJECT = "Staging link for review: Vesopa online checkout (Dojo hosted checkout) at menu.pontardawerfc.com"
TO = [("Alex Radzio", "alex.radzio@dojo.tech"), ("Dojo Customer Support", "support@dojo.tech"), ("Dojo Integration Support", "integrations@dojo.tech")]
CC = [("Meirion Davies", "info@vesopasoftware.com"), ("Meirion Davies", "info@vesopa.com")]
ORG = ("Vesopa Developer", "muzahid@vesopa.com")
LINK = "https://menu.pontardawerfc.com/"

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'

CHECKS = [
    ("Contact details", "The foot of the menu shows the address, telephone and email; a Contact us link goes to pontardawerfc.com/contact."),
    ("Legal entity name", "Pontardawe Rugby Football Club Limited, company no. 10056776, at the foot of the menu and in the terms."),
    ("Refund policy", 'A clearly labelled Refund policy: <a href="https://pontardawerfc.com/ordering-terms#refunds" style="color:#0b1a6b;">pontardawerfc.com/ordering-terms#refunds</a>, linked from the menu.'),
    ("Privacy policy", '<a href="https://pontardawerfc.com/privacy" style="color:#0b1a6b;">pontardawerfc.com/privacy</a>, which names Dojo (Paymentsense Limited) for online card payments.'),
    ("Card scheme logos", "Visa, Mastercard, Apple Pay and Google Pay at the foot of the menu."),
    ("Terms and conditions", '<a href="https://pontardawerfc.com/ordering-terms" style="color:#0b1a6b;">Ordering terms and refund policy</a>, naming the legal entity, with a "Paying online by card" section.'),
    ("Secure checkout page", "HTTPS throughout; card details are entered only on Dojo's hosted checkout (pay.dojo.tech)."),
]
FLOW = [
    "Successful payment: Dojo redirects back to the order tracker, which reads the result from the payment intent (never from the redirect).",
    "Unsuccessful payment: the tracker shows Payment not finished, with Pay now, Pay at the bar and Cancel. Nothing goes to the kitchen.",
    "Successful payment after an unsuccessful one: Pay now refreshes the client session secret (refresh-client-session-secret) before returning to the checkout.",
    "3-D Secure, successful and unsuccessful: handled on Dojo's checkout page; the result comes back through the intent.",
    "Cancel: back to the tracker, the intent is cancelled and the customer is told nothing was charged.",
    "Webhooks: payment_intent.status_updated, signature verified, at https://pontardawerfc.com/dojo_test_webhook (PontardaweRFC Demo).",
    "Refunds: a paid order cancelled on the till or kitchen screen is refunded through the API, with an idempotency key.",
]


def row(h, t):
    return f'''<tr><td valign="top" width="26" style="padding:9px 0;{F}font-size:15px;color:#2f8f00;font-weight:800;">&#10003;</td>
      <td style="padding:9px 0;border-bottom:1px solid #eef0f7;{F}font-size:14px;line-height:1.55;color:#17141c;"><strong style="color:#0b1a6b;">{h}</strong><br>{t}</td></tr>'''


def step(n, text):
    return f'''<tr><td valign="top" width="40" style="padding:0 0 12px;">
        <div style="width:28px;height:28px;border-radius:14px;background:#0b1a6b;color:#fff;{F}font-size:14px;font-weight:800;line-height:28px;text-align:center;">{n}</div></td>
      <td valign="top" style="padding:3px 0 12px;{F}font-size:15px;line-height:1.55;color:#17141c;">{text}</td></tr>'''


HOW = [
    f'Open <a href="{LINK}" style="color:#0b1a6b;font-weight:700;">menu.pontardawerfc.com</a> and tap <strong>Tap to say which table you are at</strong>; any table will do.',
    'Add something to the basket and open it. Choose <strong>Pay now by card (test)</strong> and press <strong>Pay &pound;x by card</strong>.',
    "Pay on Dojo's checkout with your sandbox test cards (including the 3-D Secure and decline cards).",
    "You come back to the order tracker: <strong>Test payment complete</strong>, or <strong>Payment not finished</strong> with the options to try again.",
]

html = f'''<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>{SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#eef0f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Our staging link for the online checkout review: menu.pontardawerfc.com, on Dojo's sandbox, built to your go-live checklist.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;"><img src="cid:hero@vesopa" width="600" alt="Vesopa and Dojo: staging ready for review. Pontardawe RFC's online menu on Dojo's sandbox at menu.pontardawerfc.com." style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hi Alex, and the Dojo Customer Support and Integration Support teams,</p>
      <p {P}>Thank you, Alex, for explaining the process. Here is our staging site for the online checkout review, built to your <a href="https://docs.dojo.tech/payments/accept-payments/online-payments/checkout-page/checklist" style="color:#0b1a6b;">go-live checklist</a>:</p>
    </td></tr>
    <tr><td style="padding:0 24px 18px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#2f8f00;">
        <a href="{LINK}" style="display:inline-block;padding:14px 26px;{F}font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">Open menu.pontardawerfc.com&nbsp;&rarr;</a>
      </td></tr></table>
      <p style="margin:12px 0 0;{F}font-size:13px;line-height:1.55;color:#5f5a68;">Card payments on this site are on Dojo's sandbox (the &ldquo;PontardaweRFC Demo&rdquo; key) and marked Test mode on the menu. A test order is never sent to the club's till, kitchen or takings, so you can test freely.</p>
    </td></tr>
    <tr><td style="padding:6px 24px 0;">
      <h2 {H2}>How to test</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, a) for i, a in enumerate(HOW, 1))}</table>
    </td></tr>
    <tr><td style="padding:10px 24px 0;">
      <h2 {H2}>Website checklist</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(row(h, t) for h, t in CHECKS)}</table>
    </td></tr>
    <tr><td style="padding:20px 24px 0;">
      <h2 {H2}>End-to-end handling, ready for your testing</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, a) for i, a in enumerate(FLOW, 1))}</table>
    </td></tr>
    <tr><td style="padding:12px 24px 0;">
      <h2 {H2}>Switching to production</h2>
      <p {P}>Each venue chooses its key in our back office under <strong>Card Payments &rsaquo; Online checkout</strong>: Demo (sandbox), its Pay at Counter key, or a live key enabled for Remote Payments. Pontardawe RFC will apply for Online Checkout through <strong>Account activation</strong> in their Dojo Developer Portal, with menu.pontardawerfc.com as the website, as you advised.</p>
      <p {P}>Please let us know any points to address and we will turn them round quickly.</p>
      <p {P}>Many thanks for your help.</p>
      <p style="margin:0 0 18px;{F}font-size:16px;line-height:1.6;color:#17141c;">Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:#5f5a68;">Vesopa Developer, Vesopa Software Ltd</span><br><a href="mailto:muzahid@vesopa.com" style="color:#0b1a6b;">muzahid@vesopa.com</a></p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-left:4px solid #a5c715;margin:0 0 30px;"><tr><td style="padding:2px 0 2px 12px;{F}font-size:14px;line-height:1.6;color:#5f5a68;">
        On behalf of <strong style="color:#17141c;">Meirion Davies</strong>, Director<br>Vesopa Software Ltd and Vesopa Ltd<br>
        <a href="mailto:info@vesopasoftware.com" style="color:#0b1a6b;">info@vesopasoftware.com</a> &middot; <a href="mailto:info@vesopa.com" style="color:#0b1a6b;">info@vesopa.com</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="background:#f6f5f9;padding:18px 24px;border-top:4px solid #a5c715;">
      <p style="margin:0;{F}font-size:12px;line-height:1.6;color:#5f5a68;">Vesopa Software Ltd &middot; <a href="https://vesopa.com" style="color:#5f5a68;">vesopa.com</a> &middot; Software house ID SL942X04 &middot; Copied to Meirion Davies, Director.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
'''

strip = lambda t: t.replace("&ldquo;", '"').replace("&rdquo;", '"').replace("&pound;", "£").replace("&rsaquo;", ">").replace("<strong>", "").replace("</strong>", "")
import re
untag = lambda t: re.sub(r"<[^>]+>", "", strip(t))
text = (f"Hi Alex, and the Dojo Customer Support and Integration Support teams,\n\nThank you, Alex, for explaining the process. Here is our staging site for the online checkout review, built to your go-live checklist:\n\n  {LINK}\n\n"
        "Card payments on this site are on Dojo's sandbox (the \"PontardaweRFC Demo\" key) and marked Test mode on the menu. A test order is never sent to the club's till, kitchen or takings, so you can test freely.\n\nHOW TO TEST\n"
        + "\n".join(f"{i}. {untag(a)}" for i, a in enumerate(HOW, 1))
        + "\n\nWEBSITE CHECKLIST\n" + "\n".join(f"- {h}: {untag(t)}" for h, t in CHECKS)
        + "\n\nEND-TO-END HANDLING, READY FOR YOUR TESTING\n" + "\n".join(f"{i}. {untag(a)}" for i, a in enumerate(FLOW, 1))
        + "\n\nSWITCHING TO PRODUCTION\nEach venue chooses its key in our back office under Card Payments > Online checkout: Demo (sandbox), its Pay at Counter key, or a live key enabled for Remote Payments. Pontardawe RFC will apply for Online Checkout through Account activation in their Dojo Developer Portal, with menu.pontardawerfc.com as the website, as you advised.\n\n"
        "Please let us know any points to address and we will turn them round quickly.\n\nMany thanks for your help.\n\nKind regards,\nMuzahid Islam\nVesopa Developer, Vesopa Software Ltd\nmuzahid@vesopa.com\n\nOn behalf of Meirion Davies, Director\nVesopa Software Ltd and Vesopa Ltd\ninfo@vesopasoftware.com | info@vesopa.com\n")

now = datetime.now(timezone.utc)
hero = open(os.path.join(HERE, "hero-staging.jpg"), "rb").read()
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
msg.get_payload()[1].add_related(hero, "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-dojo-staging.jpg")
open(os.path.join(OUT, "Vesopa-Dojo-staging.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-staging.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "vesopa-dojo-staging.jpg"))
open(os.path.join(OUT, "vesopa-dojo-staging.jpg"), "wb").write(hero)
open(os.path.join(OUT, "email-staging.txt"), "w", encoding="utf-8").write(text)
print("ok")
