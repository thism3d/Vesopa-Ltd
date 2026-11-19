/**
 * The small print of loughorrfc.site and of the Loughor RFC app: privacy,
 * cookies, ordering terms, accessibility, licences, and the app's own help,
 * privacy and terms pages (the stores link to these). Words only; the page
 * around them is src/layout.js.
 */
'use strict';

const { club } = require('./content');
const { page, masthead, esc, SITE, MEMBERS } = require('./layout');

const crumbs = (items) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE}${path}` })),
});

// --- The small print -------------------------------------------------------

function legal({ path, title, lead, sections, description }) {
  const body = `${masthead({ kicker: 'The small print', title, lead })}
<section class="sheet"><div class="wrap prose legal">
${sections.map(([id, h, html]) => `<h2 id="${id}">${esc(h)}</h2>\n${html}`).join('\n')}
<p class="muted small">Last updated 10 October 2026.</p>
</div></section>`;
  return page({ title, description, path, og: 'home', ld: [crumbs([['Home', '/'], [title, path]])] }, body);
}

function privacyPage() {
  const c = club;
  const contact = `${esc(c.company.name)}, ${esc(c.company.registered_office)}${c.email ? `, <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}, ${esc(c.phone)}`;
  return legal({
    path: '/privacy',
    title: 'Privacy policy',
    lead: 'What we collect, why, and what you can ask us to do with it.',
    description: `How ${c.name} uses personal information on loughorrfc.site, the Loughor RFC app, food orders, tickets and the club helper.`,
    sections: [
      ['app', 'Using the Loughor RFC app?', `<div class="app-privacy-box"><p>The app for iPhone, iPad, Apple Watch, Android and Wear OS, and member.loughorrfc.site, have their own pages:</p><ul>
<li><a href="/app/privacy"><b>App privacy policy</b></a>: what the app keeps, why, and for how long.</li>
<li><a href="/app/privacy-choices"><b>Your privacy choices</b></a>: switch off notifications, remove your number or photo.</li>
<li><a href="/app/terms"><b>Terms and licences</b></a>: the app's terms of use and open-source licences.</li>
<li><a href="https://auth.vesopa.com/delete-account/loughor-rfc"><b>Delete your account</b></a>, without the app.</li>
</ul></div>`],
      ['who', 'Who we are', `<p>This website, the members' app at member.loughorrfc.site and the Loughor RFC app for iPhone, iPad and Android are run by ${contact} ("the club", "we"). The club is the controller of your personal information. Our software provider, Vesopa EPOS (Vesopa Software Ltd, Wales), runs the website, the ordering system, the till and the members' app for us as our processor.</p>`],
      ['browse', 'Visiting the website', `<p>We do not use analytics, advertising or tracking of any kind, and we set no cookies. Like every web server, ours keeps short technical logs (IP address, the page asked for, the time and your browser's description) to keep the site secure and working. These are kept only as long as needed for that, normally a few weeks.</p><p>Your browser keeps your helper conversation, and that you have seen the opening greeting, on your own device (session storage) for the visit. That never leaves your device unless you place an order or ask a question, and you can clear it at any time in your browser.</p>`],
      ['orders', 'Ordering food', `<p>When you order, we receive the dishes you chose, your table (for orders in the clubhouse), and the name, phone number and note you give us. We use them to make your order, to call your name when it's ready, and to ring you if there is a problem with it. The order goes onto the club's till and kitchen screen, and is kept with our sales records for as long as the law requires us to keep accounts (six years). Our lawful basis is to take the steps you asked for (contract).</p><p>You can pay at the bar, or pay online by card when you order. Online card payments (cards, Apple Pay and Google Pay) are taken on the secure checkout page of our payment provider, Dojo (Paymentsense Limited), who process your card details under their own security standards (PCI DSS). We never see or store your card number; we receive only whether the payment went through, its amount and Dojo's reference for it, so we can refund it if needed.</p>`],
      ['tickets', 'Buying tickets', `<p>When you buy tickets online we receive your name, email address and, if you give it, your mobile number, with the tickets you chose. We use them to send your tickets and their QR codes, to check them at the gate, and to contact you if the event changes. Card payments are taken by our payment provider, Dojo (Paymentsense Ltd); we never see or store your card number. Ticket sales are kept with our sales records for six years. Our lawful basis is to take the steps you asked for (contract).</p>`],
      ['members', 'The members\' app', `<p>To give you a members' card we hold your name, email address, membership number, your membership status, and the visits and purchases made with your card, so that the members' discount is applied and you can see what you've spent and saved. Optional: your phone number and a profile photo. The app does not use your location. If you allow notifications, we send club news and offers; you can turn them off at any time. Our lawful bases are your membership (contract), and your consent for notifications and anything optional.</p><p><b>Signing in.</b> You can sign in with an emailed code, a code texted by Google Firebase, a password, a passkey, or Sign in with Apple or Google. With Apple or Google we receive only your name and email address (or Apple's private relay address if you choose to hide it), never your Apple or Google password. A passkey stays on your device; we hold only its public key. We keep a list of the devices signed in to your account (for example "iPhone"), so you can see them and sign them out.</p><p><b>Photos and notifications.</b> The app asks for your camera or photo library only when you choose a profile photo, and uploads only the photo you pick. If you allow notifications, we keep your device's notification token to send them, and delete it when you turn notifications off or sign out.</p><p>The app has no advertising and no tracking, and we do not share your information with other companies for their own use.</p><p>You can see and correct your details in the app, and delete your account from <b>Account</b> in the app. The full details are in the <a href="/app/privacy">app privacy policy</a>.</p>`],
      ['helper', 'The club helper (AI)', `<p>The "Ask the club" helper answers questions from the club's own published information. What you type is sent to an AI service (DeepSeek, with Google Gemini as a back-up) to write the answer. Before it leaves our server we remove email addresses, phone numbers and card numbers from it. We do not send your name, account or location, and we keep no copy of the conversation on our server beyond a count of how many questions were asked. Please don't type personal details into the helper. The AI services may process what you type outside the UK, under their own terms; if you would rather not, call or message the club instead. Our lawful basis is our legitimate interest in answering visitors' questions quickly.</p>`],
      ['share', 'Who we share it with', `<p>Only our processors (Vesopa EPOS; Dojo for card payments; Apple or Google only when you sign in with them; Google Firebase when you sign in with a texted code; and the AI services described above for helper questions), and anyone the law requires us to share with. We never sell personal information or use it for advertising.</p>`],
      ['rights', 'Your rights', `<p>You can ask for a copy of your information, ask us to correct or delete it, object to how we use it, or withdraw consent at any time. Ask at the bar, call ${esc(c.phone)}${c.email ? ` or email <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}. We will answer within one month. If you're unhappy with how we've handled your information, you can complain to the Information Commissioner's Office at <a href="https://ico.org.uk/make-a-complaint/" rel="noopener">ico.org.uk</a> or on 0303 123 1113.</p>`],
      ['children', 'Children', `<p>The members' app and online ordering are for adults. Junior rugby has its own consent forms, held by the club and not on this website.</p>`],
    ],
  });
}

