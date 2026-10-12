/**
 * What has happened to a sale since it was settled: how it was paid, and how
 * much of it has gone back.
 *
 * "Why can I refund the same order again and again?" Because nothing joined a
 * refund back to its sale. The till recorded each one as a till event with the
 * receipt id buried in its note, and the card log kept Dojo's side under the
 * payment intent, so neither the till's receipt list nor the back office could
 * say a bill had already been refunded, and the refund screen offered the same
 * lines every time it was opened.
 *
 * Both are read here, once, for every screen that shows a receipt:
 *
 *   - till events of kind `refund`, by `order_id` (tills from EPOS 1.17 send
 *     it, with the receipt line numbers that went back) or, for the refunds
 *     recorded before that, by the "Receipt <id>" the note starts with;
 *   - approved Dojo refunds in the card log, by order or by the payment intent
 *     the sale was paid with, which catches a card refund made from Functions ›
 *     Card machine that never went through the refund screen.
 *
 * The bill's refunded figure is the larger of the two rather than their sum: a
 * refund off a receipt writes both a till event (the whole refund) and a card
 * row (its card share), and adding them would count the card part twice.
 */

const REFUND_KINDS = ['refund', 'matched_refund', 'unlinked_refund'];
const APPROVED = ['approved', 'recorded_manually'];
const LEGACY_NOTE = /^Receipt ([0-9a-f-]{36})\b/i;

/** "3,4,5" or [3,4,5] → [3,4,5]; anything else → []. */
function lineNos(v) {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return list
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < 10000);
}

/** A till event row as the till and the back office read it. */
function refundRow(e) {
  return {
    id: e.id,
    amount_minor: Number(e.amount_minor) || 0,
    at: e.at,
    staff_name: e.staff_name || null,
    note: e.note || null,
    reason: e.reason || null,
    terminal: e.terminal || null,
    line_nos: lineNos(e.line_nos),
  };
}

async function refundEvents(pool, office, ids, since) {
  if (!ids.length) return [];
  const cols = 'id, order_id, amount_minor, at, staff_name, note, reason, terminal';
  const sql = (extra) =>
    `SELECT ${cols}${extra} FROM epos_till_events
      WHERE office = ? AND kind = 'refund'
        AND (order_id IN (?) OR (order_id IS NULL AND note LIKE 'Receipt %' AND at >= ?))
      ORDER BY at`;
  const params = [office, ids, since || new Date(0)];
  try {
    const [rows] = await pool.query(sql(', line_nos'), params);
    return rows;
  } catch (e) {
    // Before schema_refund_lines.sql: no line numbers yet, the rest still holds.
    if (e && e.code === 'ER_BAD_FIELD_ERROR') {
      const [rows] = await pool.query(sql(''), params);
      return rows;
    }
    throw e;
  }
}

/**
 * Status for a set of orders. `orders` are epos_orders rows (id, total_minor,
 * closed_at). Returns a Map of order id → {
 *   methods, has_card, refunded_minor, card_refunded_minor, refund_count,
 *   last_refund_at, refunded_line_nos, refunds, card_refunds, status
 * } where status is paid | part_refunded | refunded.
 */
async function statusFor(pool, office, orders) {
  const out = new Map();
  if (!orders.length) return out;
  const ids = orders.map((o) => o.id);
  const since = orders.reduce((min, o) => {
    const at = o.closed_at ? new Date(o.closed_at) : null;
    return at && (!min || at < min) ? at : min;
  }, null);

  for (const o of orders) {
    out.set(o.id, {
      methods: [],
      has_card: false,
      refunded_minor: 0,
      card_refunded_minor: 0,
      refund_count: 0,
      last_refund_at: null,
      refunded_line_nos: [],
      refunds: [],
      card_refunds: {},
      status: 'paid',
    });
  }

  // How each was paid, and which Dojo payments are behind it.
  const [pays] = await pool.query(
    `SELECT p.order_id, p.method, p.reference
       FROM epos_payments p
       JOIN epos_orders o ON o.id = p.order_id
      WHERE o.email = ? AND p.order_id IN (?)`,
    [office, ids]
  );
  const orderOfIntent = new Map();
  for (const p of pays) {
    const s = out.get(p.order_id);
    if (!s) continue;
    if (p.method && !s.methods.includes(p.method)) s.methods.push(p.method);
    if (p.reference && String(p.reference).startsWith('pi_')) {
      s.has_card = true;
      orderOfIntent.set(p.reference, p.order_id);
      s.card_refunds[p.reference] = 0;
    }
  }

  // Refunds recorded on the till.
  const lines = new Map();
  for (const e of await refundEvents(pool, office, ids, since)) {
    let id = e.order_id;
    if (!id) {
      const m = LEGACY_NOTE.exec(e.note || '');
      id = m && m[1];
    }
    const s = id && out.get(id);
    if (!s) continue;
    const row = refundRow(e);
    s.refunds.push(row);
    s.refunded_minor += row.amount_minor;
    s.refund_count += 1;
    s.last_refund_at = row.at;
    const set = lines.get(id) || new Set();
    row.line_nos.forEach((n) => set.add(n));
    lines.set(id, set);
  }
  for (const [id, set] of lines) out.get(id).refunded_line_nos = [...set].sort((a, b) => a - b);

  // Dojo's side: approved card refunds, by order or by the intent paid with.
  const intents = [...orderOfIntent.keys()];
  try {
    const [cards] = await pool.query(
      `SELECT order_id, intent_id, SUM(amount_minor) AS amount_minor, MAX(at) AS at
         FROM epos_card_transactions
        WHERE office = ? AND kind IN (?) AND outcome IN (?)
          AND (order_id IN (?) OR intent_id IN (?))
        GROUP BY order_id, intent_id`,
      [office, REFUND_KINDS, APPROVED, ids, intents.length ? intents : ['-']]
    );
    for (const c of cards) {
      const id = (c.intent_id && orderOfIntent.get(c.intent_id)) || c.order_id;
      const s = id && out.get(id);
      if (!s) continue;
      const amount = Number(c.amount_minor) || 0;
      s.card_refunded_minor += amount;
      if (c.intent_id && c.intent_id in s.card_refunds) s.card_refunds[c.intent_id] += amount;
      if (!s.last_refund_at || new Date(c.at) > new Date(s.last_refund_at)) s.last_refund_at = c.at;
    }
  } catch (e) {
    // A server without the card log yet still answers for the till's refunds.
    if (!e || e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }

  for (const o of orders) {
    const s = out.get(o.id);
    s.refunded_minor = Math.max(s.refunded_minor, s.card_refunded_minor);
    const total = Number(o.total_minor) || 0;
    s.status =
      s.refunded_minor <= 0 ? 'paid' : s.refunded_minor >= total ? 'refunded' : 'part_refunded';
  }
  return out;
}

/** The list form: the status without the history behind it. */
function brief(s) {
  if (!s) return { methods: [], has_card: false, refunded_minor: 0, refund_count: 0, status: 'paid' };
  return {
    methods: s.methods,
    has_card: s.has_card,
    refunded_minor: s.refunded_minor,
    refund_count: s.refund_count,
    last_refund_at: s.last_refund_at,
    status: s.status,
  };
}

module.exports = { statusFor, brief, lineNos, LEGACY_NOTE };
