/**
 * Turning what somebody chose on a shop page into an order.
 *
 * EVERYTHING IS DECIDED HERE, NEVER IN THE BROWSER. The form sends which design,
 * which amount button or typed sum, which experience, how many of which ticket.
 * Prices are looked up, limits are checked, dates are parsed in London time.
 * A tampered form can ask for anything; it can only be given what this file
 * would have given it.
 *
 * validateVoucher() and validateTickets() are pure -- no database, no clock
 * unless one is passed -- so the rules can be tested one at a time.
 */

const db = require('./db');
const { parseMoney, isEmail, clean, londonToUtc, publicId, money } = require('./util');

const PENDING_HOURS = 2;
const MAX_TICKETS_PER_ORDER = 10;

class OrderError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'OrderError';
    this.field = field || null;
  }
}

const ref = (order) => `VG-${10000 + Number(order.id)}`;

/**
 * A voucher or an experience, from the buy form.
 *
 * `venue` is the gift_venues row; `design` the chosen design (already looked up
 * and confirmed to be this venue's and on sale); `product` the experience, if
 * this is one.
 */
function validateVoucher(input, { venue, amounts, design, product, now = new Date() }) {
  const b = input || {};
  const out = {};

  // What it is worth.
  if (product) {
    out.kind = 'experience';
    out.label = product.name;
    out.unit_minor = product.price_minor;
    out.product_id = product.id;
  } else {
    out.kind = 'voucher';
    out.label = 'Gift voucher';
    const preset = Number(b.amount);
    // A typed amount wins over a ticked button: somebody who took the trouble
    // to type £40 meant £40, whatever button was left selected above it.
    const typedSomething = venue.allow_custom && String(b.custom_amount || '').trim() !== '';
    if (!typedSomething && b.amount && amounts.includes(preset)) {
      out.unit_minor = preset;
    } else {
      if (!venue.allow_custom) throw new OrderError('Choose one of the amounts', 'amount');
      const typed = parseMoney(b.custom_amount);
      if (!Number.isInteger(typed)) throw new OrderError('Enter an amount in pounds, like 40 or 40.50', 'custom_amount');
      if (typed < venue.min_minor || typed > venue.max_minor) {
        throw new OrderError(`Choose an amount between ${money(venue.min_minor)} and ${money(venue.max_minor)}`, 'custom_amount');
      }
      out.unit_minor = typed;
    }
  }
  if (!design) throw new OrderError('Choose a design', 'design');
  out.design_id = design.id;

  // Who it goes to.
  out.send_to = b.send_to === 'buyer' ? 'buyer' : 'recipient';
  out.recipient_name = clean(b.recipient_name, 120) || null;
  if (out.send_to === 'recipient') {
    if (!out.recipient_name) throw new OrderError('Tell us who it is for', 'recipient_name');
    const email = clean(b.recipient_email, 190).toLowerCase();
    if (!isEmail(email)) throw new OrderError('Enter their email address', 'recipient_email');
    out.recipient_email = email;
  } else {
    out.recipient_email = null;
  }
  out.message = clean(b.message, 300) || null;

  // When.
  out.deliver_at = null;
  if (b.when === 'later' && out.send_to === 'recipient') {
    if (!venue.allow_schedule) throw new OrderError('This venue sends vouchers straight away', 'when');
    const at = londonToUtc(b.deliver_date, b.deliver_time || '09:00');
    if (!at) throw new OrderError('Choose the day it should arrive', 'deliver_date');
    if (at.getTime() < now.getTime() + 5 * 60 * 1000) {
      throw new OrderError('Choose a time that has not passed yet', 'deliver_date');
    }
    if (at.getTime() > now.getTime() + venue.schedule_max_days * 86400000) {
      throw new OrderError(`It can be sent up to ${Math.round(venue.schedule_max_days / 30)} months ahead`, 'deliver_date');
    }
    out.deliver_at = at;
  }

  // Who is paying.
  const buyer = {
    name: clean(b.buyer_name, 120),
    email: clean(b.buyer_email, 190).toLowerCase(),
  };
  if (!buyer.name) throw new OrderError('Tell us your name', 'buyer_name');
  if (!isEmail(buyer.email)) throw new OrderError('Enter your email address, for the receipt', 'buyer_email');

  if (out.unit_minor > venue.max_order_minor) {
    throw new OrderError(`The most one order can be is ${money(venue.max_order_minor)}`, 'amount');
  }
  return { line: out, buyer, total: out.unit_minor };
}

