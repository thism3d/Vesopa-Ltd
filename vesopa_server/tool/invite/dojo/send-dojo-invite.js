#!/usr/bin/env node
/**
 * The Dojo kick-off invitation (2026-10-08), sent as Muzahid Islam
 * <muzahid@vesopa.com> the same way as the Metric invitation: through Auth's
 * own SMTP settings, so the relay sees a vesopa.com sender it accepts.
 *
 *   node tool/invite/dojo/send-dojo-invite.js                 # says what it would send
 *   node tool/invite/dojo/send-dojo-invite.js --send          # to Dojo, cc Meirion
 *   node tool/invite/dojo/send-dojo-invite.js --send --only info@vesopa.com   # one copy only
 *   ... --final       # 11 Oct: accreditation fixes done, final testing Mon 12 Oct 10:30 (new invite)
 *   ... --confirm     # 12 Oct morning: please confirm today's final testing at 10:30
 *   ... --vesopa-followup   # 26 Oct: follow-up, please verify and issue our live key (reply in the thread)
 *   ... --epos-live   # 24 Oct: certification + live API for Vesopa EPOS subscriptions (Alex, partnertech; cc Meirion)
 *   ... --staging2    # 19 Oct: staging on an established domain, pontardawerfcmenu.vesopa.com (Alex, partnertech, support, integrations; cc Meirion)
 *   ... --staging     # 16 Oct: staging link menu.pontardawerfc.com for Dojo's checklist review (Alex, support@ and integrations@, cc Meirion)
 *   ... --remote      # 15 Oct: please enable Remote Payments for Pontardawe, call Fri 16 Oct 10am UK (Alex, cc Meirion), with .ics
 *   ... --hosted-invite  # 15 Oct: the same again with the calendar invite (Yes / No / Maybe)
 *   ... --hosted      # 15 Oct: hosted payments for EPOS, menu, Android and iOS, 1:30pm UK, Alex only (cc Meirion), no .ics
 *   ... --review      # 12 Oct: UAT round 2 fixes (EPOS 1.16.3) + accreditation review 4pm UK, Alex and Finn only
 *   ... --reminder2   # 9 Oct midday: reminder for 1:30pm with the new Meet link
 *   ... --correction  # 9 Oct: right time 1:30pm (not 8:30am), new Meet link, invite SEQUENCE 2
 *   ... --reminder    # morning-of reminder, 9 Oct: today 1:30pm, Meet link and dial-in
 *   ... --confirmed   # the follow-up: new time 1:30pm accepted, Meet link, invite SEQUENCE 1
 *
 * The message is Vesopa-Dojo-kick-off.eml next to this file, made by
 * source/build.py: branded HTML, inline picture, and a METHOD:REQUEST calendar
 * invite (Fri 9 Oct 2026 10:00-10:45 Europe/London) that Outlook and Gmail
 * show with Accept and Decline. It is sent byte for byte, minus the Outlook
 * draft marker, with a fresh Date.
 */
const fs = require('fs');
const path = require('path');

const FROM = 'muzahid@vesopa.com';
const RECIPIENTS = [
  'alex.radzio@dojo.tech',
  'fintan.bridger@paymentsense.com',
  'oliver.england@paymentsense.com',
  'info@vesopasoftware.com',
  'info@vesopa.com',
];

async function main() {
  const eml = path.join(__dirname, process.argv.includes('--vesopa-followup') ? 'Vesopa-Dojo-vesopa-verify-followup.eml'
    : process.argv.includes('--vesopa-verify') ? 'Vesopa-Dojo-vesopa-verify.eml'
    : process.argv.includes('--epos-live') ? 'Vesopa-Dojo-epos-live.eml'
    : process.argv.includes('--staging2') ? 'Vesopa-Dojo-staging2.eml'
    : process.argv.includes('--staging') ? 'Vesopa-Dojo-staging.eml'
    : process.argv.includes('--remote') ? 'Vesopa-Dojo-remote.eml'
    : process.argv.includes('--hosted-invite') ? 'Vesopa-Dojo-hosted-invite.eml'
    : process.argv.includes('--hosted') ? 'Vesopa-Dojo-hosted.eml'
    : process.argv.includes('--review') ? 'Vesopa-Dojo-review.eml'
    : process.argv.includes('--confirm') ? 'Vesopa-Dojo-confirm.eml'
    : process.argv.includes('--final') ? 'Vesopa-Dojo-final-testing.eml'
    : process.argv.includes('--reminder2') ? 'Vesopa-Dojo-kick-off-reminder2.eml'
    : process.argv.includes('--correction') ? 'Vesopa-Dojo-kick-off-correction.eml'
    : process.argv.includes('--reminder') ? 'Vesopa-Dojo-kick-off-reminder.eml'
    : process.argv.includes('--confirmed') ? 'Vesopa-Dojo-kick-off-confirmed.eml' : 'Vesopa-Dojo-kick-off.eml');
  // Git may store it with LF endings; mail wants CRLF.
  let raw = fs.readFileSync(eml, 'utf8').replace(/\r?\n/g, '\r\n');
  const split = raw.indexOf('\r\n\r\n');
  let head = raw.slice(0, split);
  const body = raw.slice(split);
  head = head.replace(/^X-Unsent:.*\r\n/m, '').replace(/^Date:.*$/m, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`);
  raw = head + body;
  const subject = ((head + '\r\n').match(/^Subject:\s*([\s\S]*?)\r\n(?![ \t])/m) || [])[1]?.replace(/\r\n[ \t]+/g, ' ');

  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt > -1 ? process.argv[onlyAt + 1] : null;
  if (onlyAt > -1 && !/^[^@\s]+@[^@\s]+$/.test(only || '')) throw new Error('--only needs an address');
  // The 12 Oct review email goes to Alex and Finn only (cc Meirion), not Oliver.
  const list = process.argv.includes('--epos-live') || process.argv.includes('--vesopa-verify') || process.argv.includes('--vesopa-followup')
    ? ['alex.radzio@dojo.tech', 'partnertech@dojo.tech', 'info@vesopasoftware.com', 'info@vesopa.com']
    : process.argv.includes('--staging2')
    ? ['alex.radzio@dojo.tech', 'partnertech@dojo.tech', 'support@dojo.tech', 'integrations@dojo.tech', 'info@vesopasoftware.com', 'info@vesopa.com']
    : process.argv.includes('--staging')
    ? ['alex.radzio@dojo.tech', 'support@dojo.tech', 'integrations@dojo.tech', 'info@vesopasoftware.com', 'info@vesopa.com']
    : process.argv.includes('--hosted') || process.argv.includes('--remote')
    ? ['alex.radzio@dojo.tech', 'info@vesopasoftware.com', 'info@vesopa.com']
    : process.argv.includes('--review') ? RECIPIENTS.filter((r) => r !== 'oliver.england@paymentsense.com') : RECIPIENTS;
  const to = only ? [only] : list;

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
  console.log(`using Auth's mail server ${a.SMTP_HOST || 'localhost'}:${a.SMTP_PORT || 587}`);
  const info = await tx.sendMail({ envelope: { from: FROM, to }, raw });
  console.log(`sent "${subject}" from ${FROM} to ${to.join(', ')}: ${info.response}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
