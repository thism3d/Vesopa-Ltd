"""The legal pages Vesopa Software Ltd publishes on vesopaepos.com, vesopasoftware.com
and go.vesopa.com (owner, 2026-11-08: "compliance and terms and requirements and
refund and other policies ... Vesopa Software Ltd agreed to those and follows
strict rules and policy compliance ... respect the policies with other countries").

One source for all three sites: tool/make_legal_pages.py wraps each page in that
site's own look. Facts here are the company's own (Companies House 17362206,
the Baglan address, the phone numbers in vesopa_web/src/config.js). Nothing here
claims a certificate or registration Vesopa does not hold.
"""

UPDATED = "8 November 2026"

COMPANY = {
    "name": "Vesopa Software Ltd",
    "number": "17362206",
    "address": "Baglan Innovation Centre, Central Avenue, Baglan, Port Talbot, SA12 7AX, Wales, United Kingdom",
    "email": "info@vesopa.com",
    "support": "support@vesopa.com",
    "phone": "+44 1792 316282",
    "phone_e164": "+441792316282",
    "mobile": "+44 7501 928043",
}

C = COMPANY
CONTACT_LINE = (f'<a href="mailto:{C["email"]}">{C["email"]}</a>, telephone '
                f'<a href="tel:{C["phone_e164"]}">{C["phone"]}</a>')
WHO = (f'<p>These pages are published by <b>{C["name"]}</b>, a private limited company registered in England and Wales, '
       f'company number {C["number"]}, registered office {C["address"]}. Contact: {CONTACT_LINE}. '
       f'In these pages "Vesopa", "we" and "us" mean {C["name"]}.</p>')

# Each page: slug, title, one-line summary, body HTML (h2 sections).
PAGES = []


def page(slug, title, summary, body):
    PAGES.append({"slug": slug, "title": title, "summary": summary, "body": body.strip()})


page("legal", "Legal and compliance", "Every policy that governs Vesopa's products, in one place.", f"""
{WHO}
<h2>Our commitment</h2>
<p>{C["name"]} has adopted every policy listed on this page and follows it in how we sell, bill, support and protect our customers. Our directors are responsible for them, we review them at least once a year and whenever the law or our products change, and the date at the top of each page shows when it last changed.</p>
<p>We work to the law of England and Wales and the rest of the United Kingdom, and we respect the mandatory rights that customers have under the law of the country they live in (see <a href="/international">International customers</a>).</p>
<h2>The policies</h2>
<ul class="legal-list">
  <li><a href="/terms">Terms and conditions</a>: the agreement for our software, apps, subscriptions and hardware.</li>
  <li><a href="/refund">Refunds, cancellations and returns</a>: cooling-off periods, how to cancel, how refunds are paid.</li>
  <li><a href="/privacy">Privacy policy</a>: what personal data we hold, why, and your rights under UK GDPR and EU GDPR.</li>
  <li><a href="/cookies">Cookie policy</a>: the cookies our websites use and how to choose.</li>
  <li><a href="/payments-security">Payments and card security</a>: how card payments are taken, Strong Customer Authentication, PCI DSS.</li>
  <li><a href="/acceptable-use">Acceptable use policy</a>: what our services may not be used for.</li>
  <li><a href="/complaints">Complaints procedure</a>: how to complain and what happens next.</li>
  <li><a href="/international">International customers</a>: consumer rights outside the UK, currency, tax, sanctions.</li>
  <li><a href="/company">Company and trader information</a>: who we are, for app stores, marketplaces and the EU Digital Services Act.</li>
</ul>
<h2>Our apps</h2>
<ul class="legal-list">
  <li><a href="https://vesopasoftware.com/apps/vesopa-go">Vesopa Go</a>: trader information, privacy and terms.</li>
  <li><a href="https://vesopasoftware.com/apps/pontardawe-rfc">Pontardawe RFC</a>: trader information, privacy and terms (published by Vesopa for Pontardawe RFC).</li>
</ul>
""")

