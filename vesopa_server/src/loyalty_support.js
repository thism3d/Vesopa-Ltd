/**
 * loyalty.vesopa.com/support -- help for members of any Vesopa loyalty app.
 *
 * The App Store asks every app for a Support URL that leads to real contact
 * information, and Google Play and the Microsoft Store show one too. The
 * answers here describe what the apps actually do; change them with the app.
 */

function supportPage({ host, demoSlug = 'thevesopakitchen', contact = 'info@vesopasoftware.com' }) {
  const mail = `mailto:${contact}?subject=${encodeURIComponent('Help with my loyalty app')}`;
  const qa = [
    ['I have not received my sign-in code', 'Codes arrive within a minute and last 10 minutes. Check your spam or junk folder, and that the email address is the one you joined with. On the sign-in screen you can ask for another code, or choose "Text me a code" if you have added a mobile number.'],
    ['My points are missing from a visit', 'Points are added by the venue’s till when you show your card as you pay. Open Activity in the app to see every visit. If one is missing or wrong, ask the venue: they can check it against the till and put it right.'],
    ['How do I turn notifications on or off?', 'Open the Venue page in the app and use the Notifications switch. You can also allow or block them for the app in your phone’s or computer’s settings.'],
    ['What are "Offers when I’m nearby"?', 'If the venue offers it, you can switch it on from the Venue page. The app then checks, while it is open, whether you are near the venue so they can send you an offer. Your location is never stored.'],
    ['How do I change my name, photo or mobile number?', 'Open Account in the app. Your email address is how you get back into your membership, so to change it, ask the venue.'],
    ['I have a new phone', 'Install the app and sign in with the same email address. Your card, points and history are kept by the venue and come straight back.'],
    ['How do I delete my account and data?', `In the app: Account, then Delete my account and data. Without the app: <a href="https://auth.vesopa.com/delete-account/${demoSlug}">auth.vesopa.com/delete-account</a>. You can choose automatic deletion after 7, 15 or 30 days, or as soon as possible.`],
  ];
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Support — Vesopa Loyalty apps, including The Vesopa Kitchen</title>
<meta name="description" content="Help with The Vesopa Kitchen and every Vesopa loyalty app: signing in, points, notifications, your account and deleting your data.">
<link rel="canonical" href="https://${host}/support">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<style>
:root{--lime:#A5C715;--ink:#141413;--muted:#55554F;--line:#E3E3DC;--paper:#F6F6F1}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:#0D0D0C;padding:16px 20px}
header a{display:inline-flex;align-items:center;gap:12px;text-decoration:none;color:#B9B9B1;font:700 11px/1 system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase}
header img{height:20px}
main{max-width:780px;margin:0 auto;padding:36px 20px 70px}
h1{font-size:clamp(28px,4vw,38px);line-height:1.15;margin:0 0 8px}
.lead{color:var(--muted);margin:0 0 26px}
.contact{background:#fff;border:1px solid var(--line);border-left:4px solid var(--lime);border-radius:12px;padding:20px 22px;margin-bottom:28px}
.contact h2{margin:0 0 8px;font-size:19px}
.contact p{margin:4px 0}
.btn{display:inline-block;margin-top:12px;background:#111;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px}
details{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:10px}
summary{cursor:pointer;font-weight:700}
details p{margin:10px 0 0;color:#2A2A27}
a{color:#0D0D0C}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:14px;padding:20px;text-align:center}
</style>
</head>
<body>
<header><a href="/"><img src="/assets/vesopa_logo_on_dark.png" alt="Vesopa" width="128" height="20">Loyalty</a></header>
<main>
<h1>Support</h1>
<p class="lead">Help with The Vesopa Kitchen and every loyalty app built on Vesopa Loyalty, on iPhone, iPad, Android, Windows and the web.</p>

<div class="contact">
  <h2>Contact us</h2>
  <p>Email <a href="${mail}">${contact}</a>. We aim to reply within two working days.</p>
  <p>Questions about your points or membership at a venue are best answered by the venue itself.</p>
  <p>Vesopa Software Limited, Baglan, Port Talbot, SA12 7AX, United Kingdom. Company number 17362206.</p>
  <a class="btn" href="${mail}">Email support</a>
</div>

${qa.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('\n')}

<p class="lead">Read our <a href="/privacy">privacy policy</a>.</p>
</main>
<footer>© ${new Date().getFullYear()} Vesopa Software Limited · <a href="/">Vesopa Loyalty</a> · <a href="/privacy">Privacy</a></footer>
</body>
</html>`;
}

module.exports = { supportPage };
