"""Vesopa-Dojo-android-tap.eml (2026-11-06): to Fintan, Alex and Francis, cc Meirion.
Reply to Fintan's 4 Nov answer: yes to Android Tap to Pay on Pocket; please enable
it, say which devices we can test on, and send the guidelines.

    python vesopa_server/tool/invite/dojo/source/make_android_tap_eml.py
"""
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "Vesopa-Dojo-android-tap.eml"

TEXT = """Hi Fintan, Alex and Francis,

Thanks for your reply, Finn. That's clear on iPhone, and yes please: we would like to go ahead with the Android Tap to Pay integration on Pocket for our Vesopa Go app (com.vesopa.go).

1. Please enable it

Could you please enable Android Tap to Pay for Vesopa Software Ltd, so that we can start testing?

2. Which device do we test on?

Do we need to use a Dojo Pocket for the Android Tap to Pay tests, or can we use any Android phone with NFC? If it has to be a Dojo device, could you let us know how we can get one for testing?

3. Guidelines

Please could you send us the guidelines for this integration, including:

  - the current SDK and documentation (we have started from tech.dojo.pos:tap-to-pay-on-pocket:1.0.0);
  - how to test on sandbox, and how a device is activated for it;
  - the certification or accreditation steps before going live; and
  - anything you need from us to enable it for a venue.

Thanks very much,

Vesopa Developer
Vesopa Software Ltd
muzahid@vesopa.com | https://vesopasoftware.com
"""

HTML = """<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#0B0E0A;max-width:640px">
<p>Hi Fintan, Alex and Francis,</p>
<p>Thanks for your reply, Finn. That's clear on iPhone, and yes please: we would like to go ahead with the Android Tap to Pay integration on Pocket for our Vesopa Go app (com.vesopa.go).</p>
<h3 style="margin:18px 0 6px;font-size:16px">1. Please enable it</h3>
<p>Could you please enable Android Tap to Pay for Vesopa Software Ltd, so that we can start testing?</p>
<h3 style="margin:18px 0 6px;font-size:16px">2. Which device do we test on?</h3>
<p>Do we need to use a Dojo Pocket for the Android Tap to Pay tests, or can we use any Android phone with NFC? If it has to be a Dojo device, could you let us know how we can get one for testing?</p>
<h3 style="margin:18px 0 6px;font-size:16px">3. Guidelines</h3>
<p>Please could you send us the guidelines for this integration, including:</p>
<ul>
<li>the current SDK and documentation (we have started from tech.dojo.pos:tap-to-pay-on-pocket:1.0.0);</li>
<li>how to test on sandbox, and how a device is activated for it;</li>
<li>the certification or accreditation steps before going live; and</li>
<li>anything you need from us to enable it for a venue.</li>
</ul>
<p>Thanks very much,</p>
<p><b>Vesopa Developer</b><br>Vesopa Software Ltd<br>
<a href="mailto:muzahid@vesopa.com">muzahid@vesopa.com</a> | <a href="https://vesopasoftware.com">vesopasoftware.com</a></p>
</div>"""

m = EmailMessage()
m["From"] = "Vesopa Developer <muzahid@vesopa.com>"
m["To"] = ("Fintan Bridger <fintan.bridger@paymentsense.com>, Alex Radzio <alex.radzio@dojo.tech>, "
           "Francis Lawrence <francis.lawrence@paymentsense.com>")
m["Cc"] = "Meirion Davies <info@vesopasoftware.com>, Meirion Davies <info@vesopa.com>"
m["Reply-To"] = "Vesopa Developer <muzahid@vesopa.com>"
m["Subject"] = "Re: Vesopa Software Ltd: live API access, and Tap to Pay on iPhone for Pontardawe RFC"
m["Date"] = "Fri, 06 Nov 2026 09:00:00 +0000"
m["Message-ID"] = make_msgid(domain="vesopa.com")
m.set_content(TEXT)
m.add_alternative(HTML, subtype="html")
OUT.write_bytes(m.as_bytes())
print(OUT)
