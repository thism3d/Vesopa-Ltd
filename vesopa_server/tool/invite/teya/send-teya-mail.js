/**
 * Send a Teya email from muzahid@vesopa.com through Auth's mail server, like
 * the Dojo ones (tool/invite/dojo/send-dojo-invite.js).
 *
 *   node tool/invite/teya/send-teya-mail.js --store          # dry run
 *   node tool/invite/teya/send-teya-mail.js --store --send   # send
 *   ... --only someone@example.com                           # one test copy
 *
 *   --store   19 Oct 2026: please add a test company and store to our sandbox
 *             account (partnersupport@teya.com, cc Meirion)
 *   --country  24 Oct 2026: UK shows "No data available", no live data for info@; OCOM invoice attached
 *   --ecommerce  24 Oct 2026: enable Vesopa Software Ltd for the eCommerce API, The Vesopa
 *             Kitchen demo, 12-month device rental (partner@, globalpartner@; sent as
 *             info@vesopasoftware.com through the vesopasoftware.com app's SMTP)
 */
const fs = require('fs');
const path = require('path');

const FROM = 'muzahid@vesopa.com';
const MAILS = {
  '--store': {
    eml: 'Vesopa-Teya-store.eml',
    to: ['partnersupport@teya.com', 'info@vesopasoftware.com', 'info@vesopa.com'],
  },
  '--country': {
    eml: 'Vesopa-Teya-country.eml',
    from: 'info@vesopasoftware.com',
    env: '/home/vesopasoftware/web/vesopasoftware.com/private/nodeapp/.env',
    to: ['partner@teya.com', 'globalpartner@teya.com', 'partnersupport@teya.com', 'info@vesopa.com', 'muzahid@vesopa.com', 'info@vesopasoftware.com'],
  },
  '--ecommerce': {
    eml: 'Vesopa-Teya-ecommerce.eml',
    from: 'info@vesopasoftware.com',
    env: '/home/vesopasoftware/web/vesopasoftware.com/private/nodeapp/.env',
    to: ['partner@teya.com', 'globalpartner@teya.com', 'info@vesopa.com', 'muzahid@vesopa.com', 'info@vesopasoftware.com'],
  },
};

async function main() {
  const flag = Object.keys(MAILS).find((f) => process.argv.includes(f));
  if (!flag) throw new Error(`choose one of ${Object.keys(MAILS).join(', ')}`);
  const mail = MAILS[flag];
  // --as-muzahid: from muzahid@vesopa.com through Auth's mail server, cc Meirion (owner,
  // 24 Oct 2026: the copies sent as info@vesopasoftware.com did not reach Teya).
  const asMuzahid = process.argv.includes('--as-muzahid');
  if (asMuzahid) mail.env = null;
  const from = asMuzahid ? FROM : mail.from || FROM;
  let raw = fs.readFileSync(path.join(__dirname, mail.eml), 'utf8').replace(/\r?\n/g, '\r\n');
  const split = raw.indexOf('\r\n\r\n');
  let head = raw.slice(0, split);
  if (asMuzahid) {
    head = head.replace(/^From:.*$/m, 'From: "Muzahid Islam, Vesopa Developer" <muzahid@vesopa.com>')
      .replace(/^Reply-To:.*$/m, 'Reply-To: Muzahid Islam <muzahid@vesopa.com>')
      .replace(/^Cc:.*(\r\n[ \t].*)*$/m, 'Cc: Meirion Davies <info@vesopasoftware.com>, Meirion Davies <info@vesopa.com>')
      .replace(/^(In-Reply-To|References):.*\r\n/gm, '');
  }
  // --important: high importance and a read receipt to the sender (owner, 2026-10-25).
  if (process.argv.includes('--important')) {
    head = head.replace(/^(Importance|X-Priority|Priority|X-MSMail-Priority|Disposition-Notification-To|Return-Receipt-To):.*\r\n/gim, '')
      + '\r\nImportance: High\r\nX-Priority: 1 (Highest)\r\nX-MSMail-Priority: High\r\nPriority: urgent'
      + `\r\nDisposition-Notification-To: ${from}\r\nReturn-Receipt-To: ${from}`;
  }
  head = head.replace(/^X-Unsent:.*\r\n/m, '').replace(/^Date:.*$/m, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`);
  raw = head + raw.slice(split);
  const subject = ((head + '\r\n').match(/^Subject:\s*([\s\S]*?)\r\n(?![ \t])/m) || [])[1]?.replace(/\r\n[ \t]+/g, ' ');

  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt > -1 ? process.argv[onlyAt + 1] : null;
  if (onlyAt > -1 && !/^[^@\s]+@[^@\s]+$/.test(only || '')) throw new Error('--only needs an address');
  const to = only ? [only] : mail.to;
  if (!process.argv.includes('--send')) {
    console.log(`would send "${subject}" from ${from} to ${to.join(', ')} (${Math.round(raw.length / 1024)} KB). Add --send.`);
    return;
  }
  const nodemailer = require('nodemailer');
  const authEnv = process.env.AUTH_ENV || mail.env || '/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp/.env';
  if (!fs.existsSync(authEnv)) throw new Error(`no Auth settings at ${authEnv} (set AUTH_ENV)`);
  const a = require('dotenv').parse(fs.readFileSync(authEnv));
  const tx = nodemailer.createTransport({
    host: a.SMTP_HOST || 'localhost',
    port: Number(a.SMTP_PORT || 587),
    secure: /^(1|true|yes)$/i.test(a.SMTP_SECURE || ''),
    auth: a.SMTP_USER ? { user: a.SMTP_USER, pass: a.SMTP_PASSWORD || a.SMTP_PASS } : undefined,
    // A loopback relay is the box's own exim, whose STARTTLS certificate names its hostname,
    // never 127.0.0.1; as in vesopasoftware.com's server/lib/mail.js, skip the check for loopback only.
    ...(/^(127\.|localhost$|::1$)/.test(a.SMTP_HOST || 'localhost') ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
  });
  const info = await tx.sendMail({ envelope: { from, to }, raw });
  console.log(`sent "${subject}" from ${from} to ${to.join(', ')}: ${info.response}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
