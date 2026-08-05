/**
 * Domain availability, for the search box.
 *
 * TWO ENDPOINTS, NOT ONE, and that split is the whole point of this file.
 *
 * The registrar answers a bulk lookup in roughly 350ms per name and refuses
 * concurrent requests with a 429, so asking about seven extensions at once
 * costs about four seconds before anything at all can be shown. But the visitor
 * asked one question — "can I have mybusiness.co.uk?" — and the other six
 * answers are a cross-sell they did not request.
 *
 * So `/check` looks up the exact name only and returns in about a second, and
 * `/suggestions` fetches the alternatives afterwards. The page answers the
 * actual question immediately and fills in the rest while it is being read.
 *
 * The price in every response comes from our `tlds` table, never from the
 * registrar. A registrar that changes its rate card mid-session must not be
 * able to change what a customer is charged halfway through a checkout.
 */

const express = require('express');
const registrar = require('../integrations/domainnameapi');
const pricing = require('../pricing');
const currency = require('../currency');
const { rateLimited } = require('../http-utils');

const router = express.Router();

/** How many alternative extensions to offer alongside the exact match. */
const SUGGESTION_COUNT = 6;

/**
 * Shape one registrar row plus our price into what the front-end renders.
 *
 * `cur` is the requesting visitor's currency. It has to be threaded down to
 * here rather than read from a module global: this endpoint is hit by the
 * search box on every page, and two visitors in two currencies are routinely
 * mid-search at the same moment.
 */
function decorate(r, sld, tldBy, cur) {
  const price = tldBy[r.tld];
  return {
    domain: r.domain,
    sld,
    tld: r.tld,
    // Available AND sellable. A name that is genuinely free in an extension we
    // do not carry is not something we can offer, and showing an Add button
    // that 404s at the basket is worse than not showing the row.
    available: Boolean(r.available && price && price.active),
    reason: r.reason || '',
    invalid: Boolean(r.invalid),
    errored: Boolean(r.errored),
    price_pence: price ? price.register_pence : null,
    price_display: price ? currency.format(price.register_pence, cur) : '',
    renew_display: price ? currency.format(price.renew_pence, cur) : '',
  };
}

/**
 * Pick the extension the customer meant, and the alternatives worth offering.
 * A bare word (no dot) leads with .co.uk, which is the right default for a UK
 * customer and the cheapest thing we sell.
 */
function chooseTlds(tld, sellable, tldBy) {
  const exact = tld && tldBy[tld]?.active ? tld : sellable.find((t) => t.featured)?.tld || 'co.uk';
  const others = sellable
    .filter((t) => t.tld !== exact)
    .sort((a, b) => b.featured - a.featured || a.sort_order - b.sort_order)
    .slice(0, SUGGESTION_COUNT)
    .map((t) => t.tld);
  return { exact, others };
}

// ---------------------------------------------------------------------------
// The exact name. One lookup, answered as fast as the registrar can manage.
// ---------------------------------------------------------------------------
router.post('/check', async (req, res) => {
  // The search box is on the homepage, so this is the one endpoint a bored
  // person will hold down. Generous, but bounded.
  if (rateLimited(req.ip, 'domain-check', { max: 40, windowMs: 60_000 })) {
    return res.status(429).json({ error: 'Slow down a moment, then try again.' });
  }

  const raw = String(req.body?.q || '').trim();
  if (!raw) return res.json({ error: 'Type a domain name to check.' });

  const { sld, tld } = registrar.splitDomain(raw);
  const invalid = registrar.validateLabel(sld);
  if (invalid) return res.json({ error: invalid });

  try {
    const { tlds, tldBy } = await pricing.load({ cur: req.currency });
    const sellable = tlds.filter((t) => t.active);
    const { exact, others } = chooseTlds(tld, sellable, tldBy);

    const [result] = await registrar.checkMany(sld, [exact]);

    res.json({
      query: raw,
      sld,
      exact: decorate(result, sld, tldBy, req.currency),
      // Handed back so the follow-up request does not have to repeat the
      // choosing logic, and so the two calls cannot disagree about it.
      suggest: others,
      mock: !registrar.isConnected(),
    });
  } catch (err) {
    console.error('[domains] check failed:', err.message);
    res.status(502).json({ error: 'We could not reach the registrar just now. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// The alternatives. Slower, and nobody is waiting on it.
// ---------------------------------------------------------------------------
router.post('/suggestions', async (req, res) => {
  if (rateLimited(req.ip, 'domain-suggest', { max: 40, windowMs: 60_000 })) {
    return res.status(429).json({ error: 'Slow down a moment, then try again.' });
  }

  const { sld } = registrar.splitDomain(String(req.body?.sld || ''));
  if (registrar.validateLabel(sld)) return res.json({ suggestions: [] });

  try {
    const { tlds, tldBy } = await pricing.load({ cur: req.currency });
    const sellable = tlds.filter((t) => t.active).map((t) => t.tld);

    // Only extensions we actually sell, however the client asked. This is a
    // public endpoint, and an arbitrary list from the body would let anyone
    // use our reseller account as a free bulk availability service.
    const wanted = (Array.isArray(req.body?.tlds) ? req.body.tlds : [])
      .map((t) => String(t).toLowerCase().replace(/^\./, ''))
      .filter((t) => sellable.includes(t))
      .slice(0, SUGGESTION_COUNT);

    if (!wanted.length) return res.json({ suggestions: [] });

    const results = await registrar.checkMany(sld, wanted);
    res.json({ suggestions: results.map((r) => decorate(r, sld, tldBy, req.currency)) });
  } catch (err) {
    console.error('[domains] suggestions failed:', err.message);
    // Not a 502: the exact answer is already on screen and is the one that
    // matters. Losing the cross-sell is not worth an error banner.
    res.json({ suggestions: [] });
  }
});

module.exports = router;
