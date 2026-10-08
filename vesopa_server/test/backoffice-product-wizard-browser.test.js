/**
 * The product form in steps, in an actual browser (2026-10-01).
 *
 * "When creating a product can we copy Newbridge where it is in stages and
 * all fits on the screen instead of scrolling down." Checks that:
 *
 *   * Add product opens on step 1 of 8, with a row of steps and Continue;
 *   * Continue refuses to leave a step with a required field empty;
 *   * the Allergens step sits right before Information, as asked;
 *   * Review lists what was entered;
 *   * Save sends the new fields, and "Add to a till page" places the key;
 *   * the form fits a 1366x768 laptop without the page scrolling.
 *
 * Drives headless Chrome against a stub API: no database, no live server.
 * SKIPPED when there is no Chromium on the machine, like the other browser
 * tests. Run with PRODUCT_WIZARD_SHOTS=<dir> to also save screenshots.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const WebSocket = require('ws');
const { launch, sleep } = require('./lib/chrome');

const PUBLIC = path.join(__dirname, '..', 'public');

const ALLERGENS = [
  { code: 'celery', label: 'Celery' },
  { code: 'gluten', label: 'Cereals containing gluten' },
  { code: 'crustaceans', label: 'Crustaceans' },
  { code: 'eggs', label: 'Eggs' },
  { code: 'fish', label: 'Fish' },
  { code: 'lupin', label: 'Lupin' },
  { code: 'milk', label: 'Milk' },
  { code: 'molluscs', label: 'Molluscs' },
  { code: 'mustard', label: 'Mustard' },
  { code: 'peanuts', label: 'Peanuts' },
  { code: 'sesame', label: 'Sesame' },
  { code: 'soya', label: 'Soya' },
  { code: 'sulphites', label: 'Sulphur dioxide and sulphites' },
  { code: 'tree_nuts', label: 'Tree nuts' },
];
const DIETARY = [
  { code: 'vegetarian', label: 'Vegetarian' },
  { code: 'vegan', label: 'Vegan' },
  { code: 'gluten_free', label: 'Gluten free' },
  { code: 'dairy_free', label: 'Dairy free' },
  { code: 'halal', label: 'Halal' },
];

function startStub() {
  const state = {
    products: [
      { id: 1, pluid: 101, product_name: 'Carling Pint', department_name: 'Drink', group_name: 'Draught', price: 4.6, tax_percentage: 20,
        print_to_receipt: 1, open_price: 1, printer_routes: 'kp1' },
      { id: 2, pluid: 102, product_name: 'Chips', department_name: 'Food', group_name: 'Sides', price: 3, tax_percentage: 20 },
    ],
    created: [],
    put: null,
    placed: [],
    modifiers: [],
  };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/e2e-boot') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><meta charset="utf-8"><script>' +
          "localStorage.setItem('vesopa_token', 'stub-token');" +
          "localStorage.setItem('vesopa_user', JSON.stringify({" +
          "id: 1, name: 'Store Manager', role: 'office', officeId: 9," +
          "officeName: 'The Vesopa Kitchen', email: 'manager@vesopa.co.uk'," +
          "officeEmail: 'manager@vesopa.co.uk'}));" +
          (url.searchParams.get('theme') ? `localStorage.setItem('vesopa.theme', ${JSON.stringify(url.searchParams.get('theme'))});` : '') +
          "location.replace('/products');" +
          '</script>'
      );
    }
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const json = body ? JSON.parse(body) : {};
        const p = url.pathname;
        if (p === '/api/products' && req.method === 'GET') return send(200, state.products);
        if (p === '/api/products' && req.method === 'POST') {
          const made = { ...json, id: 50 + state.created.length, pluid: 150 + state.created.length };
          state.created.push(made);
          state.products.push(made);
          return send(201, { id: made.id, pluid: made.pluid });
        }
        const one = /^\/api\/products\/(\d+)$/.exec(p);
        if (one && req.method === 'GET') return send(200, state.products.find((x) => x.id === Number(one[1])));
        if (one && req.method === 'PUT') {
          state.put = json;
          return send(200, { ok: true });
        }
        const mods = /^\/api\/products\/(\d+)\/modifiers$/.exec(p);
        if (mods && req.method === 'PUT') {
          state.modifiers.push({ plu: Number(mods[1]), ...json });
          return send(200, { ok: true });
        }
        const place = /^\/api\/screens\/(\d+)\/place-product$/.exec(p);
        if (place) {
          state.placed.push({ screen: Number(place[1]), ...json });
          return send(200, { screen_id: Number(place[1]), name: 'Draught', already: false, row: 0, col: 3 });
        }
        if (p === '/api/departments') return send(200, [{ department_name: 'Drink' }, { department_name: 'Food' }]);
        if (p === '/api/groups') return send(200, [{ group_name: 'Draught' }, { group_name: 'Sides' }]);
        if (p === '/api/tax') return send(200, [{ percentage: 20, name: 'Standard Rate' }, { percentage: 0, name: 'Zero Rate' }]);
        if (p === '/api/modifier-groups') return send(200, [{ id: 7, name: 'Single or double', min_select: 1, max_select: 1 }]);
        if (p === '/api/print-categories') return send(200, [{ id: 3, name: 'Starters' }]);
        if (p === '/api/allergens') return send(200, { allergens: ALLERGENS, dietary: DIETARY });
        if (p === '/api/screens') {
          return send(200, [
            { id: 11, name: 'Draught', surface: 'sale', rows: 6, cols: 8, buttons: [] },
            { id: 12, name: 'Top bar', surface: 'topbar', rows: 1, cols: 10, buttons: [] },
          ]);
        }
        if (p === '/api/stock/pack-sizes') return send(200, [{ id: 1, name: 'Each', units: 1 }, { id: 2, name: '11g Keg', units: 88 }]);
        if (p === '/api/stock/suppliers') return send(200, [{ id: 4, name: 'Brakes', active: 1 }]);
        if (p === '/api/till-settings') return send(200, {});
        return send(200, req.method === 'GET' ? [] : { ok: true });
      });
    }
    const file = url.pathname === '/' || !path.extname(url.pathname) ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, url.pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  });
  const wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (s) => s.on('message', () => {}));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, wss, state })));
}

async function main() {
  console.log('Back office: the product form in steps, in a browser\n');
  const { server, wss, state } = await startStub();
  const port = server.address().port;
  const b = await launch(`http://127.0.0.1:${port}/e2e-boot`);
  if (!b) {
    console.log('  -- skipped: no Chrome or Edge on this machine\n\n0 checks run');
    wss.close();
    server.close();
    return;
  }
  const { cdp } = b;
  let passed = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      console.log(`FAIL  ${name}\n      ${e.message}`);
      process.exitCode = 1;
    }
  };
  const step = () => cdp.eval(`
    const on = document.querySelector('.wiz-steps button.on');
    return on ? on.querySelector('.wiz-num').textContent + ' ' + on.querySelector('.wiz-name').textContent : null;`);

  try {
    const ready = await cdp.until(`return !!document.getElementById('add-product');`, { tries: 100, every: 200 });
    assert.ok(ready, `the products page never drew${cdp.thrown.length ? ` — ${cdp.thrown.join(' ; ')}` : ''}`);
    await sleep(300);
    await cdp.clickOn('#add-product');
    await cdp.until(`return !!document.querySelector('.modal-wizard');`);

    await check('Add product opens on step 1 of 8, in Newbridge order with Allergens before Information', async () => {
      const names = await cdp.eval(`return [...document.querySelectorAll('.wiz-steps .wiz-name')].map((n) => n.textContent);`);
      assert.deepStrictEqual(names, [
        'Product details', 'Stock control', 'Modifiers', 'Printing',
        'Child products', 'Allergens', 'Information', 'Review',
      ]);
      assert.strictEqual(await step(), '1 Product details');
    });

    await check('Continue will not leave a step with the name empty', async () => {
      await cdp.clickOn('[data-wiz-next]');
      await sleep(150);
      assert.strictEqual(await step(), '1 Product details');
    });

    await check('the form fits a 1366x768 screen: the dialog is inside the window', async () => {
      const box = await cdp.eval(`
        const r = document.querySelector('.modal-wizard').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: innerHeight };`);
      assert.ok(box.top >= 0 && box.bottom <= box.h, JSON.stringify(box));
    });

    await check('Generate makes a valid in-store EAN-13', async () => {
      await cdp.clickOn('[data-make-ean]');
      const code = await cdp.eval(`return document.querySelector('[name=barcode]').value;`);
      assert.match(code, /^2\d{12}$/);
      const d = code.split('').map(Number);
      const sum = d.slice(0, 12).reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
      assert.strictEqual((10 - (sum % 10)) % 10, d[12], 'check digit');
    });

    await cdp.eval(`
      const set = (n, v) => { const el = document.querySelector('[name="' + n + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      set('product_name', 'Peroni Pint');
      set('short_description', 'Crisp Italian lager');
      set('department_name', 'Drink');
      set('group_name', 'Draught');
      set('price', '5.20');
      return true;`);

    await check('with a name, Continue moves through every step to Review', async () => {
      const seen = [];
      for (let i = 0; i < 7; i += 1) {
        await cdp.clickOn('[data-wiz-next]');
        await sleep(80);
        seen.push(await step());
        if (process.env.PRODUCT_WIZARD_SHOTS) await b.shot?.(path.join(process.env.PRODUCT_WIZARD_SHOTS, `step-${i + 2}.png`));
        if (i === 4) {
          // Allergens: tick Milk, trace of Peanuts, Vegetarian.
          await cdp.eval(`
            document.querySelector('[name=allergens][value=milk]').click();
            document.querySelector('[name=may_contain][value=peanuts]').click();
            document.querySelector('[name=dietary][value=vegetarian]').click();
            return true;`);
        }
        if (i === 5) {
          await cdp.eval(`
            const ed = document.querySelector('.rt-edit');
            ed.innerHTML = '<b>Brewed</b> in Rome';
            ed.dispatchEvent(new Event('input', { bubbles: true }));
            const c = document.querySelector('[name=calories]'); c.value = '210';
            const s = document.querySelector('[name=_place_screen]'); s.value = '11';
            return true;`);
        }
      }
      assert.strictEqual(seen[seen.length - 1], '8 Review');
      assert.ok(seen.includes('6 Allergens') && seen.indexOf('6 Allergens') < seen.indexOf('7 Information'));
    });

    await check('Review shows what was entered, and only sale pages are offered', async () => {
      const text = await cdp.eval(`return document.querySelector('.wiz-summary').textContent.replace(/\\s+/g, ' ');`);
      for (const want of ['Peroni Pint', 'Crisp Italian lager', 'Milk', 'Peanuts', 'Vegetarian', 'Brewed in Rome', '210', 'Draught']) {
        assert.ok(text.includes(want), `Review is missing "${want}": ${text.slice(0, 400)}`);
      }
      const pages = await cdp.eval(`return [...document.querySelectorAll('[name=_place_screen] option')].map((o) => o.textContent);`);
      assert.deepStrictEqual(pages, ['Not now', 'Draught']);
    });

    await check('Save sends the new fields and puts the key on the chosen page', async () => {
      await cdp.clickOn('.wiz-save');
      const made = await cdp.until(`return document.querySelector('.modal-wizard') ? null : true;`);
      assert.ok(made, 'the dialog did not close');
      const p = state.created[0];
      assert.ok(p, 'nothing was posted');
      assert.strictEqual(p.product_name, 'Peroni Pint');
      assert.strictEqual(p.short_description, 'Crisp Italian lager');
      assert.ok([].concat(p.allergens).includes('milk'));
      assert.ok([].concat(p.may_contain).includes('peanuts'));
      assert.ok([].concat(p.dietary).includes('vegetarian'));
      assert.match(p.description, /<b>Brewed<\/b> in Rome/);
      assert.strictEqual(String(p.calories), '210');
      assert.strictEqual(p._place_screen, undefined, 'the page choice leaked into the product');
      assert.deepStrictEqual(state.placed, [{ screen: 11, plu_id: 150 }]);
    });

    await check('Edit opens the same steps, and any step can be pressed straight to', async () => {
      await cdp.eval(`document.querySelector('[data-edit-product="1"]')?.click(); return true;`);
      const open = await cdp.until(`return !!document.querySelector('.modal-wizard');`);
      assert.ok(open, 'edit did not open the stepped form');
      await cdp.eval(`document.querySelectorAll('.wiz-steps button')[5].click(); return true;`);
      assert.strictEqual(await step(), '6 Allergens');
    });

    // 2026-10-08, Pontardawe: "it's not remembering the setting chosen if we
    // edit one thing". A box that was already ticked, and left alone, saved
    // as OFF -- so editing the price took "Show on the customer receipt" off.
    await check('editing one thing keeps every tick box that was already ticked', async () => {
      await cdp.eval(`
        document.querySelectorAll('.wiz-steps button')[0].click();
        const el = document.querySelector('[name=price]');
        el.value = '4.80';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;`);
      await cdp.clickOn('.wiz-save');
      const saved = await cdp.until(`return document.querySelector('.modal-wizard') ? null : true;`);
      assert.ok(saved, 'the dialog did not close');
      const put = state.put;
      assert.ok(put, 'nothing was saved');
      assert.strictEqual(String(put.price), '4.80');
      assert.strictEqual(String(put.print_to_receipt), '1', 'Show on the customer receipt was lost');
      assert.strictEqual(String(put.open_price), '1', 'Ask the price at the till was lost');
      assert.strictEqual(String(put.is_weighted), '0', 'an unticked box stays unticked');
      assert.deepStrictEqual([].concat(put.printer_routes), ['kp1']);
    });
  } finally {
    await b.close();
    wss.close();
    server.close();
  }
  console.log(`\n${passed} checks passed`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { startStub };