page("refund", "Refunds, cancellations and returns",
     "Cooling-off periods, cancelling a subscription, returning hardware and how refunds are paid.", f"""
{WHO}
<h2>1. Who this applies to</h2>
<p>Most of our customers are businesses (venues, clubs and shops). Some rights below apply only to <b>consumers</b>, that is, people buying for themselves rather than for a business. Where a right is for consumers only, we say so. Nothing in this policy takes away a right you have by law.</p>

<h2>2. Free trials</h2>
<p>A Vesopa EPOS free trial may start with a <b>£1.00 card check</b>. We refund the £1.00 straight away, and it normally shows back on your statement within 5 to 10 working days, depending on your bank. Nothing else is charged during the trial. If you do not want to continue, tell us before the trial ends and nothing is taken.</p>

<h2>3. Subscriptions (Vesopa EPOS, Vesopa Go, apps and add-ons)</h2>
<ul>
  <li><b>Cancelling:</b> you can cancel at any time by emailing <a href="mailto:{C["email"]}">{C["email"]}</a>, replying to any billing email, or from your account. Cancelling stops the next payment; your service carries on to the end of the term you have already paid for.</li>
  <li><b>30-day money back:</b> if you are not satisfied, tell us within 30 days of your <b>first</b> subscription payment and we refund that payment in full.</li>
  <li><b>After that:</b> fees for a term that has started are not refundable, except where we have failed to provide the service, charged you in error, or the law requires a refund.</li>
  <li><b>Consumers (14-day cooling-off):</b> under the UK Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013, and the equivalent law in the EU, you may cancel within 14 days of the contract starting for a full refund. If you asked us to start the service within those 14 days, we may keep a fair amount for the days you used.</li>
  <li><b>Charged in error:</b> a duplicate or wrong charge is refunded in full as soon as we confirm it, normally within 2 working days.</li>
</ul>

<h2>4. Hardware (tills, printers, screens, card readers)</h2>
<ul>
  <li><b>Faulty or damaged on arrival:</b> tell us within 30 days of delivery and we repair, replace or refund it in full, including delivery, under the Consumer Rights Act 2015 for consumers and our warranty for businesses. We arrange and pay for the return.</li>
  <li><b>Changed your mind (consumers):</b> you may cancel within 14 days of receiving the goods and return them within a further 14 days, unused and in their original packaging. We refund the price and the standard delivery charge; you pay the cost of sending them back.</li>
  <li><b>Changed your mind (businesses):</b> unused hardware in its original packaging, with all its accessories, may be returned within 14 days of delivery for a full refund of its price. Damage or missing parts may reduce the refund.</li>
  <li><b>Warranty:</b> hardware we sell has a 12-month warranty: we repair or replace a faulty item. Damage from misuse or improper handling is not covered. Card machines supplied by a payment provider (Dojo, Teya, Barclaycard or Stripe) are covered by that provider's own terms.</li>
</ul>

<h2>5. What is not refundable</h2>
<ul>
  <li>Installation, setup and training once delivered.</li>
  <li>Software developed to your own specification, except as the written quote or statement of work says, or where it was not delivered as agreed and we could not put it right.</li>
  <li>Hardware damaged by misuse or improper handling.</li>
</ul>

<h2>6. How refunds are paid</h2>
<ul>
  <li>Refunds go back to the <b>same card, wallet (Apple Pay, Google Pay) or account</b> you paid with. We do not refund in cash or to a different card.</li>
  <li>We send the refund within <b>14 days</b> of agreeing it (for returned goods, within 14 days of receiving them back). Banks usually show it within 5 to 10 working days after that.</li>
  <li>You get an email confirming the refund and, where VAT was charged, a credit note.</li>
</ul>

<h2>7. Payments made in a venue</h2>
<p>When you pay a venue (a bar, restaurant or club) that uses Vesopa EPOS, Vesopa Go or a venue app, your contract is with <b>that venue</b>, and refunds are a matter for the venue under its own policy. The venue can refund through its till. If you cannot resolve it with the venue, your card issuer may be able to help.</p>

<h2>8. Disputes and chargebacks</h2>
<p>Please contact us first: most problems are fixed the same day. If you raise a chargeback with your bank, we respond with the facts of the payment. Raising a chargeback does not end your contract or what you owe under it.</p>

<h2>9. Contact</h2>
<p>{CONTACT_LINE}. Written requests: {C["name"]}, {C["address"]}.</p>
""")

