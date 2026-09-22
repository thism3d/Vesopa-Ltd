/**
 * loyalty.vesopa.com/privacy -- the privacy policy for Vesopa's loyalty apps.
 *
 * WHY A PAGE OF ITS OWN. auth.vesopa.com's privacy policy is written for the
 * sign-in service, and says in so many words that it collects no location and
 * no photos. The loyalty apps do both (optionally), and Google Play checks the
 * policy it is given against the app's Data safety answers. So The Vesopa
 * Kitchen, and every venue's app, link here.
 *
 * EVERY STATEMENT HERE IS A FACT ABOUT THE CODE. Change the code, change this
 * page, the same day:
 *
 *   location     used on the spot, never stored; only a yes/no "was near the
 *                venue" mark for NEAR_HOURS (3) -- src/loyalty_app.js,
 *                POST /loyalty/v1/me/location, schema_loyalty_near.sql
 *   codes        10 minutes (CODE_MINUTES), swept after a day
 *   deletion     auth.vesopa.com/delete-account/<venue> and in the app
 *   no analytics, no advertising SDKs, no selling (vesopa_loyalty/pubspec.yaml)
 */

const UPDATED = '17 September 2026';

function privacyPage({ host, demoSlug = 'thevesopakitchen', contact = 'info@vesopasoftware.com' }) {
  const deleteUrl = `https://auth.vesopa.com/delete-account/${demoSlug}`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy policy — Vesopa Loyalty apps, including The Vesopa Kitchen</title>
<meta name="description" content="How Vesopa Software Limited's loyalty apps, including The Vesopa Kitchen, collect, use, keep and delete personal data.">
<link rel="canonical" href="https://${host}/privacy">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<style>
:root{--lime:#A5C715;--ink:#141413;--muted:#55554F;--line:#E3E3DC;--paper:#F6F6F1}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:#0D0D0C;padding:16px 20px}
header a{display:inline-flex;align-items:center;gap:12px;text-decoration:none;color:#B9B9B1;font:700 11px/1 system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase}
header img{height:20px}
main{max-width:780px;margin:0 auto;padding:36px 20px 70px}
h1{font-size:clamp(28px,4vw,38px);line-height:1.15;margin:0 0 8px;letter-spacing:-.01em}
.updated{color:var(--muted);margin:0 0 28px}
h2{font-size:21px;margin:36px 0 10px;padding-top:6px;border-top:1px solid var(--line)}
h3{font-size:17px;margin:22px 0 6px}
p,li{color:#2A2A27}
ul{padding-left:22px}li{margin:4px 0}
.summary{background:#fff;border:1px solid var(--line);border-left:4px solid var(--lime);border-radius:12px;padding:18px 22px}
.summary ul{margin:0}
table{width:100%;border-collapse:collapse;margin:10px 0 6px;font-size:15px;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
th{background:#EFEFE8;font-weight:700}
.wrap-table{overflow-x:auto}
a{color:#0D0D0C}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:14px;padding:20px;text-align:center}
</style>
</head>
<body>
<header><a href="/"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa" width="128" height="20">Loyalty</a></header>
<main>
<h1>Privacy policy for Vesopa Loyalty apps</h1>
<p class="updated">Applies to The Vesopa Kitchen and every venue loyalty app built on Vesopa Loyalty, on iPhone, iPad, Android, Windows and the web. Last updated ${UPDATED}.</p>

<div class="summary">
<ul>
<li>We collect what the app needs to run your loyalty card: who you are, your membership and points, and how you sign in.</li>
<li><strong>Your location is never stored.</strong> If you turn on nearby offers, your position is used in the moment to check whether you are at the venue, then discarded.</li>
<li>We do not sell your data, show advertising, or use analytics or tracking tools in the app.</li>
<li>You can delete your account and data in the app (Account › Delete my account and data) or at <a href="${deleteUrl}">${deleteUrl.replace('https://', '')}</a>.</li>
</ul>
</div>

<h2>1. Who we are</h2>
<p>The apps are made and run by <strong>Vesopa Software Limited</strong>, a company registered in Wales, company number 17362206, of Baglan, Port Talbot, SA12 7AX, United Kingdom.</p>
<p>Each loyalty app belongs to a venue. <strong>The venue is the controller</strong> of its members' data and Vesopa Software Limited processes it on the venue's behalf. <strong>The Vesopa Kitchen</strong> is Vesopa's own demonstration venue, so for that app Vesopa Software Limited is the controller. Its members, visits and news are sample data.</p>
<p>Contact us about privacy at <a href="mailto:${contact}">${contact}</a>.</p>

<h2>2. What we collect and why</h2>
<div class="wrap-table"><table>
<tr><th>Data</th><th>Why</th><th>Required?</th></tr>
<tr><td>Name and email address</td><td>To create your membership, sign you in with a code and show your name on your card.</td><td>Yes</td></tr>
<tr><td>Mobile number</td><td>To sign in with a text-message code, if you add one.</td><td>Optional</td></tr>
<tr><td>Photo</td><td>Shown on your card so venue staff can recognise you, if you add one.</td><td>Optional</td></tr>
<tr><td>Membership: card and member number, points, tier, visits, what you spent and earned, membership dates</td><td>To run the loyalty scheme. Points are added and spent by the venue's till.</td><td>Yes</td></tr>
<tr><td>Sign-in details: a password (stored only as a secure hash), passkeys, your Vesopa account link, and the devices you are signed in on</td><td>To keep your account secure and let you sign other devices out.</td><td>Only the ones you set up</td></tr>
<tr><td>Notification token for your phone, computer or browser</td><td>To deliver the venue's news and offers as notifications.</td><td>Optional</td></tr>
<tr><td>News you have received and read</td><td>To show the venue's messages in the app and mark new ones.</td><td>Yes</td></tr>
<tr><td>Approximate or precise location</td><td>Only if you turn on “Offers when I'm nearby”. See section 3.</td><td>Optional</td></tr>
</table></div>
<p>We do not collect your contacts, files, advertising identifiers or browsing activity, and the app contains no analytics or advertising software.</p>

<h2>3. Location</h2>
<p>The app asks for location permission only when you switch on “Offers when I'm nearby”, which is offered only by venues that have set their own location, and only while the app is open. It never asks for background location.</p>
<p>When you use it, your position is sent to our server, checked straight away against the venue's area, and discarded. <strong>Your location is never saved</strong>, not in our database and not in our logs. The only thing kept is whether you were near that venue, and when, for up to three hours so the venue can send you an offer while you are close. Turning the setting off removes that too.</p>

<h2>4. Our legal bases</h2>
<ul>
<li><strong>Contract:</strong> running your membership, card, points and sign-in.</li>
<li><strong>Consent:</strong> notifications, nearby offers and your photo. You can withdraw it at any time in the app or in your device settings.</li>
<li><strong>Legitimate interests:</strong> keeping accounts secure and preventing misuse.</li>
<li><strong>Legal obligation:</strong> sales records the venue must keep for tax.</li>
</ul>

<h2>5. Who else receives data</h2>
<p>We never sell personal data. It is shared only with the services that make the app work:</p>
<ul>
<li><strong>The venue</strong> whose app it is, in its Vesopa back office.</li>
<li><strong>Apple Push Notification service</strong> (iPhone and iPad), <strong>Google Firebase Cloud Messaging</strong> (Android), <strong>Microsoft Windows Push Notification Services</strong> (Windows) and your browser's push service (web), which receive a notification token and the message to deliver it.</li>
<li><strong>Postcoder</strong>, a UK provider, which receives your mobile number to send text-message sign-in codes.</li>
<li><strong>Vesopa Auth</strong> (auth.vesopa.com), if you choose Continue with Vesopa or ask for your data to be deleted.</li>
</ul>
<p>The apps and data are hosted on Vesopa's servers. Where a provider above processes data outside the UK, it does so under the safeguards UK data protection law requires.</p>

<h2>6. How long we keep it</h2>
<ul>
<li><strong>Your membership</strong>, for as long as it is active, or until you ask for it to be deleted.</li>
<li><strong>Sign-in codes</strong> expire after 10 minutes and are deleted within a day.</li>
<li><strong>The “near the venue” mark</strong> for up to 3 hours. Location itself is never kept.</li>
<li><strong>Sales and points records</strong> for six years, as the venue must keep them for tax. They stay without your name or contact details once you delete your account.</li>
<li><strong>A record that a deletion request was carried out</strong>, with your email address shortened so it no longer identifies you.</li>
</ul>

<h2>7. Deleting your account and data</h2>
<p>You can ask for your account and data to be deleted at any time, without contacting the venue:</p>
<ul>
<li>In the app: <strong>Account › Delete my account and data</strong>.</li>
<li>On the web, without the app: <a href="${deleteUrl}">${deleteUrl}</a>. For any venue app, <a href="https://auth.vesopa.com/delete-account">auth.vesopa.com/delete-account</a>.</li>
</ul>
<p>You can choose automatic deletion after 7, 15 or 30 days, which you can cancel until then, or deletion as soon as possible, which our team carries out, normally within two working days. We email you when it is done. What is deleted and what is kept is listed on that page and in section 6.</p>

<h2>8. Your rights</h2>
<p>Under UK data protection law you can ask for a copy of your data, correct it, delete it, restrict or object to how it is used, and receive it in a portable form. Email <a href="mailto:${contact}">${contact}</a>. We answer within one month. You can also complain to the Information Commissioner's Office at <a href="https://ico.org.uk">ico.org.uk</a>.</p>

<h2>9. Security</h2>
<p>Data travels over HTTPS. Passwords are stored only as secure hashes, sign-in codes are single-use and short-lived, and you can see and sign out every device on your account.</p>

<h2>10. Children</h2>
<p>The apps are not directed at children under 13, and we do not knowingly collect their data. If you believe a child has given us data, contact us and we will delete it.</p>

<h2>11. Changes</h2>
<p>If this policy changes we update this page and the date at the top.</p>
</main>
<footer>© ${new Date().getFullYear()} Vesopa Software Limited · <a href="/">Vesopa Loyalty</a> · <a href="${deleteUrl}">Delete your data</a></footer>
</body>
</html>`;
}

module.exports = { privacyPage };
