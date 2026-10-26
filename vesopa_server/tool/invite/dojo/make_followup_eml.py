"""The follow-up to the 24 Oct "please verify and enable our live API" email (2026-10-26).

    python vesopa_server/tool/invite/dojo/make_followup_eml.py

Writes Vesopa-Dojo-vesopa-verify-followup.eml beside it: a reply in the same
thread (In-Reply-To the first message), the first email quoted underneath, to
Alex and Partner Technology, cc Meirion, high importance with a read receipt.
Send with: python tool/send_dojo_invite.py --vesopa-followup --send
"""
import email
import html
import uuid
from email import policy
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIRST = HERE / "Vesopa-Dojo-vesopa-verify.eml"
OUT = HERE / "Vesopa-Dojo-vesopa-verify-followup.eml"

NAVY, RED, MUTED = "#0E1B2C", "#A5C715", "#55554F"

TEXT = """Hi Alex, and the Partner Technology team,

I hope you're well. I'm following up on my email of Saturday 24 October (below) about the online checkout for Vesopa Software Ltd.

Our hosted checkout is ready and waiting for your review at https://vesopaepos.com/trial. It still runs on our Dojo sandbox account (key name "Vesopa"), so no real money moves until you are happy.

Could you please:
1. Review vesopaepos.com against your online checkout checklist and let us know if anything needs changing.
2. Verify Vesopa Software Ltd for online checkout and issue our live (sk_prod_) key, so we can start taking live payments on Dojo's hosted checkout.

As soon as we have the key we will set the live webhook to https://backoffice.vesopaepos.com/api/webhooks/dojo/live, exactly as the sandbox one, and make our first live call.

If it would help, I'm happy to walk you through it on a short call at any time: just reply with a time, or ring +44 7848 494341.

Many thanks for your help.

Kind regards,
Muzahid Islam
Vesopa Developer, Vesopa Software Ltd
muzahid@vesopa.com | +44 7848 494341

On behalf of Meirion Davies, Director
Vesopa Software Ltd and Vesopa Ltd
info@vesopasoftware.com | info@vesopa.com
"""


def para(t):
    return f'<p style="margin:0 0 14px;font:15px/1.6 Arial,Helvetica,sans-serif;color:{NAVY};">{t}</p>'


def main():
    first = email.message_from_binary_file(FIRST.open("rb"), policy=policy.default)
    first_text = first.get_body(("plain",)).get_content()
    first_id = first["Message-ID"]
    first_date = first["Date"]

    quoted_text = "\n".join("> " + line for line in first_text.splitlines())
    text = TEXT + f"\nOn {first_date}, Muzahid Islam <muzahid@vesopa.com> wrote:\n\n" + quoted_text + "\n"

    body = "".join([
        para("Hi Alex, and the Partner Technology team,"),
        para("I hope you're well. I'm following up on my email of Saturday 24 October (below) about the online checkout for <strong>Vesopa Software Ltd</strong>."),
        para(f'Our hosted checkout is ready and waiting for your review at <a href="https://vesopaepos.com/trial" style="color:{NAVY};font-weight:bold;">vesopaepos.com/trial</a>. It still runs on our Dojo sandbox account (key name &ldquo;Vesopa&rdquo;), so no real money moves until you are happy.'),
        para("Could you please:"),
        f'<ol style="margin:0 0 14px 20px;padding:0;font:15px/1.6 Arial,Helvetica,sans-serif;color:{NAVY};">'
        "<li style=\"margin:0 0 6px;\">Review vesopaepos.com against your online checkout checklist and let us know if anything needs changing.</li>"
        "<li>Verify Vesopa Software Ltd for online checkout and issue our <strong>live (sk_prod_) key</strong>, so we can start taking live payments on Dojo&rsquo;s hosted checkout.</li></ol>",
        para("As soon as we have the key we will set the live webhook to https://backoffice.vesopaepos.com/api/webhooks/dojo/live, exactly as the sandbox one, and make our first live call."),
        para('If it would help, I&rsquo;m happy to walk you through it on a short call at any time: just reply with a time, or ring <a href="tel:+447848494341" style="color:' + NAVY + ';">+44 7848 494341</a>.'),
        para("Many thanks for your help."),
        para(f'Kind regards,<br><strong>Muzahid Islam</strong><br><span style="color:{MUTED};">Vesopa Developer, Vesopa Software Ltd</span><br>'
             f'<a href="mailto:muzahid@vesopa.com" style="color:{NAVY};">muzahid@vesopa.com</a> | +44 7848 494341'),
        f'<p style="margin:0 0 22px;font:13px/1.5 Arial,Helvetica,sans-serif;color:{MUTED};">On behalf of Meirion Davies, Director<br>Vesopa Software Ltd and Vesopa Ltd<br>info@vesopasoftware.com | info@vesopa.com</p>',
        f'<div style="border-left:3px solid #D9D9D2;padding:0 0 0 14px;margin:0;color:{MUTED};">'
        f'<p style="margin:0 0 10px;font:13px/1.5 Arial,Helvetica,sans-serif;color:{MUTED};">On {html.escape(str(first_date))}, Muzahid Islam &lt;muzahid@vesopa.com&gt; wrote:</p>'
        f'<pre style="white-space:pre-wrap;margin:0;font:13px/1.5 Arial,Helvetica,sans-serif;color:{MUTED};">{html.escape(first_text)}</pre></div>',
    ])
    page = (f'<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">'
            f'<div style="max-width:640px;margin:0 auto;padding:24px 20px;">{body}</div></body></html>')

    msg = EmailMessage()
    msg["From"] = "Vesopa Developer <muzahid@vesopa.com>"
    msg["To"] = "Alex Radzio <alex.radzio@dojo.tech>, Dojo Partner Technology <partnertech@dojo.tech>"
    msg["Cc"] = "Meirion Davies <info@vesopasoftware.com>, Meirion Davies <info@vesopa.com>"
    msg["Reply-To"] = "Muzahid Islam <muzahid@vesopa.com>"
    msg["Subject"] = "Re: " + str(first["Subject"]).replace("\n", " ")
    msg["Date"] = format_datetime(datetime.now(timezone.utc))
    msg["Message-ID"] = make_msgid(idstring=uuid.uuid4().hex[:8], domain="vesopa.com")
    msg["In-Reply-To"] = first_id
    msg["References"] = first_id
    msg["Importance"] = "High"
    msg["X-Priority"] = "1 (Highest)"
    msg["X-MSMail-Priority"] = "High"
    msg["Priority"] = "urgent"
    msg["Disposition-Notification-To"] = "muzahid@vesopa.com"
    msg["Return-Receipt-To"] = "muzahid@vesopa.com"
    msg.set_content(text)
    msg.add_alternative(page, subtype="html")
    OUT.write_bytes(msg.as_bytes(policy=policy.SMTP))
    print("written", OUT.name, msg["Subject"])


if __name__ == "__main__":
    main()
