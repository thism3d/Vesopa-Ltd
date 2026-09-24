#!/usr/bin/env node
/* Build the document pages — support, terms, privacy, cookies, deletion.
 *
 * Six pages that share a bar, a footer, a company block and a set of facts
 * (the support address, the company number, the cookie names). Hand-written
 * six times over, those drift: the version of the footer on /terms ends up
 * naming a page that /privacy has since renamed, and the one place a reviewer
 * checks is the one that is stale. So the shell and the facts live here once
 * and the pages are generated from them.
 *
 *   node tools/pages.mjs        writes site/{support,terms,privacy,...}.html
 *
 * The output is committed and served as static HTML — express.static with
 * `extensions:["html"]` answers /support from site/support.html, so there is
 * no route to add and nothing to keep running.                             */
import { writeFileSync } from "node:fs";

/* ---------- the facts, stated once ---------- */
export const F = {
  company: "Vesopa Software Ltd",
  number: "17362206",
  where: "England and Wales",
  address: "Baglan, Port Talbot, SA12 7AX, Wales, United Kingdom",
  support: "support@vesopasoftware.com",
  privacyEmail: "support@vesopasoftware.com",
  info: "info@vesopa.com",
  phone: "+44 1792 316282",
  phoneHref: "+441792316282",
  site: "https://vesopasoftware.com",
  updated: "2 September 2026",
  hours: "Monday to Friday, 9am – 6pm UK time",
};

const NAV = [
  ["/support", "Support"],
  ["/terms", "Terms"],
  ["/privacy", "Privacy"],
  ["/cookies", "Cookies"],
  ["/data-deletion", "Data deletion"],
  ["/delete-my-data", "Delete my data"],
];

const shell = ({ slug, title, description, body, wide }) => `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — ${F.company}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${F.site}${slug}">
<meta name="robots" content="index,follow">
<meta property="og:title" content="${title} — ${F.company}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${F.site}${slug}">
<meta property="og:type" content="website">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..700&family=Source+Serif+4:opsz,wght@8..60,300..600&family=Martian+Mono:wght@300;500&display=swap">
<link rel="stylesheet" href="/css/page.css">
</head>
<body>

<header class="bar">
  <a class="home" href="/">Vesopa Software</a>
  <nav>${NAV.map(([h, l]) =>
    `<a href="${h}"${h === slug ? ' aria-current="page"' : ""}>${l}</a>`).join("\n    ")}
  </nav>
</header>

<main class="wrap${wide ? " wide" : ""}">
${body}
</main>

<footer>
  <div class="inner">
    <nav>
      <a href="/">Home</a>
      ${NAV.map(([h, l]) => `<a href="${h}">${l}</a>`).join("\n      ")}
      <a href="/portal">Portal</a>
    </nav>
    <div class="legal">
      <p><b>${F.company}</b> — a company registered in ${F.where}, company number ${F.number}.</p>
      <p>${F.address}</p>
      <p>${F.support} &nbsp;·&nbsp; <a href="tel:${F.phoneHref}">${F.phone}</a></p>
    </div>
  </div>
</footer>

</body>
</html>
`;

/* The one script on any of these pages: it posts a form to the JSON API and
   writes the answer back into the page. Inline, because a document page
   loading a module to submit one form is a worse trade than four lines of
   duplication — and because it must work if anything else on the page fails. */
const formJs = (formId, endpoint, okMsg) => `
<script>
(function () {
  var f = document.getElementById(${JSON.stringify(formId)});
  if (!f) return;
  var msg = f.querySelector(".form-msg");
  var btn = f.querySelector("button[type=submit]");
  f.addEventListener("submit", async function (e) {
    e.preventDefault();
    msg.className = "form-msg";
    msg.textContent = "Sending…";
    btn.disabled = true;
    var data = {};
    new FormData(f).forEach(function (v, k) {
      if (data[k] === undefined) data[k] = v;
      else if (Array.isArray(data[k])) data[k].push(v);
      else data[k] = [data[k], v];
    });
    try {
      var r = await fetch(${JSON.stringify(endpoint)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      var j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "That did not go through.");
      msg.className = "form-msg ok";
      msg.textContent = ${JSON.stringify(okMsg)} + (j.ref ? " Your reference is " + j.ref + "." : "");
      f.reset();
    } catch (err) {
      msg.className = "form-msg bad";
      msg.textContent = err.message + " You can also email ${F.support} directly.";
    } finally {
      btn.disabled = false;
    }
  });
})();
</script>`;

export { shell, formJs, NAV };