page("payments-security", "Payments and card security",
     "Who takes card payments, how your card is protected, and Strong Customer Authentication.", f"""
{WHO}
<h2>1. Who processes payments</h2>
<p>We never see or store your full card number. Card payments are processed by regulated payment providers:</p>
<ul>
  <li><b>Stripe</b> (Stripe Payments UK Ltd and Stripe Payments Europe Ltd) processes payments to Vesopa on vesopaepos.com, and Tap to Pay and card readers for venues that choose Stripe.</li>
  <li><b>Dojo</b> (Paymentsense Limited), <b>Teya</b> and <b>Barclaycard</b> process payments for venues that choose them, under each venue's own agreement with that provider.</li>
</ul>
<p>Each provider is authorised by the Financial Conduct Authority or another European regulator, and certified to <b>PCI DSS Level 1</b>, the highest level of the Payment Card Industry Data Security Standard.</p>

<h2>2. Paying on our websites</h2>
<ul>
  <li>Payments to Vesopa are taken on our own page at vesopaepos.com: card, <b>Apple Pay</b>, <b>Google Pay</b> or Link. The card fields are provided by Stripe inside a secure frame, so the card details go straight from your device to Stripe over an encrypted (TLS) connection.</li>
  <li>Prices are in pounds sterling (GBP). Business prices are shown excluding VAT, which is added at 20% where it applies, and your VAT invoice is emailed when the payment is confirmed.</li>
  <li><b>Strong Customer Authentication:</b> under the UK and EU Payment Services Regulations your bank may ask you to confirm a payment (3-D Secure, a code or your banking app). Apple Pay and Google Pay confirm with Face ID, Touch ID or your device PIN.</li>
  <li>The statement shows <b>VESOPA</b> with a short reference.</li>
</ul>

<h2>3. Paying in a venue</h2>
<ul>
  <li>Tap to Pay on iPhone and Android, and card readers, read the card directly through the payment provider's certified software. The venue's staff never see the card number or the PIN.</li>
  <li>When a PIN is needed, it is entered on the payment provider's secure PIN screen, which the customer uses directly.</li>
  <li>The venue is the seller. Vesopa provides the software and records the result the payment provider returns.</li>
</ul>

<h2>4. How we protect your data</h2>
<ul>
  <li>All our sites and apps use encrypted connections (HTTPS, TLS 1.2 or later).</li>
  <li>Payment provider keys are held only on our servers, never in an app or a web page.</li>
  <li>Access to customer data is limited to staff who need it, protected by strong sign-in, and logged.</li>
  <li>We keep payment records for six years, as UK tax law requires, and nothing more about your card than the provider returns (for example "Visa ending 4242").</li>
</ul>

<h2>5. Report a problem</h2>
<p>If you think a payment is wrong or your card has been misused, contact your bank at once and tell us at <a href="mailto:{C["email"]}">{C["email"]}</a>. To report a security issue in our software, email <a href="mailto:{C["support"]}">{C["support"]}</a> with "Security" in the subject.</p>
""")

page("acceptable-use", "Acceptable use policy",
     "What Vesopa's software, apps and websites may not be used for.", f"""
{WHO}
<h2>1. Purpose</h2>
<p>This policy applies to everyone who uses our software, apps, websites and services. It forms part of our <a href="/terms">terms and conditions</a>.</p>
<h2>2. You must not use our services</h2>
<ul>
  <li>for anything unlawful, fraudulent or deceptive, including money laundering, terrorist financing or getting round sanctions;</li>
  <li>to sell or take payment for goods or services that our payment providers prohibit (for example, illegal drugs, weapons, counterfeit goods, unlicensed gambling, or adult content), or that are against the law where you trade;</li>
  <li>to sell alcohol, tobacco, vapes or other age-restricted items without checking the buyer's age as the law requires;</li>
  <li>to process a card payment for anyone other than your own business (no "factoring" or splitting a sale to avoid limits);</li>
  <li>to collect, store or share personal data in breach of data protection law, or send marketing without consent;</li>
  <li>to break into, test, overload or disrupt our systems, or get round licensing, permissions or security;</li>
  <li>to copy, resell, reverse engineer or build a competing product from our software, except where the law allows;</li>
  <li>to upload anything harmful (malware), infringing, defamatory, hateful or abusive.</li>
</ul>
<h2>3. What we do</h2>
<p>If we reasonably believe this policy is being broken, we may suspend the account or the payments involved, tell the payment provider, and report it to the police or another authority where the law requires. We tell you why unless the law prevents it. Serious or repeated breaches end the agreement.</p>
<h2>4. Reporting</h2>
<p>To report misuse, email <a href="mailto:{C["email"]}">{C["email"]}</a>.</p>
""")

