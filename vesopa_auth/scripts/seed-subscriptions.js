/**
 * Put a set of subscriptions on an account, so the page can be looked at.
 *
 *     node scripts/seed-subscriptions.js info@vesopasoftware.com
 *
 * IDEMPOTENT, and it never invents money. Each row says which product, what
 * plan, what state and what date — the things `/account/subscriptions` prints.
 * There is no amount anywhere, because `subscriptions` has no amount column and
 * `payment_methods` holds no card number: cards are recorded and never charged
 * until the authorisation work the owner deferred is actually built.
 *
 * WHY SEED AT ALL. An empty subscriptions page proves the query runs and
 * nothing else — not the grouping, not the states, not the alert card, not what
 * an expired row looks like beside an active one. Those are the things worth
 * looking at before this is put in front of a customer, and every state here is
 * one the real system can produce.
 *
 * The card is a WALLET row with a last four and nothing else, which is exactly
 * what Google Pay and Apple Pay ever hand over.
 */

const crypto = require('crypto');

const db = require('../src/db');
const { newId } = require('../src/crypto');
const { normaliseEmail } = require('../src/normalise');

const PLANS = [
  { product: 'epos', plan: 'Till', quantity: 3, status: 'active', renews: 60, card: true },
  { product: 'menu', plan: 'QR dine-in menu', quantity: 1, status: 'active', renews: 60, card: true },
  { product: 'kitchen', plan: 'Kitchen screen', quantity: 2, status: 'active', renews: 60, card: true },
  { product: 'hosting', plan: '100 GB', quantity: 1, status: 'active', renews: 21, card: true,
    attention: 'The card on file expires before the next renewal.' },
  { product: 'domain', plan: 'vesopaepos.com', quantity: 1, status: 'cancelled', ends: 45 },
  { product: 'display', plan: 'Customer display', quantity: 1, status: 'expired', ends: -120 },
];

const day = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
};

async function main() {
  const email = process.argv[2] || 'info@vesopasoftware.com';

  const user = await db.one(
    `SELECT u.id FROM users u
       JOIN user_identities i ON i.user_id = u.id
      WHERE i.type = 'email' AND i.identifier_norm = ? AND i.revoked_at IS NULL`,
    [normaliseEmail(email)],
  );
  if (!user) {
    console.error(`no account signs in with ${email}`);
    process.exit(1);
  }

  // A wallet, not a card. Brand and last four is all Apple Pay or Google Pay
  // ever gives us, and it is all this table can hold.
  let method = await db.one(
    "SELECT id FROM payment_methods WHERE user_id = ? AND provider_ref = 'seed-wallet'",
    [user.id],
  );
  if (!method) {
    const inserted = await db.execute(
      `INSERT INTO payment_methods
         (public_id, user_id, kind, brand, last4, exp_month, exp_year,
          provider, provider_ref, is_default)
       VALUES (?, ?, 'wallet', 'apple_pay', '4242', 11, 2028, 'seed', 'seed-wallet', 1)`,
      [newId(), user.id],
    );
    method = { id: inserted.insertId };
    console.log('  ✓ a wallet on file (brand and last four only — no card number)');
  } else {
    console.log('  ✓ wallet already there');
  }

  for (const spec of PLANS) {
    const product = await db.one('SELECT id, name FROM products WHERE slug = ?', [spec.product]);
    if (!product) continue;

    // eslint-disable-next-line no-await-in-loop -- six rows
    const existing = await db.one(
      'SELECT id FROM subscriptions WHERE user_id = ? AND product_id = ?',
      [user.id, product.id],
    );

    const values = [
      spec.plan,
      spec.quantity,
      spec.status,
      spec.status === 'active' ? day(spec.renews) : null,
      spec.ends !== undefined ? day(spec.ends) : null,
      day(-400),
      spec.card ? method.id : null,
      spec.attention ? 1 : 0,
      spec.attention || '',
    ];

    if (existing) {
      // eslint-disable-next-line no-await-in-loop -- six rows
      await db.execute(
        `UPDATE subscriptions
            SET plan_label = ?, quantity = ?, status = ?, renews_at = ?, ends_at = ?,
                started_at = ?, payment_method_id = ?, needs_attention = ?, attention_note = ?
          WHERE id = ?`,
        [...values, existing.id],
      );
    } else {
      // eslint-disable-next-line no-await-in-loop -- six rows
      await db.execute(
        `INSERT INTO subscriptions
           (public_id, user_id, product_id, plan_label, quantity, status,
            renews_at, ends_at, started_at, payment_method_id, needs_attention, attention_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), user.id, product.id, ...values],
      );
    }
    console.log(`  ✓ ${product.name} — ${spec.plan} (${spec.status})`);
  }

  console.log(`\nseeded for ${email}. Adjust or delete them from the database;`);
  console.log('nothing here can take a payment.');
  await db.close();
}

main().catch((error) => {
  console.error('failed:', error.message);
  process.exit(1);
});
