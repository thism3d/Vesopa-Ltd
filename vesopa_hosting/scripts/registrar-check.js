#!/usr/bin/env node
/**
 * Why is checkout refusing to sell a domain? Read-only.
 *
 * Checkout says "We can't register domains at the moment" whenever
 * registrar-funds.js refuses the sale: the reseller balance at Domain Name API
 * is below what the registry will charge, or the balance cannot be read at all.
 * A promo code makes no difference, because what we pay the registry does not
 * change when the customer pays nothing.
 *
 *   node scripts/registrar-check.js [domain]
 *
 * Prints the mode, the live balance, what the domain would need, the verdict
 * checkout would give, and the last refusals logged. Registers nothing.
 */

require('dotenv').config();

const db = require('../src/db');
const registrar = require('../src/integrations/domainnameapi');
const funds = require('../src/registrar-funds');

(async () => {
  const domain = process.argv[2] || 'example.com';
  const status = registrar.status();
  console.log('mode      ', status.mode, status.live ? '(live)' : '(not live)', status.connected ? 'connected' : 'NOT connected');
  console.log('reseller  ', status.reseller_id || '(none)', 'write url', status.write_url);

  try {
    const b = await registrar.balance();
    console.log('balance   ', `$${b.amount}`, b.reseller_name ? `(${b.reseller_name})` : '');
  } catch (err) {
    console.log('balance   ', 'UNREADABLE:', err.message, err.code ? `[${err.code}]` : '');
  }

  const line = { kind: 'domain', domain, years: 1 };
  const cost = await funds.costUsd([line]);
  console.log('needs     ', `$${cost.usd.toFixed(2)} for ${domain}`, cost.unpriced.length ? '(no cost recorded for this TLD)' : '');
  const verdict = await funds.check([line]);
  console.log('checkout  ', verdict.ok ? 'WOULD SELL' : `REFUSES: ${verdict.reason}`);

  const rows = await db.query(
    `SELECT created_at, target, detail FROM activity_log
      WHERE action = 'registrar.balance_low' ORDER BY id DESC LIMIT 5`,
  );
  console.log(`\nlast ${rows.length} refusals:`);
  for (const r of rows) console.log(' ', r.created_at, r.target, '-', r.detail);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