/**
 * Tickets for one event. `types` are the event's ticket types; `left` is how
 * many are still available, overall and per type, already worked out.
 */
function validateTickets(input, { event, types, left, now = new Date() }) {
  const b = input || {};
  if (!event.on_sale || event.cancelled_at) throw new OrderError('Tickets are not on sale for this event');
  if (new Date(event.starts_at).getTime() < now.getTime()) throw new OrderError('This event has already started');
  if (event.sales_end_at && new Date(event.sales_end_at).getTime() < now.getTime()) {
    throw new OrderError('Ticket sales for this event have closed');
  }

  const lines = [];
  let count = 0;
  for (const t of types) {
    const n = Number(b[`qty_${t.id}`] || 0);
    if (!Number.isInteger(n) || n < 0) throw new OrderError('Choose how many tickets');
    if (!n) continue;
    if (!t.on_sale) throw new OrderError(`${t.name} tickets are not on sale`);
    if (t.capacity != null && n > left.byType[t.id]) {
      throw new OrderError(left.byType[t.id] > 0 ? `Only ${left.byType[t.id]} ${t.name} left` : `${t.name} is sold out`);
    }
    lines.push({ kind: 'ticket', ticket_type_id: t.id, event_id: event.id, label: `${event.title} — ${t.name}`, unit_minor: t.price_minor, quantity: n });
    count += n;
  }
  if (!count) throw new OrderError('Choose at least one ticket');
  if (count > MAX_TICKETS_PER_ORDER) throw new OrderError(`Up to ${MAX_TICKETS_PER_ORDER} tickets in one order`);
  if (count > left.overall) throw new OrderError(left.overall > 0 ? `Only ${left.overall} left` : 'This event is sold out');

  const buyer = {
    name: clean(b.buyer_name, 120),
    email: clean(b.buyer_email, 190).toLowerCase(),
  };
  if (!buyer.name) throw new OrderError('Tell us whose name the tickets are under', 'buyer_name');
  if (!isEmail(buyer.email)) throw new OrderError('Enter your email address — the tickets are sent there', 'buyer_email');

  const total = lines.reduce((s, l) => s + l.unit_minor * l.quantity, 0);
  return { lines, buyer, total };
}

/**
 * How many tickets are left for an event: those sold, plus those in orders that
 * are still being paid for, taken off the capacity. A pending order holds its
 * seats until it expires, so two people cannot both buy the last one.
 */
async function ticketsLeft(conn, event, types) {
  const q = (sql, p) => conn.query(sql, p).then(([rows]) => rows);
  const sold = await q(
    `SELECT ticket_type_id, COUNT(*) AS n FROM gift_tickets
      WHERE event_id = ? AND status IN ('valid', 'used') GROUP BY ticket_type_id`,
    [event.id]
  );
  const held = await q(
    `SELECT l.ticket_type_id, COALESCE(SUM(l.quantity), 0) AS n
       FROM gift_order_lines l JOIN gift_orders o ON o.id = l.order_id
      WHERE l.event_id = ? AND l.kind = 'ticket'
        AND o.status = 'pending' AND o.expires_at > UTC_TIMESTAMP()
      GROUP BY l.ticket_type_id`,
    [event.id]
  );
  const taken = {};
  for (const r of [...sold, ...held]) taken[r.ticket_type_id] = (taken[r.ticket_type_id] || 0) + Number(r.n);
  const total = Object.values(taken).reduce((s, n) => s + n, 0);
  const byType = {};
  for (const t of types) {
    byType[t.id] = t.capacity == null ? Infinity : Math.max(0, t.capacity - (taken[t.id] || 0));
  }
  return { overall: Math.max(0, event.capacity - total), byType, sold: total };
}

