/**
 * Drive Vesopa Express against the running server and the Dojo sandbox, then
 * put everything back.
 *
 *     node tool/verify-express-live.js            the whole check, cleaned up
 *     node tool/verify-express-live.js --hold     leave a kiosk switched on for
 *                                                 the test venue and write its
 *                                                 token to tmp/, for driving the
 *                                                 real app against live
 *     node tool/verify-express-live.js --release  undo --hold, or finish a check
 *                                                 that died half way
 *     node tool/verify-express-live.js --cleanup --settings-were-absent
 *                                                 find what a dead run left by
 *                                                 who made it, and remove it
 *
 * WHY THIS EXISTS WHEN THERE IS ALREADY test/express.test.js
 *
 * That one runs against a scratch database and a pretend Dojo. It proves the
 * decisions. It proves nothing about whether the migration landed on live,
 * whether the routes are mounted behind nginx, whether the sandbox card
 * machine really goes InitiateRequested -> SignatureVerificationRequired ->
 * Captured, or whether the sale really lands in the rows the Z report reads.
 * Every one of those has been the real fault on this platform before.
 *
 * SAFETY -- the same rules as verify-gym-live.js
 *
 *   * It touches the test venue only (manager@vesopa.co.uk). Every other row in
 *     this database belongs to a paying customer.
 *   * It remembers the venue's Express settings, today's number counter and
 *     the stock of anything it sells before it starts, and puts them back.
 *   * It deletes only rows it CREATED, by the ids it recorded -- never rows it
 *     merely matched.
 *   * It never prints a secret. Tokens are minted in this process from the
 *     server's own config; only their effects are shown.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const { businessDate } = require('../src/express_kiosk');

const OFFICE = 'manager@vesopa.co.uk';
const BASE = process.env.VERIFY_BASE || 'https://backoffice.vesopaepos.com';
const HOLD_FILE = path.join(__dirname, '..', 'tmp', 'express-hold.json');
const TOKEN_FILE = path.join(__dirname, '..', 'tmp', 'express-kiosk-token.txt');
const CHECK_FILE = path.join(__dirname, '..', 'tmp', 'express-check.json');

const mode = process.argv.includes('--hold') ? 'hold'
  : process.argv.includes('--release') ? 'release'
  : process.argv.includes('--cleanup') ? 'cleanup' : 'check';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set in the environment.');

  const db = mysql.createPool({
    connectionLimit: 3,
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASS || process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'vesopa_eposdb',
  });

  const [[office]] = await db.query('SELECT id, name FROM offices WHERE contact_email = ?', [OFFICE]);
  if (!office) throw new Error('The test venue is not on this server.');
  const officeToken = jwt.sign({ email: OFFICE, officeId: office.id, role: 'office' }, secret, {
    expiresIn: '20m',
  });

  const call = async (p, { method = 'GET', body, token = officeToken } = {}) => {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  };

  // ---- Everything this is about to change, remembered ---------------------
  async function snapshot() {
    const [[settings]] = await db.query('SELECT * FROM epos_express_settings WHERE office = ?', [OFFICE]);
    const [[counter]] = await db.query(
      'SELECT last_number FROM epos_express_counters WHERE office = ? AND business_date = ?',
      [OFFICE, businessDate()]
    );
    return { settings: settings || null, counter: counter ? counter.last_number : null, day: businessDate() };
  }

  async function restore(state) {
    const kiosks = state.kiosks || [];
    let removed = { sales: 0, tickets: 0, queued: 0, orders: 0, webhooks: 0 };
    if (kiosks.length) {
      const holes = kiosks.map(() => '?').join(',');
      const [orders] = await db.query(
        'SELECT id, sale_id, ticket_id, dinein_order_id, dojo_intent_id FROM epos_express_orders WHERE kiosk_id IN (' + holes + ')',
        kiosks
      );
      const intents = orders.map((o) => o.dojo_intent_id).filter(Boolean);
      if (intents.length) {
        const [w] = await db.execute(
          'DELETE FROM dojo_webhook_events WHERE payment_intent_id IN (' + intents.map(() => '?').join(',') + ')',
          intents
        );
        removed.webhooks = w.affectedRows;
      }
      for (const o of orders) {
        if (o.sale_id) {
          // Put back the stock the sale took, then the sale. Lines and
          // payments go with it (ON DELETE CASCADE).
          const [lines] = await db.query(
            'SELECT plu_id, quantity, is_modifier FROM epos_order_lines WHERE order_id = ?',
            [o.sale_id]
          );
          for (const l of lines) {
            if (Number(l.is_modifier)) continue;
            await db.execute(
              'UPDATE bo_products SET stock_quantity = stock_quantity + ?' +
                ' WHERE email = ? AND pluid = ? AND stock_quantity IS NOT NULL',
              [l.quantity, OFFICE, l.plu_id]
            );
          }
          const [r] = await db.execute('DELETE FROM epos_orders WHERE id = ? AND email = ?', [o.sale_id, OFFICE]);
          removed.sales += r.affectedRows;
        }
        if (o.ticket_id) {
          const [r] = await db.execute('DELETE FROM epos_kitchen_tickets WHERE id = ? AND office = ?', [o.ticket_id, OFFICE]);
          removed.tickets += r.affectedRows;
        }
        if (o.dinein_order_id) {
          const [r] = await db.execute('DELETE FROM dinein_orders WHERE id = ? AND office_id = ?', [o.dinein_order_id, office.id]);
          removed.queued += r.affectedRows;
        }
      }
      const [r] = await db.execute('DELETE FROM epos_express_orders WHERE kiosk_id IN (' + holes + ')', kiosks);
      removed.orders = r.affectedRows;
      await db.execute('DELETE FROM epos_express_kiosks WHERE id IN (' + holes + ') AND office = ?', [...kiosks, OFFICE]);
    }

    if (state.counter === null || state.counter === undefined) {
      await db.execute('DELETE FROM epos_express_counters WHERE office = ? AND business_date = ?', [OFFICE, state.day]);
    } else {
      await db.execute(
        'UPDATE epos_express_counters SET last_number = ? WHERE office = ? AND business_date = ?',
        [state.counter, OFFICE, state.day]
      );
    }

    if (state.settings) {
      const cols = Object.keys(state.settings).filter((c) => c !== 'office' && c !== 'updated_at');
      await db.execute(
        'UPDATE epos_express_settings SET ' + cols.map((c) => c + ' = ?').join(', ') + ' WHERE office = ?',
        [...cols.map((c) => state.settings[c]), OFFICE]
      );
    } else {
      await db.execute('DELETE FROM epos_express_settings WHERE office = ?', [OFFICE]);
    }

    for (const id of state.items || []) await db.execute('DELETE FROM dinein_items WHERE id = ? AND office_id = ?', [id, office.id]);
    for (const id of state.sections || []) await db.execute('DELETE FROM dinein_sections WHERE id = ? AND office_id = ?', [id, office.id]);
    return removed;
  }

  /** A dish to sell: one the venue has, or one made for the run. */
  async function ensureDish(state) {
    const [[dish]] = await db.query(
      'SELECT i.id FROM dinein_items i' +
        '  JOIN dinein_sections s ON s.id = i.section_id' +
        '  JOIN bo_products p ON p.pluid = i.plu_id AND p.email = ?' +
        ' WHERE i.office_id = ? AND i.available = 1 AND s.active = 1 AND p.price > 0' +
        ' ORDER BY i.sort_order, i.id LIMIT 1',
      [OFFICE, office.id]
    );
    if (dish) return dish.id;
    const [[product]] = await db.query(
      'SELECT pluid FROM bo_products WHERE email = ? AND price > 0 AND is_modifier = 0 ORDER BY pluid LIMIT 1',
      [OFFICE]
    );
    if (!product) throw new Error('The test venue has no product with a price to sell.');
    const [section] = await db.execute(
      "INSERT INTO dinein_sections (office_id, name, sort_order, active) VALUES (?, 'Express live check', 999, 1)",
      [office.id]
    );
    state.sections.push(section.insertId);
    const [item] = await db.execute(
      'INSERT INTO dinein_items (section_id, office_id, plu_id, available, sort_order) VALUES (?, ?, ?, 1, 0)',
      [section.insertId, office.id, product.pluid]
    );
    state.items.push(item.insertId);
    return item.insertId;
  }

  async function newKiosk(state, name) {
    const id = crypto.randomUUID();
    await db.execute(
      'INSERT INTO epos_express_kiosks (id, office, name, commissioned_by) VALUES (?, ?, ?, ?)',
      [id, OFFICE, name, 'verify-express-live']
    );
    state.kiosks.push(id);
    const token = jwt.sign(
      { scope: 'express', office: OFFICE, officeId: office.id, kiosk: id, commissionedBy: 'verify-express-live' },
      secret,
      { expiresIn: mode === 'hold' ? '8h' : '20m' }
    );
    return { id, token };
  }

  async function pairSandboxMachine(kioskId) {
    const res = await call('/api/express/terminals');
    assert(res.status === 200, `terminals answered ${res.status}`);
    const machine = (res.body.terminals || []).find((t) => String(t.status).toLowerCase() === 'available')
      || (res.body.terminals || [])[0];
    assert(machine, 'Dojo listed no card machines' + (res.body.error ? ': ' + res.body.error : ''));
    const put = await call('/api/express/kiosks/' + kioskId, { method: 'PUT', body: { dojo_terminal_id: machine.id } });
    assert(put.status === 200, `pairing answered ${put.status}`);
    return machine;
  }

  // ---- --release ------------------------------------------------------------
  if (mode === 'release') {
    const file = fs.existsSync(HOLD_FILE) ? HOLD_FILE : CHECK_FILE;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const removed = await restore(state);
    fs.rmSync(file, { force: true });
    fs.rmSync(TOKEN_FILE, { force: true });
    console.log('released:', JSON.stringify(removed));
    await db.end();
    return;
  }

  // ---- --cleanup --------------------------------------------------------------
  //
  // For a run that died before it could write its state down. Everything is
  // found by who made it -- the kiosks this tool commissions say so -- and
  // never by what it happens to match. The settings row and today's counter are
  // only removed when the caller states they did not exist before the run (as
  // on the day the tables were created); otherwise they are left alone and the
  // caller is told.
  if (mode === 'cleanup') {
    const [ks] = await db.query(
      "SELECT id FROM epos_express_kiosks WHERE office = ? AND commissioned_by = 'verify-express-live'",
      [OFFICE]
    );
    const [secs] = await db.query(
      "SELECT id FROM dinein_sections WHERE office_id = ? AND name = 'Express live check'",
      [office.id]
    );
    const items = [];
    for (const s of secs) {
      const [its] = await db.query('SELECT id FROM dinein_items WHERE section_id = ? AND office_id = ?', [s.id, office.id]);
      items.push(...its.map((i) => i.id));
    }
    const absent = process.argv.includes('--settings-were-absent');
    const now = await snapshot();
    const state = {
      kiosks: ks.map((k) => k.id),
      sections: secs.map((s) => s.id),
      items,
      day: now.day,
      settings: absent ? null : now.settings,
      counter: absent ? null : now.counter,
    };
    const removed = await restore(state);
    console.log(`cleanup: ${state.kiosks.length} kiosks, ${items.length} menu items;`, JSON.stringify(removed));
    if (!absent) console.log('settings and counter left as they are (no --settings-were-absent)');
    fs.rmSync(CHECK_FILE, { force: true });
    await db.end();
    return;
  }

  const state = { ...(await snapshot()), kiosks: [], sections: [], items: [] };
  const save = () => {
    fs.mkdirSync(path.dirname(CHECK_FILE), { recursive: true });
    fs.writeFileSync(CHECK_FILE, JSON.stringify(state), { mode: 0o600 });
  };

  // ---- --hold -----------------------------------------------------------------
  if (mode === 'hold') {
    fs.mkdirSync(path.dirname(HOLD_FILE), { recursive: true });
    fs.writeFileSync(HOLD_FILE, JSON.stringify(state), { mode: 0o600 });
    const on = await call('/api/express/settings', {
      method: 'PUT',
      body: { enabled: true, pay_card: true, pay_counter: true, demo_mode: false, ask_name: true, board_enabled: true },
    });
    assert(on.status === 200, `settings answered ${on.status}: ${JSON.stringify(on.body)}`);
    await ensureDish(state);
    const kiosk = await newKiosk(state, 'Screenshot kiosk');
    const machine = await pairSandboxMachine(kiosk.id);
    fs.writeFileSync(HOLD_FILE, JSON.stringify(state), { mode: 0o600 });
    fs.writeFileSync(TOKEN_FILE, kiosk.token, { mode: 0o600 });
    console.log(`holding: kiosk ${kiosk.id} paired with ${machine.tid || machine.id}; token in tmp/ (8h)`);
    console.log('board:', on.body.board_url ? 'yes' : 'no');
    await db.end();
    return;
  }

  // ---- The check ------------------------------------------------------------
  console.log('\nVesopa Express, on the live server\n');
  try {
    await check('it answers the test venue, and is off until switched on', async () => {
      const res = await call('/api/express/settings');
      assert(res.status === 200, `settings answered ${res.status}`);
      assert(!('exit_hash' in res.body) && !('dojo_key_enc' in res.body), 'a secret came back');
      assert(res.body.dojo_key_source !== 'none', 'the server has no Dojo key for kiosks');
    });

    await check('the back office switches it on', async () => {
      const res = await call('/api/express/settings', {
        method: 'PUT',
        body: {
          enabled: true, pay_card: true, pay_counter: true, demo_mode: false, ask_name: false,
          notify_kitchen: true, notify_till: true, board_enabled: true,
        },
      });
      assert(res.status === 200, `PUT answered ${res.status}: ${JSON.stringify(res.body)}`);
      assert(Number(res.body.enabled) === 1, 'it did not come on');
    });

    save();
    const dishId = await ensureDish(state);
    const kiosk = await newKiosk(state, 'Live check kiosk');
    save();
    const as = { token: kiosk.token };

    await check('a kiosk token opens the kiosk and not the back office', async () => {
      const cfg = await call('/api/express/kiosk/config', as);
      assert(cfg.status === 200 && cfg.body.enabled === true, `config answered ${cfg.status}`);
      const bo = await call('/api/express/settings', as);
      assert(bo.status === 401, `the back office answered a kiosk token with ${bo.status}`);
    });

    await check('the menu is served, priced from the catalogue', async () => {
      const res = await call('/api/express/kiosk/menu', as);
      assert(res.status === 200, `menu answered ${res.status}`);
      const dish = res.body.sections.flatMap((s) => s.items).find((i) => i.id === dishId);
      assert(dish && dish.price_minor > 0, 'the dish is not on the menu with a price');
    });

    let machine = null;
    await check('Dojo lists a sandbox card machine and it pairs with the kiosk', async () => {
      machine = await pairSandboxMachine(kiosk.id);
      const cfg = await call('/api/express/kiosk/config', as);
      assert(cfg.body.payments.card === true, 'card payments did not come on');
    });

    let paid = null;
    await check('a card order is taken on the sandbox machine and becomes one sale', async () => {
      const placed = await call('/api/express/kiosk/orders', {
        ...as,
        method: 'POST',
        body: {
          client_ref: crypto.randomUUID(), order_type: 'take_away', payment: 'card',
          lines: [{ item_id: dishId, qty: 2 }],
        },
      });
      assert(placed.status === 201, `order answered ${placed.status}: ${JSON.stringify(placed.body)}`);
      const stages = [placed.body.stage];
      let view = placed.body;
      for (let i = 0; i < 60 && view.stage !== 'paid'; i++) {
        await sleep(2000);
        view = (await call('/api/express/kiosk/orders/' + placed.body.public_id, as)).body;
        if (stages[stages.length - 1] !== view.stage) stages.push(view.stage);
        if (['declined', 'unavailable', 'uncertain', 'cancelled'].includes(view.stage)) break;
      }
      console.log('        stages seen:', stages.join(' -> '));
      assert(view.stage === 'paid', `the payment ended ${view.stage}: ${view.message || ''}`);
      const [[row]] = await db.query('SELECT * FROM epos_express_orders WHERE public_id = ?', [view.public_id]);
      const [[sale]] = await db.query('SELECT * FROM epos_orders WHERE id = ?', [row.sale_id]);
      assert(sale && sale.email === OFFICE, 'no sale in epos_orders');
      assert(sale.total_minor === row.total_minor, 'the sale and the order disagree on the total');
      assert(sale.terminal === 'Live check kiosk', `terminal is ${sale.terminal}`);
      const [pays] = await db.query('SELECT * FROM epos_payments WHERE order_id = ?', [sale.id]);
      assert(pays.length === 1, `${pays.length} payments`);
      assert(pays[0].reference === row.dojo_intent_id, 'the payment is not linked to the Dojo intent');
      assert(pays[0].method === 'card' && pays[0].entry_mode === 'terminal', 'wrong method or entry mode');
      paid = row;
    });

    await check('the collection board shows the number', async () => {
      const settings = (await call('/api/express/settings')).body;
      const token = String(settings.board_url || '').split('/').pop();
      const res = await call('/express/board/' + token + '/data', { token: null });
      assert(res.status === 200, `board answered ${res.status}`);
      assert(paid, 'no paid order to look for');
      assert([...res.body.preparing, ...res.body.ready].includes(paid.number), JSON.stringify(res.body));
      const page = await fetch(BASE + '/express/board/' + token);
      assert(page.status === 200, `the board page answered ${page.status}`);
    });

    await check('pay at the counter goes to the till queue, unpaid', async () => {
      const res = await call('/api/express/kiosk/orders', {
        ...as,
        method: 'POST',
        body: { client_ref: crypto.randomUUID(), order_type: 'eat_in', payment: 'counter', lines: [{ item_id: dishId, qty: 1 }] },
      });
      assert(res.status === 201 && res.body.status === 'counter', `answered ${res.status} ${res.body.status}`);
      const [[row]] = await db.query('SELECT dinein_order_id, sale_id FROM epos_express_orders WHERE public_id = ?', [res.body.public_id]);
      assert(row.dinein_order_id && !row.sale_id, 'it is not in the till queue, or it became a sale');
    });

    await check('cancelling before a card is presented leaves no sale', async () => {
      const res = await call('/api/express/kiosk/orders', {
        ...as,
        method: 'POST',
        body: { client_ref: crypto.randomUUID(), order_type: 'take_away', payment: 'card', lines: [{ item_id: dishId, qty: 1 }] },
      });
      const cancelled = await call('/api/express/kiosk/orders/' + res.body.public_id + '/cancel', { ...as, method: 'POST' });
      const [[row]] = await db.query('SELECT status, sale_id FROM epos_express_orders WHERE public_id = ?', [res.body.public_id]);
      // The sandbox machine can be quick. Either it was cancelled with no
      // sale, or it had already been paid and there is exactly one.
      assert(
        (row.status === 'cancelled' && !row.sale_id) || (row.status === 'paid' && row.sale_id),
        `ended ${row.status} (cancel answered ${cancelled.status})`
      );
    });

    await check('demo mode takes no money', async () => {
      await call('/api/express/settings', { method: 'PUT', body: { demo_mode: true } });
      const res = await call('/api/express/kiosk/orders', {
        ...as,
        method: 'POST',
        body: { client_ref: crypto.randomUUID(), order_type: 'take_away', payment: 'card', lines: [{ item_id: dishId, qty: 1 }] },
      });
      await call('/api/express/settings', { method: 'PUT', body: { demo_mode: false } });
      assert(res.body.status === 'demo', `status ${res.body.status}`);
    });

    await check('switched off: the kiosk is told and orders are refused', async () => {
      await call('/api/express/settings', { method: 'PUT', body: { enabled: false } });
      const cfg = await call('/api/express/kiosk/config', as);
      assert(cfg.status === 200 && cfg.body.enabled === false, 'the kiosk was not told');
      const order = await call('/api/express/kiosk/orders', {
        ...as, method: 'POST', body: { order_type: 'take_away', payment: 'card', lines: [{ item_id: dishId, qty: 1 }] },
      });
      assert(order.status === 403, `an order was answered ${order.status}`);
    });

    await check('a removed kiosk stops at once', async () => {
      const del = await call('/api/express/kiosks/' + kiosk.id, { method: 'DELETE' });
      assert(del.status === 200, `delete answered ${del.status}`);
      const cfg = await call('/api/express/kiosk/config', as);
      assert(cfg.status === 401, `a removed kiosk got ${cfg.status}`);
    });
    if (machine) console.log(`        (sandbox machine: ${machine.tid || machine.id})`);
  } finally {
    const removed = await restore(state);
    fs.rmSync(CHECK_FILE, { force: true });
    const holes = state.kiosks.map(() => '?').join(',') || "''";
    const [[left]] = await db.query(
      'SELECT COUNT(*) AS n FROM epos_express_orders WHERE kiosk_id IN (' + holes + ')',
      state.kiosks
    );
    console.log(
      `\ncleaned up: removed ${removed.sales} sales, ${removed.tickets} kitchen tickets, ` +
        `${removed.queued} till-queue orders, ${removed.orders} kiosk orders; ` +
        `${Number(left.n)} kiosk orders left behind (should be 0); settings and counter restored`
    );
    await db.end();
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
