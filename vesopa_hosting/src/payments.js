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
const { SITE_URL, PAYMENT_SESSION_MINUTES } = require('./config');
const sslcommerz = require('./integrations/sslcommerz');
const stripe = require('./integrations/stripe');
const paypal = require('./integrations/paypal');
const btcpay = require('./integrations/btcpay');

/**
 * One adapter per gateway id, all sharing the same initiate() contract.
 *
 * The key is the GATEWAY ID, which is what lands in `payments.gateway` and what
 * every lookup here goes through — so crypto's adapter is filed under `crypto`
 * even though the file is named for BTCPay. The product sells "cryptocurrency";
 * which server implements it is an implementation detail that could change
 * without rewriting every historical payment row.
 */
const INTEGRATIONS = { sslcommerz, stripe, paypal, crypto: btcpay };

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
/**
 * May a gateway that does not take real money be offered?
 *
 * NOT IN PRODUCTION, ever. A mock gateway settles an order and provisions it
 * without a payment, and PayPal's sandbox does the same thing with a more
 * convincing screen in the middle — the customer approves on
 * sandbox.paypal.com, comes back, and the order goes green having cost them
 * nothing. On a dev box that is the whole point; on the live site it is a
 * checkout that gives the product away to anyone who picks the right radio
 * button, and it is invisible afterwards because the order looks exactly like
 * a paid one.
 *
 * Gated on NODE_ENV rather than on each adapter's own mode, so a gateway left
 * in test mode by mistake cannot be reached by a customer at all. It still
 * shows on the checkout, disabled, and the admin dashboard says why.
 */
const ALLOW_TEST_GATEWAYS = process.env.NODE_ENV !== 'production';

/** Is this adapter taking real money, as opposed to pretending to? */
function takesRealMoney(st) {
  return st.configured && st.mode !== 'mock' && st.mode !== 'sandbox';
}

/** Should this gateway be offered at all? */
function offerable(st) {
  return takesRealMoney(st) || (ALLOW_TEST_GATEWAYS && (st.configured || st.mode === 'mock'));
}

/**
 * Why a gateway is not on offer, in words an admin can act on.
 *
 * "Off" on its own sends somebody to check credentials that are perfectly
 * fine. A gateway held back because it is in test mode on a production box is
 * a different problem with a different fix, and the two look identical from
 * every screen unless this says so.
 */
function unavailableReason(st) {
  if (offerable(st)) return '';
  if (!st.configured && st.mode !== 'mock') return 'No credentials set.';
  return `In ${st.mode} mode, which cannot take real money — not offered on a production site.`;
}

