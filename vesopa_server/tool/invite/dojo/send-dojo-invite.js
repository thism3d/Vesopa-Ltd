#!/usr/bin/env node
/**
 * The Dojo kick-off invitation (2026-10-08), sent as Muzahid Islam
 * <muzahid@vesopa.com> the same way as the Metric invitation: through Auth's
 * own SMTP settings, so the relay sees a vesopa.com sender it accepts.
 *
 *   node tool/invite/dojo/send-dojo-invite.js                 # says what it would send
 *   node tool/invite/dojo/send-dojo-invite.js --send          # to Dojo, cc Meirion
 *   node tool/invite/dojo/send-dojo-invite.js --send --only info@vesopa.com   # one copy only
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
  const eml = path.join(__dirname, 'Vesopa-Dojo-kick-off.eml');
  // Git may store it with LF endings; mail wants CRLF.
  let raw = fs.readFileSync(eml, 'utf8').replace(/\r?\n/g, '\r\n');
  const split = raw.indexOf('\r\n\r\n');
  let head = raw.slice(0, split);
  const body = raw.slice(split);
  head = head.replace(/^X-Unsent:.*\r\n/m, '').replace(/^Date:.*$/m, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`);
  raw = head + body;
  const subject = (head.match(/^Subject: (.*)$/m) || [])[1];

  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt > -1 ? process.argv[onlyAt + 1] : null;
  if (onlyAt > -1 && !/^[^@\s]+@[^@\s]+$/.test(only || '')) throw new Error('--only needs an address');
  const to = only ? [only] : RECIPIENTS;

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
