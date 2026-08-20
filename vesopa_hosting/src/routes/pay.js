/**
 * The payment journey.
 *
 *   POST /pay/:id/start      open a session and redirect to the gateway
 *   GET  /pay/return         the browser comes back — success, fail or cancel
 *   POST /pay/ipn            the gateway tells the server, out of band
 *   GET  /pay/mock/:tranId   the fake gateway, in mock mode only
 *
 * ONE RETURN URL FOR ALL THREE OUTCOMES, and the gateway is told which is
 * which with a `?r=` it signs along with everything else. Three near-identical
 * handlers was the alternative, and the copy that would have drifted is the
 * signature check.
 *
 * THE IPN IS THE SOURCE OF TRUTH, NOT THE BROWSER RETURN.
 *
 * A customer who closes the tab on the gateway's confirmation screen never
 * hits the return URL, and their payment still happened. The IPN arrives
 * regardless, server to server, and settles the order on its own. The return
 * handler exists to show the customer something — it settles too, because it
 * usually arrives first, but nothing depends on it.
 */

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const payments = require('../payments');
const sslcommerz = require('../integrations/sslcommerz');
const stripe = require('../integrations/stripe');
const paypal = require('../integrations/paypal');
const btcpay = require('../integrations/btcpay');
const currency = require('../currency');
const { flash } = require('../http-utils');

const router = express.Router();