/* ================= support ================= */
const support = `
<span class="eyebrow">Support</span>
<h1>Talk to a person.</h1>
<p class="lead">Every message reaches the people who build and run the software. There is no ticket maze and no first-line script.</p>

<div class="key">
  <p class="big"><a href="mailto:${F.support}">${F.support}</a></p>
  <p>The fastest way to reach us, for anything at all — a fault, a question, billing, an account, or a request about your data.</p>
</div>

<div class="cards">
  <div class="card">
    <h3>Email</h3>
    <p><a href="mailto:${F.support}">${F.support}</a></p>
  </div>
  <div class="card">
    <h3>Phone</h3>
    <p><a href="tel:${F.phoneHref}">${F.phone}</a><br>${F.hours}</p>
  </div>
  <div class="card">
    <h3>Post</h3>
    <p>${F.company}<br>${F.address}</p>
  </div>
</div>

<h2 id="response">What to expect</h2>
<div class="rows">
  <div class="row"><b>Anything</b><div><p>A reply from a person within one working day. Most arrive the same day.</p></div></div>
  <div class="row"><b>Till down</b><div><p>If a till, kitchen screen or customer display is out of service in a live venue, say so in the first line and call the number above. That is treated as an emergency, not a queue position.</p></div></div>
  <div class="row"><b>Billing</b><div><p>Invoices, receipts and payment questions are answered from the same address, or from inside your portal where the whole history sits.</p></div></div>
  <div class="row"><b>Your data</b><div><p>Access, correction, export and deletion requests are answered within 30 days, and usually within a few. See <a href="/data-deletion">data deletion</a>.</p></div></div>
</div>

<h2 id="apps">The apps we support</h2>
<p>Vesopa EPOS, Vesopa Kitchen and Vesopa Customer Display, distributed through the Microsoft Store; the Vesopa customer portal at <a href="/portal">vesopasoftware.com/portal</a>; and any site, app or system we have built for you under a project.</p>
<p>If you bought a Vesopa product through a reseller or an app store, you can still come straight to us — you do not have to go back through them.</p>

<h2 id="before">Before you write</h2>
<p>Two lines make almost every fault faster to fix: what you were doing, and what happened instead. If you can, add the venue name, the device (till, kitchen screen, customer display, phone, browser) and the time it happened. Screenshots are always welcome.</p>

<h2 id="message">Send a message</h2>
<p>This reaches the same inbox as the address above. If you would rather use your own mail client, do — nothing here is required.</p>

<form class="form-card" id="support-form" novalidate>
  <div class="two">
    <div class="fld"><label for="s-name">Your name</label><input id="s-name" name="name" required autocomplete="name"></div>
    <div class="fld"><label for="s-email">Email</label><input id="s-email" name="email" type="email" required autocomplete="email"></div>
  </div>
  <div class="two">
    <div class="fld"><label for="s-phone">Phone (optional)</label><input id="s-phone" name="phone" type="tel" autocomplete="tel"></div>
    <div class="fld"><label for="s-subject">Subject</label><input id="s-subject" name="subject" placeholder="What is this about?"></div>
  </div>
  <div class="fld">
    <label for="s-message">Message</label>
    <textarea id="s-message" name="message" required></textarea>
    <span class="hint">What you were doing, and what happened instead.</span>
  </div>
  <div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
  <button class="btn" type="submit">Send message</button>
  <div class="form-msg" role="status"></div>
</form>
${formJs("support-form", "/api/contact", "Thank you — that reached us and a person will read it.")}
`;

