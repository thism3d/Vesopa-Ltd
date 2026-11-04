/**
 * A suggested layout for a till screen, from DeepSeek (owner, 2026-11-03:
 * "use suggestions of layout using AI mainly DeepSeek, also in the back
 * office as well").
 *
 * The venue's last four weeks of sales, its products and the screen as it is
 * go to DeepSeek, which answers where each product key should go: the best
 * sellers where a hand reaches first (top left), each department kept
 * together, nothing the venue did not already sell off the screen. Every key
 * that is not a product (a page, a function, a modifier, a reserved space)
 * stays exactly where it is. The answer is checked cell by cell against the
 * grid before anybody sees it, and it is only a suggestion: the back office's
 * editor and Go's layout editor show it, and a manager applies it or not
 * through the routes that already save layouts.
 *
 *   POST /api/screens/:id/suggest          the back office (session token)
 *   POST /api/tap/layouts/suggest          Vesopa Go (terminal token), for its
 *                                          own layout of a screen on a phone
 *                                          or a tablet
 *
 * The key is DEEPSEEK_API_KEY in the server's environment. No key, no
 * suggestion: the routes say so and nothing else changes.
 */
'use strict';

const express = require('express');
const { requireTerminal } = require('./auth');

const ENDPOINT = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const PER_HOUR = 20;

class LayoutAiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** What the venue sells, with four weeks of sales against each. */
async function venueFacts(pool, office) {
  const [products] = await pool.query('SELECT * FROM bo_products WHERE email = ? LIMIT 600', [office]);
  const sales = new Map();
  try {
    const [rows] = await pool.query(
      `SELECT l.plu_id, SUM(l.quantity) AS qty
         FROM epos_order_lines l JOIN epos_orders o ON o.id = l.order_id
        WHERE o.email = ? AND o.created_at > (UTC_TIMESTAMP() - INTERVAL 28 DAY)
        GROUP BY l.plu_id`, [office]);
    for (const r of rows) sales.set(Number(r.plu_id), Math.round(Number(r.qty) || 0));
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  const dept = (p) => p.department_name || p.department || p.category_name || p.category || p.group_name || '';
  return products
    .filter((p) => p.pluid != null && String(p.product_name || '').trim() && !(Number(p.deleted) || 0))
    .map((p) => ({
      plu: Number(p.pluid),
      name: String(p.product_name).trim().slice(0, 60),
      dept: String(dept(p)).trim().slice(0, 40),
      sold28d: sales.get(Number(p.pluid)) || 0,
    }));
}

/**
 * Ask DeepSeek, and keep only what fits: inside the grid, on a cell no fixed
 * key holds, one product per cell, each product once, and a product the
 * venue has.
 */
async function suggestLayout({ screen, buttons, products, goal, fetchImpl = fetch, key = process.env.DEEPSEEK_API_KEY }) {
  if (!key) throw new LayoutAiError(503, 'Layout suggestions are not switched on for this server yet (no DeepSeek key).');
  const rows = Number(screen.rows);
  const cols = Number(screen.cols);
  const fixed = buttons.filter((b) => b.kind !== 'product');
  const taken = new Set();
  for (const b of fixed) {
    for (let r = b.row; r < b.row + (b.rowSpan || 1); r++) {
      for (let c = b.col; c < b.col + (b.colSpan || 1); c++) taken.add(`${r}:${c}`);
    }
  }
  const free = rows * cols - taken.size;
  const onScreen = buttons.filter((b) => b.kind === 'product' && b.pluId != null);
  const known = new Map(products.map((p) => [p.plu, p]));
  const prompt = {
    screen: { name: screen.name, rows, cols, free_cells: free },
    fixed_keys: fixed.map((b) => ({ row: b.row, col: b.col, rowSpan: b.rowSpan || 1, colSpan: b.colSpan || 1, kind: b.kind, label: b.label || null })),
    current_products: onScreen.map((b) => ({ plu: b.pluId, row: b.row, col: b.col, name: (known.get(b.pluId) || {}).name || b.label || null })),
    products: products
      .slice()
      .sort((a, b) => b.sold28d - a.sold28d)
      .slice(0, 160),
    goal: String(goal || '').slice(0, 300) || null,
  };
  const system = [
    'You lay out the product keys on one page of a hospitality EPOS till, for speed of service.',
    'Rules: rows and columns count from 0; row 0 col 0 is top left, where a hand reaches first.',
    'Never use a cell inside a fixed key. One product per cell. Each product at most once. Only products from the list.',
    'Keep the products already on this page unless the goal says otherwise; you may add strong sellers that fit the page\'s theme when there are free cells.',
    'Put the best sellers (sold28d) first, keep each department together in a block, and keep similar items side by side.',
    'Answer JSON only: {"summary": one plain-English sentence, "reasons": [up to 4 short sentences], "placements": [{"plu": number, "row": number, "col": number}]}.',
  ].join(' ');
  let res;
  try {
    res = await fetchImpl(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(prompt) },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new LayoutAiError(502, 'DeepSeek could not be reached: ' + e.message);
  }
  if (!res.ok) throw new LayoutAiError(502, `DeepSeek refused the request (${res.status}).`);
  let answer;
  try {
    const body = await res.json();
    answer = JSON.parse(body.choices[0].message.content);
  } catch {
    throw new LayoutAiError(502, 'DeepSeek answered with something that is not a layout.');
  }
  const used = new Set();
  const placed = new Set();
  const styleOf = new Map(onScreen.map((b) => [b.pluId, b]));
  const keys = [];
  for (const p of Array.isArray(answer.placements) ? answer.placements : []) {
    const plu = Number(p && p.plu);
    const row = Number(p && p.row);
    const col = Number(p && p.col);
    if (!known.has(plu) || placed.has(plu)) continue;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= rows || col >= cols) continue;
    const cell = `${row}:${col}`;
    if (taken.has(cell) || used.has(cell)) continue;
    used.add(cell);
    placed.add(plu);
    // A product already on the page keeps its own look (colour, photo,
    // label); only its place changes. Single-cell, so nothing can overlap.
    const was = styleOf.get(plu);
    const { id: _id, row: _r, col: _c, rowSpan: _rs, colSpan: _cs, ...look } = was || {};
    keys.push({ ...(was ? look : {}), kind: 'product', pluId: plu, row, col, rowSpan: 1, colSpan: 1 });
  }
  if (!keys.length) throw new LayoutAiError(502, 'DeepSeek did not suggest anything that fits this screen. Try again, or with a goal.');
  const kept = onScreen.filter((b) => placed.has(b.pluId)).length;
  const dropped = onScreen.filter((b) => !placed.has(b.pluId)).map((b) => (known.get(b.pluId) || {}).name || b.label || `PLU ${b.pluId}`);
  const added = keys.filter((k) => !styleOf.has(k.pluId)).map((k) => known.get(k.pluId).name);
  return {
    summary: String(answer.summary || '').slice(0, 300),
    reasons: (Array.isArray(answer.reasons) ? answer.reasons : []).slice(0, 4).map((r) => String(r).slice(0, 200)),
    buttons: [...fixed, ...keys],
    moved: kept,
    added,
    dropped,
    names: Object.fromEntries(keys.map((k) => [k.pluId, known.get(k.pluId).name])),
  };
}