function cookiesPage() {
  return legal({
    path: '/cookies',
    title: 'Cookies',
    lead: 'Short version: we don\'t use any.',
    description: `${club.name} uses no cookies, analytics or advertising trackers on loughorrfc.site.`,
    sections: [
      ['none', 'No cookies', '<p>loughorrfc.site sets no cookies and loads nothing from advertising or analytics companies. Our fonts, pictures and scripts all come from this site.</p>'],
      ['storage', 'What your browser keeps', '<p>To make the site work as you use it, your browser stores three things on your own device: whether you\'ve seen the opening animation this visit, your basket on the menu page, and your conversation with the club helper. These are strictly necessary for the features you choose to use, so the law does not ask us for consent; clearing your browser\'s site data removes them.</p>'],
      ['members', 'The members\' app', '<p>member.loughorrfc.site keeps you signed in on your device with a token in its local storage. Signing out removes it.</p>'],
      ['map', 'The map', '<p>The plan of Villa Field is our own drawing and loads nothing from anyone else. The Apple Maps, Google Maps and OpenStreetMap buttons open those services, under their own privacy and cookie terms, only when you press them.</p>'],
    ],
  });
}

function termsPage() {
  return legal({
    path: '/ordering-terms',
    title: 'Ordering terms and refund policy',
    lead: 'How online orders from the clubhouse work, how you pay, and how refunds work.',
    description: `The terms for ordering food online from ${club.name}'s clubhouse, to your table or for collection.`,
    sections: [
      ['who', 'Who you\'re ordering from', `<p>${esc(club.company.name)} (company ${esc(club.company.number)}), ${esc(club.company.registered_office)}.</p>`],
      ['order', 'Your order', '<p>Prices and availability come straight from the bar\'s till when you order, and the price you see when you place the order is the price you pay. An order is accepted when the bar accepts it; until then it may be refused (for example if the kitchen is too busy or a dish has run out), and you will see that on the order screen.</p>'],
      ['table', 'Orders to your table', '<p>Orders to a table are added to that table\'s bill in the clubhouse. Please only order to the table you are sitting at.</p>'],
      ['collect', 'Orders for collection', '<p>Leave a name and a phone number we can reach you on. Collect your order from the bar and pay there by card or cash. If you can\'t make it, please call us so the food isn\'t wasted. Orders not collected within an hour of the time given may be cancelled.</p>'],
      ['pay', 'Paying online by card', `<p>You can pay for an order when you place it, by card, Apple Pay or Google Pay, or choose to pay at the bar. Online payments are taken by our payment provider, Dojo (Paymentsense Limited), on their secure checkout page, so your card details go to Dojo and never to us. We accept Visa and Mastercard. Your order is sent to the kitchen only once the payment has gone through; if it does not, nothing is charged and you can try again or pay at the bar. The amount charged is the total shown when you place the order, in pounds sterling (GBP). The payment is made to ${esc(club.company.name)}.</p>`],
      ['refunds', 'Refund policy', `<p><b>Cancelling.</b> You can cancel an order from the order screen until the bar accepts it. An order paid online and cancelled before payment is not charged.</p><p><b>If we cannot make your order.</b> If the bar or kitchen cannot make an order you have paid for online, we cancel it and refund the full amount to the card you paid with. The order screen tells you straight away.</p><p><b>Something wrong with your order.</b> Please tell the bar while you are here, so we can put it right or refund the item. Refunds for online payments go back to the card you paid with; they usually reach your account within 5 to 10 working days, depending on your bank.</p><p><b>Contact.</b> For any refund question call the club on ${esc(club.phone)}${club.email ? ` or email <a href="mailto:${esc(club.email)}">${esc(club.email)}</a>` : ''}. Refunds are given by ${esc(club.company.name)}. Nothing in this policy affects your legal rights.</p>`],
      ['allergens', 'Allergies', '<p>Each dish shows the allergens recorded by the bar. Our kitchen handles all 14 major allergens, so we cannot guarantee any dish is free of traces. If you have an allergy, tell the bar before you eat.</p>'],
      ['age', 'Age-restricted items', '<p>Alcohol is only served to people aged 18 and over, and you may be asked for ID when you collect or are served.</p>'],
      ['help', 'Problems', `<p>Call the club on ${esc(club.phone)} or speak to the bar. Nothing here affects your legal rights.</p>`],
    ],
  });
}