/** The order, if it belongs to the signed-in customer and still wants paying. */
async function payableOrder(req) {
  if (!req.customer) return null;
  const order = await db.one(
    'SELECT * FROM orders WHERE id = ? AND customer_id = ? LIMIT 1',
    [req.params.id, req.customer.id],
  );
  if (!order) return null;
  return order;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
router.post('/pay/:id/start', async (req, res, next) => {
  try {
    if (!req.customer) return res.redirect(`/login?next=${encodeURIComponent(`/panel/setup/${req.params.id}`)}`);
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/setup/${req.params.id}`);

    const order = await payableOrder(req);
    if (!order) return next();

    const back = `/panel/setup/${order.id}`;
    if (order.status !== 'pending') {
      flash(res, `That order is already ${order.status}.`, 'warn');
      return res.redirect(back);
    }

    // A 100%-off basket never reaches a gateway. See settleFree().
    if (Number(order.total_pence) === 0) {
      await payments.settleFree(order);
      flash(res, 'No payment needed — your order is confirmed.');
      return res.redirect(back);
    }

    const started = await payments.begin(order, req.customer, req.body.gateway, payments.callbackUrls(req.body.gateway));
    if (!started.ok) {
      flash(res, started.error, 'error');
      return res.redirect(back);
    }

    res.redirect(303, started.redirectUrl);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The browser comes back
// ---------------------------------------------------------------------------
router.get('/pay/return', async (req, res, next) => {
  try {
    const q = { ...req.query };
    const outcome = String(q.r || 'ok');
    // `r` is ours, added to the callback URL — but the gateway signs the whole
    // query string it receives, `r` included, so it has to stay in the payload
    // being verified. Removing it here would break every signature.
    const tranId = String(q.tran_id || '');

    /*
     * Mock mode skips the signature, and ONLY mock mode.
     *
     * The fake gateway has no secret to sign with. This is the one branch in
     * the payment path that trusts an unsigned request, it is gated on the
     * adapter's own mode rather than on anything in the request, and it cannot
     * be reached on a live install.
     */
    const trusted = sslcommerz.MODE === 'mock' || sslcommerz.verifySignature(q);

    if (!tranId || !trusted) {
      console.warn('[pay] rejected an unverified return', { tranId, outcome });
      flash(res, 'We could not verify that payment. If money has left your account, contact us and we will sort it out today.', 'error');
      return res.redirect('/panel');
    }

    if (outcome === 'ok' && sslcommerz.isPaidStatus(q.status)) {
      const settled = await payments.settle(tranId, q, { methodDetail: sslcommerz.describeMethod(q) });
      if (!settled.ok) return next();
      flash(res, settled.already ? 'That payment is already confirmed.' : 'Payment received — thank you.');
      return res.redirect(`/panel/setup/${settled.orderId}`);
    }

    const status = outcome === 'cancel' ? 'cancelled' : 'failed';
    const failed = await payments.fail(tranId, q.status || status.toUpperCase(), q, status);
    const orderId = failed ? failed.order_id : null;

    flash(
      res,
      status === 'cancelled'
        ? 'Payment cancelled — nothing has been charged and your order is still here.'
        : 'That payment did not go through. Nothing has been charged; you can try again.',
      status === 'cancelled' ? 'warn' : 'error',
    );
    res.redirect(orderId ? `/panel/setup/${orderId}` : '/panel');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Stripe: the browser comes back
// ---------------------------------------------------------------------------
/**
 * No signature to check here — nothing from this request is trusted at all.
 * `session_id` only tells us which session to ask Stripe about; the answer
 * that decides whether the order is paid comes from Stripe's own API, fetched
 * fresh, the same principle as SSLCommerz's HMAC check applied a different
 * way. A forged `session_id` for someone else's session would just return
 * that other session back, still `payment_status !== 'paid'` from this
 * customer's side of it, or — if genuinely paid — settle a payment that was
 * genuinely made, which is not a hole.
 */
router.get('/pay/stripe/return', async (req, res, next) => {
  try {
    const outcome = String(req.query.r || 'ok');
    const sessionId = String(req.query.session_id || '');

    if (outcome === 'cancel' || !sessionId) {
      const failed = sessionId ? await payments.fail(sessionId, 'CANCELLED', {}, 'cancelled') : null;
      flash(res, 'Payment cancelled — nothing has been charged and your order is still here.', 'warn');
      return res.redirect(failed ? `/panel/setup/${failed.order_id}` : '/panel');
    }

    // Mock mode skips the real lookup — there is no genuine session at Stripe
    // to ask about — and trusts `r` instead, the same one exception
    // sslcommerz.js's mock mode makes for its own signature check.
    let paid;
    let methodDetail;
    let payload;
    if (stripe.MODE === 'mock') {
      paid = outcome === 'ok';
      methodDetail = 'Test card';
      payload = { mock: true, session_id: sessionId, payment_status: paid ? 'paid' : 'unpaid' };
    } else {
      try {
        payload = await stripe.retrieveSession(sessionId);
      } catch (err) {
        console.error('[pay] stripe retrieve failed:', err.message);
        flash(res, 'We could not verify that payment. If money has left your account, contact us and we will sort it out today.', 'error');
        return res.redirect('/panel');
      }
      paid = stripe.isPaidSession(payload);
      methodDetail = stripe.describeMethod(payload);
    }

    if (paid) {
      const settled = await payments.settle(sessionId, payload, { methodDetail });
      if (!settled.ok) return next();
      flash(res, settled.already ? 'That payment is already confirmed.' : 'Payment received — thank you.');
      return res.redirect(`/panel/setup/${settled.orderId}`);
    }

    const failed = await payments.fail(sessionId, payload.payment_status || 'FAILED', payload);
    flash(res, 'That payment did not go through. Nothing has been charged; you can try again.', 'error');
    res.redirect(failed ? `/panel/setup/${failed.order_id}` : '/panel');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PayPal: the browser comes back
// ---------------------------------------------------------------------------
/**
 * PayPal appends the order id as `token` to whichever of return_url /
 * cancel_url it sends the browser back to — that is PayPal's own convention,
 * not ours. Capturing here is what confirms the money moved; nothing about a
 * capture succeeding depends on anything the browser supplied.
 */
router.get('/pay/paypal/return', async (req, res, next) => {
  try {
    const outcome = String(req.query.r || 'ok');
    const orderId = String(req.query.token || '');

    if (outcome === 'cancel' || !orderId) {
      const failed = orderId ? await payments.fail(orderId, 'CANCELLED', {}, 'cancelled') : null;
      flash(res, 'Payment cancelled — nothing has been charged and your order is still here.', 'warn');
      return res.redirect(failed ? `/panel/setup/${failed.order_id}` : '/panel');
    }

    // Mock mode skips the real capture — there is no genuine order at PayPal
    // to capture — and trusts `r` instead, same exception as sslcommerz.js.
    let paid;
    let methodDetail;
    let payload;
    if (paypal.MODE === 'mock') {
      paid = outcome === 'ok';
      methodDetail = 'paypal';
      payload = { mock: true, id: orderId, status: paid ? 'COMPLETED' : 'FAILED' };
    } else {
      try {
        payload = await paypal.captureOrder(orderId);
      } catch (err) {
        console.error('[pay] paypal capture failed:', err.message);
        flash(res, 'We could not verify that payment. If money has left your account, contact us and we will sort it out today.', 'error');
        return res.redirect('/panel');
      }
      paid = paypal.isPaidOrder(payload);
      methodDetail = paypal.describeMethod(payload);
    }

    if (paid) {
      const settled = await payments.settle(orderId, payload, { methodDetail });
      if (!settled.ok) return next();
      flash(res, settled.already ? 'That payment is already confirmed.' : 'Payment received — thank you.');
      return res.redirect(`/panel/setup/${settled.orderId}`);
    }

    const failed = await payments.fail(orderId, payload.status || 'FAILED', payload);
    flash(res, 'That payment did not go through. Nothing has been charged; you can try again.', 'error');
    res.redirect(failed ? `/panel/setup/${failed.order_id}` : '/panel');
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Crypto: the browser comes back
// ---------------------------------------------------------------------------
/**
 * BTCPay sends the browser here with OUR order reference, and nothing else.
 *
 * That reference finds our own payment row; the invoice id we then ask BTCPay
 * about comes from the row, never from the query string. So the worst a forged
 * `ref` can do is name somebody else's attempt, which is then looked up under
 * this customer's id and found not to be theirs.
 *
 * THE INTERESTING CASE IS "PAID BUT NOT CONFIRMED".
 *
 * On a card, the browser comes back to a yes or a no. On-chain it comes back to
 * `Processing` almost every time — the customer has paid, the transaction is in
 * the mempool, and it is not yet money. Telling them that failed would be wrong
 * and telling them it succeeded would be worse, because the order has not
 * started and will not until the webhook or the reconciler sees `Settled`. So
 * that state gets its own message and its own colour, and the order is left
 * exactly as it is.
 */
router.get('/pay/crypto/return', async (req, res, next) => {
  try {
    const orderRef = String(req.query.ref || '');
    if (!orderRef) return res.redirect('/panel');

    const payment = await db.one('SELECT * FROM payments WHERE order_ref = ? LIMIT 1', [orderRef]);
    if (!payment) return next();
    const back = `/panel/setup/${payment.order_id}`;

    // Mock mode has no invoice at BTCPay to ask about, so it trusts `r` —
    // the same single exception the other three adapters' mocks make.
    if (btcpay.MODE === 'mock') {
      const outcome = String(req.query.r || 'ok');
      if (outcome === 'ok') {
        const settled = await payments.settle(payment.gateway_ref, { mock: true, status: 'Settled' }, { methodDetail: 'BTC-CHAIN (test)' });
        flash(res, settled.already ? 'That payment is already confirmed.' : 'Payment received — thank you.');
        return res.redirect(settled.ok ? `/panel/setup/${settled.orderId}` : back);
      }
      await payments.fail(payment.gateway_ref, outcome === 'cancel' ? 'CANCELLED' : 'FAILED', { mock: true }, outcome === 'cancel' ? 'cancelled' : 'failed');
      flash(res, 'Payment cancelled — nothing has been charged and your order is still here.', 'warn');
      return res.redirect(back);
    }

    let invoice;
    try {
      invoice = await btcpay.getInvoice(payment.gateway_ref);
    } catch (err) {
      console.error('[pay] btcpay lookup failed:', err.message);
      flash(res, 'We could not check that payment just now. If you have sent the payment it will be picked up automatically — nothing is lost.', 'warn');
      return res.redirect(back);
    }

    if (btcpay.isPaidInvoice(invoice)) {
      const settled = await payments.settle(payment.gateway_ref, invoice, { methodDetail: btcpay.describeMethod(invoice) });
      if (!settled.ok) return next();
      flash(res, settled.already ? 'That payment is already confirmed.' : 'Payment received — thank you.');
      return res.redirect(`/panel/setup/${settled.orderId}`);
    }

    if (btcpay.isPendingInvoice(invoice) || btcpay.hasPartialPayment(invoice)) {
      flash(
        res,
        'Payment received and waiting to confirm on the network. This usually takes a few minutes'
        + ' — your order starts automatically as soon as it does, and there is nothing else to do.',
        'warn',
      );
      return res.redirect(back);
    }

    /*
     * Nothing was paid — an invoice the customer opened and left. It is NOT
     * failed here: the invoice may still be inside its window and payable, and
     * marking the attempt failed would take away the "Pay now" they came back
     * for. The reconciler closes it once the session is genuinely dead.
     */
    flash(res, 'No payment received yet. Your order is still here whenever you are ready.', 'warn');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Crypto: the webhook
// ---------------------------------------------------------------------------
/**
 * BTCPay tells the server, out of band. This is what actually settles a
 * crypto payment in practice — see the return handler above for why the
 * browser almost never comes back to a settled invoice.
 *
 * Verified against the RAW body, and nothing in the delivery is trusted beyond
 * the invoice id it names: the invoice is fetched back from BTCPay and its
 * status read from that, so a replayed delivery for an invoice that has since
 * gone Invalid cannot settle an order.
 *
 * No CSRF check, for the same reason as the SSLCommerz IPN: this is a
 * server-to-server request with no cookie and no session. The signature is the
 * authentication.
 */
router.post('/pay/crypto/webhook', async (req, res) => {
  if (!btcpay.verifyWebhook(req.rawBody, req.get('BTCPay-Sig'))) {
    console.warn('[pay] rejected an unverified BTCPay webhook');
    return res.status(401).json({ ok: false, error: 'Invalid signature' });
  }

  const invoiceId = String(req.body?.invoiceId || '');
  const type = String(req.body?.type || '');
  if (!invoiceId) return res.json({ ok: true, ignored: 'no invoice id' });

  try {
    const invoice = await btcpay.getInvoice(invoiceId);

    if (btcpay.isPaidInvoice(invoice)) {
      await payments.settle(invoiceId, { ...invoice, source: 'webhook', type }, { methodDetail: btcpay.describeMethod(invoice) });
      return res.json({ ok: true });
    }

    if (btcpay.isDeadInvoice(invoice)) {
      await payments.fail(invoiceId, invoice.status, { ...invoice, source: 'webhook', type }, 'failed');
      return res.json({ ok: true });
    }

    /*
     * Processing, or expired with money on it. Neither is settled and neither
     * is a failure, so the attempt is left alone — the reconciler is watching
     * it and a partial payment is a support job, not a status change. Answered
     * 200 all the same: BTCPay retries anything else, and there is nothing here
     * for a retry to fix.
     */
    if (btcpay.hasPartialPayment(invoice)) {
      console.warn(`[pay] crypto invoice ${invoiceId} is ${invoice.status}/${invoice.additionalStatus} — needs a human.`);
    }
    res.json({ ok: true, noted: invoice.status });
  } catch (err) {
    console.error('[pay] btcpay webhook failed:', err.message);
    // A 500 asks BTCPay to redeliver, and that is right: we failed to record
    // something about a payment that may well have happened.
    res.status(500).json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// The IPN
// ---------------------------------------------------------------------------
/**
 * Server to server, and the record that actually matters.
 *
 * Always answers 200 on anything it has handled — including a duplicate — because
 * a gateway that receives an error retries, and retrying a payment we have
 * already settled achieves nothing but noise. A 401 is reserved for a payload
 * that fails the signature, which is the one case where we want the gateway (or
 * whoever is pretending to be it) to be told no.
 *
 * No CSRF check: this request comes from the gateway, not from a browser with a
 * session, and there is no cookie involved. The signature is the authentication.
 */
router.post('/pay/ipn', async (req, res) => {
  const q = { ...(req.body || {}), ...(req.query || {}) };
  const tranId = String(q.tran_id || '');

  if (!tranId || !(sslcommerz.MODE === 'mock' || sslcommerz.verifySignature(q))) {
    return res.status(401).json({ ok: false, error: 'Invalid signature' });
  }

  try {
    if (sslcommerz.isPaidStatus(q.status)) {
      await payments.settle(tranId, { ...q, source: 'ipn' }, { methodDetail: sslcommerz.describeMethod(q) });
    } else {
      await payments.fail(tranId, q.status || 'FAILED', { ...q, source: 'ipn' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[pay] ipn failed:', err.message);
    // A 500 here DOES ask for a retry, and that is right: we failed to record a
    // payment that may well have happened.
    res.status(500).json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// The fake gateway
// ---------------------------------------------------------------------------
/**
 * Mock mode only, and refused outright otherwise.
 *
 * This page settles a real order without any money moving, so the guard is not
 * a nicety. Each gateway has its own mode, so the check is against the mode of
 * the gateway THIS PAYMENT was actually opened under — a server-side constant
 * read from the environment — and nothing in the request can influence it.
 */
const MOCK_GUARD = { sslcommerz, stripe, paypal, crypto: btcpay };

router.get('/pay/mock/:tranId', async (req, res, next) => {
  const payment = await db.one('SELECT * FROM payments WHERE gateway_ref = ? LIMIT 1', [req.params.tranId]);
  if (!payment) return next();

  const integration = MOCK_GUARD[payment.gateway];
  if (!integration || integration.MODE !== 'mock') return next();

  // NOT currency.resolve(): that returns active currencies only and falls back
  // to the default, so a taka charge would be printed with a dollar sign. The
  // settlement currency is deliberately inactive.
  const { all } = await currency.load({ includeInactive: true });
  const cur = all.find((c) => c.code === payment.charged_currency) || (await currency.base());
  res.render('public/pay-mock', {
    title: 'Test payment',
    robots: 'noindex',
    bare: true,
    tranId: req.params.tranId,
    payment,
    amount: currency.format(payment.charged_minor, cur),
  });
});

module.exports = router;