/* ================= terms ================= */
const terms = `
<span class="eyebrow">Legal</span>
<h1>Terms and conditions</h1>
<p class="stamp">Last updated ${F.updated}</p>
<p class="lead">These terms govern your use of the Vesopa Software website, the customer portal, and the Vesopa applications. Please read them; using any of those means you accept them.</p>

<div class="toc">
  <b>On this page</b>
  <ol>
    <li><a href="#who">Who we are</a></li>
    <li><a href="#accept">Acceptance</a></li>
    <li><a href="#services">What we provide</a></li>
    <li><a href="#accounts">Accounts</a></li>
    <li><a href="#acceptable">Acceptable use</a></li>
    <li><a href="#quotes">Quotes, projects and change</a></li>
    <li><a href="#fees">Fees, invoices and payment</a></li>
    <li><a href="#ip">Intellectual property</a></li>
    <li><a href="#yourdata">Your data and your content</a></li>
    <li><a href="#third">Third-party services and app stores</a></li>
    <li><a href="#availability">Availability and support</a></li>
    <li><a href="#warranty">Warranties</a></li>
    <li><a href="#liability">Liability</a></li>
    <li><a href="#term">Term, suspension and termination</a></li>
    <li><a href="#consumer">Consumers and cancellation</a></li>
    <li><a href="#changes">Changes to these terms</a></li>
    <li><a href="#law">Governing law</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</div>

<h2 id="who">1. Who we are</h2>
<p>${F.company} ("Vesopa", "we", "us") is a company registered in ${F.where} under company number ${F.number}, with its address at ${F.address}. You can reach us at <a href="mailto:${F.support}">${F.support}</a> or ${F.phone}.</p>

<h2 id="accept">2. Acceptance</h2>
<p>By visiting this website, creating a portal account, or installing or using a Vesopa application, you agree to these terms. If you are agreeing on behalf of a business, you confirm you are authorised to bind it, and "you" means that business.</p>
<p>Where we have signed a separate written agreement, statement of work or order form with you, that document takes precedence over these terms to the extent the two conflict.</p>

<h2 id="services">3. What we provide</h2>
<p>Depending on what you have bought from us, the services may include:</p>
<ul>
  <li><b>Applications</b> — Vesopa EPOS, Vesopa Kitchen and Vesopa Customer Display, and any other software we publish.</li>
  <li><b>The customer portal</b> — an account at <a href="/portal">vesopasoftware.com/portal</a> showing your projects, files, messages, invoices and receipts.</li>
  <li><b>Project work</b> — software we design, build, host or maintain for you under an agreed brief.</li>
  <li><b>Hosting and support</b> — where you have bought them.</li>
</ul>
<p>We may improve, change or discontinue features. Where a change materially reduces a paid service you rely on, we will tell you in advance and, if you would rather not continue, refund the unused part of anything you have paid in advance for it.</p>

<h2 id="accounts">4. Accounts</h2>
<p>You are responsible for the accuracy of the details on your account, for keeping your password confidential, and for everything done through your account. Tell us immediately at <a href="mailto:${F.support}">${F.support}</a> if you believe an account has been used without your permission.</p>
<p>Accounts are for named people. Do not share one login between several people; invite them to the project instead, which is free and gives everyone their own record.</p>
<p>You must be at least 18 years old, or the age of majority where you live, to hold an account. Our services are built for businesses and are not directed at children.</p>

<h2 id="acceptable">5. Acceptable use</h2>
<p>You agree not to:</p>
<ul>
  <li>break the law, or use our services to help anybody else break it;</li>
  <li>upload malware, or anything designed to interfere with the service or another user;</li>
  <li>attempt to gain access to accounts, systems or data that are not yours, or to probe, scan or test our systems without our written permission;</li>
  <li>copy, resell, sublicense or reverse-engineer our software except where the law says you may despite this clause;</li>
  <li>use the service in a way that damages its availability or performance for anyone else, including automated scraping or load beyond a fair level;</li>
  <li>upload content you do not have the right to upload, or that is unlawful, defamatory or infringing.</li>
</ul>
<p>Our AI assistant is a convenience, not an oracle: do not paste anything into it that you are not willing to send to a third-party model provider, and do not rely on its answers for legal, financial or safety decisions. See <a href="/privacy#ai">the privacy policy</a> for where those messages go.</p>

<h2 id="quotes">6. Quotes, projects and change</h2>
<p>The estimate produced by the calculator on our website is an <b>indication</b> generated from what you ticked. It is not an offer, a quotation or a fixed price. A firm figure follows only after a person has read the brief, and is given in writing.</p>
<p>Project work proceeds against a written scope. Anything outside that scope is a change: we will tell you what it costs and how it affects the date before doing it, and we will not do it until you say yes.</p>
<p>Timescales we give are honest estimates. Where a date depends on something from you — content, access, credentials, a decision, a third-party approval — the date moves if that does.</p>

<h2 id="fees">7. Fees, invoices and payment</h2>
<p>Prices are as quoted in writing or as shown on your invoice, and are exclusive of VAT unless stated otherwise. Invoices are issued through your portal and by email.</p>
<p>Unless your invoice says otherwise, payment is due within <b>14 days</b> of the invoice date. We may charge statutory interest and reasonable recovery costs on late commercial payments under the Late Payment of Commercial Debts (Interest) Act 1998.</p>
<p>Subscription and hosting fees are billed in advance for the period shown on the invoice, and renew automatically unless cancelled before the renewal date. You can cancel a renewal at any time by writing to <a href="mailto:${F.support}">${F.support}</a>; cancellation takes effect at the end of the period you have already paid for.</p>
<p>We do not take card payments through this website. Where a payment method is offered, it is operated by a regulated payment provider and your card details are handled by that provider, not by us.</p>
<p>A lapsed subscription does not switch your till off. If a payment fails we will chase it as a human being, not as a kill switch.</p>

<h2 id="ip">8. Intellectual property</h2>
<p>We own, or are licensed to use, everything in our software, this website and our brand. Nothing here transfers that to you.</p>
<p>Where you buy a licence to a Vesopa application, you get a non-exclusive, non-transferable right to use it in your own business for as long as your licence or subscription is current, on the number of devices agreed.</p>
<p>For bespoke project work, ownership of the deliverables specific to you passes to you on <b>full payment</b>, except for our pre-existing tools, libraries and frameworks, which remain ours and which you get a perpetual licence to use as part of the deliverable. Third-party and open-source components keep their own licences.</p>
<p>We may name you and describe the work in our portfolio unless you ask us in writing not to.</p>

<h2 id="yourdata">9. Your data and your content</h2>
<p>Your business data stays yours. We process it to provide the service, under our <a href="/privacy">privacy policy</a>, and where we process personal data on your behalf we do so as your processor on your documented instructions.</p>
<p>You can export or ask us to delete your data at any time — see <a href="/data-deletion">data deletion</a>. Some records, principally invoices and accounting entries, we are legally required to keep for six years even after an account closes.</p>
<p>Keep your own backups of anything you cannot afford to lose. We take backups, and they are for our own recovery; they are not a substitute for yours.</p>

<h2 id="third">10. Third-party services and app stores</h2>
<p>Our applications are distributed through the Microsoft Store and may be listed elsewhere. Where you obtain an application through a store, that store's own terms also apply to the download and to any purchase you make through it, and the store — not us — handles that payment.</p>
<p>Our services rely on third parties, including our cloud host, our email relay and the provider behind our AI assistant. We choose them carefully but we do not control them, and we are not liable for a failure that is entirely theirs beyond passing on any remedy we obtain.</p>

<h2 id="availability">11. Availability and support</h2>
<p>We aim for continuous availability but do not guarantee it. Maintenance is normally scheduled outside UK trading hours and announced in advance where it will be noticeable.</p>
<p>Support is provided as described on our <a href="/support">support page</a>. Where you hold a written service level agreement, that document governs instead.</p>

<h2 id="warranty">12. Warranties</h2>
<p>We warrant that we will provide the services with reasonable care and skill, by suitably qualified people, and in accordance with the agreed scope.</p>
<p>Beyond that, and to the extent the law allows, the services are provided "as is": we do not warrant that they will be uninterrupted or error-free, or that they will meet a requirement you have not told us about.</p>

<h2 id="liability">13. Liability</h2>
<p>Nothing in these terms limits liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for anything else that cannot lawfully be limited.</p>
<p>Subject to that, and where you are a business:</p>
<ul>
  <li>we are not liable for loss of profit, loss of business, loss of anticipated savings, loss of goodwill, or for any indirect or consequential loss; and</li>
  <li>our total liability arising in any twelve-month period is limited to the total fees you paid us in that period.</li>
</ul>
<p>Each of us must take reasonable steps to reduce any loss.</p>

<h2 id="term">14. Term, suspension and termination</h2>
<p>These terms apply for as long as you use the services. Either of us may end an ongoing service on 30 days' written notice unless a separate agreement says otherwise.</p>
<p>We may suspend or terminate access immediately where you materially breach these terms, where an invoice is seriously overdue and unanswered, or where we are legally required to. Where we can give warning first, we will.</p>
<p>On termination, you may export your data for 30 days. After that we delete it in accordance with the <a href="/data-deletion">deletion policy</a>, apart from records we must keep.</p>

<h2 id="consumer">15. Consumers and cancellation</h2>
<p>If you are a consumer rather than a business, you keep every right the law gives you, and nothing here reduces them. You normally have 14 days to cancel a distance contract. If you ask us to start work within that period, you may still cancel but you must pay for what has already been done; where a digital service is fully performed within the period with your consent, the right to cancel is lost.</p>

<h2 id="changes">16. Changes to these terms</h2>
<p>We may update these terms. The date at the top always shows the current version. Where a change materially affects a paid service, we will give you at least 30 days' notice by email or in your portal before it applies to you.</p>

<h2 id="law">17. Governing law</h2>
<p>These terms and any dispute arising from them are governed by the laws of England and Wales, and the courts of England and Wales have exclusive jurisdiction. If you are a consumer resident elsewhere in the UK, you may bring proceedings in your own jurisdiction.</p>

<h2 id="contact">18. Contact</h2>
<div class="key">
  <p class="big"><a href="mailto:${F.support}">${F.support}</a></p>
  <p>${F.company}, ${F.address}<br>Company number ${F.number} · ${F.phone}</p>
</div>
`;