function accessibilityPage() {
  return legal({
    path: '/accessibility',
    title: 'Accessibility',
    lead: 'We want everyone to be able to use this site.',
    description: `Accessibility of loughorrfc.site, the ${club.name} website.`,
    sections: [
      ['aim', 'What we aim for', '<p>The site is built to the WCAG 2.2 AA standard: it works with a keyboard and screen readers, text can be enlarged to 200%, colours meet contrast guidance, and it respects your device\'s reduced-motion setting (the opening greeting and all movement switch off).</p>'],
      ['help', 'If something doesn\'t work', `<p>Tell us at the bar, call ${esc(club.phone)}${club.email ? ` or email <a href="mailto:${esc(club.email)}">${esc(club.email)}</a>` : ''}, and we\'ll fix it or help you another way, including taking your order by phone.</p>`],
    ],
  });
}

/** The fonts and software the site uses, and their licences (the owner, 2026-10-15). */
function licencesPage() {
  const font = (name, by, licence, file, use) => `<tr><th scope="row">${esc(name)}</th><td>${esc(by)}</td><td>${esc(use)}</td><td><a href="/fonts/${file}">${esc(licence)}</a></td></tr>`;
  return legal({
    path: '/licences',
    title: 'Licences',
    lead: 'The fonts and open-source software this site is built with, and the licences they come under.',
    description: `The fonts and open-source software used on loughorrfc.site, the ${club.name} website, and their licences.`,
    sections: [
      ['fonts', 'Fonts', `<p>Every font is served from this site, so nothing is loaded from anybody else's servers.</p>
<div class="table-wrap"><table class="league licences"><thead><tr><th scope="col">Font</th><th scope="col">By</th><th scope="col">Used for</th><th scope="col">Licence</th></tr></thead><tbody>
${font('Fraunces', 'Undercase Type and the Fraunces Project Authors', 'SIL Open Font License 1.1', 'LICENSE-Fraunces.txt', 'Headings')}
${font('Source Sans 3', 'Paul D. Hunt for Adobe', 'SIL Open Font License 1.1', 'LICENSE-SourceSans3.txt', 'Text')}
</tbody></table></div>`],
      ['software', 'Software', `<p>The site runs on <a href="https://nodejs.org/" rel="noopener">Node.js</a> with <a href="https://expressjs.com/" rel="noopener">Express</a> and <a href="https://github.com/motdotla/dotenv" rel="noopener">dotenv</a>, under the MIT License. The design and its animations are written for the club and use no outside libraries.</p>`],
      ['club', 'The club\'s own', `<p>The club crest, the club's photographs and posters, and the text of this site belong to ${esc(club.company.name)}. Please ask before using them: call ${esc(club.phone)}${club.email ? ` or email <a href="mailto:${esc(club.email)}">${esc(club.email)}</a>` : ''}.</p>
`],
    ],
  });
}

