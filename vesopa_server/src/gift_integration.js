/**
 * The EPOS end of Vesopa Gift: what the online gift shop may ask the back office.
 *
 * WHY THIS IS SMALL
 *
 * The shop is a separate program with its own database. It sells; the EPOS
 * keeps the money that has been sold. A voucher bought online is issued here as
 * an ordinary gift card, so the till, the back office's Gift Cards page and the
 * Wallet pass all already know what to do with it, and the balance is spent
 * under the same row lock as every other card. Two ledgers for one voucher would
 * mean two balances and a nightly argument about which is right.
 *
 * So the shop gets exactly the calls it needs -- read a venue, issue a card,
 * read or cancel a card it issued, take a payment into the venue's own Dojo
 * account, refund one -- and nothing that could reach the rest of the back
 * office.
 *
 * WHO MAY CALL IT
 *
 * One caller, identified by GIFT_SERVICE_KEY, compared in constant time. The
 * shop runs on the same box and calls over loopback; the key is what stops
 * anything else on that box, or anything that finds a way to the port, from
 * issuing money. No key configured means the whole surface answers 503.
 *
 * A VENUE IS ITS OFFICE ID HERE, not its contact email. The email is what the
 * commerce tables are keyed on, and it is resolved from the id on every call;
 * the shop never needs to know it.
 */

const crypto = require('crypto');
const express = require('express');

const dojo = require('./dojo_client');
const { venueKey } = require('./express_kiosk');
const { brandFor } = require('./loyalty_app');
const A = require('./wallet_apple');

const BASE = '/api/integrations/gift';

/** Same alphabet as the back office's own cards: no O/0, no I/1. */
function giftCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += alphabet[crypto.randomInt(alphabet.length)];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