/* ================= privacy ================= */
const privacy = `
<span class="eyebrow">Legal</span>
<h1>Privacy policy</h1>
<p class="stamp">Last updated ${F.updated}</p>
<p class="lead">What we collect, why we collect it, who else sees it, how long we keep it, and how to make us stop. Written to be read rather than to be survived.</p>

<div class="key">
  <p><b>The short version.</b> We collect what you send us — your name, your email, what you asked for — and what our server needs to log to stay up. We do not use advertising cookies, we do not track you across other websites, we do not sell or rent your data to anybody, and we never will. You can have a copy of everything we hold, or have it deleted, by writing one email.</p>
</div>

<div class="toc">
  <b>On this page</b>
  <ol>
    <li><a href="#controller">Who is responsible</a></li>
    <li><a href="#collect">What we collect</a></li>
    <li><a href="#why">Why, and on what legal basis</a></li>
    <li><a href="#apps">Data in the Vesopa applications</a></li>
    <li><a href="#ai">The AI assistant</a></li>
    <li><a href="#share">Who else sees it</a></li>
    <li><a href="#transfers">International transfers</a></li>
    <li><a href="#keep">How long we keep it</a></li>
    <li><a href="#security">How we protect it</a></li>
    <li><a href="#rights">Your rights</a></li>
    <li><a href="#deletion">Deleting your data</a></li>
    <li><a href="#cookies">Cookies</a></li>
    <li><a href="#children">Children</a></li>
    <li><a href="#changes">Changes</a></li>
    <li><a href="#complain">Complaints</a></li>
  </ol>
</div>

<h2 id="controller">1. Who is responsible</h2>
<p>${F.company} is the data controller for the personal data described in this policy. We are registered in ${F.where} under company number ${F.number}, at ${F.address}.</p>
<p>For anything about your data, write to <a href="mailto:${F.privacyEmail}">${F.privacyEmail}</a>. It reaches a person, not a queue.</p>
<p>Where we build or host a system for a client, personal data belonging to <i>their</i> customers is processed by us as a <b>processor</b> on that client's instructions; the client is the controller and their own privacy policy applies to it.</p>

<h2 id="collect">2. What we collect</h2>
<div class="rows">
  <div class="row"><b>You give us</b><div>
    <p>Your name, email address, and optionally your phone number and company name, when you request an estimate, send an enquiry, contact support, or create a portal account.</p>
    <p>The content of what you write to us, including messages, project files and attachments you upload.</p>
    <p>Billing details — company name, billing address, VAT and company numbers — where you are invoiced.</p>
  </div></div>
  <div class="row"><b>You create</b><div>
    <p>Inside the portal: projects, tasks, messages, files, invoices, receipts and the record of what changed and when.</p>
  </div></div>
  <div class="row"><b>Automatic</b><div>
    <p>Standard server logs — IP address, date and time, the page or endpoint requested, the response, your browser's user-agent string. These are what tell us the site is up and let us investigate abuse.</p>
    <p>One strictly necessary cookie, and the size you last dragged the AI panel to, which is stored in your own browser. See <a href="/cookies">the cookie policy</a>.</p>
  </div></div>
  <div class="row"><b>We do not</b><div>
    <p>We do not collect special category data (health, biometrics, beliefs, and so on), we do not build advertising profiles, we do not use tracking pixels or third-party analytics, and we do not take card or bank details through this website.</p>
  </div></div>
</div>

<h2 id="why">3. Why, and on what legal basis</h2>
<div class="rows">
  <div class="row"><b>Answer you</b><div><p>To reply to an enquiry, quote or support request. <b>Legitimate interests</b> — you asked us a question and expect an answer — or <b>steps prior to a contract</b> where you are asking us to price work.</p></div></div>
  <div class="row"><b>Provide the service</b><div><p>To run your account, your projects and your support. <b>Performance of a contract</b>.</p></div></div>
  <div class="row"><b>Invoice and get paid</b><div><p>To issue invoices, record payments and keep accounts. <b>Contract</b>, and <b>legal obligation</b> for the accounting records themselves.</p></div></div>
  <div class="row"><b>Keep it up and safe</b><div><p>Logging, backups, rate limiting, and investigating abuse. <b>Legitimate interests</b> in a secure, available service.</p></div></div>
  <div class="row"><b>Tell you things</b><div><p>Service messages about your own account are part of the contract. Marketing email is sent only with your <b>consent</b>, and every one carries an unsubscribe link that works.</p></div></div>
  <div class="row"><b>Comply</b><div><p>Where the law requires us to keep or disclose something. <b>Legal obligation</b>.</p></div></div>
</div>
<p>Where we rely on legitimate interests, we have weighed them against your rights and concluded they do not override them. You can object at any time — see <a href="#rights">your rights</a>.</p>

<h2 id="apps">4. Data in the Vesopa applications</h2>
<p>Vesopa EPOS, Vesopa Kitchen and Vesopa Customer Display run on the venue's own devices and hold the venue's own trading data — products, prices, orders, staff logins, takings. That data belongs to the venue. Where the venue uses our hosted back office, it is stored on our servers on the venue's behalf and we act as their processor.</p>
<p>The applications do not require an end customer of the venue to identify themselves, and they do not collect data from the diner or shopper beyond what the venue itself enters into an order.</p>
<p>The applications do not contain advertising SDKs and do not share data with advertising networks.</p>

<h2 id="ai">5. The AI assistant</h2>
<p>The assistant on our website answers questions about Vesopa. What you type into it is sent to our server and from there to <b>Microsoft Azure AI Foundry</b>, which runs the model that produces the answer. Your message and the answer are processed to generate that answer.</p>
<p>The assistant is anonymous: it does not require an account and we do not attach your identity to what you type. Please do not paste passwords, card numbers or anybody else's personal data into it.</p>

<h2 id="share">6. Who else sees it</h2>
<p>We do not sell, rent or trade personal data. We share it only with the service providers we need in order to operate, each under a contract that limits them to our instructions:</p>
<div class="rows">
  <div class="row"><b>Hosting</b><div><p>Google Cloud Platform — our servers and databases, in the United States.</p></div></div>
  <div class="row"><b>Email delivery</b><div><p>SMTP2GO — delivers the mail we send you.</p></div></div>
  <div class="row"><b>AI assistant</b><div><p>Microsoft Azure AI Foundry — processes assistant conversations only.</p></div></div>
  <div class="row"><b>Fonts</b><div><p>Google Fonts serves the typefaces on this site. Your browser requests them directly, which discloses your IP address to Google. No cookie is set by that request.</p></div></div>
  <div class="row"><b>App stores</b><div><p>Microsoft, where you install an application through the Microsoft Store. Your relationship for that download is with them and their privacy notice covers it.</p></div></div>
  <div class="row"><b>Professionals</b><div><p>Our accountants and, if ever needed, our lawyers and insurers.</p></div></div>
  <div class="row"><b>Authorities</b><div><p>Where the law compels us. We will tell you unless we are prohibited from doing so.</p></div></div>
</div>
<p>If our business is ever sold or reorganised, personal data may transfer as part of it. You would be told, and this policy would continue to apply until you were given a new one.</p>

<h2 id="transfers">7. International transfers</h2>
<p>Some of the providers above process data outside the UK, principally in the United States. Where that happens we rely on the UK International Data Transfer Addendum to the European Commission's Standard Contractual Clauses, or on UK adequacy regulations where they apply, together with the technical measures described below. You can ask us for details of the safeguards used for any particular transfer.</p>

<h2 id="keep">8. How long we keep it</h2>
<div class="rows">
  <div class="row"><b>Enquiries, quotes</b><div><p>24 months from your last contact, then deleted — unless they turned into a project.</p></div></div>
  <div class="row"><b>Account and projects</b><div><p>For as long as the account is open, and 12 months after it closes.</p></div></div>
  <div class="row"><b>Invoices, receipts</b><div><p><b>Six years</b> from the end of the financial year they fall in. This one is not our choice: UK tax law requires it, and it survives a deletion request.</p></div></div>
  <div class="row"><b>Email log</b><div><p>24 months — it is how we prove a message was or was not delivered.</p></div></div>
  <div class="row"><b>Server logs</b><div><p>90 days, then rotated away.</p></div></div>
  <div class="row"><b>Backups</b><div><p>Up to 35 days. Deleted data disappears from backups as they age out.</p></div></div>
</div>

<h2 id="security">9. How we protect it</h2>
<ul>
  <li>Everything is served over HTTPS, and HTTP is redirected to it.</li>
  <li>Passwords are stored only as salted hashes; nobody at Vesopa can read yours.</li>
  <li>Session cookies are <code>HttpOnly</code>, <code>Secure</code> and <code>SameSite=Lax</code>, and every state-changing form carries a CSRF token.</li>
  <li>Public submission endpoints are rate limited.</li>
  <li>Access to the production server and database is restricted to the people who need it.</li>
  <li>Backups are taken regularly and their restoration is tested.</li>
</ul>
<p>No system is perfectly secure. If a breach ever puts your rights at risk we will tell the Information Commissioner within 72 hours and tell you without undue delay.</p>

<h2 id="rights">10. Your rights</h2>
<p>Under the UK GDPR you have the right to:</p>
<ul>
  <li><b>Access</b> — a copy of the personal data we hold about you;</li>
  <li><b>Rectification</b> — have inaccurate data corrected;</li>
  <li><b>Erasure</b> — have data deleted, where no legal obligation makes us keep it;</li>
  <li><b>Restriction</b> — have us pause processing while a dispute is resolved;</li>
  <li><b>Portability</b> — receive the data you gave us in a machine-readable form;</li>
  <li><b>Object</b> — to processing based on legitimate interests, and absolutely to direct marketing;</li>
  <li><b>Withdraw consent</b> — at any time, without affecting what was done before you withdrew it.</li>
</ul>
<p>Write to <a href="mailto:${F.privacyEmail}">${F.privacyEmail}</a>, or use the <a href="/delete-my-data">data request form</a>. We answer within one month and it costs nothing. We will ask you to confirm the request from the email address concerned, which is an identity check rather than an obstacle.</p>

<h2 id="deletion">11. Deleting your data</h2>
<p>There is a page for exactly this: <a href="/data-deletion">what deletion means, what survives it and why</a>, with a form at <a href="/delete-my-data">/delete-my-data</a>.</p>

<h2 id="cookies">12. Cookies</h2>
<p>This site sets one strictly necessary cookie and uses no analytics, advertising or tracking cookies at all. The detail is on <a href="/cookies">the cookie policy</a>.</p>

<h2 id="children">13. Children</h2>
<p>Our services are for businesses. They are not directed at children and we do not knowingly collect data from anyone under 16. If you believe a child has given us personal data, write to <a href="mailto:${F.privacyEmail}">${F.privacyEmail}</a> and we will delete it.</p>

<h2 id="changes">14. Changes</h2>
<p>We may update this policy. The date at the top is always the current version. Where a change materially affects how we use your data, we will tell you by email or in your portal before it takes effect.</p>

<h2 id="complain">15. Complaints</h2>
<p>Please come to us first — most things are a misunderstanding we can fix the same day. If you are still unhappy, you can complain to the UK's supervisory authority:</p>
<p>Information Commissioner's Office, Wycliffe House, Water Lane, Wilmslow, Cheshire SK9 5AF · 0303 123 1113 · <a href="https://ico.org.uk/make-a-complaint/" rel="noopener">ico.org.uk/make-a-complaint</a></p>

<div class="key">
  <p class="big"><a href="mailto:${F.privacyEmail}">${F.privacyEmail}</a></p>
  <p>${F.company}, ${F.address} · Company number ${F.number}</p>
</div>
`;

