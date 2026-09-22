#!/usr/bin/env node
/**
 * Sign one sample `.pkpass` of every kind, for testing on a real phone.
 *
 *     cd vesopa_server
 *     APPLE_WALLET_DIR=../passes_and_oauth \
 *     APPLE_WWDR_CERT=../passes_and_oauth/wwdr.pem \
 *     APPLE_WALLET_P12_PASSWORD=… \
 *     node tools/make-sample-passes.js
 *
 * WHY THIS IS WORTH HAVING
 *
 * Every automated check in `test/wallet-apple-signing.test.js` can pass on a
 * pass that iOS still refuses, because the tests verify the signature the way
 * openssl sees it and iOS applies rules of its own — image dimensions, field
 * counts, a `passTypeIdentifier` that must match a certificate Apple recognises
 * as current. There is no substitute for putting one on a phone.
 *
 * So: AirDrop the files this writes, or email them to yourself. A pass that
 * opens in Wallet is the only proof that counts, and "Safari cannot download
 * this file" is the only error anybody will ever see if something is wrong.
 *
 * The output goes to `passes_and_oauth/samples/`, which is ignored by that
 * folder's deny-everything rule — these are signed cards carrying sample data
 * and they do not belong in the repository.
 */

const fs = require('fs');
const path = require('path');

const A = require('../src/wallet_apple');
const G = require('../src/wallet_google');

const config = A.readConfig(process.env);
if (!config.configured) {
  console.error('Cannot sign anything yet:\n');
  for (const problem of config.problems) console.error(`  - ${problem}`);
  console.error('\nSee passes_and_oauth/README.md.');
  process.exit(1);
}

const out = path.join(__dirname, '..', '..', 'passes_and_oauth', 'samples');
fs.mkdirSync(out, { recursive: true });

/** Vesopa's own palette, so a sample looks like the real thing. */
const brand = {
  issuer_name: 'The Crown',
  program_name: 'Crown Rewards',
  hex_background: '#111111',
  hex_foreground: '#F2F4F0',
  hex_label: '#A5C715',
  homepage_url: 'https://epos.vesopa.com',
  support_phone: '01792 316282',
  terms: 'Points expire 24 months after they are earned.',
};

/**
 * A plausible holder for each kind.
 *
 * Filled in rather than left sparse on purpose: the fields a pass leaves out
 * when they are empty are exactly the ones worth seeing laid out, and a sample
 * with three blank rows tells you nothing about how a real card reads.
 */
const subjects = {
  loyalty: {
    id: 'sample-loyalty',
    name: 'Sarah Jones',
    card_number: '999800001',
    member_no: '1',
    points: 240,
    tier: 'Gold',
    discount: '10% off',
    member_since: '2024-03-02',
  },
  customer: {
    id: 'sample-member',
    name: 'Sarah Jones',
    card_number: '999800001',
    member_no: '1',
    tier: 'Gold',
    discount: '10% off',
    member_since: '2024-03-02',
  },
  giftcard: {
    id: 'sample-gift',
    card_number: '987800042',
    name: 'Owen Price',
    balance_minor: 2550,
    currency: 'GBP',
    issued_on: '2026-01-14',
    expires_on: '2027-01-14',
    state: 'ACTIVE',
  },
  staff: {
    id: 'sample-staff',
    name: 'Owen Price',
    role: 'Manager',
    card_number: '999900007',
    state: 'ACTIVE',
  },
  promo: {
    id: 'sample-promo',
    title: '2 for 1 on cocktails',
    details: 'Sunday to Thursday, before 7pm',
    card_number: 'PROMO1',
    ends_on: '2026-12-31',
    state: 'ACTIVE',
  },
};

const assetsDir = path.join(__dirname, '..', 'assets', 'wallet');

console.log(`\nSigning as team ${config.teamId}`);
console.log(`Key    ${path.basename(config.shared)}`);
console.log(`WWDR   ${config.wwdr}\n`);

for (const [kind, type] of Object.entries(G.PASS_TYPES)) {
  try {
    const built = A.buildPkpass({
      kind,
      config,
      brand,
      subject: subjects[kind],
      assetsDir,
    });
    const file = path.join(out, `vesopa-${kind}.pkpass`);
    fs.writeFileSync(file, built.bytes);
    console.log(
      `  ${type.label.padEnd(16)} ${String(Math.round(built.bytes.length / 1024)).padStart(4)}KB  ` +
        `${type.appleType}`
    );
  } catch (e) {
    console.error(`  ${kind}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log(`\nWritten to passes_and_oauth/samples/`);
console.log('AirDrop one to an iPhone, or email it to yourself. A pass that');
console.log('opens in Wallet is the only proof that counts.\n');
