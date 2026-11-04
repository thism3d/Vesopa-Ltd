"""Vesopa-Dojo-live-access.eml (2026-11-04): to Alex Radzio, cc Meirion.
Live API key access for support@ and muzahid@, and Tap to Pay on iPhone for
Pontardawe RFC. A reply in the 24/26 Oct live-key thread.

    python vesopa_server/tool/invite/dojo/source/make_live_access_eml.py
"""
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "Vesopa-Dojo-live-access.eml"
PARENT = "<179300537282.4664.4751709253901764762.a353fa9b@vesopa.com>"

TEXT = """Hi Alex,

I hope you're well.

1. Live API access for Vesopa Software Ltd

Last time you let us know that our live access had been activated, thank you. Unfortunately we still can't see it: signed in to Dojo with either of our logins, there is no live (sk_prod_) API key or live access for Vesopa Software Ltd.

Could you please check that live is enabled for the Vesopa Software Ltd account, and that both of these logins can see and manage it?

  - support@vesopa.com
  - muzahid@vesopa.com

If there is a step on our side (accepting terms, a verification, or an invitation to a separate live account), please tell us and we'll do it straight away.

2. Tap to Pay on iPhone for Pontardawe RFC

We're adding Tap to Pay on iPhone to our Vesopa Go app (com.vesopa.go) through the Dojo Tap to Pay SDK, and today we applied to Apple for the Tap to Pay on iPhone entitlement, with Dojo named as our payment provider. Could you please:

  - enable Tap to Pay on iPhone for Pontardawe RFC's Dojo account (their card machines are 27980900 and 60024115), if it isn't enabled already;
  - confirm Vesopa Software Ltd to Apple as a Dojo Tap to Pay partner if Apple asks you; and
  - let us know anything Dojo needs from us for Tap to Pay on iPhone certification.

Our merchant onboarding steps are at https://go.vesopa.com/get-started/.

Thanks very much,

Muzahid Islam
Developer, Vesopa Software Ltd
muzahid@vesopa.com | https://vesopasoftware.com
"""

HTML = """<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#0B0E0A;max-width:640px">
<p>Hi Alex,</p>
<p>I hope you're well.</p>
<h3 style="margin:18px 0 6px;font-size:16px">1. Live API access for Vesopa Software Ltd</h3>
<p>Last time you let us know that our live access had been activated, thank you. Unfortunately we still can't see it: signed in to Dojo with either of our logins, there is no live (sk_prod_) API key or live access for Vesopa Software Ltd.</p>
<p>Could you please check that live is enabled for the Vesopa Software Ltd account, and that both of these logins can see and manage it?</p>
<ul><li>support@vesopa.com</li><li>muzahid@vesopa.com</li></ul>
<p>If there is a step on our side (accepting terms, a verification, or an invitation to a separate live account), please tell us and we'll do it straight away.</p>
<h3 style="margin:18px 0 6px;font-size:16px">2. Tap to Pay on iPhone for Pontardawe RFC</h3>
<p>We're adding Tap to Pay on iPhone to our Vesopa Go app (com.vesopa.go) through the Dojo Tap to Pay SDK, and today we applied to Apple for the Tap to Pay on iPhone entitlement, with Dojo named as our payment provider. Could you please:</p>
<ul>
<li>enable Tap to Pay on iPhone for Pontardawe RFC's Dojo account (their card machines are 27980900 and 60024115), if it isn't enabled already;</li>
<li>confirm Vesopa Software Ltd to Apple as a Dojo Tap to Pay partner if Apple asks you; and</li>
<li>let us know anything Dojo needs from us for Tap to Pay on iPhone certification.</li>
</ul>
<p>Our merchant onboarding steps are at <a href="https://go.vesopa.com/get-started/">go.vesopa.com/get-started</a>.</p>
<p>Thanks very much,</p>
<p><b>Muzahid Islam</b><br>Developer, Vesopa Software Ltd<br>
<a href="mailto:muzahid@vesopa.com">muzahid@vesopa.com</a> | <a href="https://vesopasoftware.com">vesopasoftware.com</a></p>
</div>"""

m = EmailMessage()
m["From"] = "Muzahid Islam <muzahid@vesopa.com>"
m["To"] = "Alex Radzio <alex.radzio@dojo.tech>"
m["Cc"] = "Meirion Davies <info@vesopasoftware.com>, Meirion Davies <info@vesopa.com>"
m["Reply-To"] = "Muzahid Islam <muzahid@vesopa.com>"
m["Subject"] = "Vesopa Software Ltd: live API access, and Tap to Pay on iPhone for Pontardawe RFC"
m["Date"] = "Wed, 04 Nov 2026 06:00:00 +0000"
m["Message-ID"] = make_msgid(domain="vesopa.com")
m["In-Reply-To"] = PARENT
m["References"] = PARENT
m["Importance"] = "High"
m["X-Priority"] = "1 (Highest)"
m.set_content(TEXT)
m.add_alternative(HTML, subtype="html")
OUT.write_bytes(m.as_bytes())
print(OUT)
