/**
 * Taking the money, and giving it back.
 *
 * THE BUYER'S RETURN IS NOT PROOF OF PAYMENT. Dojo sends the buyer back to our
 * page when they are done on its checkout, and anybody can type that address.
 * The only thing that makes an order paid is the payment intent saying
 * Captured when the EPOS asks Dojo, with the venue's own key.
 *
 * THE INTENT IS MADE ONCE PER ORDER and reused for every retry. Dojo ignores
 * idempotency keys on intents, so a second POST would be a second charge
 * waiting to happen; the id is stored the first time and the same checkout page
 * is offered again after a decline.
 *
 * A REFUND CANCELS FIRST AND PAYS SECOND. The voucher is voided in the EPOS --
 * atomically, so it is either spent or refunded, never both -- and only what
 * was still on it is refunded. Money spent at the till bought food and drink.
 */

const crypto = require('crypto');
const db = require('./db');
const epos = require('./epos');
const venues = require('./venues');
const config = require('./config');
const { ref } = require('./orders');
const { fulfil, audit } = require('./fulfil');

async function startPayment(venue, order) {
  if (order.intent_id) {
    return `https://pay.dojo.tech/checkout/${encodeURIComponent(order.intent_id)}`;
  }
  const brand = venues.brandOf(venue);
  const r = await epos.startPayment(venue.office_id, {
    amount_minor: order.total_minor,
    reference: ref(order),
    description: `${brand.name} ${order.kind === 'tickets' ? 'tickets' : 'gift voucher'}`.slice(0, 80),
    redirect_url: `${config.BASE_URL}/${venue.slug}/paid/${order.public_id}`,
  });
  // Conditional: if two tabs raced to start the same order, the first intent
  // stored is the one used, and the second is cancelled.
  const res = await db.run(
    'UPDATE gift_orders SET intent_id = ?, pay_source = ?, sandbox = ? WHERE id = ? AND intent_id IS NULL',
    [r.intent_id, r.source, r.sandbox ? 1 : 0, order.id]
  );
  if (!res.affectedRows) {
    epos.cancelPayment(venue.office_id, r.intent_id).catch(() => {});
    const again = await db.one('SELECT intent_id FROM gift_orders WHERE id = ?', [order.id]);
    return `https://pay.dojo.tech/checkout/${encodeURIComponent(again.intent_id)}`;
  }
  return r.checkout_url;
}

/**
 * Ask whether an order has been paid for, and if it has, make it so here.
 * Answers the order as it now stands.
 */
async function refresh(order) {
  if (!order || !order.intent_id || order.status !== 'pending') return order;
  let p;
  try {
    p = await epos.payment(order.office_id, order.intent_id);
  } finally {
    await db.run('UPDATE gift_orders SET checked_at = UTC_TIMESTAMP() WHERE id = ?', [order.id]);
  }
  if (p.paid) {
    const res = await db.run(
      `UPDATE gift_orders SET status = 'paid', paid_at = UTC_TIMESTAMP(), card_brand = ?, card_last4 = ?
        WHERE id = ? AND status = 'pending'`,
      [p.card && p.card.brand ? String(p.card.brand).slice(0, 40) : null,
        p.card && p.card.last4 ? String(p.card.last4).slice(0, 4) : null, order.id]
    );
    if (res.affectedRows) await audit(order.office_id, 'order.paid', { order: ref(order), total: order.total_minor });
    await fulfil(order.id);
  }
  const fresh = await db.one('SELECT * FROM gift_orders WHERE id = ?', [order.id]);
  fresh.dojo_status = p.status;
  return fresh;
}

/**
 * Refund a line of an order (or the whole of a ticket order).
 *
 * Voucher lines: void the card, refund what it had left. Ticket orders: void
 * every ticket not yet used, refund their price. The refund row is written
 * first with its own idempotency key, so a refund pressed twice -- or retried
 * after a timeout -- reaches Dojo as the same request.
 */
async function refundLine(order, line, { by, reason }) {
  const venue = await venues.get(order.office_id);
  let amount = 0;

  if (line.kind === 'ticket') {
    const [r] = await db.pool.execute(
      "UPDATE gift_tickets SET status = 'void' WHERE line_id = ? AND status = 'valid'",
      [line.id]
    );
    amount = r.affectedRows * line.unit_minor;
    if (!amount) throw new Error('Every ticket on this line has been used or refunded already');
  } else {
    if (!line.card_id) throw new Error('No voucher was issued for this line');
    const v = await epos.voidCard(venue.office_id, line.card_id, reason || `Refunded by ${by}`);
    amount = Number(v.refundable_minor) || 0;
    await db.run('UPDATE gift_order_lines SET voided_at = COALESCE(voided_at, UTC_TIMESTAMP()) WHERE id = ?', [line.id]);
    if (!amount) {
      await audit(venue.office_id, 'line.voided', { order: ref(order), line: line.line_no, refunded: 0 }, by);
      return 0;
    }
  }

  const key = crypto.randomUUID();
  const ins = await db.run(
    `INSERT INTO gift_refunds (order_id, line_id, amount_minor, reason, idempotency_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [order.id, line.id, amount, reason || null, key, by]
  );
  try {
    const r = await epos.refund(venue.office_id, order.intent_id, {
      amount_minor: amount, reason: reason || 'Refunded by the venue', idempotency_key: key,
    });
    await db.run("UPDATE gift_refunds SET status = 'done', dojo_refund_id = ? WHERE id = ?", [r.refund_id || null, ins.insertId]);
    await db.run('UPDATE gift_order_lines SET refunded_minor = refunded_minor + ? WHERE id = ?', [amount, line.id]);
    await db.run(
      `UPDATE gift_orders SET refunded_minor = refunded_minor + ?,
              status = IF(refunded_minor + ? >= total_minor, 'refunded', status)
        WHERE id = ?`,
      [amount, amount, order.id]
    );
    await audit(venue.office_id, 'line.refunded', { order: ref(order), line: line.line_no, amount }, by);
    return amount;
  } catch (e) {
    await db.run("UPDATE gift_refunds SET status = 'failed', error = ? WHERE id = ?", [String(e.message).slice(0, 255), ins.insertId]);
    await audit(venue.office_id, 'line.refund_failed', { order: ref(order), line: line.line_no, amount, error: e.message }, by);
    throw new Error(`The voucher is cancelled, but Dojo did not take the refund: ${e.message}. Refund ${require('./util').money(amount, { always: true })} from the Dojo app.`);
  }
}

module.exports = { startPayment, refresh, refundLine };