page("complaints", "Complaints procedure", "How to complain, how quickly we answer, and where to go next.", f"""
{WHO}
<h2>1. How to complain</h2>
<p>Tell us by email at <a href="mailto:{C["email"]}">{C["email"]}</a>, by phone on <a href="tel:{C["phone_e164"]}">{C["phone"]}</a>, or in writing to {C["name"]}, {C["address"]}. Please tell us your name, your venue or account, what went wrong, and what you would like us to do.</p>
<h2>2. What happens next</h2>
<ol>
  <li>We acknowledge your complaint within <b>2 working days</b>.</li>
  <li>A named person looks into it, and we aim to give you a full answer within <b>10 working days</b>. If it needs longer, we tell you why and when you will hear.</li>
  <li>If you are not happy with the answer, ask for it to go to a director, who replies within <b>10 working days</b> with our final response.</li>
</ol>
<h2>3. If it is about a payment in a venue</h2>
<p>Payments in a venue are between you and that venue. Please contact the venue first. We help the venue look into it.</p>
<h2>4. If you are still not satisfied</h2>
<ul>
  <li><b>Consumers in the UK</b> may contact <a href="https://www.citizensadvice.org.uk/consumer/">Citizens Advice</a> or take a claim to court (small claims for amounts up to £10,000 in England and Wales).</li>
  <li><b>Data protection:</b> you may complain to the Information Commissioner's Office at <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk</a>, or to the data protection authority where you live in the EU.</li>
  <li><b>Card payments:</b> your card issuer may be able to help through its dispute process.</li>
</ul>
<p>We keep a record of complaints and review them so the same problem does not happen again.</p>
""")

page("international", "International customers", "Consumer rights, currency, tax and sanctions for customers outside the UK.", f"""
{WHO}
<h2>1. Where we sell</h2>
<p>We are based in the United Kingdom and sell mainly to customers in the UK. Our apps are available in other countries through the Apple App Store and Google Play. We respect the laws of the countries where we make our products available.</p>
<h2>2. Your local rights</h2>
<ul>
  <li><b>European Union and EEA:</b> if you are a consumer, you keep the protection of the mandatory consumer law of your country, including the 14-day right of withdrawal and the legal guarantee for goods. Personal data is handled under the EU GDPR as well as UK GDPR; transfers between the UK and the EU rely on the adequacy decision of the European Commission. The European Commission's online dispute resolution platform has closed; you may contact a national consumer body or your local courts.</li>
  <li><b>United States:</b> residents of California and other states with privacy laws may ask what personal information we hold, ask us to delete or correct it, and opt out of its sale or sharing. <b>We do not sell personal information</b> and do not share it for cross-context behavioural advertising.</li>
  <li><b>Canada, Australia and New Zealand:</b> we follow PIPEDA, the Australian Privacy Principles and the New Zealand Privacy Act where they apply, and nothing in our terms limits the consumer guarantees those countries give by law.</li>
  <li><b>Anywhere else:</b> where your local law gives you a right that cannot be excluded by contract, our terms do not take it away.</li>
</ul>
<h2>3. Currency and tax</h2>
<p>We charge in pounds sterling (GBP). Your bank may convert the amount and charge a fee for doing so. UK VAT is added at 20% where it applies; business customers outside the UK may be charged without VAT where the reverse charge applies, if they give us a valid VAT or tax number.</p>
<h2>4. Sanctions and export</h2>
<p>We do not sell to, or allow our services to be used by, people or organisations under UK, UN, EU or US sanctions, or in countries where that is prohibited.</p>
<h2>5. Language and governing law</h2>
<p>Our contracts and policies are in English. They are governed by the law of England and Wales, and the courts of England and Wales have jurisdiction, except that a consumer may also bring a claim in the courts of the country where they live and keeps the protection of its mandatory law.</p>
<h2>6. Accessibility</h2>
<p>We aim to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA on our websites and apps. If something is hard to use, tell us at <a href="mailto:{C["email"]}">{C["email"]}</a> and we will help and fix it.</p>
""")

