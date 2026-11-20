/**
 * Google Wallet state for the club app (owner, 2026-11-20): Google's save and
 * delete callbacks decide "Added to Google Wallet"; a save links the member's
 * Google account; the app can link one itself.
 *
 *   node --test test/wallet-google-state.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/wallet_google_state');

/** Just enough of MySQL for these three tables. */
function fakePool() {
  const passes = [{ office: 'info@loughorrfc.site', kind: 'loyalty', subject_id: '42', object_id: 'iss.com.loughorrfc.loyalty.abc' }];
  const state = new Map();
  const links = new Map();
  const q = async (sql, args = []) => {
    if (/^CREATE TABLE/.test(sql.trim())) return [[]];
    if (/INSERT INTO epos_wallet_google_state/.test(sql)) { state.set(args[0], args[1]); return [{}]; }
    if (/SELECT office, subject_id FROM epos_wallet_passes/.test(sql)) return [passes.filter((p) => p.object_id === args[0])];
    if (/INSERT INTO epos_loyalty_google_links \(office, customer_id, linked_at\)/.test(sql)) {
      const k = `${args[0]}|${args[1]}`; if (!links.has(k)) links.set(k, { email: null }); return [{}];
    }
    if (/INSERT INTO epos_loyalty_google_links/.test(sql)) { links.set(`${args[0]}|${args[1]}`, { email: args[3] }); return [{}]; }
    if (/DELETE FROM epos_loyalty_google_links/.test(sql)) { links.delete(`${args[0]}|${args[1]}`); return [{}]; }
    if (/SELECT email FROM epos_loyalty_google_links/.test(sql)) { const l = links.get(`${args[0]}|${args[1]}`); return [l ? [l] : []]; }
    if (/JOIN epos_wallet_google_state/.test(sql)) {
      const p = passes.find((x) => x.office === args[0] && x.subject_id === args[1]);
      return [p && state.has(p.object_id) ? [{ saved: state.get(p.object_id) }] : []];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query: q, execute: q };
}

test('saved in Google Wallet, then deleted: the app sees it, and the account counts as linked', async () => {
  S._reset();
  const pool = fakePool();
  const office = 'info@loughorrfc.site';
  assert.deepEqual(await S.status(pool, office, '42'), { linked: false, email: null, saved: false });
  await S.recordEvent(pool, { objectId: 'iss.com.loughorrfc.loyalty.abc', eventType: 'save' });
  assert.deepEqual(await S.status(pool, office, '42'), { linked: true, email: null, saved: true });
  await S.recordEvent(pool, { objectId: 'iss.com.loughorrfc.loyalty.abc', eventType: 'del' });
  assert.equal((await S.status(pool, office, '42')).saved, false, 'deleted: the button comes back');
});

test('linking in the app keeps the address; unlinking forgets it', async () => {
  S._reset();
  const pool = fakePool();
  const office = 'info@loughorrfc.site';
  await S.link(pool, office, '42', { sub: '1234', email: 'member@gmail.com' });
  assert.deepEqual(await S.status(pool, office, '42'), { linked: true, email: 'member@gmail.com', saved: false });
  await S.unlink(pool, office, '42');
  assert.equal((await S.status(pool, office, '42')).linked, false);
});
