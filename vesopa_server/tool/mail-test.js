#!/usr/bin/env node
/**
 * Send one short test message through the back office's own mailer.
 *
 *   node tool/mail-test.js info@vesopa.com [menu]
 *
 * Uses .env exactly as the running server does, so what this sends is what a
 * sign-in code or receipt would send. Prints the From it used; never a password.
 */
require('dotenv').config({ quiet: true });
const { sendMail } = require('../src/mailer');

const to = process.argv[2];
const account = process.argv[3];
if (!to) {
  console.error('usage: node tool/mail-test.js <to> [account]');
  process.exit(1);
}
const prefix = account ? account.toUpperCase() : '';
const from = account
  ? process.env[`${prefix}_MAIL_FROM`] || process.env[`${prefix}_SMTP_USER`] || process.env.MAIL_FROM
  : process.env.MAIL_FROM;
sendMail({
  to,
  account,
  subject: `Vesopa EPOS mail test${account ? ` (${account})` : ''}`,
  html: '<p>This is a test from the Vesopa EPOS back office. No action is needed.</p>',
  text: 'This is a test from the Vesopa EPOS back office. No action is needed.',
}).then((ok) => {
  console.log(`${ok ? 'handed over' : 'NOT sent'}: from ${from} to ${to}${account ? ` (${account})` : ''}`);
  process.exit(ok ? 0 : 1);
});