function sameKey(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

/** What the shop sees of a card. Not the office, not who issued it. */
function present(card) {
  if (!card) return null;
  return {
    id: card.id,
    code: card.code,
    kind: card.kind,
    label: card.label || null,
    source: card.source || null,
    initial_minor: card.initial_minor,
    balance_minor: card.balance_minor,
    currency: card.currency || 'GBP',
    expires_on: card.expires_on,
    usable_from: card.usable_from || null,
    status: card.status,
    recipient_name: card.recipient_name || null,
    created_at: card.created_at,
  };
}

function absolute(url) {
  if (!url) return null;
  const s = String(url);
  if (/^https?:\/\//i.test(s)) return s;
  const base = String(process.env.BACKOFFICE_URL || '').replace(/\/+$/, '');
  return base && s.startsWith('/') ? base + s : s;
}

function giftIntegrationRoutes({ pool, broadcast, core }) {
  const router = express.Router();

  router.use(BASE, (req, res, next) => {
    const expected = process.env.GIFT_SERVICE_KEY || '';
    if (expected.length < 32) {
      return res.status(503).json({ error: 'The gift shop is not connected to this server' });
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !sameKey(token, expected)) {
      return res.status(401).json({ error: 'Not the gift shop' });
    }
    next();
  });

  async function venueById(id) {
    const n = int(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    const [[row]] = await pool.query(
      'SELECT id, name, contact_email, status, demo_of FROM offices WHERE id = ?',
      [n]
    );
    return row || null;
  }

  async function express_settings(office) {
    try {
      const [[row]] = await pool.query('SELECT * FROM epos_express_settings WHERE office = ?', [office]);
      return row || null;
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return null;
      throw e;
    }
  }

  /**
   * The key a venue's shop is paid with.
   *
   * Its own Dojo key -- the one its Express kiosks use -- or, only when that is
   * missing AND the platform's key is a sandbox key, the platform's. A real
   * platform key is never lent to a venue: that would put a venue's customers'
   * money into Vesopa's account, which is the one thing "zero commission, paid
   * straight to the venue" promises will not happen.
   */
  async function paymentKey(office) {
    const { key, source } = venueKey(await express_settings(office));
    if (source === 'platform' && !dojo.isSandboxKey(key)) return { key: '', source: 'none' };
    return { key, source, sandbox: dojo.isSandboxKey(key) };
  }

  async function describeVenue(v) {
    let app = null;
    try {
      const [[row]] = await pool.query('SELECT * FROM epos_loyalty_app WHERE office = ?', [v.contact_email]);
      app = row || null;
    } catch {
      app = null;
    }
    const brand = await brandFor(pool, v.contact_email, app);
    const pay = await paymentKey(v.contact_email);
    const settings = await express_settings(v.contact_email);
    const apple = A.cachedConfig().configured;
    const google = !!(core && core.config && core.config.configured);
    return {
      id: v.id,
      name: v.name,
      status: v.status,
      brand: {
        name: brand.venue || brand.name || v.name,
        logo: absolute(brand.logo),
        icon: absolute(brand.icon),
        hero: absolute(brand.hero),
        colours: brand.colours,
        fonts: brand.fonts,
        address: brand.address,
        links: brand.links,
      },
      payments: {
        source: pay.source,
        sandbox: !!pay.sandbox,
        hint: pay.source === 'venue' && settings ? settings.dojo_key_hint || null : null,
      },
      wallet: { apple, google },
    };
  }

  // ---- Venues --------------------------------------------------------------

  router.get(`${BASE}/venues`, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, name, contact_email, status, demo_of FROM offices
          WHERE demo_of IS NULL ORDER BY name`
      );
      const out = [];
      for (const v of rows) out.push(await describeVenue(v));
      res.json({ venues: out });
    } catch (e) { next(e); }
  });

  router.get(`${BASE}/venues/:id`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      res.json(await describeVenue(v));
    } catch (e) { next(e); }
  });

  // ---- Cards ---------------------------------------------------------------

  function walletUrl(office, cardId) {
    if (!core || typeof core.shortLink !== 'function') return null;
    const apple = A.cachedConfig().configured;
    const google = !!(core.config && core.config.configured);
    if (!apple && !google) return null;
    return core.shortLink(office, 'giftcard', cardId).replace('/wallet/s/', '/wallet/c/');
  }

  /**
   * Issue a card for one line of one order.
   *
   * Idempotent on `external_ref`: the shop retries after a timeout, and a retry
   * must hand back the card it already has rather than a second one worth the
   * same money.
   */
  router.post(`${BASE}/venues/:id/cards`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const office = v.contact_email;
      const b = req.body || {};

      const amount = int(b.amount_minor);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 1000000) {
        return res.status(400).json({ error: 'amount_minor must be between 1 and 1000000' });
      }
      const externalRef = String(b.external_ref || '').trim().slice(0, 80);
      if (!externalRef) return res.status(400).json({ error: 'external_ref is required' });
      const expires = b.expires_on && /^\d{4}-\d{2}-\d{2}$/.test(String(b.expires_on)) ? String(b.expires_on) : null;
      const usableFrom = b.usable_from && !Number.isNaN(Date.parse(b.usable_from))
        ? new Date(b.usable_from)
        : null;

      const [[already]] = await pool.query(
        'SELECT * FROM epos_gift_cards WHERE office = ? AND external_ref = ?',
        [office, externalRef]
      );
      if (already) {
        return res.json({ card: present(already), wallet_url: walletUrl(office, already.id), repeated: true });
      }

      // A code collision is astronomically unlikely and still handled: try
      // again with a fresh one rather than failing somebody's paid order.
      for (let attempt = 0; attempt < 4; attempt++) {
        const id = crypto.randomUUID();
        const code = giftCode();
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.execute(
            `INSERT INTO epos_gift_cards
               (id, office, code, kind, initial_minor, balance_minor, recipient_name,
                expires_on, reloadable, issued_by, notes, source, external_ref, label, usable_from)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'gift', ?, ?, ?)`,
            [
              id, office, code,
              b.single_use ? 'paper' : 'smart',
              amount, amount,
              b.recipient_name ? String(b.recipient_name).slice(0, 120) : null,
              expires,
              'Vesopa Gift',
              b.notes ? String(b.notes).slice(0, 500) : null,
              externalRef,
              b.label ? String(b.label).slice(0, 120) : null,
              usableFrom,
            ]
          );
          await conn.execute(
            `INSERT INTO epos_gift_card_txns
               (id, gift_card_id, office, kind, amount_minor, balance_after, clerk_name, note)
             VALUES (?, ?, ?, 'issue', ?, ?, 'Vesopa Gift', ?)`,
            [crypto.randomUUID(), id, office, amount, amount, String(b.notes || 'Bought online').slice(0, 255)]
          );
          await conn.commit();
          const [[card]] = await pool.query('SELECT * FROM epos_gift_cards WHERE id = ?', [id]);
          broadcast({ type: 'gift-cards' });
          return res.status(201).json({ card: present(card), wallet_url: walletUrl(office, id) });
        } catch (e) {
          await conn.rollback().catch(() => {});
          if (e.code !== 'ER_DUP_ENTRY') throw e;
          // Either the code collided or another request with the same
          // reference won the race. The second answers from what it made.
          const [[won]] = await pool.query(
            'SELECT * FROM epos_gift_cards WHERE office = ? AND external_ref = ?',
            [office, externalRef]
          );
          if (won) {
            return res.json({ card: present(won), wallet_url: walletUrl(office, won.id), repeated: true });
          }
        } finally {
          conn.release();
        }
      }
      res.status(500).json({ error: 'Could not issue a card' });
    } catch (e) { next(e); }
  });

  async function giftCard(v, cardId) {
    const [[card]] = await pool.query(
      'SELECT * FROM epos_gift_cards WHERE id = ? AND office = ?',
      [String(cardId), v.contact_email]
    );
    return card || null;
  }

  router.get(`${BASE}/venues/:id/cards/:cardId`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const card = await giftCard(v, req.params.cardId);
      if (!card) return res.status(404).json({ error: 'No such card' });
      const [txns] = await pool.query(
        `SELECT kind, amount_minor, balance_after, created_at
           FROM epos_gift_card_txns WHERE gift_card_id = ? ORDER BY created_at, id`,
        [card.id]
      );
      res.json({ card: present(card), txns, wallet_url: walletUrl(v.contact_email, card.id) });
    } catch (e) { next(e); }
  });

  /**
   * The balance page's question: what is left on this code?
   *
   * Only cards the shop issued are answered. A venue's paper certificates and
   * staff cards are not the shop's to describe, and a lookup that answered for
   * them would turn the public balance page into a way of probing codes the
   * shop never sold.
   */
  router.get(`${BASE}/venues/:id/lookup`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const code = String(req.query.code || '').trim().toUpperCase();
      if (!code) return res.status(400).json({ error: 'code is required' });
      const [[card]] = await pool.query(
        `SELECT * FROM epos_gift_cards WHERE office = ? AND code = ? AND source = 'gift'`,
        [v.contact_email, code]
      );
      if (!card) return res.status(404).json({ error: 'No such voucher' });
      const [[last]] = await pool.query(
        `SELECT MAX(created_at) AS at FROM epos_gift_card_txns
          WHERE gift_card_id = ? AND kind = 'redeem'`,
        [card.id]
      );
      res.json({ card: present(card), last_used_at: last ? last.at : null });
    } catch (e) { next(e); }
  });

  /** Change what the shop may change about its own card. */
  router.patch(`${BASE}/venues/:id/cards/:cardId`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const card = await giftCard(v, req.params.cardId);
      if (!card || card.source !== 'gift') return res.status(404).json({ error: 'No such card' });
      const b = req.body || {};
      const sets = [];
      const args = [];
      if (Object.prototype.hasOwnProperty.call(b, 'usable_from')) {
        sets.push('usable_from = ?');
        args.push(b.usable_from && !Number.isNaN(Date.parse(b.usable_from)) ? new Date(b.usable_from) : null);
      }
      if (typeof b.recipient_name === 'string') {
        sets.push('recipient_name = ?');
        args.push(b.recipient_name.slice(0, 120) || null);
      }
      if (!sets.length) return res.json({ card: present(card) });
      await pool.execute(`UPDATE epos_gift_cards SET ${sets.join(', ')} WHERE id = ?`, [...args, card.id]);
      broadcast({ type: 'gift-cards' });
      res.json({ card: present(await giftCard(v, card.id)) });
    } catch (e) { next(e); }
  });

  /**
   * Cancel a card the shop issued, for a refund.
   *
   * Answers what was still on it, which is what may be refunded: money already
   * spent at the till bought food and drink and does not come back. Atomic, so
   * a card spent in the same second as it is cancelled is either spent or
   * refunded, never both.
   */
  router.post(`${BASE}/venues/:id/cards/:cardId/void`, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      await conn.beginTransaction();
      const [[card]] = await conn.query(
        'SELECT * FROM epos_gift_cards WHERE id = ? AND office = ? FOR UPDATE',
        [String(req.params.cardId), v.contact_email]
      );
      if (!card || card.source !== 'gift') {
        await conn.rollback();
        return res.status(404).json({ error: 'No such card' });
      }
      if (card.status === 'void') {
        await conn.commit();
        return res.json({ refundable_minor: 0, repeated: true, card: present(card) });
      }

      // Money a till is holding for an open bill is not refundable: the bill
      // is about to spend it. The shop is told, and can try again later.
      const [[held]] = await conn.query(
        `SELECT COALESCE(SUM(amount_minor), 0) AS held FROM epos_gift_card_holds
          WHERE gift_card_id = ? AND status = 'held' AND expires_at > NOW()`,
        [card.id]
      ).catch(() => [[{ held: 0 }]]);
      if (Number(held.held) > 0) {
        await conn.rollback();
        return res.status(409).json({ error: 'A till is using this voucher right now. Try again in a few minutes.' });
      }

      const refundable = Math.max(0, card.balance_minor);
      await conn.execute(
        "UPDATE epos_gift_cards SET balance_minor = 0, status = 'void' WHERE id = ?",
        [card.id]
      );
      await conn.execute(
        `INSERT INTO epos_gift_card_txns
           (id, gift_card_id, office, kind, amount_minor, balance_after, clerk_name, note)
         VALUES (?, ?, ?, 'void', ?, 0, 'Vesopa Gift', ?)`,
        [crypto.randomUUID(), card.id, v.contact_email, -refundable,
          String((req.body && req.body.reason) || 'Refunded online').slice(0, 255)]
      );
      await conn.commit();
      broadcast({ type: 'gift-cards' });
      res.json({ refundable_minor: refundable, card: present({ ...card, balance_minor: 0, status: 'void' }) });
    } catch (e) {
      await conn.rollback().catch(() => {});
      next(e);
    } finally { conn.release(); }
  });

  /**
   * What the venue's dashboard needs from the EPOS side: how much of what the
   * shop sold is still to be spent, and what was spent week by week.
   */
  router.get(`${BASE}/venues/:id/summary`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const office = v.contact_email;
      const weeks = Math.min(Math.max(int(req.query.weeks) || 8, 1), 52);

      const [[totals]] = await pool.query(
        `SELECT COUNT(*) AS cards,
                COALESCE(SUM(initial_minor), 0) AS issued_minor,
                COALESCE(SUM(CASE WHEN status = 'active'
                                   AND (expires_on IS NULL OR expires_on >= CURDATE())
                                  THEN balance_minor ELSE 0 END), 0) AS outstanding_minor,
                COALESCE(SUM(CASE WHEN status = 'active' AND expires_on < CURDATE()
                                  THEN balance_minor ELSE 0 END), 0) AS expired_minor
           FROM epos_gift_cards WHERE office = ? AND source = 'gift'`,
        [office]
      );

      // The two legacy tables share a collation, so this one join is safe.
      const [series] = await pool.query(
        `SELECT DATE_SUB(DATE(t.created_at), INTERVAL WEEKDAY(t.created_at) DAY) AS week,
                COALESCE(SUM(CASE WHEN t.kind = 'redeem' THEN -t.amount_minor
                                  WHEN t.kind = 'reverse' THEN -t.amount_minor ELSE 0 END), 0) AS spent_minor
           FROM epos_gift_card_txns t
           JOIN epos_gift_cards c ON c.id = t.gift_card_id
          WHERE c.office = ? AND c.source = 'gift'
            AND t.kind IN ('redeem', 'reverse')
            AND t.created_at >= DATE_SUB(CURDATE(), INTERVAL ? WEEK)
          GROUP BY week ORDER BY week`,
        [office, weeks]
      );

      res.json({
        cards: Number(totals.cards),
        issued_minor: Number(totals.issued_minor),
        outstanding_minor: Number(totals.outstanding_minor),
        expired_minor: Number(totals.expired_minor),
        spent_by_week: series.map((r) => ({ week: r.week, spent_minor: Number(r.spent_minor) })),
      });
    } catch (e) { next(e); }
  });

  // ---- Payments ------------------------------------------------------------

  function dojoFailure(res, e) {
    const status = e instanceof dojo.DojoError && e.status >= 400 && e.status < 500 ? 409 : 502;
    return res.status(status).json({ error: e.message || 'Dojo refused', dojo_status: e.status || 0 });
  }

  router.post(`${BASE}/venues/:id/payments`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const b = req.body || {};
      const amount = int(b.amount_minor);
      if (!Number.isInteger(amount) || amount < 50 || amount > 1000000) {
        return res.status(400).json({ error: 'amount_minor must be between 50 and 1000000' });
      }
      const redirect = String(b.redirect_url || '');
      // https, or this machine for a test run -- never plain http anywhere else,
      // because the return address carries the buyer's order id.
      if (!/^https:\/\//i.test(redirect) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(redirect)) {
        return res.status(400).json({ error: 'redirect_url must be an https address' });
      }
      const pay = await paymentKey(v.contact_email);
      if (!pay.key) {
        return res.status(409).json({ error: 'This venue cannot take card payments yet', payments: 'none' });
      }
      try {
        const intent = await dojo.createCheckoutIntent(pay.key, {
          amountMinor: amount,
          reference: b.reference,
          description: b.description,
          redirectUrl: redirect,
        });
        res.status(201).json({
          intent_id: intent.id,
          checkout_url: dojo.checkoutUrl(intent.id),
          status: intent.status || null,
          source: pay.source,
          sandbox: !!pay.sandbox,
        });
      } catch (e) {
        return dojoFailure(res, e);
      }
    } catch (e) { next(e); }
  });

  router.get(`${BASE}/venues/:id/payments/:intentId`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const pay = await paymentKey(v.contact_email);
      if (!pay.key) return res.status(409).json({ error: 'This venue has no Dojo key' });
      try {
        const intent = await dojo.getIntent(pay.key, req.params.intentId);
        const card = (intent && (intent.paymentDetails || {}).card) || {};
        res.json({
          intent_id: intent.id,
          status: intent.status || null,
          paid: dojo.intentPaid(intent),
          amount_minor: intent.amount ? intent.amount.value : null,
          refunded_minor: intent.refundedAmount != null ? intent.refundedAmount : null,
          card: {
            brand: card.cardName || card.scheme || null,
            last4: card.cardNumber ? String(card.cardNumber).slice(-4) : null,
          },
        });
      } catch (e) {
        return dojoFailure(res, e);
      }
    } catch (e) { next(e); }
  });

  router.post(`${BASE}/venues/:id/payments/:intentId/refund`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const b = req.body || {};
      const amount = int(b.amount_minor);
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount_minor must be more than zero' });
      }
      const key = String(b.idempotency_key || '').trim();
      if (!key) return res.status(400).json({ error: 'idempotency_key is required' });
      const pay = await paymentKey(v.contact_email);
      if (!pay.key) return res.status(409).json({ error: 'This venue has no Dojo key' });
      try {
        const out = await dojo.refundIntent(pay.key, req.params.intentId, {
          amountMinor: amount,
          reason: b.reason,
          idempotencyKey: key,
        });
        res.json({ refunded: true, refund_id: out && out.refundId ? out.refundId : null });
      } catch (e) {
        return dojoFailure(res, e);
      }
    } catch (e) { next(e); }
  });

  router.post(`${BASE}/venues/:id/payments/:intentId/cancel`, async (req, res, next) => {
    try {
      const v = await venueById(req.params.id);
      if (!v) return res.status(404).json({ error: 'No such venue' });
      const pay = await paymentKey(v.contact_email);
      if (!pay.key) return res.json({ cancelled: false });
      res.json({ cancelled: await dojo.cancelIntent(pay.key, req.params.intentId) });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { giftIntegrationRoutes, giftCode, present };