/* ================= cookies ================= */
const cookies = `
<span class="eyebrow">Legal</span>
<h1>Cookie policy</h1>
<p class="stamp">Last updated ${F.updated}</p>
<p class="lead">This site sets one cookie. It is the one that makes signing in work, and there is no way to provide the portal without it.</p>

<div class="key">
  <p><b>There is no cookie banner on this site, and that is deliberate.</b> Under UK law, consent is needed for cookies that are not strictly necessary — advertising, analytics, tracking. We use none of those, so there is nothing to ask you to agree to. A banner here would be theatre.</p>
</div>

<h2 id="what">What a cookie is</h2>
<p>A small file a website asks your browser to keep and hand back on the next request, so the server can recognise the same visitor. Related technologies — <code>localStorage</code>, for instance — keep data in your browser without sending it anywhere at all.</p>

<h2 id="ours">The cookies we set</h2>
<div class="rows">
  <div class="row"><b>vesopa.sid</b><div>
    <p><b>Strictly necessary.</b> A session identifier. It is what lets you stay signed in to the portal as you move between pages, and it carries the anti-forgery token that protects every form on the site from being submitted by another website on your behalf.</p>
    <p>It contains a random identifier and nothing else — no name, no email, no browsing history. It is <code>HttpOnly</code> (script on the page cannot read it), <code>Secure</code> (it is never sent over plain HTTP) and <code>SameSite=Lax</code> (it is not sent on cross-site requests).</p>
    <p><b>Set by:</b> vesopasoftware.com &nbsp; <b>Expires:</b> 14 days, refreshed while you are active &nbsp; <b>Third party:</b> no</p>
  </div></div>
</div>
<p>That is the complete list. There is not a second table below it.</p>

<h2 id="storage">Stored in your browser, not sent to us</h2>
<div class="rows">
  <div class="row"><b>vesopa.ai.size</b><div>
    <p>If you resize the Vesopa AI panel, your browser remembers the size you left it at so it opens the same way next time. It lives in <code>localStorage</code>, it holds two numbers, and it is never transmitted to our server or to anybody else. Clearing your site data removes it.</p>
  </div></div>
</div>

<h2 id="third">Third-party requests</h2>
<p>Two things on our pages are fetched from other people's servers, and although neither sets a cookie, both mean your browser makes a request those companies can see:</p>
<ul>
  <li><b>Google Fonts</b> (<code>fonts.googleapis.com</code>, <code>fonts.gstatic.com</code>) — the typefaces. Google receives your IP address and user-agent as part of any such request.</li>
  <li><b>Microsoft Store badge</b> — on product pages, the official "Get it from Microsoft Store" badge is loaded from Microsoft.</li>
</ul>
<p>We use no analytics, no advertising networks, no social media pixels, no session recording and no cross-site tracking of any kind.</p>

<h2 id="control">Controlling cookies</h2>
<p>Every browser lets you see, block and delete cookies — usually under Settings › Privacy. You are free to block ours. Be aware that blocking <code>vesopa.sid</code> makes signing in to the portal impossible, because the browser will no longer be able to prove between one page and the next that it is the same person.</p>
<p>Blocking it does not affect reading this website. Nothing public here needs it.</p>

<h2 id="changes">Changes</h2>
<p>If we ever add a cookie that is not strictly necessary, we will ask for your consent before setting it and this page will be updated first. Questions to <a href="mailto:${F.privacyEmail}">${F.privacyEmail}</a>.</p>
`;

