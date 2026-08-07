/**
 * Taking money.
 *
 * Everything about a payment that is not the gateway's own wire protocol lives
 * here: which gateways exist, what a customer is actually charged, and the one
 * function that turns "the gateway says yes" into a paid order.
 *
 * THE SETTLE PATH IS CALLED TWICE FOR EVERY SUCCESSFUL PAYMENT.
 *
 * The gateway sends an IPN server-to-server AND redirects the browser back,
 * and there is no guaranteed order between them — on a fast connection the
 * browser often wins. Both call `settle()`. It is therefore written to be
 * idempotent at the database level rather than by checking first and acting
 * second: the UPDATE names the status it expects to find, and a second caller
 * changes no rows and provisions nothing. Two customers' worth of hosting
 * accounts from one payment is the failure this prevents.
 */

const crypto = require('crypto');
const db = require('./db');
const currency = require('./currency');
const provisioning = require('./provisioning');
const { SITE_URL } = require('./config');
const sslcommerz = require('./integrations/sslcommerz');
const stripe = require('./integrations/stripe');
const paypal = require('./integrations/paypal');

/** One adapter per gateway id, all sharing the same initiate() contract. */
const INTEGRATIONS = { sslcommerz, stripe, paypal };

/**
 * The currency the gateway settles in.
 *
 * BosheBoshe is a Bangladeshi merchant of record and takes taka. We sell in
 * pounds, dollars and Canadian dollars, so an order is CHARGED in one currency
 * and RECORDED in another, and both figures go on the payment row — see the
 * note on the `payments` table.
 *
 * `SSLCZ_PASSTHROUGH` lists any currency the account is enabled to take
 * directly. Anything not in it is converted. Default is BDT alone, which is the
 * safe assumption: sending GBP to an account that cannot take it fails at the
 * gateway with a message the customer cannot act on.
 */
const SETTLE_CURRENCY = (process.env.SSLCZ_CURRENCY || 'BDT').toUpperCase();
const PASSTHROUGH = String(process.env.SSLCZ_PASSTHROUGH || SETTLE_CURRENCY)
  .toUpperCase()
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

/**
 * The gateways, in the order they are offered.
 *
 * Stripe and crypto are listed and disabled rather than hidden. A checkout that
 * offers exactly one way to pay looks like a limitation; one that shows three
 * and marks two "coming soon" says the same thing about today and something
 * better about tomorrow, and it costs nothing to be honest about which is which.
 * `available` is computed, never typed — turning one on is a matter of the
 * adapter reporting itself configured.
 */
function gateways() {
  const ssl = sslcommerz.status();
  const str = stripe.status();
  const pp = paypal.status();
  return [
    {
      id: 'sslcommerz',
      name: 'SSLCommerz',
      blurb: 'Cards, mobile wallets and net banking.',
      logo: '/assets/img/pay/sslcommerz.svg',
      // Mock counts as available on purpose: it is how the whole journey is
      // walked on a dev machine, and the checkout has to offer it to do that.
      available: ssl.configured || ssl.mode === 'mock',
      mock: ssl.mode === 'mock',
      note: ssl.mode === 'mock' ? 'Test mode — no money moves.' : '',
    },
    {
      id: 'stripe',
      name: 'Stripe',
      blurb: 'Card payments, Apple Pay and Google Pay.',
      logo: '/assets/img/pay/stripe.svg',
      available: str.configured || str.mode === 'mock',
      mock: str.mode === 'mock',
      note: str.mode === 'mock' ? 'Test mode — no money moves.' : '',
    },
    {
      id: 'paypal',
      name: 'PayPal',
      blurb: 'Pay with your PayPal account.',
      logo: '/assets/img/pay/paypal.svg',
      available: pp.configured || pp.mode === 'mock',
      mock: pp.mode === 'mock',
      note: pp.mode === 'sandbox' ? 'Sandbox — no real money moves.' : (pp.mode === 'mock' ? 'Test mode — no money moves.' : ''),
    },
    {
      id: 'crypto',
      name: 'Cryptocurrency',
      blurb: 'Bitcoin, Ethereum and USDT.',
      logo: '/assets/img/pay/crypto.svg',
      available: false,
      note: 'Coming soon',
    },
  ];
}

