/**
 * Legal pages.
 *
 * The prose lives here rather than in four .ejs files because it is the one
 * body of copy on the site with no markup beyond headings, lists and bold — and
 * because keeping it together makes it obvious when one document contradicts
 * another. They are rendered through a shared shell.
 *
 * These are a working starting point written for a UK company selling shared
 * hosting and domains to businesses. They are NOT a solicitor's work, and two
 * things in particular should be reviewed before you rely on them: the
 * limitation of liability, and the data-processing terms if you ever take on a
 * customer who needs a formal DPA.
 */

const express = require('express');
const { CONTACT } = require('../config');

const router = express.Router();
const UPDATED = '5 August 2026';

const DOCS = {
  terms: {
    title: 'Terms of service',
    body: `
<h2>1. Who we are</h2>
<p>These terms are between you and <strong>${CONTACT.company}</strong>, a company registered in England and Wales, whose address is ${CONTACT.address_line1}, ${CONTACT.address_line2} ("we", "us"). By ordering hosting, a domain or any other service from us you agree to them.</p>

<h2>2. Your account</h2>
<p>You must give us accurate contact details and keep them current. A great deal of what we do — renewal notices, transfer approvals, security warnings — depends on reaching you, and a domain lost because its contact address bounced is not something we can undo.</p>
<p>You are responsible for what happens under your account, including anything done by someone you gave access to. Keep your password to yourself and tell us promptly if you think it has been compromised.</p>

<h2>3. What we provide</h2>
<p>Shared web hosting, domain registration and related services, as described on our website at the time you order. We provide these with reasonable skill and care.</p>
<p>We aim for <strong>99.9% availability</strong> of the hosting service each calendar month, excluding scheduled maintenance we have told you about in advance and anything outside our reasonable control. If we fall short in a month, contact us and we will credit that month's hosting fee to your account.</p>

<h2>4. Fees, renewals and cancellation</h2>
<p>Fees are as shown when you order and <strong>include VAT</strong> — the price you see is the total you pay, and nothing further is added at checkout. Services renew automatically at the end of each term at the price shown in your control panel, so that your website and email do not stop working without warning.</p>
<p><strong>We will email you before every renewal</strong> — at least 14 days ahead for hosting and at least 30 days ahead for domains. You can turn off automatic renewal at any time from your control panel.</p>
<p>You may cancel hosting at any time, effective at the end of your current term. See our <a href="/refunds">refund policy</a> for when money comes back.</p>
<p>If payment fails we will tell you and try again. Services are not suspended the moment a date passes; we will contact you first, and suspension is a deliberate step we take only after that.</p>

<h2>5. Domain names</h2>
<p>When you register a domain through us you also enter into a relationship with the relevant registry and are bound by its rules, including ICANN's policies for generic extensions and Nominet's for .uk. We register domains as your agent — <strong>the domain is yours, not ours</strong>.</p>
<p>You may transfer a domain away at any time subject to registry rules. We will not charge you to leave and will not delay the release.</p>
<p>Registry fees are non-refundable once a registration or renewal has been submitted. This is a real constraint, not a policy choice: the money has left us and gone to the registry.</p>

<h2>6. Acceptable use</h2>
<p>Your use of our services must comply with our <a href="/aup">acceptable use policy</a>, which forms part of these terms.</p>

<h2>7. Your content and your backups</h2>
<p>You keep all rights in the content you put on our servers. You grant us only the permission we need to host it — to store, copy and transmit it in order to provide the service.</p>
<p>We take backups as described on your plan and we will do our best to restore from them. <strong>They are a convenience, not a substitute for your own copy.</strong> If your data matters to you, keep an independent copy somewhere that is not us.</p>

<h2>8. Suspension and termination</h2>
<p>We may suspend or terminate a service if you materially breach these terms or the acceptable use policy, if we are legally required to, or if your account is being used in a way that threatens the stability or security of our infrastructure or other customers.</p>
<p>Except where the breach is serious or urgent — for instance a compromised site actively attacking others — we will contact you first and give you a reasonable chance to put it right.</p>
<p>On termination we may delete your data after 30 days. Ask us within that window and we will provide an export.</p>

<h2>9. Liability</h2>
<p>Nothing in these terms limits our liability for death or personal injury caused by our negligence, for fraud, or for anything else that cannot lawfully be limited.</p>
<p>Subject to that, our total liability to you in connection with a service, in any 12-month period, is limited to the fees you paid us for that service in that period.</p>
<p>We are not liable for loss of profit, loss of business, loss of goodwill or loss of data, in each case whether direct or indirect.</p>
<p>If you are a consumer rather than a business, your statutory rights are unaffected by anything here.</p>

<h2>10. Changes</h2>
<p>We may change these terms. If a change materially affects you we will give at least 30 days' notice by email, and you may cancel without penalty before it takes effect.</p>

<h2>11. Law</h2>
<p>These terms are governed by the law of England and Wales, and the courts of England and Wales have exclusive jurisdiction.</p>
`,
  },

  privacy: {
    title: 'Privacy policy',
    body: `
<h2>Who is responsible for your data</h2>
<p><strong>${CONTACT.company}</strong>, ${CONTACT.address_line1}, ${CONTACT.address_line2}, is the data controller for the personal data described here. Contact us at <a href="mailto:${CONTACT.email}">${CONTACT.email}</a> about anything in this policy.</p>

<h2>What we collect, and why</h2>
<h3>Account and billing details</h3>
<p>Your name, email address, postal address, phone number and company name. We need these to provide the service, to invoice you, and — for domain registrations — because the registry requires a real registrant. Legal basis: performance of a contract.</p>

<h3>Payment information</h3>
<p><strong>We never see or store your card number.</strong> Payments are handled by our payment provider on their own systems; we receive only a reference and the last four digits.</p>

<h3>Technical logs</h3>
<p>Server logs record IP addresses, requests and timestamps. We use them to keep the service running, to investigate faults and to detect abuse. Legal basis: our legitimate interest in operating a secure service. Retained for 90 days.</p>

<h3>Support correspondence</h3>
<p>Tickets and emails you send us, kept so that the next person to help you can see what has already been tried.</p>

<h3>Your customers' data</h3>
<p>Whatever you store on your hosting account is yours. We do not access it except when you ask us to, when we must to fix a fault or investigate abuse, or when legally required. In respect of that data <strong>you are the controller and we are your processor</strong>.</p>

<h2>What we do not do</h2>
<ul>
  <li>We do not sell your personal data. Not to anyone, for any price.</li>
  <li>We do not run advertising trackers on this website. There is no analytics cookie, no pixel and no third-party script.</li>
  <li>We do not read your email or your site's database for any purpose of our own.</li>
</ul>

<h2>Cookies</h2>
<p>This site sets a small number of strictly necessary cookies: one to keep you signed in, one to protect forms against cross-site request forgery, one for your basket, and a short-lived one to carry a status message across a page redirect. There are no analytics or advertising cookies, which is why you have not been shown a consent banner — none is required for cookies that are strictly necessary.</p>

<h2>Who we share it with</h2>
<ul>
  <li><strong>Domain registries and our registrar</strong> — registrant details, because registration cannot happen otherwise.</li>
  <li><strong>Our payment provider</strong> — to take payment.</li>
  <li><strong>Microsoft Azure</strong> — our servers are hosted there, in a UK region.</li>
  <li><strong>Law enforcement or a court</strong> — where we are legally obliged.</li>
</ul>

<h2>Where your data is held</h2>
<p>Hosting infrastructure and backups are in the United Kingdom. Some suppliers may process limited data outside the UK; where they do, we rely on adequacy regulations or standard contractual clauses.</p>

<h2>How long we keep it</h2>
<ul>
  <li><strong>Account records</strong> — for as long as you are a customer, then 7 years, because HMRC requires it of business records.</li>
  <li><strong>Site data and backups</strong> — deleted 30 days after a service ends.</li>
  <li><strong>Server logs</strong> — 90 days.</li>
  <li><strong>Support tickets</strong> — 3 years.</li>
</ul>

<h2>Your rights</h2>
<p>You have the right to access your data, to have it corrected, to have it erased, to restrict or object to processing, and to receive it in a portable form. Email us and we will respond within one month.</p>
<p>If you think we have handled your data badly, please tell us first — but you are entitled to complain directly to the Information Commissioner's Office at <a href="https://ico.org.uk" rel="noopener" target="_blank">ico.org.uk</a>.</p>

<h2>Security</h2>
<p>Passwords are stored hashed with bcrypt and are never recoverable in plain text, including by us. Traffic to this site and to your control panel is encrypted. Accounts on our servers are isolated from one another. We patch on a schedule rather than in response to incidents.</p>
`,
  },

  aup: {
    title: 'Acceptable use policy',
    body: `
<p>This policy exists because our customers share infrastructure. Nearly all of it comes down to one idea: <strong>do not use our servers to harm other people, and do not use so much of a shared machine that your neighbours suffer.</strong></p>

<h2>You must not use our services for</h2>
<ul>
  <li>Anything illegal under the law of England and Wales.</li>
  <li>Child sexual abuse material. Accounts are terminated immediately and reported, with no notice and no refund.</li>
  <li>Sending unsolicited bulk email, or hosting a site advertised by spam sent from anywhere else.</li>
  <li>Phishing, malware distribution, or command-and-control infrastructure.</li>
  <li>Attacking other systems — port scanning, brute forcing, denial of service.</li>
  <li>Infringing someone else's copyright or trade marks.</li>
  <li>Harassment, incitement to violence, or content promoting terrorism.</li>
  <li>Open proxies, open mail relays, or anonymised traffic services.</li>
  <li>Cryptocurrency mining, or any other sustained consumption of CPU unrelated to serving a website.</li>
</ul>

<h2>Resource use on shared hosting</h2>
<p>Shared hosting is shared. Plan limits on storage, databases and mailboxes are published, and bandwidth described as unmetered means we do not bill for it — not that a single account may saturate a node.</p>
<p>If a site consistently consumes resources that degrade the server for others, we will <strong>contact you first</strong>, tell you specifically what is doing it, and help you fix it or move to something more suitable. Immediate action without warning is reserved for cases where the server is actively failing.</p>

<h2>Email sending</h2>
<p>Shared hosting is for a business's ordinary correspondence and transactional mail. It is not a bulk mailing platform: sending a large newsletter through a shared server damages the IP reputation every other customer depends on. Use a dedicated provider for lists, and keep the shared server for the mail your business sends day to day.</p>
<p>Every list must be opt-in with a working unsubscribe. Purchased lists are not opt-in.</p>

<h2>Security is a shared responsibility</h2>
<p>We patch the operating system and the server software. <strong>You are responsible for what you install</strong> — WordPress, its plugins and themes, and your own code. An abandoned plugin with a known vulnerability is the single most common way a site here gets compromised.</p>
<p>If your site is compromised we will normally suspend it to stop it harming others, tell you immediately, and help you clean it up. That is not a punishment; a compromised site is usually being used to attack somebody else.</p>

<h2>How we enforce this</h2>
<p>Proportionately. Most issues are a conversation and a fix. Where we must act, we prefer suspending one site to terminating an account, and terminating an account is a last resort — except for the categories above where it is immediate.</p>
<p>To report abuse originating from our network, email <a href="mailto:${CONTACT.email}">${CONTACT.email}</a> with "Abuse" in the subject and include logs with timestamps and time zone.</p>
`,
  },

  refunds: {
    title: 'Refund policy',
    body: `
<h2>Hosting: 30 days, no questions</h2>
<p>Cancel a new hosting plan within <strong>30 days</strong> of ordering and we will refund the hosting fee in full. Email us; there is no form to complete, no reason required, and nobody will telephone you to talk you out of it.</p>
<p>The 30 days run from the date of your first order for that service, not from each renewal.</p>

<h2>Renewals</h2>
<p>We email before every renewal — at least 14 days ahead for hosting, 30 for domains. If a renewal is taken that you did not intend, tell us within <strong>14 days</strong> and we will refund it and cancel the service.</p>
<p>Beyond 14 days we will normally refund the unused portion of a renewed hosting term as account credit. Ask.</p>

<h2>Domains cannot be refunded</h2>
<p>This is the one place we cannot be generous, and it is worth explaining rather than burying. When you register or renew a domain we immediately pay the registry, and that transaction is final — the name is now yours in a global database and the fee is spent. Nobody in the chain can reverse it, including us.</p>
<p>So: <strong>domain registration, renewal and transfer fees are non-refundable</strong>, including the domain element of a bundle that included a "free" domain, which is charged at the standard first-year rate if you cancel the hosting inside 30 days.</p>
<p>Please check the spelling before you confirm. We will always help you register the correct one, but we cannot un-buy the first.</p>

<h2>What else is not refundable</h2>
<ul>
  <li>Any part of a term already used, beyond the 30-day window.</li>
  <li>Services terminated by us for a breach of the <a href="/aup">acceptable use policy</a>.</li>
  <li>Third-party certificates or licences we bought on your instruction.</li>
</ul>

<h2>If we let you down</h2>
<p>If we miss our 99.9% availability commitment in a month, ask and we will credit that month's hosting fee. We do not require you to prove the outage — we have the monitoring, and if you noticed it we almost certainly did too.</p>

<h2>How to ask</h2>
<p>Email <a href="mailto:${CONTACT.email}">${CONTACT.email}</a> from the address on the account, or open a ticket from your control panel. Refunds go back to the original payment method, usually within 5 working days and always within 14.</p>
`,
  },
};

Object.entries(DOCS).forEach(([slug, doc]) => {
  router.get(`/${slug}`, (req, res) => {
    res.render('partials/legal-shell', {
      title: doc.title,
      description: `${doc.title} for Vesopa Cloud, part of ${CONTACT.company}.`,
      body: doc.body,
      updated: UPDATED,
    });
  });
});

module.exports = router;