/* ================= data deletion policy ================= */
const deletion = `
<span class="eyebrow">Legal</span>
<h1>Data deletion policy</h1>
<p class="stamp">Last updated ${F.updated}</p>
<p class="lead">How to have your account and your data deleted, exactly what goes, what has to stay and for how long, and how long the whole thing takes.</p>

<div class="key">
  <p class="big"><a href="/delete-my-data">Request deletion →</a></p>
  <p>Or email <a href="mailto:${F.support}">${F.support}</a> from the address on the account, with "Delete my data" in the subject. Both routes reach the same place and cost nothing.</p>
</div>

<h2 id="who">Who can ask</h2>
<p>Anyone whose personal data we hold: a portal account holder, somebody who sent an enquiry or asked for an estimate, or somebody who used one of our applications. You do not need an account to make a request, and you do not have to give a reason.</p>
<p>If a venue uses Vesopa software and you are that venue's customer, the venue is the controller of its own trading data. Ask them — and tell us, and we will help them action it.</p>

<h2 id="how">How to ask</h2>
<ol>
  <li>Use the <a href="/delete-my-data">deletion request form</a>, or email <a href="mailto:${F.support}">${F.support}</a>.</li>
  <li>Tell us the email address the data sits under. If you have more than one, list them.</li>
  <li>We reply to that address to confirm it is really you. This is an identity check required by data protection law, not a retention tactic — we cannot delete an account because a stranger asked us to.</li>
  <li>Confirm, and we act.</li>
</ol>

<h2 id="when">How long it takes</h2>
<div class="rows">
  <div class="row"><b>Acknowledged</b><div><p>Within 1 working day.</p></div></div>
  <div class="row"><b>Identity confirmed</b><div><p>As soon as you reply to our confirmation email.</p></div></div>
  <div class="row"><b>Deleted</b><div><p>Within <b>30 days</b> of confirmation, and normally within 7. We write to tell you when it is done.</p></div></div>
  <div class="row"><b>Gone from backups</b><div><p>Within <b>35 days</b> of deletion, as encrypted backups age out and are destroyed on their normal cycle. They are not restored to anything in the meantime.</p></div></div>
</div>

<h2 id="what">What is deleted</h2>
<p>Everything below is destroyed, not archived and not anonymised-in-place:</p>
<ul>
  <li>Your account: name, email address, phone number, password hash, preferences and sessions.</li>
  <li>Enquiries, estimate requests and quotes you submitted.</li>
  <li>Messages you sent or received through the portal.</li>
  <li>Files and attachments you uploaded, and the copies of them on our servers.</li>
  <li>Project records, tasks and updates that exist solely for you.</li>
  <li>Notifications, email preferences and the delivery log of mail sent to you.</li>
  <li>Any support correspondence held in our support mailbox.</li>
</ul>

<h2 id="kept">What we must keep, and why</h2>
<p>We would rather tell you this plainly than have you find out later:</p>
<div class="rows">
  <div class="row"><b>Invoices &amp; payments</b><div>
    <p>Kept for <b>six years</b> from the end of the financial year they belong to. UK tax law requires it and a deletion request cannot override it. They are locked to accounting use only — no marketing, no profiling, no support use.</p>
    <p>What is kept is the accounting record: what was sold, for how much, to whom, and when. Everything about you that is <i>not</i> part of that record still goes.</p>
  </div></div>
  <div class="row"><b>Deletion record</b><div><p>We keep a one-line record that a deletion request was made and completed, with the date. It is how we prove to you or to a regulator that we did what we said. It contains no other data about you.</p></div></div>
  <div class="row"><b>Legal hold</b><div><p>If data is the subject of an active legal claim or a regulator's request, it is preserved until that ends, and we will tell you if that applies.</p></div></div>
  <div class="row"><b>Suppression</b><div><p>If you asked never to be contacted again, we keep your email address on a do-not-contact list. That is the only way to honour the request — deleting it entirely would let the address be re-added tomorrow.</p></div></div>
</div>

<h2 id="apps">Deleting data in the applications</h2>
<p>Vesopa EPOS, Vesopa Kitchen and Vesopa Customer Display store the venue's trading data on the venue's own devices and, where the venue uses our hosted back office, on our servers on their behalf.</p>
<ul>
  <li><b>Uninstalling</b> the application removes the app and its local data from that device.</li>
  <li><b>Hosted back office data</b> is deleted on the account holder's request, through this same process.</li>
  <li>If you are a member of staff at a venue and want your own staff record removed, ask the venue — they control it. We will help them do it.</li>
</ul>

<h2 id="instead">Things you might want instead</h2>
<div class="rows">
  <div class="row"><b>Export</b><div><p>A copy of everything we hold, in a machine-readable form, before you go. Ask on the same form.</p></div></div>
  <div class="row"><b>Correction</b><div><p>If something is simply wrong, we can fix it rather than delete it.</p></div></div>
  <div class="row"><b>Unsubscribe</b><div><p>If it is only the email you want to stop, one link in any message does that and leaves your account alone.</p></div></div>
  <div class="row"><b>Close, keep records</b><div><p>Close the account and stop all processing, while your invoices remain available to you for your own accounts.</p></div></div>
</div>

<h2 id="cost">Cost, and refusal</h2>
<p>There is no charge. We may refuse only where a request is manifestly unfounded or excessive, or where the law requires us to keep the data — and if we refuse any part of a request we will tell you which part, why, and how to challenge it.</p>
<p>If you are not satisfied you can complain to the Information Commissioner's Office at <a href="https://ico.org.uk/make-a-complaint/" rel="noopener">ico.org.uk/make-a-complaint</a>.</p>

<div class="key">
  <p class="big"><a href="/delete-my-data">Request deletion →</a></p>
  <p>${F.company}, ${F.address} · Company number ${F.number} · <a href="mailto:${F.support}">${F.support}</a></p>
</div>
`;