/**
 * Absolute URLs for the gateway's callbacks.
 *
 * The gateway fetches and redirects to these FROM ITS OWN SERVER, so a relative
 * path is useless to it and `localhost` resolves to the gateway's machine
 * rather than ours. SITE_URL is the configured public origin and is the only
 * correct source — which also means a dev box cannot receive a live IPN, and
 * should not.
 *
 * One return URL for success, failure and cancellation, told apart by `r`. The
 * gateway signs the whole query string it is given, `r` included, so the flag
 * cannot be tampered with in transit.
 *
 * Stripe and PayPal each verify a payment by asking their own API for the
 * session/order back by id — never by trusting the query string — so unlike
 * SSLCommerz they need no shared signature and no IPN, and each gets its own
 * return route rather than reusing `/pay/return`.
 */
function callbackUrls(gatewayId) {
  const base = String(SITE_URL || '').replace(/\/+$/, '');
  if (gatewayId === 'stripe') {
    return {
      successUrl: `${base}/pay/stripe/return?r=ok`,
      cancelUrl: `${base}/pay/stripe/return?r=cancel`,
    };
  }
  if (gatewayId === 'paypal') {
    return {
      successUrl: `${base}/pay/paypal/return?r=ok`,
      cancelUrl: `${base}/pay/paypal/return?r=cancel`,
    };
  }
  return {
    successUrl: `${base}/pay/return?r=ok`,
    failUrl: `${base}/pay/return?r=fail`,
    cancelUrl: `${base}/pay/return?r=cancel`,
    ipnUrl: `${base}/pay/ipn`,
  };
}

/** The default selection: the first gateway that can actually take money. */
function defaultGateway() {
  return gateways().find((g) => g.available)?.id || '';
}

function gatewayById(id) {
  return gateways().find((g) => g.id === String(id || '')) || null;
}

/** Is there any way at all to pay online right now? */
function anyGatewayAvailable() {
  return gateways().some((g) => g.available);
}

// ---------------------------------------------------------------------------
// What the customer is actually charged
// ---------------------------------------------------------------------------
/**
 * Convert an order total into the currency the gateway will take.
 *
 * Goes VIA THE BASE CURRENCY rather than cross-multiplying two rates directly,
 * because that is the only conversion this app has ever defined: every rate in
 * the `currencies` table is "units per one pound". USD -> BDT is therefore
 * USD -> GBP -> BDT, and doing it in one step would need a rate nobody
 * maintains.
 *
 * The BDT row is deliberately inactive — it is FX plumbing, not a currency
 * anyone is offered — so it has to be read with `includeInactive`.
 */
async function toSettlement(minor, orderCurrencyCode) {
  const code = String(orderCurrencyCode || '').toUpperCase();
  if (PASSTHROUGH.includes(code)) {
    return { minor, currency: code, rate: 1, converted: false };
  }

  const { all } = await currency.load({ includeInactive: true });
  const from = all.find((c) => c.code === code);
  const to = all.find((c) => c.code === SETTLE_CURRENCY);

  if (!to || !Number(to.rate)) {
    const err = new Error(
      `No rate for ${SETTLE_CURRENCY} in the currencies table — add one before taking payments.`,
    );
    err.code = 'NO_SETTLE_RATE';
    throw err;
  }

  const baseMinor = from ? currency.toBase(minor, from) : minor;
  // Rounded to a whole minor unit, once, here. The gateway is then sent a
  // decimal derived from this exact integer, so what we record and what we
  // charge cannot differ by a rounding step.
  const settled = Math.round(baseMinor * Number(to.rate));

  return {
    minor: settled,
    currency: to.code,
    rate: Number(to.rate),
    converted: true,
    display: currency.format(settled, to),
  };
}