// --- The Loughor RFC app's own small print (the owner, 2026-10-25: "All
// the privacy URLs should be in the loughorrfc official website"). The App
// Store and Google Play listings and the app's Settings link here.

const APP_DELETE = 'https://auth.vesopa.com/delete-account/loughor-rfc';
const APP_UPDATED = '25 October 2026';

/** The quick links at the top of every app page, so each is one tap from the others. */
function appLinks(here) {
  const links = [['/app/help', 'Help'], ['/app/privacy', 'App privacy policy'], ['/app/privacy-choices', 'Your privacy choices'], ['/app/terms', 'Terms and licences'], [APP_DELETE, 'Delete your account']];
  return `<nav class="app-legal-links" aria-label="The app's small print"><ul>${links.map(([href, label]) => `<li>${href === here ? `<b aria-current="page">${label}</b>` : `<a href="${href}">${label}</a>`}</li>`).join('')}</ul></nav>`;
}

function appLegal({ path, title, lead, description, sections }) {
  const body = `${masthead({ kicker: 'The Loughor RFC app', title, lead })}
<section class="sheet"><div class="wrap prose legal">
${appLinks(path)}
${sections.map(([id, h, html]) => `<h2 id="${id}">${esc(h)}</h2>\n${html}`).join('\n')}
<p class="muted small">Last updated ${APP_UPDATED}.</p>
</div></section>`;
  return page({ title, description, path, og: 'home', ld: [crumbs([['Home', '/'], ['Privacy policy', '/privacy'], [title, path]])] }, body);
}

const askClub = () => `call ${esc(club.phone)}${club.email ? ` or email <a href="mailto:${esc(club.email)}">${esc(club.email)}</a>` : ''}`;

