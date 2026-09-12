/**
 * Demo venues — the clone, against a database of the right shape.
 *
 *   node test/demo-venue.test.js
 *
 * WHY A FAKE DATABASE AND NOT MYSQL
 *
 * The end-to-end path is covered by five-features.test.js against a live-shaped
 * database. What is tested here is the part that is dangerous to get wrong and
 * awkward to provoke on real data: whether a copied child row ends up pointing
 * at its copy's parent, or at the REAL venue's parent. A stray id across the
 * tenant boundary is the one failure this whole design exists to prevent, and
 * it would not look like a failure -- the practice venue would simply show a
 * real venue's buttons, and nobody would know why.
 *
 * So the tables here are small and fake, and every assertion is about where the
 * ids landed.
 */
const assert = require('assert');

const demo = require('../src/demo_venue');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const r = fn();
    const done = () => {
      passed++;
      console.log(`  ok  ${name}`);
    };
    if (r && typeof r.then === 'function') return r.then(done, (e) => fail(name, e));
    done();
  } catch (e) {
    fail(name, e);
  }
  return undefined;
}
function fail(name, e) {
  failed++;
  console.error(`  FAIL  ${name}`);
  console.error(`        ${e.message}`);
  process.exitCode = 1;
}

/**
 * Just enough MySQL to run the clone: information_schema, a tenant-scoped
 * SELECT, an INSERT that hands back an insertId, and the offices table.
 */