function gateways() {
  const ssl = sslcommerz.status();
  const str = stripe.status();
  const pp = paypal.status();
  const btc = btcpay.status();
  return [
    {
      id: 'sslcommerz',
      name: 'SSLCommerz',
      blurb: 'Cards, mobile wallets and net banking.',
      logo: '/assets/img/pay/sslcommerz.svg',
      // Mock counts as available on a dev machine on purpose: it is how the
      // whole journey is walked without a gateway account. Never in production
      // — see ALLOW_TEST_GATEWAYS.
      available: offerable(ssl),
      reason: unavailableReason(ssl),
      mock: !takesRealMoney(ssl),
      note: ssl.mode === 'mock' ? 'Test mode — no money moves.' : '',
    },
    {
      id: 'stripe',
      name: 'Stripe',
      blurb: 'Card payments, Apple Pay and Google Pay.',
      logo: '/assets/img/pay/stripe.svg',
      available: offerable(str),
      reason: unavailableReason(str),
      mock: !takesRealMoney(str),
      note: str.mode === 'mock' ? 'Test mode — no money moves.' : '',
    },
    {
      id: 'paypal',
      name: 'PayPal',
      blurb: 'Pay with your PayPal account.',
      logo: '/assets/img/pay/paypal.svg',
      available: offerable(pp),
      reason: unavailableReason(pp),
      // Sandbox counts as mock HERE even though PayPal calls it a real
      // environment, because the only thing this flag decides is "can an order
      // paid this way have actually been paid for", and the answer is no.
      mock: !takesRealMoney(pp),
      note: pp.mode === 'sandbox' ? 'Sandbox — no real money moves.' : (pp.mode === 'mock' ? 'Test mode — no money moves.' : ''),
    },
    {
      id: 'crypto',
      name: 'Cryptocurrency',
      /*
       * WHAT THE STORE ACTUALLY OFFERS, which is not the same as what it has
       * enabled. The BTCPay store has USDT switched on for Tron, Polygon and
       * Ethereum, but no invoice it issues offers them — Polygon has no
       * receiving address configured at all and the Tron pool is too small to
       * reserve one per invoice — so every invoice comes back offering BTC
       * on-chain, Lightning and LNURL only. Naming USDT here would promise a
       * customer a method that is not on the page they are sent to. Put it
       * back the day an invoice offers it.
       */
      blurb: 'Bitcoin and Lightning, on our own payment server.',
      logo: '/assets/img/pay/crypto.svg',
      available: offerable(btc),
      reason: unavailableReason(btc),
      mock: !takesRealMoney(btc),
      /*
       * Crypto gets a longer session than the card gateways — see the note on
       * BTCPAY_SESSION_MINUTES. A card either authorises or does not; an
       * on-chain payment can be broadcast inside the window and confirm well
       * outside it, and closing the attempt at ninety minutes would write off a
       * payment that is simply waiting for a block.
       */
      sessionMinutes: btcpay.SESSION_MINUTES,
      note: btc.mode === 'mock' ? 'Test mode — no money moves.' : '',
      /*
       * Crypto needs its own reassurance line, because the stock one is about
       * card details and this method has none. It also has to set the right
       * expectation about time: a card is decided in seconds, a chain payment
       * is not, and a customer who is not told that reads a few minutes of
       * "confirming" as something having gone wrong.
       */
      secure: 'You are taken to our own payment server to pay. We wait for the'
        + ' network to confirm — usually a few minutes — and your order starts'
        + ' the moment it does.',
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
  /*
   * BTCPay redirects to ONE url and has no cancel target — a customer who
   * changes their mind on the checkout page just closes it, and the invoice
   * expires on its own. So there is no cancel branch to write here, and the
   * attempt is closed by the reconciler rather than by a callback that will
   * never come.
   */
  if (gatewayId === 'crypto') {
    return { successUrl: `${base}/pay/crypto/return` };
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
   * Only SSLCommerz settles in taka. Stripe, PayPal and BTCPay all take
   * GBP/USD/CAD directly, so they charge the order's own currency and skip the
   * BDT conversion entirely — a rate that does not apply cannot be misapplied.
   *
   * BTCPay in particular is handed the FIAT figure and does its own conversion
   * to whichever coin the customer picks. Converting to a coin here would mean
   * two rates for one payment, ours and BTCPay's, and the customer would be
   * quoted against whichever we happened to fetch first.
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
    description: `Order ${order.reference} — Vesopa Cloud`,
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
  /*
   * `expires_at` is when this attempt stops being worth asking the gateway
   * about. Until then the reconciler polls it — a customer who pays and then
   * closes the tab never hits the return URL, and Stripe and PayPal send no
   * IPN of their own, so without that poll their money would sit at the
   * gateway with an order marked pending behind it.
   */
  await db.query(
    `INSERT INTO payments
       (order_id, customer_id, gateway, status, amount_minor, currency,
        charged_minor, charged_currency, fx_rate, order_ref, gateway_ref, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [
      order.id, customer.id, gateway.id,
      order.total_pence, order.currency,
      charge.minor, charge.currency, charge.rate,
      orderRef, started.tranId,
      // Per gateway, not one number for all of them: see the crypto entry in
      // gateways(), whose session has to outlive a slow block confirmation.
      Number(gateway.sessionMinutes) || PAYMENT_SESSION_MINUTES,
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
   * THE ACCOUNT IS BUILT HERE, and nowhere earlier.
   *
   * activateOrder() writes the service, domain and mailbox rows this order paid
   * for and then starts provisioning — unless a hosting service is still
   * waiting to be told which domain it is for, in which case the setup wizard
   * asks and starts it. Every other route that can confirm a payment calls the
   * same function, so the rule has one home.
   */
  const activated = await provisioning.activateOrder(order.id, {
    actorType: 'customer',
    actorId: order.customer_id,
  });

  return {
    ok: true,
    already: false,
    orderId: order.id,
    order,
    payment,
    waiting: Boolean(activated.waiting),
  };
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

  const activated = await provisioning.activateOrder(order.id, {
    actorType: 'customer',
    actorId: order.customer_id,
  });

  return { ok: true, orderId: order.id, waiting: Boolean(activated.waiting) };
}

// ---------------------------------------------------------------------------
// Asking the gateway what became of a payment
// ---------------------------------------------------------------------------

/**
 * Re-check one pending attempt against the gateway that owns it.
 *
 * THE CUSTOMER'S BROWSER IS NOT PART OF THIS. The return URL exists to show
 * somebody a page; it is not how we find out whether we were paid. A tab closed
 * on the confirmation screen, a phone that lost signal on the way back, a
 * gateway whose IPN never arrived — in all three the money moved and only the
 * gateway knows it. So the server asks, on a timer, until the attempt is
 * settled or its session is dead.
 *
 * Settlement itself still goes through `settle()`, with its
 * status-in-the-WHERE-clause guard, so an answer arriving here at the same
 * moment as an IPN cannot provision an order twice.
 *
 * @returns {Promise<{outcome: 'paid'|'failed'|'expired'|'pending'|'unsupported', detail?: string}>}
 */
async function reconcilePayment(payment) {
  const ref = payment.gateway_ref;
  if (!ref) return { outcome: 'pending', detail: 'No gateway reference.' };

  if (payment.gateway === 'stripe') {
    if (stripe.MODE === 'mock') return { outcome: 'unsupported', detail: 'Stripe is in mock mode.' };

    let session;
    try {
      session = await stripe.retrieveSession(ref);
    } catch (err) {
      // The session is gone from Stripe entirely. Nothing will ever settle it,
      // so it is closed rather than asked about every five minutes forever.
      if (err.stripeCode === 'resource_missing') {
        await fail(ref, 'NOT_FOUND', { source: 'reconcile', error: err.message }, 'cancelled');
        return { outcome: 'failed', detail: 'Stripe no longer has that session.' };
      }
      throw err;
    }
    if (stripe.isPaidSession(session)) {
      await settle(ref, { ...session, source: 'reconcile' }, { methodDetail: stripe.describeMethod(session) });
      return { outcome: 'paid' };
    }
    if (session.status === 'expired') {
      await fail(ref, 'EXPIRED', { ...session, source: 'reconcile' }, 'failed');
      return { outcome: 'failed', detail: 'The Stripe session expired.' };
    }
    return { outcome: 'pending', detail: session.status || '' };
  }

  if (payment.gateway === 'paypal') {
    if (paypal.MODE === 'mock') return { outcome: 'unsupported', detail: 'PayPal is in mock mode.' };

    let order;
    try {
      order = await paypal.getOrder(ref);
    } catch (err) {
      /*
       * PayPal has no record of this order. Seen for real on the first live
       * pass: an approval the customer never completed, on an order PayPal has
       * since dropped — it answers 404 RESOURCE_NOT_FOUND and will do so
       * forever. Retrying it every five minutes achieves nothing except a
       * noisy log, so the attempt is closed.
       */
      if (err.paypalName === 'RESOURCE_NOT_FOUND') {
        await fail(ref, 'NOT_FOUND', { source: 'reconcile', error: err.message.slice(0, 400) }, 'cancelled');
        return { outcome: 'failed', detail: 'PayPal no longer has that order.' };
      }
      throw err;
    }
    if (paypal.isPaidOrder(order)) {
      await settle(ref, { ...order, source: 'reconcile' }, { methodDetail: paypal.describeMethod(order) });
      return { outcome: 'paid' };
    }
    /*
     * APPROVED means the payer said yes and nobody has taken the money. That is
     * the exact state a closed tab leaves behind, and capturing it is the whole
     * reason this reconciler exists — the alternative is an authorised payment
     * that quietly expires and a customer who believes they have paid.
     */
    if (paypal.isApprovedOrder(order)) {
      const captured = await paypal.captureOrder(ref);
      if (paypal.isPaidOrder(captured)) {
        await settle(ref, { ...captured, source: 'reconcile' }, { methodDetail: paypal.describeMethod(captured) });
        return { outcome: 'paid', detail: 'Captured an approved order.' };
      }
      return { outcome: 'pending', detail: captured.status || 'capture did not complete' };
    }
    if (['VOIDED', 'EXPIRED'].includes(String(order.status || '').toUpperCase())) {
      await fail(ref, order.status, { ...order, source: 'reconcile' }, 'failed');
      return { outcome: 'failed', detail: order.status };
    }
    return { outcome: 'pending', detail: order.status || '' };
  }

  if (payment.gateway === 'crypto') {
    if (btcpay.MODE === 'mock') return { outcome: 'unsupported', detail: 'BTCPay is in mock mode.' };

    let invoice;
    try {
      invoice = await btcpay.getInvoice(ref);
    } catch (err) {
      /*
       * 403 AND 404 BOTH MEAN "no invoice for you", and only one of them means
       * the invoice is gone — see storeReachable(). A revoked or expired API
       * key answers 403 for every invoice there is, and closing attempts on
       * that would cancel payments that are confirming perfectly well.
       *
       * So the store is asked whether it still knows us. If it does, this one
       * invoice really is missing and the attempt is closed. If it does not,
       * nothing is touched: the attempt keeps its pending status, the log says
       * why, and it closes on its session expiry like any other stall.
       */
      if (err.httpStatus === 404 || err.httpStatus === 403) {
        if (await btcpay.storeReachable()) {
          await fail(ref, 'NOT_FOUND', { source: 'reconcile', error: err.message }, 'cancelled');
          return { outcome: 'failed', detail: 'BTCPay no longer has that invoice.' };
        }
        console.error('[payments] BTCPay refused the store as well — check BTCPAY_API_KEY. Leaving attempts alone.');
        return { outcome: 'pending', detail: 'BTCPay is refusing our key.' };
      }
      throw err;
    }

    if (btcpay.isPaidInvoice(invoice)) {
      await settle(ref, { ...invoice, source: 'reconcile' }, { methodDetail: btcpay.describeMethod(invoice) });
      return { outcome: 'paid' };
    }

    if (btcpay.isDeadInvoice(invoice)) {
      await fail(ref, invoice.status, { ...invoice, source: 'reconcile' }, 'failed');
      return { outcome: 'failed', detail: invoice.status };
    }

    /*
     * Anything else stays pending ON PURPOSE, including an expired invoice that
     * received money.
     *
     * `Processing` is a payment waiting on a block and will settle itself.
     * `Expired` with a partial or late payment is coins we are holding against
     * an order nobody has fulfilled, and the worst thing this function could do
     * with that is tidy it away as a failure — the customer would see a
     * cancelled order and an empty wallet. It is left open and shouted about in
     * the log so a human deals with it; the sweep below closes it only once the
     * session is properly dead, and the payload keeps the evidence either way.
     */
    if (btcpay.hasPartialPayment(invoice)) {
      console.warn(
        `[payments] crypto invoice ${ref} is ${invoice.status}/${invoice.additionalStatus}`
        + ' — money arrived but the invoice did not settle. Needs a human.',
      );
      return { outcome: 'pending', detail: `${invoice.status} · ${invoice.additionalStatus}` };
    }

    return { outcome: 'pending', detail: invoice.status || '' };
  }

  /*
   * SSLCommerz, via BosheBoshe, offers this integration no transaction-status
   * endpoint — settlement arrives by IPN and by the browser return, both signed.
   * Rather than invent a URL to poll, an attempt of theirs is left alone until
   * its session expires and is then closed out below. Said plainly here so the
   * next person does not go looking for the query call that is "missing".
   */
  return { outcome: 'unsupported', detail: 'This gateway has no status lookup.' };
}

/** Close out an attempt whose gateway session is long dead. */
async function expirePayment(payment) {
  const closed = await fail(
    payment.gateway_ref,
    'SESSION_EXPIRED',
    { source: 'reconcile', note: 'The payment session expired without settling.' },
    'cancelled',
  );
  if (closed) {
    await db.logActivity({
      actorType: 'system', actorId: payment.customer_id, action: 'payment.expired',
      target: payment.order_ref, detail: `${payment.gateway} attempt never completed`, ok: false,
    });
  }
  return Boolean(closed);
}

module.exports = {
  SETTLE_CURRENCY,
  PASSTHROUGH,
  reconcilePayment,
  expirePayment,
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
