"""Ask Teya partner support for a test company and store on our sandbox account (2026-10-19).

The Device Code sign-in to Teya's sandbox works for muzahid@vesopa.com, but
GET /poslink/v1/stores returns {"stores": []}, and Teya's SDK setup cannot
link a till without a store. Teya's guide: "Coordinate with Teya to set up a
partner test account and a Staging company/store."

    python build_store.py <out-dir>
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

SUBJECT = "Vesopa Software Ltd: please add a test company and store to our Teya sandbox account"
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
]

DONE = [
    "Windows: Vesopa EPOS runs the Teya SDK app 1.9.0 as a sub-process over JSON-RPC, as your getting-started guide describes. It checks the signature against signing_cert.cer first. <strong>initialize</strong> is acknowledged on the sandbox.",
    "Payments with makePaymentAndSubscribe, with live state changes on the till, plus cancelPayment, unsubscribeAll and refundPayment. COMMUNICATION_FAILED is shown as not confirmed, never as declined.",
    "The merchant signs in through the Device Code flow, which works with our credentials. The back office lists the stores and card machines and lets the venue pick each till's machine.",
    "Online payments for our table-ordering menu: hosted checkout with plugin registration (pluginType TESTING), a signed registration webhook and payments webhook, and refunds.",
    "Android tills will move to the Unified ePOS SDK next.",
]

ASKS = [
    "<strong>A test company and store</strong> on the sandbox for muzahid@vesopa.com. Our sign-in is approved, but <code>GET /poslink/v1/stores</code> returns <code>{\"stores\": []}</code>, so Teya's SDK setup has no store to link. A second store would also help us test a venue with more than one.",
    "<strong>A test card machine in that store</strong> for the mock payment app (TeyaTerminalApp mock 3.11.2), or the steps to register an emulator or phone running it as the store's terminal.",
    "<strong>Online Payments enabled on the test store</strong>, so plugin registration with business.teya.xyz completes to our registration webhook.",
    "<strong>Our physical card machine:</strong> Teya has delivered a live card machine for our test venue. Can it run the sandbox payment app (the Sunmi, PAX, Verifone or NexGo builds on your downloads page) while we test, or should it stay on live?",
    "<strong>Certification:</strong> what are the next steps once our tests pass, and when should we ask for the production credentials and our own pluginType for online payments?",
]


def row(h, t):
    return f'''<tr><td width="38%" valign="top" style="padding:9px 10px 9px 0;border-bottom:1px solid #eef0f7;{F}font-size:13px;font-weight:800;color:#0b1a6b;">{h}</td>
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Our Teya sandbox sign-in works, but the account has no store yet. Could you add a test company and store?</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">
    <tr><td style="background:#0b1a6b;"><img src="cid:hero@vesopa" width="600" alt="Vesopa and Teya: Vesopa EPOS is built on Teya's SDK. One thing left to test it: a store on our sandbox account." style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
    <tr><td style="padding:34px 24px 6px;">
      <p {P}>Hello Teya Partner Support,</p>
      <p {P}>Thank you for approving our sandbox account for <strong>Vesopa Software Ltd</strong>. We have built Teya into Vesopa EPOS, and venues can now choose Teya instead of Dojo for their tills and their online menu. One thing stops us testing end to end: <strong>our sandbox account has no company or store yet</strong>. Your integration guide says to coordinate this with you, so could you please add one?</p>
    </td></tr>
    <tr><td style="padding:0 24px 8px;">
      <h2 {H2}>Our sandbox account</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(row(h, t) for h, t in ACCOUNT)}</table>
    </td></tr>
    <tr><td style="padding:18px 24px 0;">
      <h2 {H2}>What we are asking for</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(step(i, t) for i, t in enumerate(ASKS, 1))}</table>
    </td></tr>
    <tr><td style="padding:10px 24px 0;">
      <h2 {H2}>What is built and ready to test</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(tick(t) for t in DONE)}</table>
    </td></tr>
    <tr><td style="padding:22px 24px 0;">
      <p {P}>As soon as the store is in place we will run the full test set: approved, declined, cancelled from the till and on the machine, a lost connection, and full and part refunds. Then we will come back to you for certification.</p>
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
    t = t.replace("&nbsp;", " ").replace("&quot;", '"')
    return re.sub(r"<[^>]+>", "", t)


text = (
    "Hello Teya Partner Support,\n\n"
    "Thank you for approving our sandbox account for Vesopa Software Ltd. We have built Teya into Vesopa EPOS, and venues can now choose "
    "Teya instead of Dojo for their tills and their online menu. One thing stops us testing end to end: our sandbox account has no "
    "company or store yet. Your integration guide says to coordinate this with you, so could you please add one?\n\n"
    "OUR SANDBOX ACCOUNT\n" + "\n".join(f"- {h}: {t}" for h, t in ACCOUNT)
    + "\n\nWHAT WE ARE ASKING FOR\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(ASKS, 1))
    + "\n\nWHAT IS BUILT AND READY TO TEST\n" + "\n".join(f"- {plain(t)}" for t in DONE)
    + "\n\nAs soon as the store is in place we will run the full test set: approved, declined, cancelled from the till and on the machine, "
    "a lost connection, and full and part refunds. Then we will come back to you for certification.\n\n"
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
open(os.path.join(OUT, "Vesopa-Teya-store.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-store.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "vesopa-teya.jpg"))
open(os.path.join(OUT, "vesopa-teya.jpg"), "wb").write(hero)
print("ok")