function layoutAiRoutes({ pool, secret, auth, fetchImpl }) {
  const router = express.Router();
  const terminal = requireTerminal(secret);
  const recent = new Map(); // office -> [times]

  function limit(office) {
    const now = Date.now();
    const list = (recent.get(office) || []).filter((t) => now - t < 3600e3);
    if (list.length >= PER_HOUR) throw new LayoutAiError(429, `That is ${PER_HOUR} suggestions this hour. Try again later.`);
    recent.set(office, [...list, now]);
  }

  async function screenWithButtons(office, screenId) {
    const [[s]] = await pool.query(
      'SELECT id, name, surface, grid_rows, grid_cols FROM epos_screens WHERE id = ? AND office = ?', [screenId, office]);
    if (!s) throw new LayoutAiError(404, 'No such screen at this venue.');
    const { buttonToJson } = require('./screens');
    const [rows] = await pool.query('SELECT * FROM epos_screen_buttons WHERE screen_id = ? ORDER BY grid_row, grid_col', [s.id]);
    return { screen: { id: s.id, name: s.name, rows: s.grid_rows, cols: s.grid_cols, surface: s.surface }, buttons: rows.map(buttonToJson) };
  }

  const fail = (res, e, next) => (e instanceof LayoutAiError ? res.status(e.status).json({ error: e.message }) : next(e));

  router.post('/api/screens/:id/suggest', auth, express.json(), async (req, res, next) => {
    try {
      let office = req.user.email;
      if (req.user.officeId) {
        const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
        if (o) office = o.contact_email;
      }
      const { screen, buttons } = await screenWithButtons(office, Number(req.params.id));
      if (screen.surface !== 'sale') throw new LayoutAiError(400, 'Suggestions are for sale pages.');
      limit(office);
      const products = await venueFacts(pool, office);
      res.json(await suggestLayout({ screen, buttons, products, goal: (req.body || {}).goal, fetchImpl }));
    } catch (e) { fail(res, e, next); }
  });

  router.post('/api/tap/layouts/suggest', terminal, express.json(), async (req, res, next) => {
    try {
      const b = req.body || {};
      const { screen, buttons: tillButtons } = await screenWithButtons(req.office, Number(b.screen_id));
      // Go's own layout of the screen for this kind of device, when it has one.
      const { goLayoutsFor } = require('./go_options');
      const own = (await goLayoutsFor(pool, req.office, String(b.form || '')))[String(screen.id)];
      limit(req.office);
      const products = await venueFacts(pool, req.office);
      res.json(await suggestLayout({ screen, buttons: Array.isArray(own) ? own : tillButtons, products, goal: b.goal, fetchImpl }));
    } catch (e) { fail(res, e, next); }
  });

  return router;
}

module.exports = { layoutAiRoutes, suggestLayout, LayoutAiError };