/* ================= the deletion request form ================= */
const request = `
<span class="eyebrow">Your data</span>
<h1>Delete my data</h1>
<p class="lead">Ask us to delete your account and the personal data we hold about you. No account needed, no reason required, no charge.</p>

<div class="key">
  <p>We will email the address you give below to confirm the request is really from you, then delete within <b>30 days</b> and write to tell you when it is done. Read <a href="/data-deletion">what is deleted and what has to be kept</a> before you send this — invoices, in particular, we are legally required to keep for six years.</p>
</div>

<form class="form-card" id="delete-form" novalidate>
  <div class="two">
    <div class="fld"><label for="d-name">Your name</label><input id="d-name" name="name" required autocomplete="name"></div>
    <div class="fld">
      <label for="d-email">Email on the account</label>
      <input id="d-email" name="email" type="email" required autocomplete="email">
      <span class="hint">We reply here to confirm it is you.</span>
    </div>
  </div>

  <div class="fld">
    <label for="d-kind">What would you like us to do?</label>
    <select id="d-kind" name="kind">
      <option value="delete">Delete my account and my data</option>
      <option value="export">Send me a copy of my data</option>
      <option value="correct">Correct something that is wrong</option>
      <option value="stop">Stop contacting me, keep the account</option>
      <option value="object">Object to how my data is used</option>
    </select>
  </div>

  <div class="fld">
    <label>What should it cover?</label>
    <label class="opt"><input type="checkbox" name="scope" value="portal"> My portal account, projects, messages and files</label>
    <label class="opt"><input type="checkbox" name="scope" value="enquiries"> Enquiries, quotes and estimate requests I sent</label>
    <label class="opt"><input type="checkbox" name="scope" value="apps"> Data held in a Vesopa application or hosted back office</label>
    <label class="opt"><input type="checkbox" name="scope" value="marketing"> Marketing and mailing lists</label>
    <label class="opt"><input type="checkbox" name="scope" value="all"> Everything you hold about me</label>
  </div>

  <div class="fld">
    <label for="d-detail">Anything that helps us find it (optional)</label>
    <textarea id="d-detail" name="message" placeholder="Other email addresses, a company name, a venue, an invoice reference — anything that identifies the records."></textarea>
  </div>

  <div class="fld">
    <label class="opt">
      <input type="checkbox" name="confirm" value="yes" required>
      <span>I understand that deletion is permanent, that it cannot be undone, and that records we are legally required to keep — principally invoices, for six years — will be retained as described in the <a href="/data-deletion">deletion policy</a>.</span>
    </label>
  </div>

  <div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
  <button class="btn" type="submit">Send request</button>
  <div class="form-msg" role="status"></div>
</form>
${formJs("delete-form", "/api/data-request", "Request received. Check your email — we have sent you a confirmation to reply to.")}

<h2 id="post">Prefer to write?</h2>
<p>Email <a href="mailto:${F.support}">${F.support}</a> from the address on the account with "Delete my data" in the subject, or write to ${F.company}, ${F.address}. A letter takes longer only because the post does.</p>

<h2 id="next">What happens next</h2>
<ol>
  <li>We acknowledge within one working day.</li>
  <li>We email the address above to confirm the request is yours.</li>
  <li>You reply to confirm.</li>
  <li>We delete, and write to tell you it is done — within 30 days, usually within 7.</li>
</ol>
`;

