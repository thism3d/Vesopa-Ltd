/**
 * Post-payment onboarding.
 *
 * The journey is now: pick a plan → pay → *this* → panel. Everything that used
 * to be asked before checkout — which domain, do you want the free one — is
 * asked here instead, because a customer who has decided to buy should meet a
 * payment form rather than a form about DNS.
 *
 * Three states, decided by the server from the order and the service, never by
 * the URL:
 *
 *   pay          the order is not paid yet. Nothing else is offered.
 *   domain       claim the free domain, or name one you already own, or skip.
 *   provisioning the work is running; the page watches it happen.
 *
 * Mounted under /panel, so it inherits the signed-in guard from panel.js.
 */

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const pricing = require('../pricing');
const registrar = require('../integrations/domainnameapi');
const provisioning = require('../provisioning');
const linking = require('../domain-linking');
const payments = require('../payments');
const { flash, field, rateLimited } = require('../http-utils');
const currency = require('../currency');
const { FREE_DOMAIN_MAX_PENCE, tldQualifiesFree, NAMESERVERS } = require('../config');

const router = express.Router();

/**
 * The order, its hosting service, and what state the wizard is in.
 * Returns null if the order is not this customer's — a 404 rather than a 403,
 * because confirming that someone else's order id exists is itself a leak.
 */
async function loadSetup(req) {
  const order = await db.one('SELECT * FROM orders WHERE id = ? AND customer_id = ? LIMIT 1', [
    req.params.id,
    req.customer.id,
  ]);
  if (!order) return null;

  const service = await db.one(
    `SELECT s.*, p.name AS plan_name, p.slug AS plan_slug
       FROM services s JOIN plans p ON p.id = s.plan_id
      WHERE s.order_id = ? LIMIT 1`,
    [order.id],
  );

  const paid = ['paid', 'provisioning', 'active'].includes(order.status);

  /*
   * THE WIZARD PRICES IN THE ORDER'S CURRENCY, not the visitor's.
   *
   * These two can differ — somebody who paid in dollars and later clicked the
   * GBP switcher is the obvious case, but so is opening the confirmation link
   * on a different device. What was charged was charged, and a screen that
   * re-renders a completed order in whatever currency the reader currently
   * prefers is showing them a number nobody was ever asked to pay.
   *
   * The free-domain search below is the one exception, and it is not really
   * one: nothing has been bought yet, so it is priced like any other shop
   * page — in the currency of the order it will be attached to.
   */
  const cur = await currency.resolve(order.currency);

  let state;
  if (!paid) state = 'pay';
  else if (service && service.setup_step === 'domain') state = 'domain';
  else state = 'provisioning';

  return { order, service, paid, state, cur };
}

