"""The staging link again, on an established domain, 19 Oct 2026: HTML, text, .eml.

Alex (Dojo), 19 Oct: "due to the domain being very recently registered, our
workplace security policies prevented us from accessing the site ... if you can
supply an alternate staging link for testing that's on an established domain
then I can look at this sooner." So: pontardawerfcmenu.vesopa.com, the whole
menu on vesopa.com (menu, policy pages, the order page Dojo's checkout returns
to), and how to do this for more venues.

Every link carries data-no-track, so the mail relay (SMTP2GO) leaves it as it
is: the last email's links were rewritten through link.vesopa.com, its
click-tracking address, which a security filter may also refuse.

    python build_staging2.py <out-dir>
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

SUBJECT = "Staging on an established domain: pontardawerfcmenu.vesopa.com (Vesopa online checkout review)"
TO = [
    ("Alex Radzio", "alex.radzio@dojo.tech"),
    ("Dojo Partner Technology", "partnertech@dojo.tech"),
    ("Dojo Customer Support", "support@dojo.tech"),
    ("Dojo Integration Support", "integrations@dojo.tech"),
]
CC = [("Meirion Davies", "info@vesopasoftware.com"), ("Meirion Davies", "info@vesopa.com")]
ORG = ("Vesopa Developer", "muzahid@vesopa.com")
SITE = "https://pontardawerfcmenu.vesopa.com"
LINK = SITE + "/"

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 14px;{F}font-size:20px;line-height:1.3;font-weight:800;color:#0b1a6b;"'


def a(href, text, extra=""):
    """A link SMTP2GO leaves alone (data-no-track)."""
    return f'<a href="{href}" data-no-track style="color:#0b1a6b;{extra}">{text}</a>'


CHECKS = [
    ("Contact details", f"The foot of the menu shows the address, telephone and email, and Contact us opens {a(SITE + '/legal/contact', 'pontardawerfcmenu.vesopa.com/legal/contact')}."),
    ("Legal entity name", "Pontardawe Rugby Football Club Limited, company no. 10056776, at the foot of the menu and in the terms."),
    ("Refund policy", f"A clearly labelled Refund policy: {a(SITE + '/legal/terms#refunds', 'pontardawerfcmenu.vesopa.com/legal/terms#refunds')}."),
    ("Privacy policy", f"{a(SITE + '/legal/privacy', 'pontardawerfcmenu.vesopa.com/legal/privacy')}, which names Dojo (Paymentsense Limited) for online card payments."),
    ("Terms and conditions", f"{a(SITE + '/legal/terms', 'pontardawerfcmenu.vesopa.com/legal/terms')}, naming the legal entity, with a Paying online by card section."),
    ("Card scheme logos", "Visa, Mastercard, Apple Pay and Google Pay at the foot of the menu."),
    ("Secure checkout page", "HTTPS throughout; card details are entered only on Dojo's hosted checkout (pay.dojo.tech)."),
]

FLOW = [
    "Successful payment: Dojo's checkout returns to the order page on pontardawerfcmenu.vesopa.com, which reads the result from the payment intent, never from the redirect.",
    "Unsuccessful payment: the order page shows Payment not finished, with Pay now, Pay at the bar and Cancel. Nothing goes to the kitchen.",
    "Successful payment after an unsuccessful one: Pay now refreshes the client session secret before returning to the checkout.",
    "3-D Secure, successful and unsuccessful: handled on Dojo's checkout page; the result comes back through the intent.",
    "Cancel on Dojo's checkout: the intent carries a cancelUrl as well as a redirectUrl, both to the order page, which says nothing was charged.",
    "Paid, then the browser closed before the redirect: the payment_intent.status_updated webhook settles the order within seconds, and a check every minute asks Dojo about any order still waiting, so a paid order is never lost.",
    "Webhooks: the dojo-signature is verified (a forged one is refused with 401), and the server always confirms the status with Dojo before acting on it.",
    "Errors (4xx and 5xx): if the checkout cannot be opened the order is cancelled and the customer told to try again or pay at the bar; if Dojo errors on a retry the customer returns to the order page; a payment Dojo no longer has closes as not paid; an approved payment still being captured is never cancelled.",
    "Refunds: a paid order cancelled on the till or the kitchen screen is refunded through the API, with an idempotency key.",
]

HOW = [
    f'Open {a(LINK, "pontardawerfcmenu.vesopa.com", "font-weight:700;")} and choose a table (any table will do).',
    "Add something to the basket and open it. Choose <strong>Pay now by card (test)</strong> and press <strong>Pay &pound;x by card</strong>.",
    "Pay on Dojo's checkout with your sandbox test cards (including the 3-D Secure and decline cards), or press its cancel option.",
    "You come back to the order page on the same address: <strong>Test payment complete</strong>, or <strong>Payment not finished</strong> with the options to try again.",
]

ASKS = [
    "Can the Vesopa integration be reviewed once, as a partner product, so that each new venue only needs Account activation in its Dojo portal rather than a review of its own?",
    "If each venue does need its site checked, is a vesopa.com address per venue (like this one) acceptable as the site you review, while the venue's own domain is what customers use?",
    "Is there a partner process or an API for submitting venues for online checkout, so the activation can be started from our side when a venue joins?",
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">The same staging site on vesopa.com, an established domain: pontardawerfcmenu.vesopa.com.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;"><img src="cid:hero@vesopa" width="600" alt="Vesopa and Dojo: staging on an established domain. Pontardawe RFC's menu at pontardawerfcmenu.vesopa.com." style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hi Alex, and the Dojo teams,</p>
      <p {P}>Thank you, Alex, and sorry the first link was blocked. Here is the same staging site on <strong>vesopa.com</strong>, an established domain:</p>
    </td></tr>
    <tr><td style="padding:0 24px 18px;" align="center">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:12px;background:#2f8f00;">
        <a href="{LINK}" data-no-track style="display:inline-block;padding:14px 26px;{F}font-size:16px;font-weight:800;color:#ffffff;text-decoration:none;border-radius:12px;">Open pontardawerfcmenu.vesopa.com&nbsp;&rarr;</a>
      </td></tr></table>
      <p style="margin:12px 0 0;{F}font-size:13px;line-height:1.55;color:#5f5a68;">Everything stays on this address: the menu, the terms, refund and privacy pages, and the order page Dojo's checkout returns to. Card payments are on Dojo's sandbox (the PontardaweRFC Demo key) and marked Test mode; a test order never reaches the club's till, kitchen or takings.</p>
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
      <h2 {H2}>End-to-end handling, ready for your testing</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(FLOW, 1))}</table>
    </td></tr>
    <tr><td style="padding:12px 24px 0;">
      <h2 {H2}>More venues</h2>
      <p {P}>We are adding venues every week, and each runs its online menu and checkout on Vesopa. What is the best way to do this for many venues?</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(ASKS, 1))}</table>
      <p {P}>Pontardawe RFC will apply for Online Checkout through Account activation in their Dojo Developer Portal, as you advised. Please let us know any points to address and we will turn them round quickly.</p>
      <p {P}>Many thanks for your help.</p>
      <p style="margin:0 0 18px;{F}font-size:16px;line-height:1.6;color:#17141c;">Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:#5f5a68;">Vesopa Developer, Vesopa Software Ltd</span><br>{a("mailto:muzahid@vesopa.com", "muzahid@vesopa.com")}</p>
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

# Every link must be untracked; a missed one would go through link.vesopa.com.
assert all("data-no-track" in tag for tag in re.findall(r"<a [^>]*>", html)), "a link without data-no-track"


def plain(t):
    t = t.replace("&pound;", "£").replace("&nbsp;", " ").replace("&rarr;", "->")
    return re.sub(r"<[^>]+>", "", t)


text = (
    "Hi Alex, and the Dojo teams,\n\n"
    "Thank you, Alex, and sorry the first link was blocked. Here is the same staging site on vesopa.com, an established domain:\n\n"
    f"  {LINK}\n\n"
    "Everything stays on this address: the menu, the terms, refund and privacy pages, and the order page Dojo's checkout returns to. "
    "Card payments are on Dojo's sandbox (the PontardaweRFC Demo key) and marked Test mode; a test order never reaches the club's till, kitchen or takings.\n\n"
    "HOW TO TEST\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(HOW, 1))
    + "\n\nWEBSITE CHECKLIST\n" + "\n".join(f"- {h}: {plain(t)}" for h, t in CHECKS)
    + "\n\nEND-TO-END HANDLING, READY FOR YOUR TESTING\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(FLOW, 1))
    + "\n\nMORE VENUES\nWe are adding venues every week, and each runs its online menu and checkout on Vesopa. What is the best way to do this for many venues?\n"
    + "\n".join(f"{i}. {t}" for i, t in enumerate(ASKS, 1))
    + "\n\nPontardawe RFC will apply for Online Checkout through Account activation in their Dojo Developer Portal, as you advised. "
    "Please let us know any points to address and we will turn them round quickly.\n\nMany thanks for your help.\n\n"
    "Kind regards,\nMuzahid Islam\nVesopa Developer, Vesopa Software Ltd\nmuzahid@vesopa.com\n\n"
    "On behalf of Meirion Davies, Director\nVesopa Software Ltd and Vesopa Ltd\ninfo@vesopasoftware.com | info@vesopa.com\n"
)

now = datetime.now(timezone.utc)
hero = open(os.path.join(HERE, "hero-staging2.jpg"), "rb").read()
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
open(os.path.join(OUT, "Vesopa-Dojo-staging2.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-staging2.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "vesopa-dojo-staging.jpg"))
open(os.path.join(OUT, "vesopa-dojo-staging.jpg"), "wb").write(hero)
print("ok")
