/**
 * A short reseller balance refuses the sale; a pending registration is not
 * served. The two halves of the wintk999.com fix (2026-09-22).
 *
 *     node --test test/registrar-funds.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const stub = (rel, exports) => {
  const file = path.join(__dirname, '..', 'src', rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const state = { balance: { ok: true, amount: 12.05 }, live: true, connected: true, balanceThrows: false, logged: [] };
stub('db.js', {
  one: async (_sql, [tld]) => ({ com: { cost_pence: 891 }, uk: { cost_pence: 450 } }[tld] || null),
  logActivity: async (row) => { state.logged.push(row); },
});
stub('currency.js', { resolve: async () => ({ code: 'USD', is_base: false, rate: 1.3 }) });
stub(path.join('integrations', 'domainnameapi.js'), {
  splitDomain: (d) => ({ tld: String(d).split('.').slice(1).join('.') }),
  isConnected: () => state.connected,
  isLive: () => state.live,
  balance: async () => { if (state.balanceThrows) throw new Error('timeout'); return state.balance; },
});

const funds = require('../src/registrar-funds');
const dom = (domain, years = 1, kind = 'domain') => ({ kind, domain, years });

test('a basket with no domain is never held up', async () => {
  assert.deepEqual(await funds.check([{ kind: 'hosting' }]), { ok: true });
});

test('a .com passes when the balance covers cost + margin', async () => {
  state.balance = { ok: true, amount: 12.05 }; // £8.91 × 1.3 × 1.1 ≈ $12.74 → short!
  const r = await funds.check([dom('wintk999.com')]);
  assert.equal(r.ok, false, '$12.05 does not cover $12.74');
  state.balance = { ok: true, amount: 20 };
  assert.equal((await funds.check([dom('wintk999.com')])).ok, true);
});

test('the wintk999.com case: a near-empty balance refuses with the customer message', async () => {
  state.balance = { ok: true, amount: 3.2 };
  const r = await funds.check([dom('wintk999.com')]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient reseller balance');
  assert.match(r.message, /nothing has been charged/);
  assert.ok(r.needUsd > r.haveUsd);
});

test('every year of a multi-year registration is paid up front', async () => {
  state.balance = { ok: true, amount: 30 };
  assert.equal((await funds.check([dom('a.com', 1)])).ok, true);
  assert.equal((await funds.check([dom('a.com', 3)])).ok, false, '3 × $12.74 > $30');
});

test('two domains in one basket are added together', async () => {
  state.balance = { ok: true, amount: 15 };
  assert.equal((await funds.check([dom('a.com'), dom('b.com')])).ok, false);
});

test('fails closed when the balance cannot be read', async () => {
  state.balanceThrows = true;
  const r = await funds.check([dom('a.com')]);
  state.balanceThrows = false;
  assert.equal(r.ok, false);
  assert.match(r.reason, /unavailable/);
  state.balance = { ok: false };
  assert.equal((await funds.check([dom('a.com')])).ok, false);
});

test('not live (mock or sandbox): no real money, no check', async () => {
  state.balance = { ok: true, amount: 0 };
  state.live = false;
  assert.equal((await funds.check([dom('a.com')])).ok, true);
  state.live = true;
});

test('a refusal is logged where the admin sees it, with the top-up amount', async () => {
  state.logged = [];
  await funds.logRefusal({ ok: false, needUsd: 12.74, haveUsd: 3.2 }, { domains: ['wintk999.com'] });
  assert.equal(state.logged[0].action, 'registrar.balance_low');
  assert.match(state.logged[0].detail, /\$3\.2 is below the \$12\.74.*Top up/);
});

// ---- hosting must not adopt a name that was never registered ---------------

const { mayPoint } = require('../src/domain-linking');

test('a registration still pending is not served; once active it is', () => {
  assert.equal(mayPoint({ source: 'registered', status: 'pending' }), false, 'wintk999.com');
  assert.equal(mayPoint({ source: 'registered', status: 'active' }), true);
});

test('external domains are unchanged: served once their nameservers are verified', () => {
  assert.equal(mayPoint({ source: 'external', status: 'pending', ns_verified_at: null }), false);
  assert.equal(mayPoint({ source: 'external', status: 'active', ns_verified_at: new Date() }), true);
});