/** Extensions cheap enough to be given away, for the free-domain search. */
async function freeTlds(cur) {
  const { tlds } = await pricing.load({ cur });
  return tlds
    .filter(tldQualifiesFree)
    .sort((a, b) => b.featured - a.featured || a.sort_order - b.sort_order);
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------
router.get('/setup/:id', async (req, res, next) => {
  try {
    const ctx = await loadSetup(req);
    if (!ctx) return next();

    const items = await db.query('SELECT * FROM order_items WHERE order_id = ?', [ctx.order.id]);

    res.render('panel/setup', {
      title: 'Finish setting up',
      robots: 'noindex',
      // The wizard is full-bleed: it is the only thing the customer should be
      // doing, so it does not get the panel's rail and topbar.
      bodyClass: '',
      ...ctx,
      items,
      freeTlds: await freeTlds(ctx.cur),
      freeMax: currency.format(currency.convert(FREE_DOMAIN_MAX_PENCE, ctx.cur), ctx.cur),
      paymentsMode: (process.env.PAYMENTS_MODE || 'manual').toLowerCase(),
      // The payment step. Only meaningful in the `pay` state, but passed
      // always — an EJS template that references an undefined local throws, and
      // guarding every use with `typeof` in the view is worse than four cheap
      // locals here.
      gateways: payments.gateways(),
      selectedGateway: payments.defaultGateway(),
      canPayOnline: payments.anyGatewayAvailable(),
      isFree: Number(ctx.order.total_pence) === 0,
      // What SSLCommerz will actually take, when that differs from what the
      // order is denominated in. Null when it does not.
      chargeQuote: ctx.state === 'pay' ? await payments.quote(ctx.order) : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Step 1 — the domain.
 *
 * Three answers, and "later" is a real one: a hosting account provisions
 * perfectly well without a domain and forcing the decision here is how people
 * abandon onboarding.
 */
router.post('/setup/:id/domain', async (req, res, next) => {
  try {
    const ctx = await loadSetup(req);
    if (!ctx) return next();
    if (!auth.checkCsrf(req)) return res.redirect(`/panel/setup/${req.params.id}`);
    if (!ctx.paid || !ctx.service) return res.redirect(`/panel/setup/${req.params.id}`);

    const choice = String(req.body.choice || 'later');
    const back = `/panel/setup/${ctx.order.id}`;

    if (choice === 'free') {
      // Everything here is re-checked server-side. The form is a convenience;
      // it is not evidence.
      if (!ctx.service.free_domain_eligible || ctx.service.free_domain_claimed) {
        flash(res, 'That free domain has already been used.', 'error');
        return res.redirect(back);
      }
      const wanted = field(req.body.domain, 190).toLowerCase();
      const { domain, sld, tld } = registrar.splitDomain(wanted);
      const invalid = registrar.validateLabel(sld);
      const price = tld ? await pricing.priceForTld(tld, ctx.cur) : null;

      if (invalid || !price || !tldQualifiesFree(price)) {
        const cap = currency.format(currency.convert(FREE_DOMAIN_MAX_PENCE, ctx.cur), ctx.cur);
        flash(res, invalid || `That extension is not included — pick one at ${cap} or less.`, 'error');
        return res.redirect(back);
      }

      // Checked again at the last moment: the customer may have sat on this
      // screen for an hour, and registering a taken name fails at the registry
      // with a far worse error than this one.
      const check = await registrar.checkAvailability(domain).catch(() => null);
      if (check && !check.available) {
        flash(res, `${domain} has just been taken. Try another.`, 'error');
        return res.redirect(back);
      }

      /*
       * The name is taken here, not merely wanted: `domains.domain` is unique,
       * and a row already held by somebody else means the claim cannot be
       * honoured. Checked before the insert so the customer gets "pick another"
       * rather than a duplicate-key error page.
       */
      const held = await db.one('SELECT customer_id FROM domains WHERE domain = ? LIMIT 1', [domain]);
      if (held && held.customer_id !== req.customer.id) {
        flash(res, `${domain} has just been taken. Try another.`, 'error');
        return res.redirect(back);
      }

      await db.transaction(async (conn) => {
        await conn.query(
          `INSERT INTO domains (customer_id, order_id, domain, tld, status, source, years, ns1, ns2)
           VALUES (?, ?, ?, ?, 'pending', 'registered', 1, ?, ?)
           ON DUPLICATE KEY UPDATE order_id = VALUES(order_id), status = 'pending',
                                   source = 'registered', ns1 = VALUES(ns1), ns2 = VALUES(ns2)`,
          [req.customer.id, ctx.order.id, domain, tld, NAMESERVERS[0], NAMESERVERS[1]],
        );
        await conn.query(
          `INSERT INTO order_items (order_id, kind, description, domain, years, unit_pence, qty, total_pence)
           VALUES (?, 'domain', ?, ?, 1, ?, 1, 0)`,
          [ctx.order.id, `${domain} — registration, 1 year (free with plan)`, domain, price.register_pence],
        );
        await conn.query(
          `UPDATE services SET primary_domain = ?, free_domain_claimed = 1, setup_step = 'provisioning'
            WHERE id = ?`,
          [domain, ctx.service.id],
        );
      });

      await db.logActivity({
        actorType: 'customer', actorId: req.customer.id, action: 'domain.free_claimed',
        target: domain,
        detail: `worth ${currency.format(price.register_pence, ctx.cur)} ${ctx.cur.code}`,
        ip: req.ip,
      });
    } else if (choice === 'existing') {
      /*
       * A domain registered somewhere else. It goes on the account through the
       * same door as the panel's "add a domain" — as an EXTERNAL domain waiting
       * on its nameservers — rather than being written straight onto the
       * service as a fact. Nobody has proved they own it yet, and we will not
       * build a website, accept mail or issue a certificate for a name on the
       * strength of it having been typed into a form.
       *
       * The service still records it as the primary domain, so the panel can
       * say what this account is for and the sweep knows what to build when the
       * delegation lands.
       */
      const wanted = field(req.body.existing_domain, 190);
      const { domain: existing } = registrar.splitDomain(wanted);

      if (existing) {
        const added = await linking.addExternal({
          customer: req.customer,
          domain: existing,
          serviceId: ctx.service.id,
        });
        if (!added.ok && !added.id) {
          flash(res, added.error, 'error');
          return res.redirect(back);
        }
      }

      await db.query(
        `UPDATE services SET primary_domain = ?, setup_step = 'provisioning' WHERE id = ?`,
        [existing || '', ctx.service.id],
      );
    } else {
      await db.query(`UPDATE services SET setup_step = 'provisioning' WHERE id = ?`, [ctx.service.id]);
    }

    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

/**
 * Step 2 — start the work.
 *
 * Deliberately NOT awaited. Provisioning takes seconds to a minute; holding the
 * HTTP request open for it would show the customer a blank tab and then time
 * out behind nginx. It runs in the background and the page watches the
 * `setup_steps` rows instead.
 */
router.post('/setup/:id/start', async (req, res, next) => {
  try {
    const ctx = await loadSetup(req);
    if (!ctx) return next();
    if (!auth.checkCsrf(req)) return res.status(400).json({ error: 'expired' });
    if (!ctx.paid) return res.status(409).json({ error: 'not_paid' });

    // Cheap guard against a double-click or a second tab starting it twice.
    // provisionOrder is idempotent per row as well, so this is belt and braces.
    if (rateLimited(`setup-${ctx.order.id}`, 'provision', { max: 1, windowMs: 20_000 })) {
      return res.json({ ok: true, already: true });
    }

    provisioning
      .provisionOrder(ctx.order.id, { actorType: 'customer', actorId: req.customer.id, ip: req.ip })
      .catch((err) => console.error('[setup] provision failed:', err.message));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Step 2 — the progress the page polls.
 *
 * Polling rather than server-sent events: SSE needs `proxy_buffering off` in
 * nginx to work at all, and a progress bar that silently never moves on
 * production because of a missing directive is worse than a request every
 * second.
 */
router.get('/setup/:id/status', async (req, res, next) => {
  try {
    const ctx = await loadSetup(req);
    if (!ctx) return next();

    const steps = await db.query(
      'SELECT step_key, label, status, detail FROM setup_steps WHERE order_id = ? ORDER BY sort_order, id',
      [ctx.order.id],
    );

    const done = steps.filter((s) => ['ok', 'failed', 'skipped'].includes(s.status)).length;
    res.json({
      state: ctx.state,
      orderStatus: ctx.order.status,
      steps,
      // 0 until the first step is planned, so the bar does not start full on an
      // order whose provisioning has not been kicked off yet.
      percent: steps.length ? Math.round((done / steps.length) * 100) : 0,
      finished: steps.length > 0 && done === steps.length,
      failed: steps.some((s) => s.status === 'failed'),
    });
  } catch (err) {
    next(err);
  }
});

/** The free-domain search. Only offers extensions inside the cap. */
router.post('/setup/:id/search', async (req, res, next) => {
  try {
    const ctx = await loadSetup(req);
    if (!ctx) return next();
    if (rateLimited(req.ip, 'setup-search', { max: 30, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Slow down a moment, then try again.' });
    }

    const { sld } = registrar.splitDomain(String(req.body?.q || ''));
    const invalid = registrar.validateLabel(sld);
    if (invalid) return res.json({ error: invalid });

    const allowed = await freeTlds(ctx.cur);
    const wanted = allowed.slice(0, 6).map((t) => t.tld);
    const results = await registrar.checkMany(sld, wanted);

    const byTld = Object.fromEntries(allowed.map((t) => [t.tld, t]));
    res.json({
      sld,
      results: results.map((r) => {
        const price = byTld[r.tld];
        return {
          domain: r.domain,
          sld,
          tld: r.tld,
          available: Boolean(r.available && price),
          errored: Boolean(r.errored),
          // What it would have cost, so "free" means something, and what it
          // renews at, so the offer is honest before it is taken.
          worth: price ? currency.format(price.register_pence, ctx.cur) : '',
          renew: price ? currency.format(price.renew_pence, ctx.cur) : '',
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
