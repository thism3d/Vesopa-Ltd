"""Reply to Teya's question on the certification ticket (2026-10-26).

    python vesopa_server/tool/invite/teya/make_reply_eml.py

Teya asked: "we received multiple emails from you and I'm not sure if there is
any issue or not. From my understanding you want to certify your solution. Is
that correct?" This answers it in the same ticket (same subject): yes, all the
emails were ours, here is everything in one place, and the eCommerce live API
for Vesopa Software Ltd first. Writes Vesopa-Teya-reply.eml beside it; send
with: python tool/send_teya_mail.py --reply --send
"""
import uuid
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "Vesopa-Teya-reply.eml"
NAVY, MUTED = "#0E1B2C", "#55554F"
SUBJECT = "Re: [Teya] - Vesopa Software Ltd: ready to begin Teya partner certification (POSLink and Online Payments)"

ITEMS = [
    ("eCommerce API, live (most urgent)",
     "Please enable the Teya eCommerce API for Vesopa Software Ltd and issue our live credentials, so our venues and our own website can take online payments through Teya as soon as possible."),
    ("Partner certification",
     "We are ready to certify both integrations: POSLink (card terminals with our Vesopa EPOS till) and Online Payments. Please let us know the next steps and who we should work with."),
    ("Great Britain shows \"No data available\"",
     "In our Teya application, Great Britain shows \"No data available\", so we cannot complete the live set-up for the UK. Our hardware invoice is attached to the earlier email, if it helps."),
    ("Sandbox test company and store",
     "Please add a test company and store to our Teya sandbox account, so we can run the certification tests end to end."),
]

TEXT = "Hello,\n\nThank you for coming back to us, and sorry for the number of emails. Yes, they were all from us: some of our first emails did not reach you, so we sent them again to make sure they arrived. Nothing is wrong on our side.\n\nYes, that is correct: we would like to certify our solution. To keep everything in one place, here is all we are asking for:\n\n" + "\n\n".join(f"{i}. {t}\n   {d}" for i, (t, d) in enumerate(ITEMS, 1)) + """

The first one matters most to us: we would like Vesopa Software Ltd's eCommerce live API activated as soon as possible. Please reply in this ticket, and we can use it for everything from now on.

If a short call would be quicker, we are happy to join at any time: just reply with a time, or ring +44 7848 494341.

Many thanks for your help.

Kind regards,
Muzahid Islam
Vesopa Developer, Vesopa Software Ltd
muzahid@vesopa.com | +44 7848 494341

On behalf of Meirion Davies, Director
Vesopa Software Ltd and Vesopa Ltd
info@vesopasoftware.com | info@vesopa.com
"""


def p(t, style=""):
    return f'<p style="margin:0 0 14px;font:15px/1.6 Arial,Helvetica,sans-serif;color:{NAVY};{style}">{t}</p>'


def main():
    items = "".join(
        f'<li style="margin:0 0 12px;"><strong>{t}</strong><br>{d}</li>' for t, d in ITEMS)
    body = "".join([
        p("Hello,"),
        p("Thank you for coming back to us, and sorry for the number of emails. <strong>Yes, they were all from us</strong>: some of our first emails did not reach you, so we sent them again to make sure they arrived. Nothing is wrong on our side."),
        p("Yes, that is correct: <strong>we would like to certify our solution</strong>. To keep everything in one place, here is all we are asking for:"),
        f'<ol style="margin:0 0 14px 20px;padding:0;font:15px/1.6 Arial,Helvetica,sans-serif;color:{NAVY};">{items}</ol>',
        p("The first one matters most to us: we would like <strong>Vesopa Software Ltd&rsquo;s eCommerce live API activated as soon as possible</strong>. Please reply in this ticket, and we can use it for everything from now on."),
        p(f'If a short call would be quicker, we are happy to join at any time: just reply with a time, or ring <a href="tel:+447848494341" style="color:{NAVY};">+44 7848 494341</a>.'),
        p("Many thanks for your help."),
        p(f'Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:{MUTED};">Vesopa Developer, Vesopa Software Ltd</span><br><a href="mailto:muzahid@vesopa.com" style="color:{NAVY};">muzahid@vesopa.com</a> | +44 7848 494341'),
        f'<p style="margin:0;font:13px/1.5 Arial,Helvetica,sans-serif;color:{MUTED};">On behalf of Meirion Davies, Director<br>Vesopa Software Ltd and Vesopa Ltd<br>info@vesopasoftware.com | info@vesopa.com</p>',
    ])
    page = f'<!doctype html><html><body style="margin:0;background:#fff;"><div style="max-width:640px;margin:0 auto;padding:24px 20px;">{body}</div></body></html>'

    msg = EmailMessage()
    msg["From"] = '"Muzahid Islam, Vesopa Developer" <muzahid@vesopa.com>'
    msg["To"] = '"Jay, Teya" <help@teya.com>, "Teya Partner Support" <partnersupport@teya.com>, "Teya UK Partner Manager" <global.partnerships@teya.com>'
    msg["Cc"] = "Meirion Davies <info@vesopasoftware.com>, Meirion Davies <info@vesopa.com>"
    msg["Reply-To"] = "Muzahid Islam <muzahid@vesopa.com>"
    msg["Subject"] = SUBJECT
    msg["Date"] = format_datetime(datetime.now(timezone.utc))
    msg["Message-ID"] = make_msgid(idstring=uuid.uuid4().hex[:8], domain="vesopa.com")
    msg.set_content(TEXT)
    msg.add_alternative(page, subtype="html")
    OUT.write_bytes(msg.as_bytes(policy=policy.SMTP))
    print("written", OUT.name)


if __name__ == "__main__":
    main()
