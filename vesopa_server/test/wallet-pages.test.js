/**
 * The pages a wallet card links out to.
 *
 * A card has room for about six facts. These four pages are where the rest goes
 * — what the points are worth, how far off the next reward, what the tier above
 * gets you, what is on this week — and they are reached by tapping a tile on a
 * pass, by somebody who is not signed in to anything.
 *
 * Which is why the checks below are as much about what these pages *refuse* as
 * what they show. The link is public, it lives in a stranger's pocket, and it
 * names a real person's balance.
 */

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const P = require('../src/wallet_pages');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nWallet card pages\n');

const SECRET = 'test-secret';
const OFFICE = 'manager@vesopa.co.uk';

const BRAND = {
  office: OFFICE,
  issuer_name: 'The Crown',
  program_name: 'Crown Rewards',
  homepage_url: 'https://thecrown.example',
  support_phone: '01792 316282',
  earning_text: 'A point for every pound.',
  redeeming_text: 'Spend from 200 points.',
  address_text: '1 High Street, Swansea',
  hours_text: 'Noon till late, every day',
};

const SUBJECTS = {
  loyalty: {
    id: 'c1',
    name: 'Sarah Jones',
    card_number: '999800001',
    points: 160,
    tier: 'Gold',
    discount: '10% off',
    member_since: '2024-03-02',
    member_no: '2',
    reward_floor: 200,
    point_value_minor: 1,
    points_per_pound: 1,
    history: [
      { at: '2026-09-01', kind: 'earn', points: 12, balance_after: 160 },
      { at: '2026-08-24', kind: 'redeem', points: -200, balance_after: 148 },
    ],
  },
  customer: {
    id: 'c1',
    name: 'Sarah Jones',
    card_number: '999800001',
    member_no: '2',
    tier: 'Gold',
    discount: '10% off',
    member_since: '2024-03-02',
  },
  giftcard: {
    id: 'g1',
    name: 'Owen Price',
    card_number: '987800001',
    balance_minor: 2550,
    currency: 'GBP',
    expires_on: '2027-01-01',
  },
};

function harness({ offers = [], tiers = [], settings = { min_redeem_points: 200, point_value_minor: 1, points_per_pound: 1 } } = {}) {
  const pool = {
    async query(sql) {
      if (sql.includes('epos_loyalty_settings')) return [settings ? [settings] : []];
      if (sql.includes('epos_loyalty_tiers')) return [tiers];
      if (sql.includes('epos_promotions')) return [offers];
      if (sql.includes('epos_gift_card_txns')) {
        return [[
          { kind: 'issue', amount_minor: 5000, balance_after: 5000, created_at: '2026-01-05' },
          { kind: 'redeem', amount_minor: -2450, balance_after: 2550, created_at: '2026-08-02' },
        ]];
      }
      return [[]];
    },
    async execute() { return [{}]; },
  };

  const core = {
    readBrand: async () => ({ ...BRAND }),
    loadSubject: async (_office, kind) => SUBJECTS[kind] || null,
  };

  const app = express();
  app.use(P.walletPageRoutes({ pool, secret: SECRET, core }));
  return app;
}

const tokenFor = (kind, sub = 'c1') =>
  jwt.sign({ scope: 'wallet', office: OFFICE, kind, sub }, SECRET, { expiresIn: '365d' });

async function get(app, path) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