function appPrivacyPage() {
  const c = club;
  const row = (what, why, need) => `<tr><td>${what}</td><td>${why}</td><td>${need}</td></tr>`;
  return appLegal({
    path: '/app/privacy',
    title: 'App privacy policy',
    lead: 'What the Loughor RFC app (iPhone, iPad, Apple Watch, Android and Wear OS) and member.loughorrfc.site keep about you, why, and for how long.',
    description: `The privacy policy of the ${c.name} members' app for iPhone, Android, Apple Watch and Wear OS, and of member.loughorrfc.site.`,
    sections: [
      ['short', 'In short', `<ul>
<li>The app holds your members' card: your name, email address, membership and the visits and purchases made with your card.</li>
<li>Your mobile number, photo and notifications are optional, and you can remove them in the app at any time.</li>
<li>The app does not use your location, show advertising, or contain analytics or tracking.</li>
<li>We never sell your information.</li>
<li>You can delete your account in the app (<b>Account › Delete my account and data</b>) or <a href="${APP_DELETE}">on the web</a>.</li>
</ul>`],
      ['who', 'Who we are', `<p>The app and member.loughorrfc.site belong to ${esc(c.company.name)} (company ${esc(c.company.number)}), ${esc(c.company.registered_office)} ("the club", "we"). The club is the controller of your information. Our software provider, <b>Vesopa Software Limited</b> (company 17362206, Baglan, Port Talbot, SA12 7AX), makes and hosts the app for us and processes your information only on our instructions.</p><p>For anything about your privacy, ${askClub()}.</p>`],
      ['collect', 'What we keep and why', `<div class="table-wrap"><table class="league"><thead><tr><th scope="col">What</th><th scope="col">Why</th><th scope="col">Needed?</th></tr></thead><tbody>
${row('Name and email address', 'To make your members\' card, sign you in and show your name on the card.', 'Yes')}
${row('Membership: card and member number, status, dates, visits, what you spent and saved', 'To give you the members\' discount at the bar and show you your membership.', 'Yes')}
${row('Mobile number', 'To sign in with a texted code, if you add one. Google Firebase sends the code and checks it.', 'Optional')}
${row('Photo', 'Shown on your card so bar staff can recognise you, if you add one. The app asks for your camera or photos only when you choose one.', 'Optional')}
${row('Membership payments: amount, date and result', 'To renew your membership in the app. Dojo takes the card payment; we never see your card number.', 'Only if you pay in the app')}
${row('Sign-in details: a password (stored only as a secure hash), passkeys, and the devices you are signed in on (for example "iPhone, iOS 26")', 'To keep your account safe and let you sign devices out.', 'Only the ones you set up')}
${row('Notification token for your phone, watch or browser', 'To send club news and offers as notifications.', 'Optional')}
${row('News you have received and read', 'To show the club\'s messages in the app and mark new ones.', 'Yes')}
</tbody></table></div>
<p>We do not collect your location, contacts, files, advertising identifiers or browsing activity.</p>`],
      ['choices', 'Your choices', '<p>Everything optional can be switched off in the app without affecting your membership. Each one, and where to find it, is on <a href="/app/privacy-choices">Your privacy choices</a>.</p>'],
      ['bases', 'Our lawful bases', `<ul>
<li><b>Contract:</b> your membership, card, discount and sign-in.</li>
<li><b>Consent:</b> notifications, your mobile number and your photo. You can withdraw it at any time in the app or your device's settings.</li>
<li><b>Legitimate interests:</b> keeping accounts secure and preventing misuse.</li>
<li><b>Legal obligation:</b> sales records the club must keep for tax.</li>
</ul>`],
      ['share', 'Who else receives it', `<p>Only the services that make the app work:</p><ul>
<li><b>Vesopa Software Limited</b>, who host the app and the club's till system for us.</li>
<li><b>Google Firebase Authentication</b>, which receives your mobile number to send and check a sign-in code, if you use one.</li>
<li><b>Apple Push Notification service</b>, <b>Google Firebase Cloud Messaging</b> and your browser's push service, which receive a notification token and the message, to deliver notifications.</li>
<li><b>Apple and Google</b>, only if you choose Sign in with Apple or Continue with Google: they tell us your name and email address, never your password.</li>
<li><b>Dojo</b> (Paymentsense Limited), only if you pay for your membership in the Android app or on member.loughorrfc.site, on Dojo's secure payment page. Dojo takes the card payment under its own security standards (PCI DSS). The iPhone and iPad app takes no payments.</li>
<li><b>Apple Wallet and Google Wallet</b>, only if you add your card to them.</li>
</ul><p>Where one of these processes information outside the UK, it does so under the safeguards UK data protection law requires.</p>`],
      ['keep', 'How long we keep it', `<ul>
<li><b>Your account</b>, while your membership is active or until you delete it.</li>
<li><b>Sign-in codes</b> expire after 10 minutes and are deleted within a day.</li>
<li><b>Sales records</b> for six years, as the law requires; once you delete your account they no longer carry your name or contact details.</li>
</ul>`],
      ['delete', 'Deleting your account', `<p>In the app: <b>Account › Delete my account and data</b>. Without the app: <a href="${APP_DELETE}">${APP_DELETE.replace('https://', '')}</a>. You can choose deletion after 7, 15 or 30 days (which you can cancel), or as soon as possible. We email you when it is done.</p>`],
      ['rights', 'Your rights', `<p>You can ask for a copy of your information, correct it, delete it, object to how it is used, or ask for it in a portable form: ${askClub()}. We answer within one month. You can also complain to the Information Commissioner's Office at <a href="https://ico.org.uk/make-a-complaint/" rel="noopener">ico.org.uk</a> or on 0303 123 1113.</p>`],
      ['security', 'Security', '<p>Everything travels over HTTPS. Passwords are stored only as secure hashes, sign-in codes are single-use and short-lived, and you can see and sign out every device on your account.</p>'],
      ['children', 'Children', '<p>The app is for adult members and is not directed at children under 13.</p>'],
      ['club-site', 'The club\'s website, tickets and food orders', '<p>The club\'s main <a href="/privacy">privacy policy</a> covers this website, buying tickets and ordering food.</p>'],
    ],
  });
}

