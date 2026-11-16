/**
 * An in-memory venue for Vesopa AI's tests and its browser preview: two sites,
 * four products, a busy last Monday and a quiet today, and another venue's
 * sale that must never show. Answers the SQL ai_metrics.js and ai_advisor.js send.
 */
'use strict';

const SECRET = 'ai-test-secret';
const NOW = '2026-11-16 15:00:00'; // a Monday
const OFFICE = 'kitchen@example.com';
const OTHER = 'other@example.com';

// ---- the venue ---------------------------------------------------------------
const orders = [];
const lines = [];
let nextId = 1;
function sale(office, at, terminal, clerk, items) {
  const id = nextId++;
  let total = 0;
  for (const [plu, name, qty, price] of items) {
    lines.push({ order_id: id, plu_id: plu, name, quantity: qty, unit_price_minor: price, discount_minor: 0, tax_percentage: 20, is_modifier: 0 });
    total += qty * price;
  }
  orders.push({ id, email: office, closed_at: at, terminal, clerk_name: clerk, total_minor: total, tax_minor: Math.round(total - total / 1.2), discount_minor: 0, covers: 2, table_number: '' });
}
// Monday 9 Nov (last week): busy lunch.
for (let i = 0; i < 10; i++) sale(OFFICE, `2026-11-09 12:${String(10 + i).padStart(2, '0')}:00`, 'BAR1', 'Alex', [[1, 'Lager', 2, 500], [2, 'Burger', 1, 1200]]);
sale(OFFICE, '2026-11-09 19:00:00', 'LOUNGE1', 'Sam', [[3, 'Wine', 1, 2000]]);
// Sunday 15 Nov (yesterday) and the Sunday before (8 Nov).
for (let i = 0; i < 6; i++) sale(OFFICE, `2026-11-15 13:${String(10 + i).padStart(2, '0')}:00`, 'BAR1', 'Alex', [[1, 'Lager', 2, 500]]);
for (let i = 0; i < 8; i++) sale(OFFICE, `2026-11-08 13:${String(10 + i).padStart(2, '0')}:00`, 'BAR1', 'Alex', [[1, 'Lager', 2, 500], [2, 'Burger', 1, 1200]]);
// Monday 16 Nov (today, to 15:00): quieter lunch, no burgers.
for (let i = 0; i < 4; i++) sale(OFFICE, `2026-11-16 12:${String(10 + i).padStart(2, '0')}:00`, 'BAR1', 'Jo', [[1, 'Lager', 2, 500]]);
// Another venue's sale at the same time: must never appear.
sale(OTHER, '2026-11-16 12:30:00', 'BAR1', 'Alex', [[1, 'Lager', 100, 500]]);

const products = [
  { email: OFFICE, pluid: 1, product_name: 'Lager', department_name: 'Drinks', stock_quantity: 10, low_stock_at: 5, cost_price: 1.0 },
  { email: OFFICE, pluid: 2, product_name: 'Burger', department_name: 'Food', stock_quantity: 0, low_stock_at: 2, cost_price: 11.5 },
  { email: OFFICE, pluid: 3, product_name: 'Wine', department_name: 'Drinks', stock_quantity: 40, low_stock_at: 2, cost_price: 4 },
  { email: OFFICE, pluid: 4, product_name: 'Cider', department_name: 'Drinks', stock_quantity: 30, low_stock_at: 2, cost_price: 1.2 },
];
const sites = [{ id: 1, office: OFFICE, name: 'Bar', sort: 0 }, { id: 2, office: OFFICE, name: 'Lounge', sort: 1 }];
const tillNames = [{ office: OFFICE, terminal: 'BAR1', site_id: 1 }, { office: OFFICE, terminal: 'LOUNGE1', site_id: 2 }];
const clarks = [
  { id: 7, email: OFFICE, clark_name: 'Mel', pin_code: '1234', permission_group_id: 1, active: 1 },
  { id: 8, email: OFFICE, clark_name: 'Jo', pin_code: '5555', permission_group_id: 2, active: 1 },
];
const groups = [{ id: 1, email: OFFICE, is_manager: 1 }, { id: 2, email: OFFICE, is_manager: 0 }];
const offices = [{ id: 1, contact_email: OFFICE, name: 'Vesopa Kitchen' }, { id: 2, contact_email: OFFICE.replace('kitchen', 'x'), name: 'X' }];
const users = [{ id: 1, email: 'owner@example.com', office_id: 1, role_id: null }, { id: 2, email: 'staff@example.com', office_id: 1, role_id: 5 }];
const roles = [{ id: 5, email: OFFICE, display_name: 'Staff', permissions: '["dashboard.view"]' }];
const members = [];
const convos = [];
const messages = [];
const writes = [];

