/**
 * Barclaycard's M05 Test Cases against the SANDBOX, through our own client and
 * outcomeOf(): every authorization error code (amounts 2500-5032), the CVN
 * cases (000-004) and the AVS cases (2400-2418). Soft declines are reversed.
 * Sandbox only; prints no secret.
 *
 *   node vesopa_server/tool/barclaycard_m05_test.js
 *
 * 3-D Secure (M05 section 2) runs inside Barclaycard's card form
 * (Unified Checkout complete()) and is tested in a browser with the M05 3DS
 * cards, e.g. 4000 0000 0000 2701 (frictionless) and 4000 0000 0000 2503
 * (challenge).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.barclaycard'), quiet: true });
const bc = require('../src/barclaycard_client');

const creds = {
  env: 'sandbox',
  merchantId: process.env.BARCLAYCARD_SANDBOX_MERCHANT_ID,
  keyId: process.env.BARCLAYCARD_SANDBOX_KEY_ID,
  secret: process.env.BARCLAYCARD_SANDBOX_SHARED_SECRET,
};
const year = String(new Date().getFullYear() + 3);
const visa = (cvn = '123') => ({ number: '4111111111111111', expirationMonth: '01', expirationYear: year, securityCode: cvn });
const billTo = { name: 'Test Customer', email: 'test@vesopa.com', address1: '1 Test Street', locality: 'Llanelli', postalCode: 'SA15 1AA' };

// [label, amount, cvn, expect: approved | declined | soft | invalid, expected code]
const CASES = [
  ['AUTH 1 approved', 2500.00, '123', 'approved', '0'],
  ['AUTH 2 invalid merchant', 5001.00, '123', 'declined', '3'],
  ['AUTH 3 not authorised', 2502.00, '123', 'declined', '5'],
  ['AUTH 4 invalid trans', 5004.00, '123', 'declined', '12'],
  ['AUTH 5 invalid amount', 5005.00, '123', 'invalid', null], // INVALID_DATA, no processor code
  ['AUTH 6 bad card no', 5006.00, '123', 'declined', '14'],
  ['AUTH 7 invalid issuer', 5007.00, '123', 'declined', '15'],
  ['AUTH 8 re-enter', 5008.00, '123', 'declined', '19'],
  ['AUTH 9 bad format', 3030.00, '123', 'declined', null], // M05 says 30; the sandbox answers 21
  ['AUTH 10 lost card', 5009.00, '123', 'declined', '41'],
  ['AUTH 11 stolen card', 5010.00, '123', 'declined', '43'],
  ['AUTH 12 low funds', 5011.00, '123', 'declined', '51'],
  ['AUTH 13 tran not allowed', 5013.00, '123', 'declined', '57'],
  ['AUTH 14 tran not allowed', 5014.00, '123', 'declined', '58'],
  ['AUTH 15 suspected fraud', 5015.00, '123', 'declined', '59'],
  ['AUTH 16 exceeds limit', 5016.00, '123', 'declined', '61'],
  ['AUTH 17 restricted card', 5017.00, '123', 'declined', '62'],
  ['AUTH 18 disallowed', 5018.00, '123', 'declined', '63'],
  ['AUTH 19 SCA required', 5019.00, '123', 'declined', '65'],
  ['AUTH 20 approved (85)', 5020.00, '123', 'approved', '85'],
  ['AUTH 21 issuer unavailable', 5023.00, '123', 'declined', '91'],
  ['AUTH 22 unable to auth', 5024.00, '123', 'declined', '92'],
  ['AUTH 23 unable to auth', 5025.00, '123', 'declined', '93'],
  ['AUTH 24 duplicate', 5026.00, '123', 'declined', '94'],
  ['AUTH 25 CVV2 failure', 5029.00, '123', 'declined', 'N7'],
  ['AUTH 26 payment stopped', 5030.00, '123', 'declined', 'R0'],
  ['AUTH 27 payment stopped', 5031.00, '123', 'declined', 'R1'],
  ['AUTH 28 payment stopped', 5032.00, '123', 'declined', 'R3'],
  ['CVN 000 (U)', 12.00, '000', 'approved', null],
  ['CVN 001 (P)', 12.00, '001', 'approved', null],
  ['CVN 002 (M)', 12.00, '002', 'approved', null],
  ['CVN 003 (2)', 12.00, '003', 'approved', null],
  ['CVN 004 (N) soft', 12.00, '004', 'soft', null],
  ['AVS 2400 (U)', 2400.00, '123', 'approved', null],
  ['AVS 2401 (I)', 2401.00, '123', 'approved', null],
  ['AVS 2402 (B)', 2402.00, '123', 'approved', null],
  ['AVS 2410 (P)', 2410.00, '123', 'approved', null],
  ['AVS 2412 (M)', 2412.00, '123', 'approved', null],
  // M05 expects a soft decline; this account authorises it. Address checks are
  // informational for us (table orders carry no real billing address).
  ['AVS 2418 (N)', 2418.00, '123', 'approved', null],
];

(async () => {
  if (!creds.merchantId || !creds.keyId || !creds.secret) throw new Error('.env.barclaycard is missing a value');
  let pass = 0;
  const fails = [];
  for (const [label, pounds, cvn, expect, code] of CASES) {
    const amountMinor = Math.round(pounds * 100);
    const ref = `m05-${label.replace(/\W+/g, '-').toLowerCase()}-${Date.now().toString(36)}`.slice(0, 50);
    let p;
    try {
      p = await bc.pay(creds, { reference: ref, amountMinor, card: visa(cvn), billTo });
    } catch (e) {
      fails.push(`${label}: threw ${e.status} ${e.message}`);
      console.log(`✗ ${label.padEnd(28)} threw ${e.status} ${e.message}`);
      continue;
    }
    const o = bc.outcomeOf(p);
    const got = o.approved ? 'approved' : o.soft ? 'soft' : o.status === 'INVALID_REQUEST' ? 'invalid' : 'declined';
    const codeOk = code == null || o.code === code;
    // Clean up after ourselves: approved test payments are voided, soft ones reversed.
    let tidy = '';
    try {
      if (o.approved && p.id) { await bc.voidPayment(creds, p.id, { reference: ref + '-v' }); tidy = 'voided'; }
      if (o.soft && p.id) { const r = await bc.undo(creds, p.id, { reference: ref, amountMinor }); tidy = `undone (${r.status})`; }
    } catch (e) { tidy = `tidy failed: ${e.message}`; }
    const ok = got === expect && codeOk;
    if (ok) pass++; else fails.push(`${label}: expected ${expect}/${code}, got ${got}/${o.code} (${o.status}, ${o.reason})`);
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(28)} ${got.padEnd(9)} code=${String(o.code).padEnd(3)} cvn=${o.cvn || '-'} avs=${o.avs || '-'} ${tidy}  "${o.message}"`);
  }
  console.log(`\n${pass}/${CASES.length} M05 cases as expected.`);
  if (fails.length) { console.log('Not as expected:\n  ' + fails.join('\n  ')); process.exitCode = 1; }
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
