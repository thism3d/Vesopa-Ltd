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

    const started = await payments.begin(order, req.customer, req.body.gateway, payments.callbackUrls());
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
 * a nicety. It is checked against the adapter's mode — a server-side constant
 * read from the environment — and nothing in the request can influence it.
 */
router.get('/pay/mock/:tranId', async (req, res, next) => {
  if (sslcommerz.MODE !== 'mock') return next();

  const payment = await db.one('SELECT * FROM payments WHERE gateway_ref = ? LIMIT 1', [req.params.tranId]);
  if (!payment) return next();

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