/* ---------- write them ---------- */
const PAGES = [
  { slug: "/support", file: "support", title: "Support", wide: false,
    description: `Contact Vesopa Software support at ${F.support}. A person replies within one working day.`,
    body: support },
  { slug: "/terms", file: "terms", title: "Terms and conditions", wide: false,
    description: "The terms governing the Vesopa Software website, customer portal and applications.",
    body: terms },
  { slug: "/privacy", file: "privacy", title: "Privacy policy", wide: false,
    description: "What Vesopa Software collects, why, who else sees it, how long it is kept, and how to have it deleted.",
    body: privacy },
  { slug: "/cookies", file: "cookies", title: "Cookie policy", wide: false,
    description: "Vesopa Software sets one strictly necessary cookie and uses no analytics, advertising or tracking cookies.",
    body: cookies },
  { slug: "/data-deletion", file: "data-deletion", title: "Data deletion policy", wide: false,
    description: "How to have your Vesopa Software account and data deleted, what is removed, what is retained and for how long.",
    body: deletion },
  { slug: "/delete-my-data", file: "delete-my-data", title: "Delete my data", wide: false,
    description: "Request deletion of your personal data held by Vesopa Software. No account needed and no charge.",
    body: request },
];

for (const p of PAGES) {
  const html = shell(p);
  writeFileSync(`site/${p.file}.html`, html);
  console.log(`site/${p.file}.html`.padEnd(28), (html.length / 1024).toFixed(1) + " KB", " → " + p.slug);
}
