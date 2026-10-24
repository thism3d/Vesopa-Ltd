"""Teya follow-up (24 Oct 2026): the application shows "No data available" for Great Britain
(United Kingdom) when signed in as info@vesopasoftware.com, and no live data for that login;
the supplier invoice attached as supporting evidence. Threads under the eCommerce email.

The invoice is attached as the owner supplied it, described only as the supplier's proforma.

    python build_country.py <out-dir>
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

SUBJECT = "Vesopa Software Ltd: Great Britain shows \"No data available\" in our Teya application"
PARENT = "<179287781613.11088.420252741003057136@vesopasoftware.com>"
TO = [("Teya Partnerships", "partner@teya.com"), ("Teya Global Partnerships", "globalpartner@teya.com"), ("Teya Partner Support", "partnersupport@teya.com")]
CC = [("Vesopa EPOS", "info@vesopa.com"), ("Vesopa Developer", "muzahid@vesopa.com")]
CH = "https://find-and-update.company-information.service.gov.uk/company/17362206"

F = "font-family:'Plus Jakarta Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;"
P = f'style="margin:0 0 16px;{F}font-size:16px;line-height:1.6;color:#17141c;"'
H2 = f'style="margin:8px 0 12px;{F}font-size:19px;line-height:1.3;font-weight:800;color:#0b1a6b;"'


def a(href, text):
    return f'<a href="{href}" data-no-track style="color:#0b1a6b;">{text}</a>'


ISSUES = [
    "<strong>Country list:</strong> signed in to the Teya application as <strong>info@vesopasoftware.com</strong>, choosing the country <strong>Great Britain (United Kingdom)</strong> shows <em>&ldquo;No data available&rdquo;</em>, so we cannot go any further with the application.",
    "<strong>Live data:</strong> on the web, only <strong>muzahid@vesopa.com</strong> (our developer) can sign in, and that is to the sandbox. <strong>info@vesopasoftware.com</strong> shows no live data at all.",
]
ASKS = [
    "Please enable Great Britain (United Kingdom) for Vesopa Software Ltd's application, or tell us the right route for a UK company.",
    "Please set up <strong>info@vesopasoftware.com</strong> as the main login for Vesopa Software Ltd, with access to live as well as sandbox.",
    "Let us know if you need anything else to verify the company; we will send it the same day.",
]
ATTACH = [
    "<strong>OCOM-PI2606112.pdf</strong>: our supplier's proforma invoice for the Vesopa tills and receipt printers we supply to venues.",
]


def items(rows):
    return "".join(f'<li style="margin:0 0 10px;{F}font-size:15px;line-height:1.55;color:#17141c;">{t}</li>' for t in rows)


html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#eef0f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f7;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border-radius:18px;overflow:hidden;">
<tr><td style="background:#0b1a6b;"><img src="cid:hero@vesopa" width="600" alt="Vesopa and Teya" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
<tr><td style="height:6px;background:#a5c715;"></td></tr>
<tr><td style="padding:30px 24px 10px;">
  <p {P}>Hello Teya team,</p>
  <p {P}>Following our email about the eCommerce API, two things are stopping <strong>Vesopa Software Ltd</strong> (company number 17362206, Baglan Innovation Centre, Central Avenue, Baglan, Port Talbot SA12 7AX) from completing our Teya application ({a(CH, "Companies House record")}).</p>
  <h2 {H2}>What we see</h2><ol style="margin:0 0 16px;padding-left:22px;">{items(ISSUES)}</ol>
  <h2 {H2}>What we would like</h2><ol style="margin:0 0 16px;padding-left:22px;">{items(ASKS)}</ol>
  <h2 {H2}>Attached for verification</h2><ul style="margin:0 0 16px;padding-left:22px;">{items(ATTACH)}</ul>
  <p {P}>Thank you for your help. We are happy to share a screen on a call if that is quicker: {a("tel:+441792316282", "+44 1792 316282")}.</p>
  <p style="margin:0 0 28px;{F}font-size:16px;line-height:1.6;color:#17141c;"><strong>Meirion Davies</strong><br><span style="color:#5f5a68;">Director, Vesopa Software Ltd</span><br>{a("mailto:info@vesopasoftware.com", "info@vesopasoftware.com")} &middot; {a("tel:+441792316282", "+44 1792 316282")}<br><span style="color:#5f5a68;">Technical: Muzahid Islam, Vesopa Developer, {a("mailto:muzahid@vesopa.com", "muzahid@vesopa.com")}</span></p>
</td></tr>
<tr><td style="background:#f6f5f9;padding:16px 24px;border-top:4px solid #a5c715;"><p style="margin:0;{F}font-size:12px;line-height:1.6;color:#5f5a68;">Vesopa Software Ltd &middot; company number 17362206, registered in England and Wales &middot; Baglan Innovation Centre, Central Avenue, Baglan, Port Talbot SA12 7AX</p></td></tr>
</table></td></tr></table></body></html>
'''


def plain(t):
    t = t.replace("&ldquo;", '"').replace("&rdquo;", '"').replace("&middot;", "|")
    return re.sub(r"<[^>]+>", "", t)


text = (
    "Hello Teya team,\n\nFollowing our email about the eCommerce API, two things are stopping Vesopa Software Ltd "
    "(company number 17362206, Baglan Innovation Centre, Central Avenue, Baglan, Port Talbot SA12 7AX) from completing our Teya application.\n\n"
    "WHAT WE SEE\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(ISSUES, 1))
    + "\n\nWHAT WE WOULD LIKE\n" + "\n".join(f"{i}. {plain(t)}" for i, t in enumerate(ASKS, 1))
    + "\n\nATTACHED FOR VERIFICATION\n" + "\n".join(f"- {plain(t)}" for t in ATTACH) + "\n"
    + "\nThank you for your help. We are happy to share a screen on a call if that is quicker: +44 1792 316282.\n\n"
    "Meirion Davies\nDirector, Vesopa Software Ltd\ninfo@vesopasoftware.com | +44 1792 316282\nTechnical: Muzahid Islam, Vesopa Developer, muzahid@vesopa.com\n"
)

msg = EmailMessage(policy=SMTP)
msg["X-Unsent"] = "1"
msg["From"] = "Vesopa Software Ltd <info@vesopasoftware.com>"
msg["To"] = ", ".join(f"{n} <{e}>" for n, e in TO)
msg["Cc"] = ", ".join(f"{n} <{e}>" for n, e in CC)
msg["Reply-To"] = "Vesopa Software Ltd <info@vesopasoftware.com>"
msg["Subject"] = SUBJECT
msg["In-Reply-To"] = PARENT
msg["References"] = PARENT
msg["Date"] = format_datetime(datetime.now(timezone.utc))
msg["Message-ID"] = make_msgid(domain="vesopasoftware.com")
msg.set_content(text)
msg.add_alternative(html, subtype="html")
msg.get_payload()[1].add_related(open(os.path.join(HERE, "..", "vesopa-teya.jpg"), "rb").read(), "image", "jpeg", cid="<hero@vesopa>", filename="vesopa-teya.jpg")
pdf = open(os.path.join(HERE, "..", "attach", "OCOM-PI2606112.pdf"), "rb").read()
msg.add_attachment(pdf, maintype="application", subtype="pdf", filename="OCOM-PI2606112.pdf")
open(os.path.join(OUT, "Vesopa-Teya-country.eml"), "wb").write(msg.as_bytes())
open(os.path.join(OUT, "email-country.html"), "w", encoding="utf-8").write(html.replace("cid:hero@vesopa", "vesopa-teya.jpg"))
print("ok")
