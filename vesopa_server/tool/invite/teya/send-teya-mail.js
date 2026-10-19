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
 */
const fs = require('fs');
const path = require('path');

const FROM = 'muzahid@vesopa.com';
const MAILS = {
  '--store': {
    eml: 'Vesopa-Teya-store.eml',
    to: ['partnersupport@teya.com', 'info@vesopasoftware.com', 'info@vesopa.com'],
  },
};

async function main() {
  const flag = Object.keys(MAILS).find((f) => process.argv.includes(f));
  if (!flag) throw new Error(`choose one of ${Object.keys(MAILS).join(', ')}`);
  const mail = MAILS[flag];
  let raw = fs.readFileSync(path.join(__dirname, mail.eml), 'utf8').replace(/\r?\n/g, '\r\n');
  const split = raw.indexOf('\r\n\r\n');
  let head = raw.slice(0, split);
  head = head.replace(/^X-Unsent:.*\r\n/m, '').replace(/^Date:.*$/m, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`);
  raw = head + raw.slice(split);
  const subject = ((head + '\r\n').match(/^Subject:\s*([\s\S]*?)\r\n(?![ \t])/m) || [])[1]?.replace(/\r\n[ \t]+/g, ' ');

  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt > -1 ? process.argv[onlyAt + 1] : null;
  if (onlyAt > -1 && !/^[^@\s]+@[^@\s]+$/.test(only || '')) throw new Error('--only needs an address');
  const to = only ? [only] : mail.to;
  if (!process.argv.includes('--send')) {
    console.log(`would send "${subject}" from ${FROM} to ${to.join(', ')} (${Math.round(raw.length / 1024)} KB). Add --send.`);
    return;
  }
  const nodemailer = require('nodemailer');
  const authEnv = process.env.AUTH_ENV || '/home/vesopasoftware/web/auth.vesopa.com/private/nodeapp/.env';
  if (!fs.existsSync(authEnv)) throw new Error(`no Auth settings at ${authEnv} (set AUTH_ENV)`);
  const a = require('dotenv').parse(fs.readFileSync(authEnv));
  const tx = nodemailer.createTransport({
    host: a.SMTP_HOST || 'localhost',
    port: Number(a.SMTP_PORT || 587),
    secure: /^(1|true|yes)$/i.test(a.SMTP_SECURE || ''),
    auth: a.SMTP_USER ? { user: a.SMTP_USER, pass: a.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
  });
  const info = await tx.sendMail({ envelope: { from: FROM, to }, raw });
  console.log(`sent "${subject}" from ${FROM} to ${to.join(', ')}: ${info.response}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
