"""Vesopa-Dojo-pocket-address.eml (2026-11-06): to Fintan, Alex and Francis, cc Meirion.
Answers Dojo's offer to ship a Pocket: the delivery address, please send it fast,
and the news that Pontardawe RFC is live on the App Store.

    python vesopa_server/tool/invite/dojo/source/make_pocket_address_eml.py
"""
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "Vesopa-Dojo-pocket-address.eml"
APP = "https://apps.apple.com/us/app/pontardawe-rfc/id6821217200"

TEXT = f"""Hi Fintan, Alex and Francis,

Thanks for coming back to us so quickly. I'm writing on behalf of Meirion Davies, Director of Vesopa Software Ltd.

Yes please, do ship the Dojo Pocket to us. Here is the delivery address:

Meirion Davies
Vesopa Software Ltd
Baglan Innovation Centre
Central Avenue
Baglan
Port Talbot
SA12 7AX
United Kingdom

Telephone: +44 1792 316282
Email: info@vesopa.com

Please could you send it as fast as possible, and let us know the tracking details when it goes out?

Some good news too: today we officially launched the Pontardawe RFC app on the App Store:
{APP}

And our Vesopa Go app (com.vesopa.go) has Apple's Tap to Pay on iPhone development entitlement for NFC payments.

Thanks very much,

Vesopa Developer
On behalf of Meirion Davies
Vesopa Software Ltd
muzahid@vesopa.com | https://vesopasoftware.com
"""

HTML = f"""<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#0B0E0A;max-width:640px">
<p>Hi Fintan, Alex and Francis,</p>
<p>Thanks for coming back to us so quickly. I'm writing on behalf of Meirion Davies, Director of Vesopa Software Ltd.</p>
<p>Yes please, do ship the Dojo Pocket to us. Here is the delivery address:</p>
<p style="margin-left:16px"><b>Meirion Davies</b><br>Vesopa Software Ltd<br>Baglan Innovation Centre<br>Central Avenue<br>Baglan<br>Port Talbot<br>SA12 7AX<br>United Kingdom</p>
<p style="margin-left:16px">Telephone: +44 1792 316282<br>Email: <a href="mailto:info@vesopa.com">info@vesopa.com</a></p>
<p>Please could you send it as fast as possible, and let us know the tracking details when it goes out?</p>
<p>Some good news too: today we officially launched the <a href="{APP}">Pontardawe RFC app on the App Store</a>.</p>
<p>And our Vesopa Go app (com.vesopa.go) has Apple's Tap to Pay on iPhone development entitlement for NFC payments.</p>
<p>Thanks very much,</p>
<p><b>Vesopa Developer</b><br>On behalf of Meirion Davies<br>Vesopa Software Ltd<br>
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
m["In-Reply-To"] = "<179392854107.24840.294125586649387198@vesopa.com>"
m["References"] = "<179392854107.24840.294125586649387198@vesopa.com>"
m.set_content(TEXT)
m.add_alternative(HTML, subtype="html")
OUT.write_bytes(m.as_bytes())
print(OUT)
