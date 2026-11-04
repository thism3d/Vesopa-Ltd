// A DeepSeek layout suggestion is only ever what fits the screen (src/layout_ai.js).
const assert = require('assert');
const { suggestLayout } = require('../src/layout_ai');

const screen = { name: 'Drinks', rows: 3, cols: 4 };
const buttons = [
  { id: 1, kind: 'page', row: 0, col: 3, rowSpan: 3, colSpan: 1, label: 'Food' },
  { id: 2, kind: 'product', pluId: 10, row: 2, col: 2, rowSpan: 1, colSpan: 1, fill: '#ff0000', label: 'Lager' },
  { id: 3, kind: 'product', pluId: 11, row: 0, col: 0, rowSpan: 1, colSpan: 1 },
];
const products = [
  { plu: 10, name: 'Lager', dept: 'Draught', sold28d: 400 },
  { plu: 11, name: 'Cider', dept: 'Draught', sold28d: 90 },
  { plu: 12, name: 'Cola', dept: 'Soft', sold28d: 150 },
];
const reply = (content) => async (url, init) => {
  reply.last = { url, body: JSON.parse(init.body) };
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
};

(async () => {
  await assert.rejects(suggestLayout({ screen, buttons, products, key: '' }), /not switched on/);

  const s = await suggestLayout({
    screen, buttons, products, key: 'k',
    fetchImpl: reply({
      summary: 'Best sellers first.',
      reasons: ['Lager sells most.'],
      placements: [
        { plu: 10, row: 0, col: 0 },
        { plu: 11, row: 0, col: 0 }, // same cell: dropped
        { plu: 12, row: 0, col: 3 }, // inside the page key: dropped
        { plu: 99, row: 1, col: 0 }, // not the venue's: dropped
        { plu: 12, row: 9, col: 0 }, // off the grid: dropped
        { plu: 12, row: 0, col: 1 },
        { plu: 10, row: 1, col: 1 }, // twice: dropped
      ],
    }),
  });
  assert.strictEqual(s.summary, 'Best sellers first.');
  const page = s.buttons.find((b) => b.kind === 'page');
  assert.deepStrictEqual([page.row, page.col], [0, 3], 'a page key never moves');
  const lager = s.buttons.find((b) => b.pluId === 10);
  assert.deepStrictEqual([lager.row, lager.col, lager.fill], [0, 0, '#ff0000'], 'moved, and keeps its look');
  assert.ok(s.buttons.find((b) => b.pluId === 12 && b.row === 0 && b.col === 1));
  assert.strictEqual(s.buttons.filter((b) => b.kind === 'product').length, 2);
  assert.deepStrictEqual(s.added, ['Cola']);
  assert.deepStrictEqual(s.dropped, ['Cider']);
  assert.strictEqual(reply.last.body.response_format.type, 'json_object');
  assert.strictEqual(JSON.parse(reply.last.body.messages[1].content).screen.free_cells, 9);

  await assert.rejects(
    suggestLayout({ screen, buttons, products, key: 'k', fetchImpl: reply({ placements: [{ plu: 99, row: 0, col: 0 }] }) }),
    /did not suggest anything/);
  console.log('layout-ai.test.js: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
