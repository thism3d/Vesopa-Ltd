const crypto = require('crypto');
const express = require('express');
const { requireAuth } = require('./auth');

/**
 * Commerce: gift cards, deposits, loyalty, promotions, rules and tender
 * settings.
 *
 * Money that is *held* (a gift-card balance, a deposit) is kept apart from
 * money that is *discounted* (a voucher, a promotion). The difference matters:
 * a balance can be overdrawn and a discount cannot, so every redemption here
 * goes through a transaction that re-reads the balance under a row lock rather
 * than trusting what the till was showing when the clerk pressed the button.
 */
function commerceRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query(
        'SELECT contact_email FROM offices WHERE id = ?',
        [req.user.officeId]
      );
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  /** Reads the office for an unauthenticated till call. */
  function tillOffice(req) {
    const office = String(req.query.office || req.body?.office || '').trim();
    return office || null;
  }

  const money = (v) => Math.round(Number(v) || 0);

  // ---- Tender settings ----------------------------------------------------

  const TENDER_DEFAULTS = {
    gratuity_enabled: 1,
    gratuity_mode: 'prompt',
    gratuity_presets: '5,10,12.5,15,20',
    gratuity_default_bp: 125,
    gratuity_removable: 1,
    gratuity_min_covers: 0,
    // No £50: most UK counters will not take one, so the key never gets
    // pressed. A venue that does take them adds it back here.
    cash_presets: '500,1000,2000',
    cash_quick_round: 1,
    allow_partial_card: 1,
    allow_split_bill: 1,
  };

  const TENDER_FIELDS = Object.keys(TENDER_DEFAULTS);

  async function readTender(office) {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_tender_settings WHERE office = ?',
      [office]
    );
    return row || { office, ...TENDER_DEFAULTS };
  }

  router.get('/tender-settings', auth, async (req, res, next) => {
    try {
      res.json(await readTender(await tenantEmail(req)));
    } catch (e) { next(e); }
  });

  /** The till's copy — needed before anyone signs in on the terminal. */
  router.get('/tender-settings/public', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      if (!office) return res.status(400).json({ error: 'office is required' });
      res.json(await readTender(office));
    } catch (e) { next(e); }
  });

  router.put('/tender-settings', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const given = TENDER_FIELDS.filter((f) =>
        Object.prototype.hasOwnProperty.call(req.body, f));

      const values = given.map((f) => {
        const v = req.body[f];
        if (f === 'gratuity_mode') {
          return ['off', 'prompt', 'auto'].includes(v) ? v : 'prompt';
        }
        if (f === 'gratuity_presets' || f === 'cash_presets') {
          return String(v ?? '');
        }
        if (f.startsWith('gratuity_') || f.startsWith('cash_') ||
            f.startsWith('allow_')) {
          // Everything else in this table is a number or a flag.
          return typeof v === 'boolean' ? (v ? 1 : 0) : money(v);
        }
        return v;
      });

      const cols = ['office', ...given];
      await pool.execute(
        `INSERT INTO epos_tender_settings (${cols.map((c) => `\`${c}\``).join(',')})
         VALUES (${cols.map(() => '?').join(',')})
         ${given.length ? `ON DUPLICATE KEY UPDATE ${given.map((f) => `\`${f}\`=VALUES(\`${f}\`)`).join(',')}` : ''}`,
        [office, ...values]
      );

      broadcast({ type: 'tender.settings' });
      res.json(await readTender(office));
    } catch (e) { next(e); }
  });

  // ---- Gift cards ---------------------------------------------------------

  /** Human-readable, unambiguous: no O/0 or I/1 to mis-read off a printed card. */
  function giftCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 12; i++) {
      out += alphabet[crypto.randomInt(alphabet.length)];
      if (i === 3 || i === 7) out += '-';
    }
    return out;
  }

  router.get('/gift-cards', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT * FROM epos_gift_cards WHERE office = ?
         ORDER BY created_at DESC LIMIT 500`,
        [office]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  /** Look a card up by code. Used by the till before offering it as a tender. */
  router.get('/gift-cards/lookup', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const code = String(req.query.code || '').trim().toUpperCase();
      if (!office || !code) {
        return res.status(400).json({ error: 'office and code are required' });
      }

      const [[card]] = await pool.query(
        'SELECT * FROM epos_gift_cards WHERE office = ? AND code = ?',
        [office, code]
      );
      if (!card) return res.status(404).json({ error: 'No such gift card' });

      // Expiry is checked on read as well as on redeem, so the till can grey
      // the card out rather than letting a clerk try and be refused.
      const expired = card.expires_on &&
        new Date(card.expires_on) < new Date(new Date().toDateString());
      res.json({
        ...card,
        expired: !!expired,
        redeemable: card.status === 'active' && !expired && card.balance_minor > 0,
      });
    } catch (e) { next(e); }
  });

  router.get('/gift-cards/:id/transactions', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT * FROM epos_gift_card_txns
         WHERE gift_card_id = ? AND office = ?
         ORDER BY created_at DESC LIMIT 200`,
        [req.params.id, office]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  /** Issue a card. Paper cards are single-use for their face value. */
  router.post('/gift-cards', auth, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = await tenantEmail(req);
      const amount = money(req.body.initial_minor);
      if (amount <= 0) {
        return res.status(400).json({ error: 'Amount must be more than zero' });
      }

      const kind = req.body.kind === 'paper' ? 'paper' : 'smart';
      const id = crypto.randomUUID();
      const code = String(req.body.code || '').trim().toUpperCase() || giftCode();

      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO epos_gift_cards
           (id, office, code, kind, initial_minor, balance_minor, customer_id,
            recipient_name, expires_on, reloadable, issued_by, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, office, code, kind, amount, amount,
          req.body.customer_id || null,
          req.body.recipient_name || null,
          req.body.expires_on || null,
          // A paper certificate cannot be topped up.
          kind === 'paper' ? 0 : (req.body.reloadable === false ? 0 : 1),
          req.body.issued_by || req.user.email || null,
          req.body.notes || null,
        ]
      );
      await conn.execute(
        `INSERT INTO epos_gift_card_txns
           (id, gift_card_id, office, kind, amount_minor, balance_after,
            clerk_name, note)
         VALUES (?,?,?,'issue',?,?,?,?)`,
        [crypto.randomUUID(), id, office, amount, amount,
         req.body.issued_by || req.user.email || null, 'Card issued']
      );
      await conn.commit();

      const [[card]] = await pool.query(
        'SELECT * FROM epos_gift_cards WHERE id = ?', [id]);
      broadcast({ type: 'gift-cards' });
      res.status(201).json(card);
    } catch (e) {
      await conn.rollback();
      // A duplicate code is a user error, not a server fault.
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'That gift card code already exists' });
      }
      next(e);
    } finally { conn.release(); }
  });

  /**
   * Move money on a card: redeem, reload, refund or adjust.
   *
   * The balance is re-read inside the transaction with FOR UPDATE. Without
   * that, two tills redeeming the same card at the same moment would both see
   * the old balance and the card would be spent twice.
   */
  async function moveGiftCard({ office, code, id, kind, amountMinor, orderId, clerk, note }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[card]] = await conn.query(
        `SELECT * FROM epos_gift_cards
         WHERE office = ? AND ${id ? 'id = ?' : 'code = ?'} FOR UPDATE`,
        [office, id || code]
      );
      if (!card) {
        await conn.rollback();
        return { error: 'No such gift card', status: 404 };
      }
      if (card.status !== 'active') {
        await conn.rollback();
        return { error: `This card is ${card.status}`, status: 409 };
      }
      if (card.expires_on &&
          new Date(card.expires_on) < new Date(new Date().toDateString())) {
        await conn.rollback();
        return { error: 'This card has expired', status: 409 };
      }

      const amount = money(amountMinor);
      if (amount <= 0) {
        await conn.rollback();
        return { error: 'Amount must be more than zero', status: 400 };
      }

      // Redemptions and refunds take money off; reloads put it on.
      const delta = kind === 'redeem' ? -amount : amount;

      if (kind === 'redeem' && amount > card.balance_minor) {
        await conn.rollback();
        return {
          error: 'Not enough left on this card',
          status: 409,
          balance_minor: card.balance_minor,
        };
      }
      if (kind === 'reload' && !card.reloadable) {
        await conn.rollback();
        return { error: 'This card cannot be topped up', status: 409 };
      }

      const balanceAfter = card.balance_minor + delta;
      // A spent smart card stays 'active' so it can be reloaded; a paper
      // certificate is done once redeemed.
      const status = balanceAfter <= 0 && card.kind === 'paper'
        ? 'redeemed'
        : card.status;

      await conn.execute(
        'UPDATE epos_gift_cards SET balance_minor = ?, status = ? WHERE id = ?',
        [balanceAfter, status, card.id]
      );
      await conn.execute(
        `INSERT INTO epos_gift_card_txns
           (id, gift_card_id, office, kind, amount_minor, balance_after,
            order_id, clerk_name, note)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), card.id, office, kind, delta, balanceAfter,
         orderId || null, clerk || null, note || null]
      );

      await conn.commit();
      return { card: { ...card, balance_minor: balanceAfter, status } };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally { conn.release(); }
  }

  /** Redeem against a sale. Unauthenticated: this is a till operation. */
  router.post('/gift-cards/redeem', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      if (!office) return res.status(400).json({ error: 'office is required' });

      const result = await moveGiftCard({
        office,
        code: String(req.body.code || '').trim().toUpperCase(),
        kind: 'redeem',
        amountMinor: req.body.amount_minor,
        orderId: req.body.order_id,
        clerk: req.body.clerk_name,
        note: req.body.note || 'Redeemed against sale',
      });

      if (result.error) return res.status(result.status).json(result);
      broadcast({ type: 'gift-cards' });
      res.json(result.card);
    } catch (e) { next(e); }
  });

  router.post('/gift-cards/:id/reload', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const result = await moveGiftCard({
        office, id: req.params.id, kind: 'reload',
        amountMinor: req.body.amount_minor,
        clerk: req.user.email, note: req.body.note || 'Topped up',
      });
      if (result.error) return res.status(result.status).json(result);
      broadcast({ type: 'gift-cards' });
      res.json(result.card);
    } catch (e) { next(e); }
  });

  router.put('/gift-cards/:id/void', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [r] = await pool.execute(
        `UPDATE epos_gift_cards SET status = 'void'
         WHERE id = ? AND office = ?`,
        [req.params.id, office]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such gift card' });
      broadcast({ type: 'gift-cards' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---- Deposits -----------------------------------------------------------

  router.get('/deposits', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const status = req.query.status;
      const [rows] = await pool.query(
        `SELECT * FROM epos_deposits
         WHERE office = ? ${status ? 'AND status = ?' : ''}
         ORDER BY created_at DESC LIMIT 500`,
        status ? [office, status] : [office]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  /** The till looks a deposit up by reference to redeem it. */
  router.get('/deposits/lookup', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const reference = String(req.query.reference || '').trim().toUpperCase();
      if (!office || !reference) {
        return res.status(400).json({ error: 'office and reference are required' });
      }
      const [[row]] = await pool.query(
        'SELECT * FROM epos_deposits WHERE office = ? AND reference = ?',
        [office, reference]
      );
      if (!row) return res.status(404).json({ error: 'No such deposit' });
      res.json({
        ...row,
        remaining_minor: row.amount_minor - row.redeemed_minor,
        redeemable: row.status === 'held' &&
          row.amount_minor > row.redeemed_minor,
      });
    } catch (e) { next(e); }
  });

  router.post('/deposits', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const amount = money(req.body.amount_minor);
      if (amount <= 0) {
        return res.status(400).json({ error: 'Amount must be more than zero' });
      }

      const id = crypto.randomUUID();
      // A short reference is what gets written on a booking sheet.
      const reference = String(req.body.reference || '').trim().toUpperCase() ||
        `DEP-${crypto.randomInt(100000, 999999)}`;

      await pool.execute(
        `INSERT INTO epos_deposits
           (id, office, reference, customer_id, customer_name, customer_phone,
            description, amount_minor, order_total_minor, method, due_on,
            taken_by, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, office, reference,
          req.body.customer_id || null,
          req.body.customer_name || null,
          req.body.customer_phone || null,
          req.body.description || null,
          amount,
          req.body.order_total_minor != null ? money(req.body.order_total_minor) : null,
          req.body.method || 'cash',
          req.body.due_on || null,
          req.body.taken_by || req.user.email || null,
          req.body.notes || null,
        ]
      );

      const [[row]] = await pool.query('SELECT * FROM epos_deposits WHERE id = ?', [id]);
      broadcast({ type: 'deposits' });
      res.status(201).json(row);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'That deposit reference already exists' });
      }
      next(e);
    }
  });

  /**
   * Redeem a deposit against a bill. Locked the same way as a gift card: a
   * deposit is money already taken, and redeeming it twice gives the customer
   * their money back twice.
   */
  router.post('/deposits/redeem', async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = tillOffice(req);
      const reference = String(req.body.reference || '').trim().toUpperCase();
      if (!office || !reference) {
        return res.status(400).json({ error: 'office and reference are required' });
      }

      await conn.beginTransaction();
      const [[row]] = await conn.query(
        'SELECT * FROM epos_deposits WHERE office = ? AND reference = ? FOR UPDATE',
        [office, reference]
      );
      if (!row) {
        await conn.rollback();
        return res.status(404).json({ error: 'No such deposit' });
      }
      if (row.status !== 'held') {
        await conn.rollback();
        return res.status(409).json({ error: `This deposit is ${row.status}` });
      }

      const remaining = row.amount_minor - row.redeemed_minor;
      // Redeeming without an amount uses whatever is left.
      const take = req.body.amount_minor != null
        ? money(req.body.amount_minor)
        : remaining;

      if (take <= 0 || take > remaining) {
        await conn.rollback();
        return res.status(409).json({
          error: 'Not enough left on this deposit',
          remaining_minor: remaining,
        });
      }

      const redeemed = row.redeemed_minor + take;
      const status = redeemed >= row.amount_minor ? 'redeemed' : 'held';
      await conn.execute(
        `UPDATE epos_deposits
         SET redeemed_minor = ?, status = ?, redeemed_order_id = ?
         WHERE id = ?`,
        [
          redeemed,
          status,
          req.body.order_id || row.redeemed_order_id || null,
          row.id,
        ]
      );
      await conn.commit();

      broadcast({ type: 'deposits' });
      // Report the state as it now is, not as it was read: a caller that
      // echoes this back to the clerk must not show a spent deposit as held.
      res.json({
        ...row,
        redeemed_minor: redeemed,
        status,
        applied_minor: take,
        remaining_minor: row.amount_minor - redeemed,
      });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally { conn.release(); }
  });

  router.put('/deposits/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const allowed = ['customer_name', 'customer_phone', 'description',
        'due_on', 'status', 'notes'];
      const given = allowed.filter((f) =>
        Object.prototype.hasOwnProperty.call(req.body, f));
      if (!given.length) return res.status(400).json({ error: 'Nothing to update' });

      await pool.execute(
        `UPDATE epos_deposits SET ${given.map((f) => `\`${f}\`=?`).join(',')}
         WHERE id = ? AND office = ?`,
        [...given.map((f) => req.body[f] ?? null), req.params.id, office]
      );
      const [[row]] = await pool.query('SELECT * FROM epos_deposits WHERE id = ?',
        [req.params.id]);
      broadcast({ type: 'deposits' });
      res.json(row);
    } catch (e) { next(e); }
  });

  // ---- Loyalty ------------------------------------------------------------

  const LOYALTY_DEFAULTS = {
    enabled: 1, points_per_pound: 1, point_value_minor: 1, min_spend_minor: 0,
    min_redeem_points: 100, redeem_step_points: 100, points_expire_months: 0,
    earn_on_gratuity: 0, require_phone: 1,
  };

  async function readLoyalty(office) {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_loyalty_settings WHERE office = ?', [office]);
    const [tiers] = await pool.query(
      `SELECT * FROM epos_loyalty_tiers WHERE office = ? AND active = 1
       ORDER BY min_spend_minor`, [office]);
    return { ...(row || { office, ...LOYALTY_DEFAULTS }), tiers };
  }

  router.get('/loyalty', auth, async (req, res, next) => {
    try { res.json(await readLoyalty(await tenantEmail(req))); }
    catch (e) { next(e); }
  });

  router.get('/loyalty/public', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      if (!office) return res.status(400).json({ error: 'office is required' });
      res.json(await readLoyalty(office));
    } catch (e) { next(e); }
  });

  router.put('/loyalty', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const fields = Object.keys(LOYALTY_DEFAULTS)
        .filter((f) => Object.prototype.hasOwnProperty.call(req.body, f));

      if (fields.length) {
        const values = fields.map((f) => {
          const v = req.body[f];
          return typeof v === 'boolean' ? (v ? 1 : 0) : money(v);
        });
        const cols = ['office', ...fields];
        await pool.execute(
          `INSERT INTO epos_loyalty_settings (${cols.map((c) => `\`${c}\``).join(',')})
           VALUES (${cols.map(() => '?').join(',')})
           ON DUPLICATE KEY UPDATE ${fields.map((f) => `\`${f}\`=VALUES(\`${f}\`)`).join(',')}`,
          [office, ...values]
        );
      }

      // Tiers are replaced wholesale: the editor sends the full ladder, and a
      // tier removed there must disappear here.
      if (Array.isArray(req.body.tiers)) {
        await pool.execute('DELETE FROM epos_loyalty_tiers WHERE office = ?', [office]);
        for (const [i, tier] of req.body.tiers.entries()) {
          await pool.execute(
            `INSERT INTO epos_loyalty_tiers
               (office, name, min_spend_minor, discount_percent,
                points_multiplier, colour, perks, active, sort_order)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [
              office, tier.name || `Tier ${i + 1}`,
              money(tier.min_spend_minor), Number(tier.discount_percent) || 0,
              Number(tier.points_multiplier) || 1,
              tier.colour || '#8e8e93', tier.perks || null,
              tier.active === false ? 0 : 1, i,
            ]
          );
        }
      }

      broadcast({ type: 'loyalty' });
      res.json(await readLoyalty(office));
    } catch (e) { next(e); }
  });

  /**
   * Search members by name, phone, card number or email.
   *
   * A phone number is the usual way loyalty is claimed, but it is not the only
   * one: regulars are known by name, and a scheme with printed cards is claimed
   * by scanning one. Exact-phone-only lookup meant a clerk who could see the
   * customer standing in front of them still could not find their points.
   *
   * Returns the same shape as `/loyalty/customer`, so the till can treat a
   * search hit and a phone match identically.
   */
  router.get('/loyalty/search', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const term = String(req.query.q || '').trim();
      if (!office) return res.status(400).json({ error: 'office is required' });
      // One character matches most of the customer book; make the clerk commit
      // to at least two before scanning the table.
      if (term.length < 2) return res.json([]);

      const like = `%${term}%`;
      // Spaces are how phone numbers are written and never how they are typed
      // into a till, so the number is matched with them stripped out.
      const digits = term.replace(/\s+/g, '');
      const [rows] = await pool.query(
        `SELECT id, name, phone, email, card_number, points_balance, tier_name,
                lifetime_spend_minor, visits, discount_type, discount_value,
                membership_expiry
         FROM epos_customers
         WHERE email_key = ?
           AND (name LIKE ? OR email LIKE ? OR card_number LIKE ?
                OR REPLACE(phone, ' ', '') LIKE ?)
         ORDER BY points_balance DESC, name
         LIMIT 25`,
        [office, like, like, like, `%${digits}%`]
      );

      const settings = await readLoyalty(office);
      res.json(rows.map((c) => ({
        ...c,
        points_value_minor: c.points_balance * settings.point_value_minor,
        redeemable: c.points_balance >= settings.min_redeem_points,
        settings,
      })));
    } catch (e) { next(e); }
  });

  /**
   * Find a customer by phone — how loyalty is claimed at the counter.
   * Unauthenticated because the till uses it, and it returns only what a
   * receipt would already show.
   */
  router.get('/loyalty/customer', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const phone = String(req.query.phone || '').replace(/\s+/g, '');
      if (!office || !phone) {
        return res.status(400).json({ error: 'office and phone are required' });
      }

      const [[customer]] = await pool.query(
        `SELECT id, name, phone, email, points_balance, tier_name,
                lifetime_spend_minor, visits, discount_type, discount_value,
                membership_expiry
         FROM epos_customers
         WHERE email_key = ? AND REPLACE(phone, ' ', '') = ?`,
        [office, phone]
      );
      if (!customer) return res.status(404).json({ error: 'No customer with that number' });

      const settings = await readLoyalty(office);
      const value = customer.points_balance * settings.point_value_minor;
      res.json({
        ...customer,
        // What those points are actually worth, so the till does not have to
        // duplicate the arithmetic.
        points_value_minor: value,
        redeemable: customer.points_balance >= settings.min_redeem_points,
        settings,
      });
    } catch (e) { next(e); }
  });

  /**
   * Find a member by the card they just swiped.
   *
   * Exact match, never a LIKE. `/loyalty/search` matches a card number as a
   * substring, which is right when a clerk is typing part of one and wrong when
   * a reader has sent a whole one: a venue whose numbers run 999800001 upwards
   * would find member 1 by searching for 99980000**1** and also find member 11,
   * 21 and 100 with it, and the till would have to guess between them with a
   * customer waiting.
   *
   * The same shape as `/loyalty/customer`, so the till treats a swiped member
   * and a phoned-in one identically -- including the settings block, which is
   * what every redemption on the till is priced against.
   */
  router.get('/loyalty/card', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      // The sentinels are the reader's framing, not the card's data, and the
      // till strips them before it gets here. Stripped again anyway: a route
      // that trusts its caller to have sanitised is a route that answers 404
      // for a perfectly good card the first time somebody calls it by hand.
      const number = String(req.query.number || '')
        .replace(/^[;%B]+/, '')
        .replace(/[?].*$/, '')
        .replace(/\D/g, '');

      if (!office || !number) {
        return res.status(400).json({ error: 'office and number are required' });
      }

      const [[customer]] = await pool.query(
        `SELECT id, name, phone, email, card_number, points_balance, tier_name,
                lifetime_spend_minor, visits, discount_type, discount_value,
                membership_expiry
         FROM epos_customers
         WHERE email_key = ? AND card_number = ?
         LIMIT 1`,
        [office, number]
      );

      // Not an error, and said as its own thing rather than as a 404 with a
      // generic message: "no member holds that card" is what the till turns
      // into "would you like to create a new member for this card?", which is
      // the venue's own request and the single most useful thing this route
      // does.
      if (!customer) {
        return res.status(404).json({ error: 'No member holds that card', number });
      }

      const settings = await readLoyalty(office);
      res.json({
        ...customer,
        points_value_minor: customer.points_balance * settings.point_value_minor,
        redeemable: customer.points_balance >= settings.min_redeem_points,
        settings,
      });
    } catch (e) { next(e); }
  });

  /** Enrol at the till: a name and a phone number is all it takes. */
  router.post('/loyalty/customer', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const phone = String(req.body.phone || '').trim();
      if (!office || !phone) {
        return res.status(400).json({ error: 'office and phone are required' });
      }

      const [[existing]] = await pool.query(
        `SELECT id FROM epos_customers
         WHERE email_key = ? AND REPLACE(phone, ' ', '') = ?`,
        [office, phone.replace(/\s+/g, '')]
      );
      if (existing) {
        const [[row]] = await pool.query(
          'SELECT * FROM epos_customers WHERE id = ?', [existing.id]);
        return res.json(row);
      }

      const id = crypto.randomUUID();
      await pool.execute(
        `INSERT INTO epos_customers (id, email_key, name, phone, email)
         VALUES (?,?,?,?,?)`,
        [id, office, req.body.name || 'Guest', phone, req.body.email || null]
      );
      const [[row]] = await pool.query('SELECT * FROM epos_customers WHERE id = ?', [id]);
      broadcast({ type: 'customers' });
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  /**
   * Award or spend points. Locked, because points are money-adjacent and the
   * same customer can be on two tills at once.
   */
  router.post('/loyalty/points', async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = tillOffice(req);
      const customerId = req.body.customer_id;
      const kind = ['earn', 'redeem', 'adjust'].includes(req.body.kind)
        ? req.body.kind : 'earn';
      if (!office || !customerId) {
        return res.status(400).json({ error: 'office and customer_id are required' });
      }

      await conn.beginTransaction();
      const [[customer]] = await conn.query(
        'SELECT * FROM epos_customers WHERE id = ? AND email_key = ? FOR UPDATE',
        [customerId, office]
      );
      if (!customer) {
        await conn.rollback();
        return res.status(404).json({ error: 'No such customer' });
      }

      const settings = await readLoyalty(office);
      const spend = money(req.body.spend_minor);

      // The scheme being switched off has to stop points moving here, not just
      // hide the buttons: a till that has not refreshed its settings would
      // otherwise keep minting points into a retired scheme.
      if (!settings.enabled && kind !== 'adjust') {
        await conn.rollback();
        return res.status(409).json({
          error: 'The loyalty scheme is turned off',
          points_balance: customer.points_balance,
        });
      }

      // The tier the customer is on *now* is what earns — a promotion applies
      // from the next sale, not retrospectively to the one that triggered it.
      const tier = settings.tiers.find((t) => t.name === customer.tier_name);
      const multiplier = Number(tier?.points_multiplier) || 1;

      let points = Math.round(Number(req.body.points) || 0);
      if (kind === 'earn') {
        if (!points) {
          // Earned from the spend when the till does not compute it itself.
          points = Math.floor(spend / 100) * settings.points_per_pound;
        }
        // A tier's multiplier is the whole point of having tiers, and it was
        // being stored and then ignored — a Gold member on 2x earned the same
        // as a walk-in.
        points = Math.round(points * multiplier);
        // A scheme with a minimum spend earns nothing below it.
        if (spend < settings.min_spend_minor) points = 0;
      }

      const delta = kind === 'redeem' ? -Math.abs(points) : points;

      if (kind === 'redeem') {
        if (Math.abs(delta) > customer.points_balance) {
          await conn.rollback();
          return res.status(409).json({
            error: 'Not enough points',
            points_balance: customer.points_balance,
          });
        }
        // The redemption floor is a scheme rule, so it is enforced where the
        // points actually move rather than trusted to whichever till asked.
        if (Math.abs(delta) < settings.min_redeem_points) {
          await conn.rollback();
          return res.status(409).json({
            error: `At least ${settings.min_redeem_points} points are needed to redeem`,
            points_balance: customer.points_balance,
          });
        }
      }

      const balanceAfter = customer.points_balance + delta;
      const lifetime = customer.lifetime_spend_minor + (kind === 'earn' ? spend : 0);

      // Tier is recomputed from lifetime spend on every earn, so a customer
      // crossing a threshold is promoted at the till rather than overnight.
      let tierName = customer.tier_name;
      if (kind === 'earn' && settings.tiers.length) {
        const earned = settings.tiers
          .filter((t) => lifetime >= t.min_spend_minor)
          .sort((a, b) => b.min_spend_minor - a.min_spend_minor)[0];
        if (earned) tierName = earned.name;
      }

      await conn.execute(
        `UPDATE epos_customers
         SET points_balance = ?, lifetime_spend_minor = ?, tier_name = ?,
             visits = visits + ?, last_visit = NOW()
         WHERE id = ?`,
        [balanceAfter, lifetime, tierName, kind === 'earn' ? 1 : 0, customerId]
      );
      await conn.execute(
        `INSERT INTO epos_loyalty_txns
           (id, office, customer_id, order_id, kind, points, balance_after,
            spend_minor, value_minor, note)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          crypto.randomUUID(), office, customerId, req.body.order_id || null,
          kind, delta, balanceAfter, spend,
          Math.abs(delta) * settings.point_value_minor,
          req.body.note || null,
        ]
      );
      await conn.commit();

      broadcast({ type: 'loyalty.points' });
      res.json({
        customer_id: customerId,
        points: delta,
        points_balance: balanceAfter,
        tier_name: tierName,
        value_minor: Math.abs(delta) * settings.point_value_minor,
      });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally { conn.release(); }
  });

  router.get('/loyalty/customer/:id/transactions', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT * FROM epos_loyalty_txns
         WHERE customer_id = ? AND office = ?
         ORDER BY created_at DESC LIMIT 200`,
        [req.params.id, office]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  // ---- Promotions ---------------------------------------------------------

  const PROMO_FIELDS = ['name', 'kind', 'value', 'buy_qty', 'free_qty',
    'deal_price_minor', 'scope', 'scope_value', 'min_spend_minor', 'starts_on',
    'ends_on', 'days_of_week', 'start_time', 'end_time', 'badge_text',
    'badge_colour', 'stackable', 'priority', 'active', 'sort_order'];

  router.get('/promotions', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        'SELECT * FROM epos_promotions WHERE office = ? ORDER BY sort_order, id',
        [office]
      );
      // The products each promo names, so the editor can show them.
      for (const row of rows) {
        const [products] = await pool.query(
          'SELECT pluid FROM epos_promotion_products WHERE promotion_id = ?',
          [row.id]
        );
        row.products = products.map((p) => p.pluid);
      }
      res.json(rows);
    } catch (e) { next(e); }
  });

  /** The till's copy: only what is live today, so it applies offers offline. */
  router.get('/promotions/public', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      if (!office) return res.status(400).json({ error: 'office is required' });

      const [rows] = await pool.query(
        `SELECT * FROM epos_promotions
         WHERE office = ? AND active = 1
           AND (starts_on IS NULL OR starts_on <= CURDATE())
           AND (ends_on IS NULL OR ends_on >= CURDATE())
         ORDER BY priority DESC, sort_order`,
        [office]
      );
      for (const row of rows) {
        const [products] = await pool.query(
          'SELECT pluid FROM epos_promotion_products WHERE promotion_id = ?',
          [row.id]
        );
        row.products = products.map((p) => p.pluid);
      }
      res.json(rows);
    } catch (e) { next(e); }
  });

  router.post('/promotions', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const given = PROMO_FIELDS.filter((f) =>
        Object.prototype.hasOwnProperty.call(req.body, f));

      const [r] = await pool.execute(
        `INSERT INTO epos_promotions (office ${given.length ? ',' + given.map((f) => `\`${f}\``).join(',') : ''})
         VALUES (?${given.map(() => ',?').join('')})`,
        [office, ...given.map((f) => normalisePromo(f, req.body[f]))]
      );
      await setPromoProducts(r.insertId, req.body.products);

      const [[row]] = await pool.query('SELECT * FROM epos_promotions WHERE id = ?',
        [r.insertId]);
      broadcast({ type: 'promotions' });
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  router.put('/promotions/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const given = PROMO_FIELDS.filter((f) =>
        Object.prototype.hasOwnProperty.call(req.body, f));

      if (given.length) {
        await pool.execute(
          `UPDATE epos_promotions SET ${given.map((f) => `\`${f}\`=?`).join(',')}
           WHERE id = ? AND office = ?`,
          [...given.map((f) => normalisePromo(f, req.body[f])), req.params.id, office]
        );
      }
      if (Array.isArray(req.body.products)) {
        await setPromoProducts(req.params.id, req.body.products);
      }

      const [[row]] = await pool.query('SELECT * FROM epos_promotions WHERE id = ?',
        [req.params.id]);
      broadcast({ type: 'promotions' });
      res.json(row);
    } catch (e) { next(e); }
  });

  router.delete('/promotions/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      await pool.execute('DELETE FROM epos_promotions WHERE id = ? AND office = ?',
        [req.params.id, office]);
      await pool.execute('DELETE FROM epos_promotion_products WHERE promotion_id = ?',
        [req.params.id]);
      broadcast({ type: 'promotions' });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  function normalisePromo(field, value) {
    if (field === 'active' || field === 'stackable') {
      return value ? 1 : 0;
    }
    if (['value', 'buy_qty', 'free_qty', 'deal_price_minor', 'min_spend_minor',
         'priority', 'sort_order'].includes(field)) {
      return money(value);
    }
    // Empty date and time strings must become NULL, not ''.
    if (['starts_on', 'ends_on', 'start_time', 'end_time'].includes(field)) {
      return value || null;
    }
    return value ?? null;
  }

  async function setPromoProducts(promotionId, products) {
    if (!Array.isArray(products)) return;
    await pool.execute('DELETE FROM epos_promotion_products WHERE promotion_id = ?',
      [promotionId]);
    for (const pluid of products) {
      const id = Number(pluid);
      if (!Number.isFinite(id)) continue;
      await pool.execute(
        `INSERT IGNORE INTO epos_promotion_products (promotion_id, pluid)
         VALUES (?,?)`,
        [promotionId, id]
      );
    }
  }

  // ---- Rules --------------------------------------------------------------

  router.get('/rules', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        'SELECT * FROM epos_rules WHERE office = ? ORDER BY sort_order, id',
        [office]
      );
      // Stored as TEXT on 5.7; parsed here so the client gets objects.
      res.json(rows.map((r) => ({
        ...r,
        conditions: safeParse(r.conditions),
        actions: safeParse(r.actions),
      })));
    } catch (e) { next(e); }
  });

  router.get('/rules/public', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      if (!office) return res.status(400).json({ error: 'office is required' });
      const [rows] = await pool.query(
        `SELECT * FROM epos_rules WHERE office = ? AND active = 1
         ORDER BY priority DESC, sort_order`,
        [office]
      );
      res.json(rows.map((r) => ({
        ...r,
        conditions: safeParse(r.conditions),
        actions: safeParse(r.actions),
      })));
    } catch (e) { next(e); }
  });

  router.post('/rules', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [r] = await pool.execute(
        `INSERT INTO epos_rules
           (office, name, trigger_kind, conditions, actions, active, priority, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          office, req.body.name || 'Rule',
          req.body.trigger_kind || 'sale_total',
          JSON.stringify(req.body.conditions ?? {}),
          JSON.stringify(req.body.actions ?? {}),
          req.body.active === false ? 0 : 1,
          money(req.body.priority), money(req.body.sort_order),
        ]
      );
      broadcast({ type: 'rules' });
      res.status(201).json({ id: r.insertId });
    } catch (e) { next(e); }
  });

  router.put('/rules/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      await pool.execute(
        `UPDATE epos_rules
         SET name = ?, trigger_kind = ?, conditions = ?, actions = ?,
             active = ?, priority = ?, sort_order = ?
         WHERE id = ? AND office = ?`,
        [
          req.body.name || 'Rule', req.body.trigger_kind || 'sale_total',
          JSON.stringify(req.body.conditions ?? {}),
          JSON.stringify(req.body.actions ?? {}),
          req.body.active === false ? 0 : 1,
          money(req.body.priority), money(req.body.sort_order),
          req.params.id, office,
        ]
      );
      broadcast({ type: 'rules' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.delete('/rules/:id', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      await pool.execute('DELETE FROM epos_rules WHERE id = ? AND office = ?',
        [req.params.id, office]);
      broadcast({ type: 'rules' });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  function safeParse(text) {
    // A malformed rule must not take the whole list down with it.
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  // ---- Voucher validation -------------------------------------------------

  /**
   * Check a voucher before the till applies it. Enforces expiry, start date,
   * usage limits and minimum spend in one place, so a till cannot honour a
   * voucher the back office has retired.
   */
  router.get('/vouchers/validate', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const code = String(req.query.code || '').trim().toUpperCase();
      const subtotal = money(req.query.subtotal_minor);
      if (!office || !code) {
        return res.status(400).json({ error: 'office and code are required' });
      }

      const [[row]] = await pool.query(
        `SELECT v.* FROM bo_vouchers v
         JOIN offices o ON o.id = v.office_id
         WHERE o.contact_email = ? AND UPPER(v.code) = ?`,
        [office, code]
      );
      if (!row) return res.status(404).json({ error: 'No such voucher' });

      const today = new Date(new Date().toDateString());
      const reasons = [];
      if (!row.active) reasons.push('This voucher is not active');
      if (row.expires_on && new Date(row.expires_on) < today) {
        reasons.push('This voucher has expired');
      }
      if (row.starts_on && new Date(row.starts_on) > today) {
        reasons.push('This voucher is not valid yet');
      }
      if (!row.reusable && row.times_used > 0) {
        reasons.push('This voucher has already been used');
      }
      if (row.max_uses > 0 && row.times_used >= row.max_uses) {
        reasons.push('This voucher has reached its limit');
      }
      if (row.min_spend_minor > 0 && subtotal < row.min_spend_minor) {
        reasons.push(`Spend at least £${(row.min_spend_minor / 100).toFixed(2)}`);
      }

      // What it is worth against this particular bill.
      let discount = 0;
      if (row.discount_type === 'percent') {
        discount = Math.round(subtotal * (row.value / 100));
      } else if (row.discount_type === 'amount') {
        discount = row.value;
      }
      // Never discount more than the bill: a £20 voucher on an £8 sale is £8
      // off, not £12 handed back.
      discount = Math.min(discount, subtotal);

      res.json({
        ...row,
        valid: reasons.length === 0,
        reasons,
        discount_minor: reasons.length ? 0 : discount,
      });
    } catch (e) { next(e); }
  });

  /** Record a redemption so single-use vouchers cannot be used twice. */
  router.post('/vouchers/redeem', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const code = String(req.body.code || '').trim().toUpperCase();
      if (!office || !code) {
        return res.status(400).json({ error: 'office and code are required' });
      }
      const [r] = await pool.execute(
        `UPDATE bo_vouchers v
         JOIN offices o ON o.id = v.office_id
         SET v.times_used = v.times_used + 1
         WHERE o.contact_email = ? AND UPPER(v.code) = ?`,
        [office, code]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such voucher' });
      broadcast({ type: 'vouchers' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { commerceRoutes };
