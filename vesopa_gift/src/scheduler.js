/**
 * What happens when nobody is looking.
 *
 * Every thirty seconds:
 *
 *   * orders being paid for are checked with Dojo -- a buyer who paid and then
 *     closed the tab before coming back still gets their voucher
 *   * paid orders the EPOS could not be reached for are tried again
 *   * vouchers due now (a birthday at 9am) are sent, and failed sends retried
 *   * orders nobody paid for are let go after two hours, their seats released
 *
 * One runner at a time, across processes, by a MySQL named lock. pm2 runs one
 * process today; the lock is what keeps that from mattering tomorrow.
 */

const db = require('./db');
const epos = require('./epos');
const venues = require('./venues');
const { refresh } = require('./payments');
const { fulfil, deliverOrder, audit } = require('./fulfil');
const { ref } = require('./orders');

const EVERY_MS = Number(process.env.GIFT_SWEEP_MS) || 30 * 1000;
let running = false;

async function sweepPayments() {
  const pending = await db.all(
    `SELECT * FROM gift_orders
      WHERE status = 'pending' AND intent_id IS NOT NULL
        AND (checked_at IS NULL OR checked_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 SECOND))
      ORDER BY id LIMIT 20`
  );
  for (const o of pending) {
    await refresh(o).catch((e) => console.warn(`[sweep] order ${o.id}: ${e.message}`));
  }
}

async function retryFulfil() {
  const stuck = await db.all(
    `SELECT id FROM gift_orders WHERE status = 'paid' AND fulfilled_at IS NULL ORDER BY id LIMIT 10`
  );
  for (const o of stuck) await fulfil(o.id).catch((e) => console.warn(`[sweep] fulfil ${o.id}: ${e.message}`));

  // Paid and made, but a card could not be issued for one line at the time.
  const unissued = await db.all(
    `SELECT DISTINCT o.id FROM gift_orders o JOIN gift_order_lines l ON l.order_id = o.id
      WHERE o.status = 'paid' AND l.kind IN ('voucher', 'experience')
        AND l.card_id IS NULL AND l.voided_at IS NULL LIMIT 10`
  );
  for (const o of unissued) await fulfil(o.id).catch((e) => console.warn(`[sweep] issue ${o.id}: ${e.message}`));
}

async function deliverDue() {
  const due = await db.all(
    `SELECT DISTINCT l.order_id FROM gift_order_lines l JOIN gift_orders o ON o.id = l.order_id
      WHERE o.status = 'paid' AND l.delivered_at IS NULL AND l.voided_at IS NULL
        AND (l.kind = 'ticket' OR l.card_id IS NOT NULL)
        AND (l.deliver_at IS NULL OR l.deliver_at <= UTC_TIMESTAMP())
        AND (l.next_try_at IS NULL OR l.next_try_at <= UTC_TIMESTAMP())
        AND l.delivery_attempts < 8
      ORDER BY l.order_id LIMIT 20`
  );
  for (const d of due) await deliverOrder(d.order_id).catch((e) => console.warn(`[sweep] deliver ${d.order_id}: ${e.message}`));
}

/**
 * Let go of orders nobody paid for. Asked one last time first: somebody who
 * paid at the last minute must not have their order cancelled underneath them.
 * The intent is then cancelled at Dojo, so the checkout page cannot take money
 * for an order that no longer exists.
 */
async function expire() {
  const old = await db.all(
    `SELECT * FROM gift_orders WHERE status = 'pending' AND expires_at < UTC_TIMESTAMP() ORDER BY id LIMIT 20`
  );
  for (const o of old) {
    try {
      if (o.intent_id) {
        const now = await refresh(o);
        if (now.status !== 'pending') continue;
        await epos.cancelPayment(o.office_id, o.intent_id).catch(() => {});
        // Cancelling can lose to a payment captured in the same second.
        const last = await refresh(now).catch(() => now);
        if (last.status !== 'pending') continue;
      }
      const r = await db.run(
        "UPDATE gift_orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
        [o.id]
      );
      if (r.affectedRows) await audit(o.office_id, 'order.expired', { order: ref(o) });
    } catch (e) {
      console.warn(`[sweep] expire ${o.id}: ${e.message}`);
    }
  }
}

let brandsAt = 0;
async function refreshBrands() {
  if (Date.now() - brandsAt < 30 * 60 * 1000) return;
  brandsAt = Date.now();
  const rows = await db.all('SELECT office_id FROM gift_venues');
  for (const r of rows) await venues.refreshBrand(r.office_id).catch(() => {});
}

async function tick() {
  if (running) return;
  running = true;
  const conn = await db.pool.getConnection();
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK('vesopa_gift_scheduler', 0) AS got");
    if (!lock.got) return;
    try {
      await sweepPayments();
      await retryFulfil();
      await deliverDue();
      await expire();
      await refreshBrands();
    } finally {
      await conn.query("SELECT RELEASE_LOCK('vesopa_gift_scheduler')");
    }
  } catch (e) {
    console.warn(`[sweep] ${e.message}`);
  } finally {
    conn.release();
    running = false;
  }
}

function start() {
  setTimeout(tick, Math.min(5000, EVERY_MS));
  return setInterval(tick, EVERY_MS);
}

module.exports = { start, tick, sweepPayments, deliverDue, expire };