function appChoicesPage() {
  const row = (what, need, how) => `<tr><td>${what}</td><td>${need}</td><td>${how}</td></tr>`;
  return appLegal({
    path: '/app/privacy-choices',
    title: 'Your privacy choices',
    lead: 'What is optional in the Loughor RFC app, and how to switch it off. None of it affects your membership.',
    description: `How to switch off notifications, remove your number or photo, and delete your account in the ${club.name} app.`,
    sections: [
      ['choices', 'What you can change', `<div class="table-wrap"><table class="league"><thead><tr><th scope="col">What</th><th scope="col">Needed?</th><th scope="col">How to change it</th></tr></thead><tbody>
${row('Notifications', 'Optional', 'Settings › Notifications in the app, or your phone\'s settings for the app. On member.loughorrfc.site: Account › Notifications.')}
${row('Mobile number', 'Optional', 'Account › Mobile number › Remove.')}
${row('Photo on your card', 'Optional', 'Account › Your photo › the bin.')}
${row('Passkeys', 'Optional', 'Account › Signing in › remove a passkey.')}
${row('Signed-in devices', 'Your choice', 'Account › Signing in › sign a device out.')}
${row('Name, email and membership', 'Needed for a card', `Delete your account: Account › Delete my account and data, or <a href="${APP_DELETE}">on the web</a>.`)}
</tbody></table></div>`],
      ['never', 'What the app never does', '<p>It does not use your location, show advertising, track you across other apps or websites, or sell your information.</p>'],
      ['ask', 'Questions or a copy of your data', `<p>Please ${askClub()}. The full details are in the <a href="/app/privacy">app privacy policy</a>.</p>`],
    ],
  });
}

/**
 * Help with the app, and who does what (owner, 2026-10-25: "Vesopa Software
 * Development help and relationships page ... data protection and other
 * rights"). The club owns the app and its members' details; Vesopa makes it.
 */
