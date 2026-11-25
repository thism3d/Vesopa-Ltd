/**
 * Terminals in the reports (Nicky, Pontardawe RFC, 2026-11-24): "If there are
 * 2 terminals It should be just Terminal 1 & Terminal 2, and an option rename
 * them. Ability to name Vesopa Go Terminals ... or an option to hide from
 * reporting."
 *
 *   node test/report-terminals.test.js
 */
const assert = require('assert');
const { terminalsInUse } = require('../src/reports');

function pool({ names = [] } = {}) {
  return {
    async query(sql) {
      if (/ALTER TABLE bo_till_names/.test(sql)) {
        const e = new Error('dup'); e.code = 'ER_DUP_FIELDNAME'; throw e;
      }
      if (/FROM epos_orders o\s+WHERE o.email = \?\s+GROUP BY o.terminal/.test(sql)) {
        return [[
          { terminal: 'DESKTOP-33SR5PJ', sales: 2901 },
          { terminal: 'DESKTOP-K97NU7G', sales: 2419 },
          { terminal: 'Nickys-PC', sales: 2 },
          { terminal: 'OLD-BAR-PC', sales: 37 },
          { terminal: 'Android (Vesopa Go) B2AF', sales: 3 },
          { terminal: null, sales: 4 },
        ]];
      }
      if (/FROM bo_terminals/.test(sql)) {
        return [[
          { kind: 'till', terminal_no: 1, name: null, device_name: 'DESKTOP-33SR5PJ', revoked_at: null },
          { kind: 'till', terminal_no: 2, name: null, device_name: 'DESKTOP-K97NU7G', revoked_at: null },
          // Terminal 1's old PC, replaced: its sales are Terminal 1's too.
          { kind: 'till', terminal_no: 1, name: null, device_name: 'OLD-BAR-PC', revoked_at: new Date() },
          { kind: 'go', terminal_no: 3, name: null, device_name: 'Android (Vesopa Go) B2AF', revoked_at: null },
        ]];
      }
      if (/FROM bo_till_names/.test(sql)) return [names];
      return [[]];
    },
  };
}

(async () => {
  const list = await terminalsInUse({ pool: pool(), office: 'v@example.com' });
  const labels = list.map((t) => t.label);
  assert.deepStrictEqual(labels, ['Nickys-PC', 'Terminal 1', 'Terminal 2', 'Vesopa Go 3', 'Unknown terminal']);
  const t1 = list.find((t) => t.label === 'Terminal 1');
  assert.strictEqual(t1.sales, 2901 + 37, 'both PCs that were Terminal 1');
  assert.strictEqual(t1.value, 'named:Terminal 1');
  assert.strictEqual(list.find((t) => t.label === 'Terminal 2').value, 'DESKTOP-K97NU7G');
  console.log('  ok  terminals are Terminal 1, Terminal 2 and Vesopa Go 3, not computer names');

  const renamed = await terminalsInUse({
    pool: pool({ names: [
      { terminal: 'DESKTOP-33SR5PJ', label: 'Bar', hidden: 0 },
      { terminal: 'Android (Vesopa Go) B2AF', label: null, hidden: 1 },
    ] }),
    office: 'v@example.com',
  });
  const r = renamed.map((t) => t.label);
  assert.ok(r.includes('Bar'), 'a name given in Sites wins');
  assert.ok(!r.includes('Vesopa Go 3'), 'a hidden one is not offered');
  console.log('  ok  renamed in Sites, and a Vesopa Go handset hidden from reports');
  console.log('2 passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