const between = (at, from, to) => at >= from && at < to;
function scoped(sql, params) {
  // [office, from, to, tills?]
  const [office, from, to, tills] = params;
  return orders.filter((o) => o.email === office && between(o.closed_at, from, to) && (!/IN \(\?\)/.test(sql) || tills.includes(o.terminal)));
}
const sum = (list, k) => list.reduce((a, x) => a + (Number(x[k]) || 0), 0);

const pool = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ');
    if (/^CREATE TABLE/.test(s.trim())) return [{}];
    if (/SELECT NOW\(\)/.test(s)) return [[{ now: NOW }]];
    if (/FROM bo_till_sites/.test(s)) return [sites.filter((x) => x.office === params[0])];
    if (/FROM bo_till_names/.test(s)) return [tillNames.filter((x) => x.office === params[0])];
    if (/FROM offices WHERE id/.test(s)) return [[offices.find((o) => o.id === params[0])].filter(Boolean)];
    if (/FROM offices WHERE contact_email/.test(s)) return [[offices.find((o) => o.contact_email === params[0])].filter(Boolean)];
    if (/FROM epos_void_log/.test(s)) return [[]];
    if (/FROM ai_members WHERE user_id/.test(s)) return [members.filter((m) => m.user_id === params[0] && m.office === params[1] && m.status === 'active')];
    if (/FROM backoffice_users u JOIN bo_user_roles/.test(s)) {
      const u = users.find((x) => x.id === params[0]);
      return [[roles.find((r) => u && r.id === u.role_id)].filter(Boolean)];
    }
    if (/FROM bo_clarks c LEFT JOIN epos_permission_groups/.test(s) && /c\.id = \?/.test(s)) {
      const c = clarks.find((x) => x.id === params[0] && x.email === params[1]);
      if (!c) return [[]];
      const g = groups.find((x) => x.id === c.permission_group_id);
      return [[{ id: c.id, name: c.clark_name, pin: c.pin_code, grp: c.permission_group_id, is_manager: g ? g.is_manager : null }]];
    }
    if (/INSERT INTO ai_conversations/.test(s)) { convos.push({ id: convos.length + 1, office: params[0], user_key: params[1], title: params[2], state: null }); return [{ insertId: convos.length }]; }
    if (/UPDATE ai_conversations SET state/.test(s)) { convos.find((c) => c.id === params[1]).state = params[0]; return [{}]; }
    if (/SELECT \* FROM ai_conversations WHERE id/.test(s)) return [convos.filter((c) => c.id === params[0] && c.office === params[1] && c.user_key === params[2])];
    if (/INSERT INTO ai_messages/.test(s)) { messages.push({ conversation_id: params[0], question: params[2], answer: params[3] }); return [{}]; }
    if (/SELECT question, answer FROM ai_messages/.test(s)) return [messages.filter((m) => m.conversation_id === params[0])];
    if (/INSERT INTO ai_members/.test(s)) {
      members.push({ id: members.length + 1, office: params[0], email: params[1], name: params[2], sites: params[3], can_profit: params[4], can_staff: params[5], status: 'invited', token_hash: params[6], expires_at: params[7] });
      return [{ insertId: members.length }];
    }
    if (/SELECT id FROM ai_members WHERE office = \? AND email/.test(s)) return [members.filter((m) => m.office === params[0] && m.email === params[1] && m.status !== 'revoked')];
    if (/FROM ai_conversations c WHERE c\.office/.test(s)) return [convos.filter((c) => c.office === params[0] && c.user_key === params[1]).map((c) => ({ id: c.id, title: c.title, updated_at: NOW, messages: messages.filter((m) => m.conversation_id === c.id).length })).reverse()];
    if (/SELECT id, title FROM ai_conversations/.test(s)) return [convos.filter((c) => c.id === params[0] && c.office === params[1] && c.user_key === params[2])];
    if (/FROM ai_members WHERE office = \? AND status <> 'revoked' ORDER/.test(s)) return [members.filter((m) => m.office === params[0] && m.status !== 'revoked').map((m) => ({ ...m, invited_by: 'Owner', invited_at: NOW }))];
    if (/INSERT|UPDATE|DELETE/.test(s.trim().slice(0, 7))) { writes.push(s); return [{}]; }

    if (/FROM epos_order_lines l JOIN epos_orders o/.test(s) && /GROUP BY l\.plu_id, l\.name/.test(s)) {
      const ids = new Set(scoped(s, params).map((o) => o.id));
      const by = new Map();
      for (const l of lines.filter((x) => ids.has(x.order_id))) {
        const p = products.find((x) => x.pluid === l.plu_id && x.email === params[0]) || {};
        const e = by.get(l.plu_id) || { plu_id: l.plu_id, name: l.name, department: p.department_name, qty: 0, takings_minor: 0, tax_minor: 0, cost_minor: 0, costed: p.cost_price > 0 ? 1 : 0 };
        const t = l.quantity * l.unit_price_minor;
        e.qty += l.quantity; e.takings_minor += t; e.tax_minor += t * 20 / 120; e.cost_minor += l.quantity * (p.cost_price || 0) * 100;
        by.set(l.plu_id, e);
      }
      return [[...by.values()]];
    }
    if (/FROM bo_products p LEFT JOIN/.test(s)) {
      const [office, from] = params;
      const tills = /IN \(\?\)/.test(s) ? params[2] : null;
      const ids = new Set(orders.filter((o) => o.email === office && o.closed_at >= from && (!tills || tills.includes(o.terminal))).map((o) => o.id));
      return [products.filter((p) => p.email === office).map((p) => ({ ...p, sold: sum(lines.filter((l) => ids.has(l.order_id) && l.plu_id === p.pluid), 'quantity') }))];
    }
    if (/FROM epos_orders o/.test(s) && /GROUP BY HOUR/.test(s)) {
      const by = new Map();
      for (const o of scoped(s, params)) { const h = Number(o.closed_at.slice(11, 13)); const e = by.get(h) || { hour: h, sales: 0, takings_minor: 0 }; e.sales++; e.takings_minor += o.total_minor; by.set(h, e); }
      return [[...by.values()].sort((a, b) => a.hour - b.hour)];
    }
    if (/FROM epos_orders o/.test(s) && /GROUP BY clerk/.test(s)) {
      const by = new Map();
      for (const o of scoped(s, params)) { const e = by.get(o.clerk_name) || { clerk: o.clerk_name, sales: 0, takings_minor: 0, discount_minor: 0 }; e.sales++; e.takings_minor += o.total_minor; by.set(o.clerk_name, e); }
      return [[...by.values()]];
    }
    if (/FROM epos_orders o/.test(s) && /GROUP BY terminal/.test(s)) {
      const by = new Map();
      for (const o of orders.filter((x) => x.email === params[0] && between(x.closed_at, params[1], params[2]))) { const e = by.get(o.terminal) || { terminal: o.terminal, sales: 0, takings_minor: 0 }; e.sales++; e.takings_minor += o.total_minor; by.set(o.terminal, e); }
      return [[...by.values()]];
    }
    if (/FROM epos_orders o/.test(s) && /ORDER BY o\.closed_at DESC/.test(s)) return [scoped(s, params)];
    if (/FROM epos_orders o/.test(s) && /MAX\(o\.closed_at\)/.test(s)) {
      const list = scoped(s, params);
      return [[{ sales: list.length, takings_minor: sum(list, 'total_minor'), tax_minor: sum(list, 'tax_minor'), discount_minor: 0, covers: sum(list, 'covers'), last_sale: list.length ? list.map((o) => o.closed_at).sort().pop() : null }]];
    }
    throw new Error('Unexpected SQL in test: ' + s.slice(0, 160));
  },
};

module.exports = { pool, SECRET, NOW, OFFICE, OTHER, orders, lines, products, sites, tillNames, clarks, members, convos, messages, writes };