(async () => {
  // ---------------------------------------------------------------------------
  // What each page says
  // ---------------------------------------------------------------------------

  await check('the rewards page says how far off the next reward is', async () => {
    const res = await get(harness(), `/wallet/rewards/${tokenFor('loyalty')}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('160'), 'the balance is missing');
    // 200 floor - 160 held = 40. The number that makes the page worth opening.
    assert.ok(res.body.includes('40'), 'does not say how many more points are needed');
    assert.ok(/more\s+points/i.test(res.body), 'no sentence around the number');
  });

  await check('points are given a value in money', async () => {
    const res = await get(harness(), `/wallet/rewards/${tokenFor('loyalty')}`);
    // 160 points at 1p each.
    assert.ok(res.body.includes('£1.60'), 'the points are not valued in money');
  });

  await check('a customer over the line is told they can spend', async () => {
    const app = harness();
    SUBJECTS.loyalty.points = 500;
    try {
      const res = await get(app, `/wallet/rewards/${tokenFor('loyalty')}`);
      assert.ok(/Ready to spend/i.test(res.body), 'a redeemable balance says nothing');
    } finally {
      SUBJECTS.loyalty.points = 160;
    }
  });

  // A venue that has not set a redemption floor cannot be made to say one.
  await check('a venue with no loyalty rules still gets a page', async () => {
    const res = await get(
      harness({ settings: null }),
      `/wallet/rewards/${tokenFor('loyalty')}`
    );
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('160'), 'the balance vanished with the rules');
    assert.ok(!/to go/i.test(res.body), 'invented a target the venue never set');
  });

  await check("the venue's own words reach the page", async () => {
    const res = await get(harness(), `/wallet/rewards/${tokenFor('loyalty')}`);
    assert.ok(res.body.includes('A point for every pound.'), 'earning_text missing');
    assert.ok(res.body.includes('Spend from 200 points.'), 'redeeming_text missing');
    assert.ok(res.body.includes('1 High Street, Swansea'), 'address missing');
  });

  await check('the membership page leads with the member number', async () => {
    const res = await get(harness(), `/wallet/member/${tokenFor('customer')}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('0002'), 'the member number is not shown');
    assert.ok(res.body.includes('Gold'), 'the tier is not shown');
  });

  await check('the balance page shows the balance and what was loaded', async () => {
    const res = await get(harness(), `/wallet/balance/${tokenFor('giftcard')}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('£25.50'), 'no balance');
    assert.ok(res.body.includes('£50.00'), 'does not say how much was loaded');
    assert.ok(/Topping up/i.test(res.body), 'no top-up section');
  });

  // A gift card is a bearer instrument. The full number belongs in the barcode.
  await check('the balance page never prints the whole card number', async () => {
    const res = await get(harness(), `/wallet/balance/${tokenFor('giftcard')}`);
    assert.ok(!res.body.includes('987800001'), 'the whole gift card number is on screen');
    assert.ok(res.body.includes('0001'), 'not even the last four are shown');
  });

  await check('the offers page lists what is on', async () => {
    const offers = [
      { name: 'Two for one on mains', badge_text: '2 for 1', kind: 'bogof', ends_on: '2026-12-01' },
    ];
    const res = await get(harness({ offers }), `/wallet/offers/${tokenFor('loyalty')}`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('2 for 1'), 'the offer is missing');
    assert.ok(res.body.includes('Two for one on mains'));
  });

  await check('a venue with no offers says so rather than showing a gap', async () => {
    const res = await get(harness({ offers: [] }), `/wallet/offers/${tokenFor('loyalty')}`);
    assert.strictEqual(res.status, 200);
    assert.ok(/Nothing on just now/i.test(res.body), 'an empty page with no explanation');
  });

  // The real column names. epos_loyalty_tiers has discount_percent and
  // points_multiplier -- NOT the discount_type/discount_value pair that
  // epos_customers carries. Naming the wrong ones threw, and a shared try/catch
  // turned that into a page silently missing its progress bar and tier list.
  await check('tiers show which one the holder is on', async () => {
    const tiers = [
      { name: 'Silver', min_spend_minor: 0, discount_percent: 5, points_multiplier: 1 },
      { name: 'Gold', min_spend_minor: 50000, discount_percent: 10, points_multiplier: 2 },
    ];
    const res = await get(harness({ tiers }), `/wallet/rewards/${tokenFor('loyalty')}`);
    assert.ok(res.body.includes('You are here'), 'the holder’s own tier is not marked');
    assert.ok(res.body.includes('10% off'), 'the tier perk is not shown');
    assert.ok(res.body.includes('2× points'), 'a points multiplier is not shown');
  });

  // The bug this pair exists to stop: a tiers query that fails must not take
  // the reward arithmetic with it. The card beside this page reads the settings
  // by a different path, so the two disagreeing is worse than a missing section
  // -- and it returned 200 with nothing in the log.
  await check('a broken tiers query does not silence the progress bar', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('epos_loyalty_tiers')) {
          throw new Error("Unknown column 'discount_type' in 'field list'");
        }
        if (sql.includes('epos_loyalty_settings')) {
          return [[{ min_redeem_points: 200, point_value_minor: 1, points_per_pound: 1 }]];
        }
        return [[]];
      },
      async execute() { return [{}]; },
    };
    const core = {
      readBrand: async () => ({ ...BRAND }),
      loadSubject: async (_o, kind) => SUBJECTS[kind] || null,
    };
    const app = express();
    app.use(P.walletPageRoutes({ pool, secret: SECRET, core }));

    const quiet = console.error;
    console.error = () => {};
    try {
      const res = await get(app, `/wallet/rewards/${tokenFor('loyalty')}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.includes('40'), 'the progress arithmetic went with the tiers');
      assert.ok(res.body.includes('£1.60'), 'the points value went with the tiers');
    } finally {
      console.error = quiet;
    }
  });

  // ---------------------------------------------------------------------------
  // What they refuse
  // ---------------------------------------------------------------------------

  // The link is public and names somebody's balance. A token minted for a gift
  // card must not open the membership page: the two carry different facts about
  // the same person.
  await check('a token for one card does not open another card’s page', async () => {
    const app = harness();
    const wrong = await get(app, `/wallet/member/${tokenFor('giftcard')}`);
    assert.strictEqual(wrong.status, 400);
    assert.ok(!wrong.body.includes('Sarah Jones'), 'it leaked the member anyway');

    const alsoWrong = await get(app, `/wallet/balance/${tokenFor('loyalty')}`);
    assert.strictEqual(alsoWrong.status, 400);
    assert.ok(!alsoWrong.body.includes('£25.50'), 'it leaked a balance anyway');
  });

  await check('a forged token opens nothing', async () => {
    const forged = jwt.sign(
      { scope: 'wallet', office: OFFICE, kind: 'loyalty', sub: 'c1' },
      'not-the-secret'
    );
    const res = await get(harness(), `/wallet/rewards/${forged}`);
    assert.strictEqual(res.status, 400);
    assert.ok(!res.body.includes('Sarah Jones'));
  });

  await check('a token for something other than a wallet link is refused', async () => {
    const other = jwt.sign({ scope: 'session', office: OFFICE, kind: 'loyalty', sub: 'c1' }, SECRET);
    const res = await get(harness(), `/wallet/rewards/${other}`);
    assert.strictEqual(res.status, 400);
  });

  await check('an expired link says so instead of failing', async () => {
    const stale = jwt.sign(
      { scope: 'wallet', office: OFFICE, kind: 'loyalty', sub: 'c1' },
      SECRET,
      { expiresIn: '-1h' }
    );
    const res = await get(harness(), `/wallet/rewards/${stale}`);
    assert.strictEqual(res.status, 400);
    assert.ok(/expired/i.test(res.body), 'no explanation for a dead link');
  });

  // ---------------------------------------------------------------------------
  // How the card reaches them
  // ---------------------------------------------------------------------------

  await check('every kind but staff links somewhere, and staff links nowhere', () => {
    for (const kind of ['loyalty', 'customer', 'giftcard', 'promo']) {
      assert.ok(P.PAGE_FOR[kind], `${kind} has no page`);
      assert.ok(P.PAGE_FOR[kind].type, `${kind} has no featuredAction type`);
    }
    assert.strictEqual(P.PAGE_FOR.staff, null, 'a work card should not offer a rewards page');
  });

  await check('the link is absolute, because a pass has no page to be relative to', () => {
    const was = process.env.BACKOFFICE_URL;
    process.env.BACKOFFICE_URL = 'https://backoffice.vesopaepos.com';
    try {
      const url = P.pageLink('loyalty', 'tok');
      assert.ok(url.startsWith('https://'), `not absolute: ${url}`);
      assert.ok(url.includes('/wallet/rewards/'));
    } finally {
      if (was === undefined) delete process.env.BACKOFFICE_URL;
      else process.env.BACKOFFICE_URL = was;
    }
  });

  // Without a configured base there is no absolute URL to build, and a relative
  // one in a pass points at nothing at all. Better no tile than a dead one.
  await check('no base URL means no link rather than a broken one', () => {
    const was = process.env.BACKOFFICE_URL;
    delete process.env.BACKOFFICE_URL;
    try {
      assert.strictEqual(P.pageLink('loyalty', 'tok'), '');
    } finally {
      if (was !== undefined) process.env.BACKOFFICE_URL = was;
    }
  });

  console.log(`\n${passed} checks passed\n`);
})();