function appHelpPage() {
  const c = club;
  return appLegal({
    path: '/app/help',
    title: 'Help with the app',
    lead: 'Getting the app, signing in, and who to ask about what.',
    description: `Help with the ${c.name} members' app: getting it, signing in, your rights, and the club's relationship with Vesopa Software.`,
    sections: [
      ['get', 'Getting the app', `<ul>
<li><b>iPhone, Apple Watch, Android phones and Wear OS watches:</b> the Loughor RFC app is on its way to the App Store and Google Play. This page will link to it the day it is published.</li>
<li><b>Any phone or computer, now:</b> <a href="${esc(MEMBERS)}/">member.loughorrfc.site</a>, the same card and account in your browser.</li>
</ul>`],
      ['signin', 'Signing in', `<p>The app is for club members. Sign in with the email address or mobile number the club has for you:</p><ul>
<li><b>Mobile number:</b> choose your country, type your number and we text you a six-digit code.</li>
<li><b>Email:</b> an emailed code, or a password if you have set one.</li>
<li><b>Passkey:</b> your face, fingerprint or phone PIN. One passkey works in the app and on member.loughorrfc.site.</li>
<li><b>Google or Apple:</b> one tap, with the address on your membership.</li>
</ul><p>Not a member yet, or your details have changed? Ask behind the bar or ${askClub()}.</p>`],
      ['who', 'Who does what', `<div class="table-wrap"><table class="league"><thead><tr><th scope="col">Ask</th><th scope="col">About</th><th scope="col">How</th></tr></thead><tbody>
<tr><td><b>${esc(c.name)}</b></td><td>Your membership, renewals, the members' discount, your details, news and offers</td><td>At the bar, ${esc(c.phone)}${c.email ? `, <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</td></tr>
<tr><td><b>Vesopa Software</b></td><td>The app not working: signing in, codes not arriving, the card or notifications</td><td><a href="https://loyalty.vesopa.com/support" rel="noopener">App support form</a>, <a href="mailto:info@vesopasoftware.com">info@vesopasoftware.com</a>, +44 7848 494341</td></tr>
</tbody></table></div>`],
      ['relationship', 'The club and Vesopa', `<p>The app, its name and the members' details belong to ${esc(c.company.name)}, which decides how they are used (the controller). <b>Vesopa Software Limited</b> (company 17362206, Baglan, Port Talbot) designs, builds and hosts the app, the club's website, online ordering and its till for the club, and uses members' details only on the club's instructions (the processor), under a written agreement as UK data protection law requires.</p><p>Vesopa makes software for clubs, pubs, restaurants and shops across the UK: <a href="https://vesopaepos.com" rel="noopener">vesopaepos.com</a>.</p>`],
      ['rights', 'Your data and your rights', `<ul>
<li><a href="/app/privacy">App privacy policy</a>: what the app keeps, why, and for how long.</li>
<li><a href="/app/privacy-choices">Your privacy choices</a>: switch off notifications, remove your number or photo.</li>
<li><a href="https://auth.vesopa.com/delete-account/loughor-rfc">Delete your account</a>, with or without the app.</li>
<li>Ask for a copy of your data, a correction or deletion: ${askClub()}. We answer within one month.</li>
<li>Not happy with how your data is handled? The <a href="https://ico.org.uk/make-a-complaint/" rel="noopener">Information Commissioner's Office</a>, 0303 123 1113.</li>
<li><a href="/app/terms">Terms and licences</a> for the app.</li>
</ul>`],
    ],
  });
}

function appTermsPage() {
  const lib = (name, licence) => `<tr><th scope="row">${esc(name)}</th><td>${esc(licence)}</td></tr>`;
  return appLegal({
    path: '/app/terms',
    title: 'Terms and licences',
    lead: 'The agreement for using the Loughor RFC app, and the software it is built with.',
    description: `The terms of use of the ${club.name} members' app, and the open-source software and licences it uses.`,
    sections: [
      ['terms', 'Using the app', `<p>The app is provided by ${esc(club.company.name)} for its members, to carry the members' card, receive club news and manage your membership. Please keep your sign-in to yourself and use only your own card; the club may suspend a card that is misused. Membership, prices and the members' discount are set by the club and may change. The app is provided as it is, and may sometimes be unavailable. Nothing here affects your legal rights.</p><p>If you downloaded the app from the App Store, Apple's <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/" rel="noopener">standard licence agreement</a> also applies; from Google Play, Google Play's terms of service also apply. Apple and Google are not responsible for the app or its support.</p>`],
      ['own', 'Who owns what', `<p>The club crest, name and news belong to ${esc(club.company.name)}. The app's software belongs to Vesopa Software Limited and is licensed to the club. Apple, Apple Watch, iPhone, Apple Wallet and the App Store are trademarks of Apple Inc.; Android, Wear OS, Google Wallet and Google Play are trademarks of Google LLC.</p>`],
      ['licences', 'Open-source licences', `<p>The app is built with these open-source components, used under their licences. The full licence texts are in the app under <b>Settings › Open-source software</b>.</p>
<div class="table-wrap"><table class="league licences"><thead><tr><th scope="col">Software</th><th scope="col">Licence</th></tr></thead><tbody>
${lib('Flutter and the Dart SDK (Google)', 'BSD 3-Clause')}
${lib('http, http_parser, crypto, web (Dart)', 'BSD 3-Clause')}
${lib('shared_preferences, url_launcher, image_picker (Flutter)', 'BSD 3-Clause')}
${lib('package_info_plus (Flutter Community)', 'BSD 3-Clause')}
${lib('qr_flutter and qr', 'BSD 3-Clause')}
${lib('flutter_riverpod and riverpod', 'MIT')}
${lib('image (Brendan Duncan)', 'MIT')}
${lib('screen_brightness', 'MIT')}
${lib('cupertino_icons', 'MIT')}
${lib('Firebase Authentication and Cloud Messaging SDKs (Google)', 'Apache 2.0')}
${lib('AndroidX, Jetpack Compose and Wear OS libraries (Google)', 'Apache 2.0')}
${lib('Kotlin standard library (JetBrains)', 'Apache 2.0')}
</tbody></table></div>`],
      ['help', 'Help', `<p>For help with the app, ${askClub()}.</p>`],
    ],
  });
}

module.exports = { privacyPage, cookiesPage, termsPage, accessibilityPage, licencesPage, appPrivacyPage, appChoicesPage, appHelpPage, appTermsPage };
