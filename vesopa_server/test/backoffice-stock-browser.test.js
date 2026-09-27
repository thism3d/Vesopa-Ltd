/**
 * The stock documents, in an actual browser (2026-09-24 notes from Dylan).
 *
 *   * the product box lists products the moment it is clicked -- no Enter;
 *   * a stock take is laid out by sub-department, with a heading for each;
 *   * each line shows its case size and can change it there and then;
 *   * a quantity goes in as cases, units, or both, and is saved as units.
 *
 * Drives headless Chrome against a stub API: no database, no live server.
 * SKIPPED when there is no Chromium on the machine, like the screen editor's.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const WebSocket = require('ws');
const { launch, sleep } = require('./lib/chrome');

const PUBLIC = path.join(__dirname, '..', 'public');

const PACKS = [
  { id: 1, name: 'Each', units: 1 },
  { id: 2, name: 'Pack of 24', units: 24 },
  { id: 3, name: 'Pack of 12', units: 12 },
];

function product(id, name, dept, group, packId, stock) {
  const pack = PACKS.find((k) => k.id === packId) || null;
  return {
    id,
    pluid: 100 + id,
    product_name: name,
    department_name: dept,
    group_name: group,
    pack_size_id: packId,
    pack_name: pack ? pack.name : null,
    pack_units: pack ? pack.units : null,
    stock_quantity: stock,
    level: stock === null ? 'untracked' : 'ok',
    stock_item: Boolean(packId),
    unit_cost_minor: 50,
    price: 4,
  };
}

function startStub() {
  const state = {
    products: [
      product(1, 'Carling Pint', 'Bar', 'Draught', 2, 40),
      product(2, 'Peroni Bottle', 'Bar', 'Bottles', 2, 30),
      product(3, 'Budweiser Bottle', 'Bar', 'Bottles', 3, 10),
      product(4, 'House Red Bottle', 'Wine', 'Red', 1, 6),
      product(5, 'Chips', 'Food', 'Sides', null, null),
      { ...product(6, 'Carling Half', 'Bar', 'Draught', null, null), stock_parent_pluid: 101, stock_ratio: 0.5, price: 2.4 },
    ],
    created: [],
    putProduct: null,
    patched: [],
    posted: [],
  };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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
          `location.replace(${JSON.stringify(url.searchParams.get('to') || '/stock/stock-takes')});` +
          '</script>'
      );
    }
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const json = body ? JSON.parse(body) : {};
        const p = url.pathname;
        if (p === '/api/stock/products' && req.method === 'GET') return send(200, state.products);
        if (p === '/api/stock/pack-sizes') return send(200, PACKS);
        if (p === '/api/stock/suppliers') return send(200, []);
        if (p === '/api/stock/docs' && req.method === 'GET') return send(200, []);
        if (p === '/api/stock/docs' && req.method === 'POST') {
          state.posted.push(json);
          return send(200, { id: 'doc-1', completed: Boolean(json.complete) });
        }
        const m = /^\/api\/stock\/products\/(\d+)$/.exec(p);
        if (m && req.method === 'PATCH') {
          state.patched.push({ id: Number(m[1]), ...json });
          const row = state.products.find((x) => x.id === Number(m[1]));
          if (json.stock_parent_pluid !== undefined && row) {
            Object.assign(row, { stock_parent_pluid: json.stock_parent_pluid, stock_ratio: json.stock_ratio });
          }
          if (json.pack_size_id !== undefined) {
            const pack = PACKS.find((k) => k.id === json.pack_size_id) || null;
            Object.assign(row, {
              pack_size_id: pack ? pack.id : null,
              pack_name: pack ? pack.name : null,
              pack_units: pack ? pack.units : null,
              stock_item: Boolean(pack),
            });
          }
          return send(200, { ok: true });
        }
        // The catalogue, for the product form.
        if (p === '/api/products' && req.method === 'GET') return send(200, state.products);
        if (p === '/api/products' && req.method === 'POST') {
          const made = { ...json, id: 50 + state.created.length, pluid: 150 + state.created.length };
          state.created.push(made);
          state.products.push(made);
          return send(200, made);
        }
        const one = /^\/api\/products\/(\d+)$/.exec(p);
        if (one && req.method === 'GET') return send(200, { ...state.products.find((x) => x.id === Number(one[1])), tax_percentage: 20 });
        if (one && req.method === 'PUT') {
          state.putProduct = json;
          return send(200, { ok: true });
        }
        if (p === '/api/till-settings') return send(200, {});
        if (p === '/api/allergens') return send(200, { allergens: [] });
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
  console.log('Back office: stock documents, in a browser\n');
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

  try {
    const ready = await cdp.until(`return !!document.querySelector('[data-sk-doc-new="stocktake"]');`, { tries: 100, every: 200 });
    assert.ok(ready, `the stock takes page never drew${cdp.thrown.length ? ` — ${cdp.thrown.join(' ; ')}` : ''}`);

    await cdp.clickOn('[data-sk-doc-new="stocktake"]');
    await cdp.until(`return !!document.getElementById('sk-doc-product');`);

    await check('clicking into the product box lists products, stock items first, with no Enter', async () => {
      await cdp.clickOn('#sk-doc-product');
      const list = await cdp.until(
        `const l = document.getElementById('sk-doc-suggest');
         return l && !l.hidden && [...l.querySelectorAll('[data-sk-suggest]')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim());`
      );
      assert.ok(Array.isArray(list) && list.length === 6, `expected six rows, got ${JSON.stringify(list)}`);
      assert.ok(list.slice(4).every((r) => /No case size/.test(r)) && list.slice(0, 4).every((r) => !/No case size/.test(r)), `stock items were not first: ${JSON.stringify(list)}`);
    });

    await check('typing narrows the list, and a click adds the product', async () => {
      await cdp.type('bottle');
      const n = await cdp.until(`const r = document.querySelectorAll('#sk-doc-suggest [data-sk-suggest]'); return r.length === 3 && r.length;`);
      assert.strictEqual(n, 3, 'typing "bottle" did not narrow to three');
      await cdp.clickOn('#sk-doc-suggest [data-sk-suggest="102"]');
      const lines = await cdp.until(`return skOpen.stocktake && skOpen.stocktake.lines.length === 1 && skOpen.stocktake.lines.map((l) => l.pluid);`);
      assert.deepStrictEqual(lines, [102]);
      const box = await cdp.eval(`return { value: document.getElementById('sk-doc-product').value, focused: document.activeElement.id };`);
      assert.deepStrictEqual(box, { value: '', focused: 'sk-doc-product' }, 'the box was not emptied and kept for the next product');
    });

    await check('arrow keys and Enter add the highlighted product', async () => {
      await cdp.type('carling');
      await cdp.until(`return document.querySelectorAll('#sk-doc-suggest [data-sk-suggest]').length === 1;`);
      await cdp.key('ArrowDown', 'ArrowDown', 40);
      await cdp.key('Enter', 'Enter', 13);
      const lines = await cdp.until(`return skOpen.stocktake.lines.length === 2 && skOpen.stocktake.lines.map((l) => l.pluid);`);
      assert.ok(lines && lines.includes(101), `Carling was not added: ${JSON.stringify(lines)}`);
    });

    await check('a stock take is grouped by sub-department, in shelf order', async () => {
      await cdp.eval(`skAddLines('stocktake', [103, 104]); return true;`);
      const shape = await cdp.eval(
        `return [...document.querySelectorAll('#sk-doc-lines tr')].map((tr) =>
           tr.classList.contains('sk-group-row') ? '# ' + tr.textContent.replace(/\\d+ lines?/, '').trim() : tr.querySelector('strong').textContent);`
      );
      assert.deepStrictEqual(shape, [
        '# Bar › Bottles', 'Budweiser Bottle', 'Peroni Bottle',
        '# Bar › Draught', 'Carling Pint',
        '# Wine › Red', 'House Red Bottle',
      ]);
    });

    await check('cases and units add up to units, with the difference live', async () => {
      const i = await cdp.eval(`return skOpen.stocktake.lines.findIndex((l) => l.pluid === 102);`);
      await cdp.clickOn(`[data-sk-cases="${i}"]`);
      await cdp.type('1');
      await cdp.clickOn(`[data-sk-units="${i}"]`);
      await cdp.type('6');
      const seen = await cdp.eval(
        `return { total: document.querySelector('[data-sk-total="${i}"]').textContent,
                  diff: document.querySelector('[data-sk-diff="${i}"]').textContent,
                  q: skOpen.stocktake.lines[${i}].quantity };`
      );
      assert.deepStrictEqual(seen, { total: '= 30 units', diff: '0', q: 30 });
    });

    // `SHOT=<dir>` leaves a picture of the stock take editor behind.
    if (process.env.SHOT) {
      fs.mkdirSync(process.env.SHOT, { recursive: true });
      await cdp.clickOn('#sk-doc-product');
      await sleep(200);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.SHOT, 'stock-take.png'), Buffer.from(shot.data, 'base64'));
      await cdp.key('Escape', 'Escape', 27);
    }

    await check('a product with no real case takes units only', async () => {
      const i = await cdp.eval(`return skOpen.stocktake.lines.findIndex((l) => l.pluid === 104);`);
      const disabled = await cdp.eval(`return document.querySelector('[data-sk-cases="${i}"]').disabled;`);
      assert.strictEqual(disabled, true);
    });

    await check('changing a line’s case size saves it on the product and re-values the cases typed', async () => {
      const i = await cdp.eval(`return skOpen.stocktake.lines.findIndex((l) => l.pluid === 102);`);
      await cdp.eval(
        `const s = document.querySelector('[data-sk-case="${i}"]');
         s.value = '3';
         s.dispatchEvent(new Event('change', { bubbles: true }));
         return true;`
      );
      await cdp.until(`return skProduct(102).pack_units === 12;`);
      assert.deepStrictEqual(state.patched.at(-1), { id: 2, pack_size_id: 3 });
      const j = await cdp.eval(`return skOpen.stocktake.lines.findIndex((l) => l.pluid === 102);`);
      const q = await cdp.until(`return skOpen.stocktake.lines[${j}].quantity === 18 && 18;`);
      assert.strictEqual(q, 18, '1 case + 6 of a 12 should now be 18');
    });

    await check('completing sends units, never cases', async () => {
      await cdp.eval(
        `for (const l of skOpen.stocktake.lines) if (l.quantity === '') { l.units = '5'; l.cases = ''; skLineFromBoxes(l); }
         skRenderDocEditor('stocktake', skOpen.stocktake);
         return true;`
      );
      await cdp.clickOn('[data-sk-doc-complete="stocktake"]');
      await sleep(300);
      // The confirm dialog is the app's own; press its confirm button.
      await cdp.until(`const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Complete' && x.closest('.modal')); if (b) b.click(); return !!b;`);
      const posted = await cdp.until(`return true;`).then(() => sleep(400)).then(() => state.posted.at(-1));
      assert.ok(posted, 'nothing was posted');
      assert.strictEqual(posted.complete, true);
      const byPlu = Object.fromEntries(posted.lines.map((l) => [l.pluid, l.quantity]));
      assert.deepStrictEqual(byPlu, { 101: 5, 102: 18, 103: 5, 104: 5 });
    });

    await check('an adjustment keeps typing order and takes negative cases', async () => {
      await cdp.eval(`history.pushState({}, '', '/stock/adjustments'); return true;`);
      await cdp.eval(`if (typeof go === 'function') go('stock_adjustments'); else location.href = '/stock/adjustments'; return true;`);
      const ready2 = await cdp.until(`return !!document.querySelector('[data-sk-doc-new="adjustment"]');`, { tries: 80, every: 200 });
      assert.ok(ready2, 'the adjustments page never drew');
      await cdp.clickOn('[data-sk-doc-new="adjustment"]');
      await cdp.until(`return !!document.getElementById('sk-doc-product');`);
      await cdp.eval(`skAddLines('adjustment', [104, 102]); return true;`);
      const order = await cdp.eval(`return skOpen.adjustment.lines.map((l) => l.pluid);`);
      assert.deepStrictEqual(order, [104, 102]);
      const heads = await cdp.eval(`return document.querySelectorAll('#sk-doc-lines .sk-group-row').length;`);
      assert.strictEqual(heads, 0);
      await cdp.clickOn('[data-sk-cases="1"]');
      await cdp.type('-2');
      const q = await cdp.eval(`return skOpen.adjustment.lines[1].quantity;`);
      assert.strictEqual(q, -24);
    });

    await check('the helpers split and join as a person would say it', async () => {
      const r = await cdp.eval(
        `return [skSplitQty(30, 24), skSplitQty(24, 24), skSplitQty(5, 24), skSplitQty(-30, 24), skSplitQty(7, 1),
                 skJoinQty('', '', 24), skJoinQty('2', '', 24), skJoinQty('1', '0.5', 24), skJoinQty('', '3', 1),
                 skQtyWords(30, { pack_units: 24 }), skQtyWords(48, { pack_units: 24 }), skQtyWords(3, {})];`
      );
      assert.deepStrictEqual(r, [
        { cases: 1, units: 6 }, { cases: 1, units: '' }, { cases: '', units: 5 }, { cases: -1, units: -6 }, { cases: '', units: 7 },
        '', 48, 24.5, 3,
        '1 case + 6 units', '2 cases', '3 units',
      ]);
    });

    // ---------------------------------------------------------------------
    // The product form: sections, and child products
    // ---------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/e2e-boot?to=/products` });
    await cdp.until(`return location.pathname === '/products' && typeof productRefs !== 'undefined' && productRefs.packs && productRefs.packs.length > 0;`, { tries: 100, every: 200 });
    const openEdit = async (id) => {
      await cdp.eval(`const b = document.createElement('button'); b.dataset.editProduct = '${id}'; document.body.appendChild(b); b.click(); b.remove(); return true;`);
      return cdp.until(`return !!document.querySelector('#modal-form .form-section-nav');`);
    };

    await check('the product form is in five sections, with a button for each', async () => {
      assert.ok(await openEdit(1), 'the edit form never opened');
      const nav = await cdp.eval(`return [...document.querySelectorAll('.form-section-nav [data-form-jump]')].map((b) => b.textContent);`);
      assert.deepStrictEqual(nav, ['Product details', 'Stock', 'Modifiers', 'Printing', 'Images']);
      const where = await cdp.eval(
        `const order = [...document.querySelectorAll('#modal-form [data-form-section], #modal-form [name]')].map((el) => el.dataset.formSection ? '#' + el.dataset.formSection : el.name);
         const at = (n) => order.indexOf(n);
         return { name: at('product_name') < at('#stock'), pack: at('#stock') < at('pack_size_id') && at('pack_size_id') < at('#modifiers'),
                  image: at('image_url') > at('#images'), printers: at('print_category_id') > at('#printing') && at('print_category_id') < at('#images') };`
      );
      assert.deepStrictEqual(where, { name: true, pack: true, image: true, printers: true });
    });

    await check('a section button scrolls the form to it and lights up', async () => {
      await cdp.clickOn('.form-section-nav [data-form-jump="printing"]');
      const on = await cdp.until(`const b = document.querySelector('.form-section-nav button.on'); return b && b.dataset.formJump === 'printing' && 'printing';`);
      assert.strictEqual(on, 'printing');
    });

    if (process.env.SHOT) {
      await cdp.clickOn('.form-section-nav [data-form-jump="stock"]');
      await sleep(600);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.SHOT, 'product-form.png'), Buffer.from(shot.data, 'base64'));
    }

    await check('the parent lists its existing children, with their cost from its own', async () => {
      const rows = await cdp.until(`const r = [...document.querySelectorAll('.cp-row:not(.cp-head)')]; return r.length === 1 && r.map((x) => x.textContent.replace(/\\s+/g, ' ').trim());`);
      assert.ok(rows && /Carling Half/.test(rows[0]), `expected Carling Half, got ${JSON.stringify(rows)}`);
      await cdp.eval(`const c = document.querySelector('[name="cost_price"]'); c.value = '1.20'; c.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
      const cost = await cdp.eval(`return document.querySelector('[data-cp-cost="0"]').textContent;`);
      assert.strictEqual(cost, '£0.60');
      const offered = await cdp.eval(`return [...document.querySelectorAll('[data-cp-link] option')].map((o) => o.value).filter(Boolean);`);
      assert.ok(!offered.includes('1') && !offered.includes('6'), `offered itself or its own child: ${offered}`);
    });

    await check('saving makes a new child, links an existing one and unlinks a removed one', async () => {
      await cdp.clickOn('[data-cp-new]');
      await cdp.type('Carling Third');
      await cdp.eval(`document.querySelector('[data-cp-price="1"]').focus(); return true;`);
      await cdp.type('1.80');
      await cdp.eval(`document.querySelector('[data-cp-ratio="1"]').focus(); return true;`);
      await cdp.type('0.33');
      await cdp.eval(`const s = document.querySelector('[data-cp-link]'); s.value = '5'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
      await cdp.eval(`document.querySelector('[data-cp-ratio="2"]').focus(); return true;`);
      await cdp.type('1');
      await cdp.clickOn('[data-cp-del="0"]');
      const before = state.patched.length;
      await cdp.eval(`document.querySelector('#modal-form').requestSubmit(); return true;`);
      await cdp.until(`return !document.querySelector('#modal-form');`);
      await sleep(400);
      assert.ok(state.putProduct, 'the product itself was not saved');
      assert.strictEqual(state.putProduct._children, undefined, 'the panel value was sent as a product field');
      const made = state.created.find((c) => c.product_name === 'Carling Third');
      assert.ok(made, 'the new child was not created');
      assert.strictEqual(made.department_name, 'Bar');
      assert.strictEqual(made.price, 1.8);
      const moves = state.patched.slice(before).filter((x) => x.stock_parent_pluid !== undefined).map((x) => [x.id, x.stock_parent_pluid, x.stock_ratio]);
      assert.deepStrictEqual(moves, [[6, null, null], [5, 101, 1], [made.id, 101, 0.33]]);
    });

    await check('a product that sells from another cannot have children', async () => {
      // Chips: linked to the pint by the check above.
      assert.ok(await openEdit(5), 'the edit form never opened');
      const note = await cdp.until(`const h = document.querySelector('[data-children-field]'); return h && /sells from/.test(h.textContent) && h.textContent.replace(/\\s+/g, ' ').trim();`);
      assert.ok(note && /Carling Pint/.test(note), `got ${note}`);
      await cdp.eval(`document.getElementById('modal-cancel').click(); return true;`);
    });

    await check('nothing on the page threw', async () => {
      assert.strictEqual(cdp.thrown.length, 0, cdp.thrown.join(' ; '));
    });
  } finally {
    await b.close();
    wss.close();
    server.close();
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