function fakeDb({ schema, rows, offices }) {
  const data = {};
  for (const [table, list] of Object.entries(rows)) {
    data[table] = list.map((r) => ({ ...r }));
  }
  let nextId = 5000;

  async function query(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (/information_schema\.COLUMNS/i.test(text)) {
      const columns = schema[params[0]];
      if (!columns) return [[]];
      return [columns.map((c) => ({ name: c.name, extra: c.extra || '' }))];
    }

    let m = /^SELECT .* FROM offices WHERE contact_email = \?$/i.exec(text);
    if (m) return [offices.filter((o) => o.contact_email === params[0])];

    m = /^SELECT .* FROM offices WHERE id = \?$/i.exec(text);
    if (m) return [offices.filter((o) => Number(o.id) === Number(params[0]))];

    m = /^SELECT .* FROM offices WHERE demo_of = \?$/i.exec(text);
    if (m) return [offices.filter((o) => Number(o.demo_of) === Number(params[0]))];

    m = /^SELECT \* FROM `([a-z0-9_]+)` WHERE `([a-z0-9_]+)` = \?( AND \((.+)\))?$/i.exec(text);
    if (m) {
      const [, table, column, , extra] = m;
      let list = (data[table] || []).filter((r) => r[column] === params[0]);
      // The only extra clause SETUP uses.
      if (extra && /training/i.test(extra)) list = list.filter((r) => Number(r.training) === 1);
      return [list.map((r) => ({ ...r }))];
    }

    throw new Error(`fake db: unhandled query: ${text}`);
  }

  async function execute(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();

    let m = /^INSERT INTO `([a-z0-9_]+)` \((.+)\) VALUES \((.+)\)$/i.exec(text);
    if (m) {
      const table = m[1];
      const columns = m[2].split(',').map((c) => c.trim().replace(/`/g, ''));
      const row = {};
      columns.forEach((c, i) => {
        row[c] = params[i];
      });
      const auto = (schema[table] || []).find((c) => (c.extra || '').includes('auto_increment'));
      const insertId = nextId++;
      if (auto) row[auto.name] = insertId;
      data[table] = data[table] || [];
      data[table].push(row);
      return [{ insertId, affectedRows: 1 }];
    }

    m = /^DELETE FROM `([a-z0-9_]+)` WHERE `([a-z0-9_]+)` = \?$/i.exec(text);
    if (m) {
      const [, table, column] = m;
      const before = (data[table] || []).length;
      data[table] = (data[table] || []).filter((r) => r[column] !== params[0]);
      return [{ affectedRows: before - data[table].length }];
    }

    if (/^UPDATE offices SET/i.test(text)) return [{ affectedRows: 1 }];

    throw new Error(`fake db: unhandled statement: ${text}`);
  }

  return { query, execute, data };
}

const LIVE = {
  id: 1,
  name: 'The Arms',
  contact_email: 'arms@demo.test',
  status: 'active',
  demo_of: null,
};
const DEMO = {
  id: 2,
  name: 'The Arms — Demo',
  contact_email: 'demo.1@vesopa.invalid',
  status: 'active',
  demo_of: 1,
};
const OTHER = {
  id: 3,
  name: 'The Other Inn',
  contact_email: 'other@demo.test',
  status: 'active',
  demo_of: null,
};

/** A venue with screens, buttons on them, and the same shape at a second venue. */
function world() {
  return fakeDb({
    offices: [LIVE, DEMO, OTHER],
    schema: {
      epos_screens: [
        { name: 'id', extra: 'auto_increment' },
        { name: 'office' },
        { name: 'name' },
      ],
      epos_screen_buttons: [
        { name: 'id', extra: 'auto_increment' },
        { name: 'office' },
        { name: 'screen_id' },
        { name: 'label' },
      ],
      bo_clarks: [
        { name: 'id', extra: 'auto_increment' },
        { name: 'email' },
        { name: 'name' },
        { name: 'training' },
      ],
    },
    rows: {
      epos_screens: [
        { id: 10, office: LIVE.contact_email, name: 'Drinks' },
        { id: 11, office: LIVE.contact_email, name: 'Food' },
        { id: 90, office: OTHER.contact_email, name: 'Someone else' },
      ],
      epos_screen_buttons: [
        { id: 20, office: LIVE.contact_email, screen_id: 10, label: 'Lager' },
        { id: 21, office: LIVE.contact_email, screen_id: 11, label: 'Chips' },
        { id: 99, office: OTHER.contact_email, screen_id: 90, label: 'Not ours' },
      ],
      bo_clarks: [
        { id: 30, email: LIVE.contact_email, name: 'Sam', training: 0 },
        { id: 31, email: LIVE.contact_email, name: 'Training', training: 1 },
      ],
    },
  });
}

async function main() {
  console.log('demo venues');

  await check('every linked parent is copied before the child that points at it', () => {
    const seen = new Set();
    for (const entry of demo.SETUP) {
      for (const parent of Object.values(entry.links || {})) {
        assert.ok(
          seen.has(parent),
          `${entry.table} points at ${parent}, which is copied later or not at all`
        );
      }
      seen.add(entry.table);
    }
  });

  await check('nothing is both cloned as setup and wiped as practice', () => {
    const setup = new Set(demo.SETUP.map((e) => e.table));
    for (const table of demo.PRACTICE) {
      assert.ok(!setup.has(table), `${table} is in both SETUP and PRACTICE`);
    }
  });

  await check("a practice venue's address can never be delivered to", () => {
    // RFC 2606 reserves .invalid precisely so it cannot resolve. A practice
    // venue that could send email would eventually send a real customer one.
    assert.ok(demo.DEMO_EMAIL_DOMAIN.endsWith('.invalid'));
  });

  // The real test of the clone: run it, then inspect where everything landed.
  await check('the clone copies a venue and rewires its ids', async () => {
    demo.forgetShapes();
    const db = world();

    // Only the three tables the fixture knows about are exercised; the rest of
    // SETUP is absent from the fake schema and skipped, which is the same path
    // a real database takes for a table a release has not added yet.
    await demo.cloneSetup(db, {
      fromEmail: LIVE.contact_email,
      toEmail: DEMO.contact_email,
    });

    const screens = db.data.epos_screens.filter((r) => r.office === DEMO.contact_email);
    const buttons = db.data.epos_screen_buttons.filter((r) => r.office === DEMO.contact_email);
    const clerks = db.data.bo_clarks.filter((r) => r.email === DEMO.contact_email);

    assert.strictEqual(screens.length, 2, 'both of the live venue’s screens are copied');
    assert.strictEqual(buttons.length, 2, 'both buttons are copied');

    // The heart of it: each copied button points at a COPIED screen.
    const copiedScreenIds = new Set(screens.map((s) => s.id));
    for (const button of buttons) {
      assert.ok(
        copiedScreenIds.has(button.screen_id),
        `button "${button.label}" points at screen ${button.screen_id}, which is not one of the copies`
      );
    }

    // And specifically not at the originals.
    for (const button of buttons) {
      assert.ok(
        ![10, 11, 90].includes(button.screen_id),
        'a copied button still points at a live screen'
      );
    }

    // Lager was on Drinks and must still be.
    const drinks = screens.find((s) => s.name === 'Drinks');
    const lager = buttons.find((b) => b.label === 'Lager');
    assert.strictEqual(lager.screen_id, drinks.id, 'Lager moved to the wrong screen');

    // Only the training account comes across.
    assert.strictEqual(clerks.length, 1, 'only training accounts are copied');
    assert.strictEqual(clerks[0].name, 'Training');

    // The other venue is untouched throughout.
    const other = db.data.epos_screens.filter((r) => r.office === OTHER.contact_email);
    assert.strictEqual(other.length, 1, 'another venue’s data was altered');
  });

  await check('cloning into a venue that is not a practice one is refused', async () => {
    demo.forgetShapes();
    const db = world();
    await assert.rejects(
      () => demo.cloneSetup(db, { fromEmail: LIVE.contact_email, toEmail: OTHER.contact_email }),
      /not a practice one/i,
      'a real venue can be overwritten by a clone'
    );
    void db;
  });

  await check('resetting a venue that is not a practice one is refused', async () => {
    demo.forgetShapes();
    const db = world();
    await assert.rejects(
      () => demo.resetDemo(db, LIVE.contact_email),
      /not a practice venue/i,
      'a live venue’s sales can be wiped by a reset'
    );
  });

  await check('a reset empties the practice data and keeps the setup', async () => {
    demo.forgetShapes();
    const db = fakeDb({
      offices: [LIVE, DEMO],
      schema: {
        epos_screens: [
          { name: 'id', extra: 'auto_increment' },
          { name: 'office' },
          { name: 'name' },
        ],
        epos_orders: [
          { name: 'id', extra: 'auto_increment' },
          { name: 'email' },
          { name: 'total' },
        ],
      },
      rows: {
        epos_screens: [{ id: 1, office: DEMO.contact_email, name: 'Drinks' }],
        epos_orders: [
          { id: 1, email: DEMO.contact_email, total: 5 },
          { id: 2, email: LIVE.contact_email, total: 9 },
        ],
      },
    });

    await demo.resetDemo(db, DEMO.contact_email);

    assert.strictEqual(
      db.data.epos_orders.filter((r) => r.email === DEMO.contact_email).length,
      0,
      'practice sales survived a reset'
    );
    assert.strictEqual(
      db.data.epos_orders.filter((r) => r.email === LIVE.contact_email).length,
      1,
      'a reset of the practice venue deleted a live sale'
    );
    assert.strictEqual(db.data.epos_screens.length, 1, 'the setup was wiped by a reset');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