/** A quote for the checkout page: "you will be charged ৳8,940". */
async function quote(order) {
  try {
    const out = await toSettlement(order.total_pence, order.currency);
    return out.converted ? out : null;
  } catch {
    // A missing rate must not take the checkout page down — the charge attempt
    // itself will fail loudly and say why.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Opening a payment
// ---------------------------------------------------------------------------
/**
 * Open a gateway session for an order and return where to send the browser.
 *
 * CALLED FROM TWO PLACES and therefore living in neither: once by the checkout,
 * which hands off to the gateway the moment the order is written, and once by
 * the Pay now button on the setup screen, for the customer who cancelled and
 * came back. Two copies of this would be two copies of the row-before-redirect
 * ordering below, and only one of them would stay correct.
 *
 * @returns {Promise<{ok: true, redirectUrl} | {ok: false, error}>}
 */
async function begin(order, customer, gatewayId, urls) {
  const gateway = gatewayById(gatewayId) || gatewayById(defaultGateway());
  if (!gateway || !gateway.available) {
    return { ok: false, error: 'That payment method is not available yet.' };
  }

  /*
   * `order_ref` is OURS and is unique per ATTEMPT, not per order.
   *
   * A customer who abandons the gateway and comes back gets a second attempt
   * and a second row. Reusing the order reference would collide on the unique
   * index the second time round and, worse, would make two attempts
   * indistinguishable in a dispute about a double charge.
   */
  const orderRef = `${order.reference}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  /*
   * Only SSLCommerz settles in taka. Stripe and PayPal both take GBP/USD/CAD
   * directly, so they charge the order's own currency and skip the BDT
   * conversion entirely — a rate that does not apply cannot be misapplied.
   */
  let charge;
  try {
    charge = gateway.id === 'sslcommerz'
      ? await toSettlement(order.total_pence, order.currency)
      : { minor: order.total_pence, currency: order.currency, rate: 1, converted: false };
  } catch (err) {
    console.error('[payments] settlement currency:', err.message);
    return {
      ok: false,
      error: 'Card payment is temporarily unavailable. Please contact us and we will take payment another way.',
    };
  }

  const integration = INTEGRATIONS[gateway.id];
  const started = await integration.initiate({
    amount: charge.minor / currency.MINOR,
    currency: charge.currency,
    orderRef,
    description: `Order ${order.reference} — Vesopa Hosting`,
    cusName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    cusEmail: customer.email,
    cusPhone: customer.phone,
    cusAddress: customer.address1,
    cusCity: customer.city,
    ...urls,
  });

  if (!started.ok) {
    await db.logActivity({
      actorType: 'customer', actorId: customer.id, action: 'payment.start_failed',
      target: order.reference, detail: started.error, ok: false,
    });
    return { ok: false, error: started.error };
  }

  /*
   * The row is written BEFORE the redirect, and that ordering is the point.
   *
   * The IPN can arrive while the customer's browser is still being redirected —
   * the gateway does not wait for us. Written afterwards, the IPN would look up
   * a `gateway_ref` that does not exist yet, find nothing, and the payment would
   * settle only if the browser happened to come back.
   */
  await db.query(
    `INSERT INTO payments
       (order_id, customer_id, gateway, status, amount_minor, currency,
        charged_minor, charged_currency, fx_rate, order_ref, gateway_ref)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id, customer.id, gateway.id,
      order.total_pence, order.currency,
      charge.minor, charge.currency, charge.rate,
      orderRef, started.tranId,
    ],
  );

  return { ok: true, redirectUrl: started.redirectUrl, gateway: gateway.id, charge };
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------
/**
 * Mark a payment paid, mark its order paid, and start provisioning.
 *
 * `gatewayRef` is the gateway's transaction id and the only key both callbacks
 * carry. Returns what happened so the caller can decide where to send the
 * browser — and `already: true` when this was the second of the two callbacks,
 * which is normal and not an error.
 */
async function settle(gatewayRef, payload = {}, { methodDetail = '' } = {}) {
  const payment = await db.one('SELECT * FROM payments WHERE gateway_ref = ? LIMIT 1', [gatewayRef]);
  if (!payment) return { ok: false, reason: 'unknown_payment' };

  if (payment.status === 'paid') {
    return { ok: true, already: true, orderId: payment.order_id, payment };
  }

  /*
   * The guard is the WHERE clause, not an if.
   *
   * `status = 'pending'` in the UPDATE is what makes this safe when the IPN and
   * the browser return arrive at the same moment: exactly one of them changes a
   * row, and the loser sees affectedRows 0 and stops. Reading the status first
   * and then writing leaves a window between the two, and that window is where
   * an order gets provisioned twice.
   */
  const [res] = await db.pool.query(
    `UPDATE payments
        SET status = 'paid', settled_at = NOW(), payload = ?, method_detail = ?
      WHERE id = ? AND status = 'pending'`,
    [JSON.stringify(payload).slice(0, 60000), methodDetail.slice(0, 120), payment.id],
  );
  if (res.affectedRows !== 1) {
    return { ok: true, already: true, orderId: payment.order_id, payment };
  }

  const order = await db.one('SELECT * FROM orders WHERE id = ? LIMIT 1', [payment.order_id]);
  if (!order) return { ok: false, reason: 'unknown_order' };

  // Same clause-as-guard trick. An order an admin has already marked paid by
  // hand is left exactly as it is.
  await db.pool.query(
    `UPDATE orders
        SET status = 'paid', paid_at = NOW(), payment_method = ?, payment_ref = ?
      WHERE id = ? AND status = 'pending'`,
    [payment.gateway, gatewayRef, order.id],
  );

  await db.logActivity({
    actorType: 'customer',
    actorId: order.customer_id,
    action: 'order.paid',
    target: order.reference,
    detail: `${payment.gateway} · ${(payment.charged_minor / 100).toFixed(2)} ${payment.charged_currency}`
      + ` for ${(payment.amount_minor / 100).toFixed(2)} ${payment.currency}`,
  });

  /*
   * Provision, unless the customer still owes us an answer.
   *
   * Exactly the rule the admin's "mark paid" button follows, and for the same
   * reason: a hosting service sitting at the `domain` step is waiting to be
   * told which domain it is for, including the free one. Provisioning here
   * would answer that with "none" before the customer ever saw the question,
   * and the free domain would be quietly lost.
   */
  const waiting = await db.one(
    `SELECT id FROM services WHERE order_id = ? AND setup_step = 'domain' AND status = 'pending' LIMIT 1`,
    [order.id],
  );

  if (!waiting) {
    // Not awaited. Provisioning talks to a registrar and a hosting node and can
    // take a minute; the customer is mid-redirect and must not be held on it.
    // The setup screen polls `setup_steps` and shows the progress.
    provisioning
      .provisionOrder(order.id, { actorType: 'customer', actorId: order.customer_id })
      .catch((err) => console.error('[payments] provisioning failed:', err.message));
  }

  return { ok: true, already: false, orderId: order.id, order, payment, waiting: Boolean(waiting) };
}

/** Record a payment that did not happen, and say why. */
async function fail(gatewayRef, reason = 'FAILED', payload = {}, status = 'failed') {
  const [res] = await db.pool.query(
    `UPDATE payments
        SET status = ?, failure_reason = ?, payload = ?
      WHERE gateway_ref = ? AND status = 'pending'`,
    [status, String(reason).slice(0, 190), JSON.stringify(payload).slice(0, 60000), gatewayRef],
  );
  if (!res.affectedRows) return null;
  return db.one('SELECT * FROM payments WHERE gateway_ref = ? LIMIT 1', [gatewayRef]);
}

/**
 * An order that costs nothing.
 *
 * A 100%-off coupon produces a real order with real services on it and a total
 * of zero, and there is nothing for a gateway to do with that — SSLCommerz
 * rejects a zero amount, as it should. Sending the customer to a payment page
 * to pay nothing is the worst of both: it fails, and it fails at the moment
 * they expected to be finished.
 *
 * So a free order settles here, immediately, and is recorded as a payment with
 * gateway `free` so the order still has a payment row and the books still
 * balance at zero rather than having a hole in them.
 */
async function settleFree(order) {
  const ref = `FREE-${order.reference}`;
  await db.query(
    `INSERT INTO payments
       (order_id, customer_id, gateway, status, amount_minor, currency,
        charged_minor, charged_currency, fx_rate, order_ref, gateway_ref, settled_at, method_detail)
     VALUES (?, ?, 'free', 'paid', 0, ?, 0, ?, 1.000000, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE status = 'paid', settled_at = NOW()`,
    [order.id, order.customer_id, order.currency, order.currency, ref, ref,
      order.coupon_code ? `100% off — ${order.coupon_code}` : 'No payment required'],
  );

  await db.pool.query(
    `UPDATE orders SET status = 'paid', paid_at = NOW(), payment_method = 'free', payment_ref = ?
      WHERE id = ? AND status = 'pending'`,
    [ref, order.id],
  );

  await db.logActivity({
    actorType: 'customer',
    actorId: order.customer_id,
    action: 'order.free',
    target: order.reference,
    detail: order.coupon_code ? `100% off with ${order.coupon_code}` : 'Zero total',
  });

  const waiting = await db.one(
    `SELECT id FROM services WHERE order_id = ? AND setup_step = 'domain' AND status = 'pending' LIMIT 1`,
    [order.id],
  );
  if (!waiting) {
    provisioning
      .provisionOrder(order.id, { actorType: 'customer', actorId: order.customer_id })
      .catch((err) => console.error('[payments] provisioning failed:', err.message));
  }

  return { ok: true, orderId: order.id, waiting: Boolean(waiting) };
}

module.exports = {
  SETTLE_CURRENCY,
  PASSTHROUGH,
  gateways,
  gatewayById,
  callbackUrls,
  defaultGateway,
  anyGatewayAvailable,
  toSettlement,
  quote,
  begin,
  settle,
  fail,
  settleFree,
};