page("company", "Company and trader information",
     "Who Vesopa Software Ltd is: the trader behind our websites and apps.", f"""
<p>{C["name"]} is the <b>trader</b> (seller) for our websites, for Vesopa EPOS, and for the apps we publish on the Apple App Store and Google Play, including on behalf of venues. This page gives the information the App Store, Google Play and the EU Digital Services Act ask a trader to publish.</p>
<table class="legal-table">
  <tr><th>Trader name</th><td>{C["name"]}</td></tr>
  <tr><th>Legal form</th><td>Private company limited by shares</td></tr>
  <tr><th>Registered in</th><td>England and Wales (Companies House)</td></tr>
  <tr><th>Company number</th><td>{C["number"]}</td></tr>
  <tr><th>Address</th><td>{C["address"]}</td></tr>
  <tr><th>Email</th><td><a href="mailto:{C["email"]}">{C["email"]}</a></td></tr>
  <tr><th>Support</th><td><a href="mailto:{C["support"]}">{C["support"]}</a></td></tr>
  <tr><th>Telephone</th><td><a href="tel:{C["phone_e164"]}">{C["phone"]}</a></td></tr>
  <tr><th>Websites</th><td><a href="https://vesopasoftware.com">vesopasoftware.com</a>, <a href="https://vesopaepos.com">vesopaepos.com</a>, <a href="https://go.vesopa.com">go.vesopa.com</a></td></tr>
</table>
<h2>Our apps</h2>
<ul class="legal-list">
  <li><a href="https://vesopasoftware.com/apps/vesopa-go">Vesopa Go</a></li>
  <li><a href="https://vesopasoftware.com/apps/pontardawe-rfc">Pontardawe RFC</a></li>
</ul>
<h2>Our commitment</h2>
<p>We confirm that we only offer products and services that comply with the law of the United Kingdom and of the European Union where we make them available, and we follow the <a href="/legal">policies listed here</a>.</p>
""")

# App trader pages: vesopasoftware.com/apps/<slug> only.
APPS = [
    {
        "slug": "vesopa-go",
        "name": "Vesopa Go",
        "what": "Vesopa Go is the till, kitchen screen and customer display for venues that use Vesopa EPOS, on iPhone, iPad and Android, with Tap to Pay.",
        "for": "Venues that use Vesopa EPOS, and their staff.",
        "stores": [
            ("Google Play", "https://play.google.com/store/apps/details?id=com.vesopa.go"),
            ("Website", "https://go.vesopa.com"),
        ],
        "privacy": "https://go.vesopa.com/privacy",
        "terms": "https://go.vesopa.com/terms",
        "support": "https://go.vesopa.com/support",
        "payments": "Card payments in Vesopa Go are processed by the venue's chosen provider (Stripe, Dojo or Teya) under the venue's own agreement with that provider. Vesopa never sees the card number or PIN.",
    },
    {
        "slug": "pontardawe-rfc",
        "name": "Pontardawe RFC",
        "what": "The official app of Pontardawe RFC: membership, rewards, news, fixtures and ordering at the club. Published by Vesopa Software Ltd for Pontardawe RFC.",
        "for": "Members, supporters and visitors of Pontardawe RFC.",
        "stores": [
            ("App Store", "https://apps.apple.com/gb/app/pontardawe-rfc/id6821217200"),
            ("Google Play", "https://play.google.com/store/apps/details?id=com.vesopaepos.pontardawerfc"),
            ("Website", "https://pontardawerfc.com"),
        ],
        "privacy": "https://pontardawerfc.com/app/privacy",
        "terms": "https://pontardawerfc.com/app/terms",
        "support": "https://pontardawerfc.com/app/privacy-choices",
        "payments": "Payments in the app are made to Pontardawe RFC, which is the seller of the goods and services. They are processed by the club's payment provider; Vesopa never sees the card number.",
    },
]