/**
 * The limits a stolen card runs into. Honest buyers never see them: five orders
 * a day from one address and fifteen an hour from one connection are well past
 * what anybody buying presents does.
 */
async function checkFraud(venue, buyerEmail, ip, total) {
  if (total > venue.max_order_minor) {
    throw new OrderError(`The most one order can be is ${money(venue.max_order_minor)}`);
  }
  const byEmail = await db.one(
    `SELECT COUNT(*) AS n FROM gift_orders
      WHERE buyer_email = ? AND office_id = ? AND status IN ('pending', 'paid')
        AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`,
    [buyerEmail, venue.office_id]
  );
  if (Number(byEmail.n) >= venue.orders_per_email_day) {
    throw new OrderError('That is a lot of orders for one day. Try again tomorrow, or contact the venue.');
  }
  const byIp = await db.one(
    `SELECT COUNT(*) AS n FROM gift_orders
      WHERE ip = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)`,
    [String(ip || '').slice(0, 45)]
  );
  if (Number(byIp.n) >= 15) {
    throw new OrderError('That is a lot of orders in an hour. Wait a while and try again.');
  }
}

async function insertOrder(conn, { venue, kind, buyer, total, ip }) {
  const [res] = await conn.execute(
    `INSERT INTO gift_orders (public_id, office_id, kind, status, buyer_name, buyer_email, total_minor, ip, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))`,
    [publicId(24), venue.office_id, kind, buyer.name, buyer.email, total, String(ip || '').slice(0, 45), PENDING_HOURS]
  );
  return res.insertId;
}

async function createVoucherOrder(venue, validated, ip) {
  await checkFraud(venue, validated.buyer.email, ip, validated.total);
  return db.tx(async (conn) => {
    const orderId = await insertOrder(conn, {
      venue, kind: 'voucher', buyer: validated.buyer, total: validated.total, ip,
    });
    const l = validated.line;
    await conn.execute(
      `INSERT INTO gift_order_lines
         (order_id, line_no, kind, product_id, label, unit_minor, quantity, design_id,
          send_to, recipient_name, recipient_email, message, deliver_at)
       VALUES (?, 1, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [orderId, l.kind, l.product_id || null, l.label, l.unit_minor, l.design_id,
        l.send_to, l.recipient_name, l.recipient_email, l.message, l.deliver_at]
    );
    const [[order]] = await conn.query('SELECT * FROM gift_orders WHERE id = ?', [orderId]);
    return order;
  });
}

/**
 * Tickets are created under a lock on the event row, so the capacity check and
 * the order that relies on it cannot be split by a second buyer.
 */
async function createTicketOrder(venue, event, input, ip) {
  return db.tx(async (conn) => {
    const [[locked]] = await conn.query('SELECT * FROM gift_events WHERE id = ? AND office_id = ? FOR UPDATE', [event.id, venue.office_id]);
    if (!locked) throw new OrderError('No such event');
    const [types] = await conn.query('SELECT * FROM gift_ticket_types WHERE event_id = ? ORDER BY sort, id', [event.id]);
    const left = await ticketsLeft(conn, locked, types);
    const validated = validateTickets(input, { event: locked, types, left });
    await checkFraud(venue, validated.buyer.email, ip, validated.total);
    const orderId = await insertOrder(conn, {
      venue, kind: 'tickets', buyer: validated.buyer, total: validated.total, ip,
    });
    let n = 1;
    for (const l of validated.lines) {
      await conn.execute(
        `INSERT INTO gift_order_lines
           (order_id, line_no, kind, event_id, ticket_type_id, label, unit_minor, quantity, send_to)
         VALUES (?, ?, 'ticket', ?, ?, ?, ?, ?, 'buyer')`,
        [orderId, n++, l.event_id, l.ticket_type_id, l.label, l.unit_minor, l.quantity]
      );
    }
    const [[order]] = await conn.query('SELECT * FROM gift_orders WHERE id = ?', [orderId]);
    return order;
  });
}

module.exports = {
  OrderError, ref, validateVoucher, validateTickets, ticketsLeft, checkFraud,
  createVoucherOrder, createTicketOrder, PENDING_HOURS, MAX_TICKETS_PER_ORDER,
};
