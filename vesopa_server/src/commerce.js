const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('./auth');
const applePush = require('./wallet_apple_push');
const { ensureMemberNumber } = require('./member_numbers');
const training = require('./training');
const tillSeats = require('./till_seats');

/**
 * How long a till's hold on a gift card lasts.
 *
 * Long enough for a table's bill to be split three ways and paid over dinner,
 * short enough that money a till never came back for is not locked up for a
 * day. A capture after it lapses still succeeds when the money is still there;
 * the expiry only stops a forgotten hold blocking another till.
 */
const HOLD_MINUTES = 60;

/**
 * The routes a TILL calls, which identify the venue by a query parameter.
 *
 * Exact method and path, not a prefix: /loyalty/customer/:id/transactions is a
 * back-office route under the same stem, carries a session token, and must not
 * be mistaken for a till.
 */
const TILL_CALLS = [
  ['get', '/tender-settings/public'],
  ['get', '/promotions/public'],
  ['get', '/rules/public'],
  ['get', '/loyalty/public'],
  ['get', '/gift-cards/lookup'],
  ['post', '/gift-cards/redeem'],
  ['post', '/gift-cards/hold'],
  ['post', '/gift-cards/capture'],
  ['post', '/gift-cards/release'],
  ['post', '/gift-cards/reverse'],
  ['get', '/deposits/lookup'],
  ['post', '/deposits/redeem'],
  ['get', '/vouchers/validate'],
  ['post', '/vouchers/redeem'],
  ['get', '/loyalty/search'],
  ['get', '/loyalty/customer'],
  ['get', '/loyalty/card'],
  ['post', '/loyalty/renew'],
  ['post', '/loyalty/customer'],
  ['post', '/loyalty/points'],
];

/** The ones that read somebody's money or somebody's details back. */
const LOOKUPS = new Set([
  '/gift-cards/lookup', '/deposits/lookup', '/vouchers/validate',
  '/loyalty/search', '/loyalty/customer', '/loyalty/card',
]);

/**
 * Lookups a minute: per address for an unsigned caller, per venue for a till.
 *
 * Generous on purpose. Every till in a venue shares one public address, and a
 * clerk typing a member's name searches as they type, so a tight limit would
 * stop a busy bar finding its own customers on a Saturday night. Guessing a
 * gift card code at 240 a minute is still hopeless -- there are about 10^18 of
 * them -- and the real answer to strangers is the terminal token, not a limit.
 */
const UNSIGNED_LOOKUPS = Number(process.env.COMMERCE_UNSIGNED_LOOKUPS_PER_MIN) || 240;
const SIGNED_LOOKUPS = Number(process.env.COMMERCE_SIGNED_LOOKUPS_PER_MIN) || 1200;

/**
 * A fixed-window counter per key. In memory, because a restart forgiving
 * everybody is fine and a table written on every lookup is not.
 */
const windows = new Map();
function limited(key, perMinute) {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= 60000) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 5000) {
      for (const [k, v] of windows) if (now - v.start >= 60000) windows.delete(k);
    }
    return false;
  }
  w.count += 1;
  return w.count > perMinute;
}

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

  // Training mode moves no money. A till in training never calls these (it
  // simulates the tender), so this only ever catches a till that got it wrong
  // -- and a trainee spending a real customer's gift card or points is exactly
  // the mistake that must be refused, loudly, rather than recorded.
  router.post(
    ['/gift-cards/redeem', '/deposits/redeem', '/vouchers/redeem',
      '/loyalty/points', '/loyalty/renew'],
    (req, res, next) => {
      const b = req.body || {};
      if (b.training === true || b.training === 1) {
        return res.status(409).json({ error: training.REFUSED, training: true });
      }
      next();
    }
  );

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

  /**
   * The venue a till call is for.
   *
   * A signed till's own venue when it sent its token -- see tillIdentity -- and
   * the `office` it named otherwise. The second is what every till did before
   * the token existed, and is still accepted until every till sends one.
   */
  function tillOffice(req) {
    if (req.tillOffice) return req.tillOffice;
    const office = String(req.query.office || req.body?.office || '').trim();
    return office || null;
  }

  // ---- Which till is calling ----------------------------------------------
  //
  // These routes used to trust whatever venue email they were handed. Anybody
  // who knew a venue's contact address -- it is on its website -- and the code
  // off a gift card could check the balance or spend it from anywhere, and the
  // loyalty search would list a venue's members to them.
  //
  // A till has carried a signed terminal token since v1.3.1.0, so it can prove
  // which venue it belongs to. When it sends one, that venue is the only one
  // it can act for. When nothing is sent, the call is counted and -- until
  // COMMERCE_REQUIRE_TERMINAL=1 -- allowed, because a till too old to send a
  // token is still a till in a venue that is trading.

  const unsignedSeen = new Map();
  function noteUnsigned(req, route, reason) {
    const office = String(req.query.office || req.body?.office || '').trim().slice(0, 190) || '?';
    pool
      .execute(
        `INSERT INTO epos_commerce_unsigned (office, route, reason, day, calls, last_ip, last_at)
         VALUES (?, ?, ?, CURDATE(), 1, ?, NOW())
         ON DUPLICATE KEY UPDATE calls = calls + 1, last_ip = VALUES(last_ip), last_at = NOW()`,
        [office, route.slice(0, 40), reason, String(req.ip || '').slice(0, 45)]
      )
      .catch(() => {});
    const key = `${office}|${route}|${reason}`;
    const last = unsignedSeen.get(key) || 0;
    if (Date.now() - last > 60 * 60 * 1000) {
      unsignedSeen.set(key, Date.now());
      console.warn(`[commerce] unsigned till call: ${route} for ${office} (${reason})`);
    }
  }

  function tooMany(res) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many lookups. Wait a minute and try again.' });
  }

  async function tillIdentity(req, res, next) {
    const route = (req.route && req.route.path) || req.path;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    let claims = null;
    if (token) {
      try {
        const c = jwt.verify(token, secret);
        if (c.scope === 'terminal' && c.office) {
          claims = c;
        } else if (!c.scope) {
          // A back-office session. Not a till, and not a stranger either: it
          // behaves exactly as it did before.
          return next();
        }
      } catch {
        claims = null;
      }
    }

    if (claims) {
      // A till signed out from the back office is turned away here as it is
      // everywhere else. A lookup that fails lets it through: a licence count
      // must never be what stops a venue taking a gift card.
      try {
        const seat = await tillSeats.seatFor(claims, token);
        if (seat && seat.released) {
          return res.status(401).json({
            error: 'This till was signed out from the back office. Sign it in again to carry on.',
            signed_out: true,
          });
        }
      } catch (e) {
        console.warn('[commerce] could not check a seat:', e.message);
      }

      const named = String(req.query.office || req.body?.office || '').trim();
      if (named && named.toLowerCase() !== String(claims.office).toLowerCase()) {
        return res.status(403).json({ error: 'That till belongs to a different venue.' });
      }
      req.tillOffice = claims.office;
      req.terminal = claims;
      if (LOOKUPS.has(route) && limited(`t:${claims.office}`, SIGNED_LOOKUPS)) return tooMany(res);
      return next();
    }

    noteUnsigned(req, route, token ? 'bad-token' : 'none');
    if (process.env.COMMERCE_REQUIRE_TERMINAL === '1') {
      return res.status(401).json({
        error: 'This till needs to be signed in again before it can take gift cards, vouchers or points.',
        needs_terminal: true,
      });
    }
    if (LOOKUPS.has(route) && limited(`ip:${req.ip}`, UNSIGNED_LOOKUPS)) return tooMany(res);
    next();
  }

  for (const [method, path] of TILL_CALLS) router[method](path, tillIdentity);

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

  /**
   * What is held on a card by open bills, in pence.
   *
   * Bound by card id, never joined: the holds table and the cards table were
   * created years apart and do not share a collation on live.
   */
  async function heldOn(db, cardId, exceptHoldId = null) {
    try {
      const [[row]] = await db.query(
        `SELECT COALESCE(SUM(amount_minor), 0) AS held FROM epos_gift_card_holds
          WHERE gift_card_id = ? AND status = 'held' AND expires_at > NOW()` +
          (exceptHoldId ? ' AND id <> ?' : ''),
        exceptHoldId ? [cardId, exceptHoldId] : [cardId]
      );
      return Number(row && row.held) || 0;
    } catch (e) {
      // A server that has not had schema_gift_shop.sql yet has no holds.
      if (e.code === 'ER_NO_SUCH_TABLE') return 0;
      throw e;
    }
  }

  /** Why a card cannot be spent right now, or null when it can. */
  function cardProblem(card) {
    if (!card) return { error: 'No such gift card', status: 404 };
    if (card.status !== 'active') return { error: `This card is ${card.status}`, status: 409 };
    if (card.expires_on &&
        new Date(card.expires_on) < new Date(new Date().toDateString())) {
      return { error: 'This card has expired', status: 409 };
    }
    if (card.usable_from && new Date(card.usable_from) > new Date()) {
      const when = new Date(card.usable_from).toLocaleString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
        timeZone: 'Europe/London',
      });
      return {
        error: `This card can be used from ${when}`,
        status: 409,
        usable_from: card.usable_from,
      };
    }
    return null;
  }

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
      const held = await heldOn(pool, card.id);
      const problem = cardProblem(card);
      res.json({
        ...card,
        expired: !!expired,
        // What another open bill has not already claimed. A till offers this,
        // not the balance, so two tills cannot both promise the same money.
        available_minor: Math.max(0, card.balance_minor - held),
        not_yet: !!(card.usable_from && new Date(card.usable_from) > new Date()),
        reason: problem && problem.status !== 404 ? problem.error : null,
        redeemable: !problem && card.balance_minor - held > 0,
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
      // A reload tops up a card that is not spendable YET -- an online order
      // still inside its waiting period -- so only a redemption asks when.
      const problem = kind === 'redeem'
        ? cardProblem(card)
        : (cardProblem(card) && cardProblem(card).usable_from ? null : cardProblem(card));
      if (problem) {
        await conn.rollback();
        return problem;
      }

      const amount = money(amountMinor);
      if (amount <= 0) {
        await conn.rollback();
        return { error: 'Amount must be more than zero', status: 400 };
      }

      // Redemptions and refunds take money off; reloads put it on.
      const delta = kind === 'redeem' ? -amount : amount;

      // An older till spends straight away rather than holding first, and must
      // not spend money a newer till is holding for a bill it has open.
      const available = kind === 'redeem'
        ? card.balance_minor - await heldOn(conn, card.id)
        : card.balance_minor;
      if (kind === 'redeem' && amount > available) {
        await conn.rollback();
        return {
          error: 'Not enough left on this card',
          status: 409,
          balance_minor: card.balance_minor,
          available_minor: Math.max(0, available),
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

      // The balance on the front of the card just changed, which for a gift
      // card is the only thing on it anybody reads. Same fire-and-forget as
      // the loyalty push above: this runs inside a redemption at a till.
      applePush
        .notifyPassChanged({ pool, office, kind: 'giftcard', subjectId: card.id })
        .catch(() => {});

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

  // ---- Hold, capture, release, reverse ------------------------------------
  //
  // The till used to spend a gift card the moment it was tendered, then record
  // the tender. Undo took the tender off the till and left the money off the
  // card: a customer who changed their mind about paying with it lost what they
  // had tendered. The shape below is the one gift-card platforms settled on:
  //
  //   hold     reserve an amount while the bill is open; moves no money
  //   capture  the sale completed -- spend exactly what was held
  //   release  the tender was undone or the bill abandoned -- give it back
  //   reverse  a finished sale was refunded -- put the money back on the card
  //
  // /gift-cards/redeem stays for tills that do not know about holds.

  router.post('/gift-cards/hold', async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = tillOffice(req);
      const code = String(req.body.code || '').trim().toUpperCase();
      const amount = money(req.body.amount_minor);
      if (!office || !code) {
        return res.status(400).json({ error: 'office and code are required' });
      }
      if (amount <= 0) return res.status(400).json({ error: 'Amount must be more than zero' });

      await conn.beginTransaction();
      const [[card]] = await conn.query(
        'SELECT * FROM epos_gift_cards WHERE office = ? AND code = ? FOR UPDATE',
        [office, code]
      );
      const problem = cardProblem(card);
      if (problem) {
        await conn.rollback();
        return res.status(problem.status).json(problem);
      }

      const held = await heldOn(conn, card.id);
      const available = card.balance_minor - held;
      if (amount > available) {
        await conn.rollback();
        return res.status(409).json({
          error: 'Not enough left on this card',
          balance_minor: card.balance_minor,
          available_minor: Math.max(0, available),
        });
      }

      const id = crypto.randomUUID();
      await conn.execute(
        `INSERT INTO epos_gift_card_holds
           (id, gift_card_id, office, amount_minor, order_id, terminal, clerk_name, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'held', DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
        [
          id, card.id, office, amount,
          req.body.order_id ? String(req.body.order_id).slice(0, 64) : null,
          // What the till calls itself, or failing that its seat: enough for a
          // manager to tell which of two tills is holding a card.
          String(req.body.terminal || (req.terminal && req.terminal.jti) || '').slice(0, 80) || null,
          req.body.clerk_name ? String(req.body.clerk_name).slice(0, 80) : null,
          HOLD_MINUTES,
        ]
      );
      await conn.commit();

      res.json({
        hold_id: id,
        amount_minor: amount,
        expires_in_s: HOLD_MINUTES * 60,
        card: {
          id: card.id,
          code: card.code,
          label: card.label || null,
          balance_minor: card.balance_minor,
          available_minor: available - amount,
          expires_on: card.expires_on,
        },
      });
    } catch (e) {
      await conn.rollback().catch(() => {});
      next(e);
    } finally { conn.release(); }
  });

  router.post('/gift-cards/capture', async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = tillOffice(req);
      const holdId = String(req.body.hold_id || '').trim();
      if (!office || !holdId) {
        return res.status(400).json({ error: 'office and hold_id are required' });
      }

      await conn.beginTransaction();
      const [[hold]] = await conn.query(
        'SELECT * FROM epos_gift_card_holds WHERE id = ? AND office = ? FOR UPDATE',
        [holdId, office]
      );
      if (!hold) {
        await conn.rollback();
        return res.status(404).json({ error: 'No such hold' });
      }

      const [[card]] = await conn.query(
        'SELECT * FROM epos_gift_cards WHERE id = ? AND office = ? FOR UPDATE',
        [hold.gift_card_id, office]
      );

      // The same capture sent twice -- a retry after a dropped connection --
      // answers as it did the first time rather than spending twice.
      if (hold.status === 'captured') {
        await conn.commit();
        return res.json({ captured: true, repeated: true, txn_id: hold.txn_id, card: card || null });
      }
      if (hold.status === 'released') {
        await conn.rollback();
        return res.status(409).json({ error: 'That hold was already given back' });
      }
      if (!card || card.status === 'void') {
        await conn.rollback();
        return res.status(409).json({ error: 'This card has been cancelled' });
      }

      // A hold taken while the card was valid is honoured even if the card
      // expired while the bill was open. What it cannot do is spend money that
      // is no longer there, which only happens when the hold lapsed and
      // somebody else spent it in the meantime.
      const others = await heldOn(conn, card.id, hold.id);
      if (hold.amount_minor > card.balance_minor - others) {
        await conn.rollback();
        return res.status(409).json({
          error: 'Not enough left on this card',
          balance_minor: card.balance_minor,
          available_minor: Math.max(0, card.balance_minor - others),
        });
      }

      const after = card.balance_minor - hold.amount_minor;
      const status = after <= 0 && card.kind === 'paper' ? 'redeemed' : card.status;
      const txnId = crypto.randomUUID();
      await conn.execute(
        'UPDATE epos_gift_cards SET balance_minor = ?, status = ? WHERE id = ?',
        [after, status, card.id]
      );
      await conn.execute(
        `INSERT INTO epos_gift_card_txns
           (id, gift_card_id, office, kind, amount_minor, balance_after,
            order_id, clerk_name, note, hold_id)
         VALUES (?, ?, ?, 'redeem', ?, ?, ?, ?, ?, ?)`,
        [
          txnId, card.id, office, -hold.amount_minor, after,
          String(req.body.order_id || hold.order_id || '').slice(0, 36) || null,
          hold.clerk_name, 'Redeemed against sale', hold.id,
        ]
      );
      await conn.execute(
        `UPDATE epos_gift_card_holds SET status = 'captured', txn_id = ?, settled_at = NOW()
          WHERE id = ?`,
        [txnId, hold.id]
      );
      await conn.commit();

      applePush
        .notifyPassChanged({ pool, office, kind: 'giftcard', subjectId: card.id })
        .catch(() => {});
      broadcast({ type: 'gift-cards' });
      res.json({ captured: true, txn_id: txnId, card: { ...card, balance_minor: after, status } });
    } catch (e) {
      await conn.rollback().catch(() => {});
      next(e);
    } finally { conn.release(); }
  });

  /** Give a hold back. Saying it twice is harmless. */
  router.post('/gift-cards/release', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const holdId = String(req.body.hold_id || '').trim();
      if (!office || !holdId) {
        return res.status(400).json({ error: 'office and hold_id are required' });
      }
      const [r] = await pool.execute(
        `UPDATE epos_gift_card_holds SET status = 'released', settled_at = NOW()
          WHERE id = ? AND office = ? AND status = 'held'`,
        [holdId, office]
      );
      res.json({ released: r.affectedRows > 0 });
    } catch (e) { next(e); }
  });

  /**
   * Put money back on a card for a sale that was undone.
   *
   * Never more than that sale took from that card, net of anything already put
   * back: a refund pressed twice, or a partial refund followed by a full one,
   * cannot mint money onto a card.
   */
  router.post('/gift-cards/reverse', async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = tillOffice(req);
      const code = String(req.body.code || '').trim().toUpperCase();
      const orderId = String(req.body.order_id || '').trim().slice(0, 36);
      if (!office || !code || !orderId) {
        return res.status(400).json({ error: 'office, code and order_id are required' });
      }

      await conn.beginTransaction();
      const [[card]] = await conn.query(
        'SELECT * FROM epos_gift_cards WHERE office = ? AND code = ? FOR UPDATE',
        [office, code]
      );
      if (!card) {
        await conn.rollback();
        return res.status(404).json({ error: 'No such gift card' });
      }

      const [[sums]] = await conn.query(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'redeem' THEN -amount_minor ELSE 0 END), 0) AS taken,
           COALESCE(SUM(CASE WHEN kind = 'reverse' THEN amount_minor ELSE 0 END), 0) AS returned
         FROM epos_gift_card_txns
         WHERE gift_card_id = ? AND order_id = ?`,
        [card.id, orderId]
      );
      const outstanding = Number(sums.taken) - Number(sums.returned);
      if (outstanding <= 0) {
        await conn.rollback();
        return res.status(409).json({ error: 'Nothing was taken from this card for that sale' });
      }
      const asked = req.body.amount_minor == null ? outstanding : money(req.body.amount_minor);
      if (asked <= 0) {
        await conn.rollback();
        return res.status(400).json({ error: 'Amount must be more than zero' });
      }
      const amount = Math.min(asked, outstanding);

      const after = card.balance_minor + amount;
      // A spent paper certificate comes back to life with what it was owed. A
      // void card stays void: the money goes back on the record, and the
      // venue decides what to do about a card it had cancelled.
      const status = card.status === 'redeemed' ? 'active' : card.status;
      const txnId = crypto.randomUUID();
      await conn.execute(
        'UPDATE epos_gift_cards SET balance_minor = ?, status = ? WHERE id = ?',
        [after, status, card.id]
      );
      await conn.execute(
        `INSERT INTO epos_gift_card_txns
           (id, gift_card_id, office, kind, amount_minor, balance_after,
            order_id, clerk_name, note)
         VALUES (?, ?, ?, 'reverse', ?, ?, ?, ?, ?)`,
        [
          txnId, card.id, office, amount, after, orderId,
          req.body.clerk_name ? String(req.body.clerk_name).slice(0, 80) : null,
          String(req.body.note || 'Given back: sale undone').slice(0, 255),
        ]
      );
      await conn.commit();

      applePush
        .notifyPassChanged({ pool, office, kind: 'giftcard', subjectId: card.id })
        .catch(() => {});
      broadcast({ type: 'gift-cards' });
      res.json({ reversed_minor: amount, txn_id: txnId, card: { ...card, balance_minor: after, status } });
    } catch (e) {
      await conn.rollback().catch(() => {});
      next(e);
    } finally { conn.release(); }
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
    // Membership, which is a different thing from points and shares this row
    // because it is the same scheme from the venue's side.
    //
    // A TERM *AND* A DATE, and which one applies is decided in /loyalty/renew.
    //
    // This used to be a term only, and the comment here argued the case: a
    // fixed date is wrong for everybody who renews on a different day and has
    // to be edited every year, whereas twelve months from the day the fee is
    // taken needs setting once. That argument is sound and it answered the
    // wrong question. A members' club does not run twelve rolling months per
    // person; it runs a season, and every card in the place expires on the
    // same night. The venue said so in their own example — "the card would
    // expire on 31/08/2027" — which is a rugby season, not an anniversary.
    //
    // So both. `membership_renewal_date` wins while it is set and has not
    // passed; the term is what a venue with no season gets, and what everybody
    // gets back the moment the date is cleared. £10 is the venue's own figure.
    membership_term_months: 12, membership_fee_minor: 1000,
    // The night the season ends, or null for "no season, use the term".
    //
    // Null is a real answer and the default, not a value nobody has filled in
    // yet: it is what every venue on 1.6.8.0 has, and clearing the field is
    // how a venue goes back to rolling months.
    membership_renewal_date: null,
    // The product a renewal is rung up as, so the fee carries a VAT treatment,
    // a department and a line in the Z report rather than being a bare number.
    // Null is a real answer — the till then rings a plain line at the fee above
    // with no VAT on it, and the settings form says so.
    membership_plu: null,
  };

  async function readLoyalty(office) {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_loyalty_settings WHERE office = ?', [office]);
    const [tiers] = await pool.query(
      `SELECT * FROM epos_loyalty_tiers WHERE office = ? AND active = 1
       ORDER BY min_spend_minor`, [office]);
    // Defaults first, so a stored row that predates a setting still answers
    // for it. `SELECT *` returns whatever columns the database has; before
    // schema_membership.sql has been applied that is nine settings rather than
    // eleven, and the till would otherwise be told a membership costs
    // `undefined`.
    const settings = { ...LOYALTY_DEFAULTS, ...(row || { office }), tiers };

    /*
     * The season date, as a day rather than as a moment.
     *
     * `SELECT *` hands a DATE back as a JavaScript Date at local midnight, and
     * JSON.stringify turns that into "2027-08-30T23:00:00.000Z" in British
     * summer time — a day early, and only in summer, which is the worst way
     * for a date bug to behave because it works all winter.
     *
     * Every other date on this row is read with DATE_FORMAT for exactly this
     * reason; this one cannot be, because the query is a star. So it is
     * normalised here instead, and the string is what the till and the form
     * both compare against.
     */
    const day = settings.membership_renewal_date;
    settings.membership_renewal_date = day
      ? (day instanceof Date
          ? [
              day.getFullYear(),
              String(day.getMonth() + 1).padStart(2, '0'),
              String(day.getDate()).padStart(2, '0'),
            ].join('-')
          : String(day).slice(0, 10))
      : null;

    return settings;
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

      // The two membership settings are checked rather than merely rounded.
      // A term of 0 renews a member to today — an expired card the moment it
      // is paid for — and a negative fee is a line that takes money off the
      // bill. Both are one typed character away in the settings form.
      if (Object.prototype.hasOwnProperty.call(req.body, 'membership_term_months')) {
        const months = Number(req.body.membership_term_months);
        if (!Number.isInteger(months) || months < 1 || months > 60) {
          return res.status(400).json({
            error: 'A membership runs for between 1 and 60 months.',
          });
        }
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'membership_fee_minor')) {
        const fee = Number(req.body.membership_fee_minor);
        if (!Number.isFinite(fee) || fee < 0) {
          return res.status(400).json({
            error: 'A membership fee cannot be less than nothing.',
          });
        }
      }

      // The season date, if one was sent. An empty box clears it, which is how
      // a venue goes back to rolling months, so '' and null are accepted and
      // mean the same thing. Anything else has to be a real calendar date:
      // a typo stored as-is would be read back by the renewal route and turn
      // into a membership expiring on a day that does not exist.
      //
      // A date in the PAST is allowed through deliberately. A season end is
      // entered months ahead and a venue that has not rolled it forward yet
      // has made a mistake we should tell them about rather than refuse — the
      // form warns, and /loyalty/renew ignores a date that has passed and uses
      // the term, so nobody is ever issued an already-expired card.
      if (Object.prototype.hasOwnProperty.call(req.body, 'membership_renewal_date')) {
        const raw = req.body.membership_renewal_date;
        if (raw !== null && raw !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
          return res.status(400).json({
            error: 'A renewal date must be a day, as YYYY-MM-DD, or empty.',
          });
        }
      }

      if (fields.length) {
        const values = fields.map((f) => {
          const v = req.body[f];
          // A day or nothing. Not through `money` — that would turn
          // "2027-08-31" into a number and store 2027.
          if (f === 'membership_renewal_date') {
            return v === null || v === '' ? null : String(v).slice(0, 10);
          }
          // `membership_plu` is the one nullable setting here, and null is a
          // real answer: it means "no product, ring a plain line". Everything
          // else goes through `money`, which turns null into 0 — and a PLU of
          // 0 is a product nobody has, so the till would look one up, fail to
          // find it, and fall back silently for ever.
          if (f === 'membership_plu') {
            const plu = Number(v);
            return v === null || v === '' || !Number.isFinite(plu) || plu <= 0
              ? null
              : Math.round(plu);
          }
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
                membership_expiry, photo_url
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
                membership_expiry, photo_url
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
                membership_expiry, photo_url
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

  /**
   * Renew a membership, and say when it now runs to.
   *
   * "Say they expired and then paid £10 membership at the till, the till
   * should then renew to a date we set in the back office."
   *
   * THE DATE IS COMPUTED HERE, NOT AT THE TILL
   *
   * Two tills and a back office would otherwise each add a term to whatever
   * they last synced, on whatever their own clock says, and a member would end
   * up with a different expiry depending on which terminal took the money. One
   * server, one clock, one answer.
   *
   * AN EARLY RENEWAL EXTENDS, IT DOES NOT SHORTEN
   *
   * A member who pays in November for a card that runs to January gets January
   * plus a year, not November plus a year. Renewing early must never cost
   * somebody two months they have already paid for — and a venue that pushes
   * renewals at Christmas would otherwise be quietly taking them.
   *
   * The money is not taken here. The fee is a line on the bill and goes
   * through tendering like everything else, so it lands in the takings, on the
   * receipt and in the Z. This route moves a date.
   */
  router.post('/loyalty/renew', async (req, res, next) => {
    try {
      const office = tillOffice(req);
      const customerId = String(req.body?.customer_id || '').trim();
      if (!office || !customerId) {
        return res.status(400).json({ error: 'office and customer_id are required' });
      }

      const [[customer]] = await pool.query(
        `SELECT id, DATE_FORMAT(membership_expiry, '%Y-%m-%d') AS membership_expiry
           FROM epos_customers WHERE id = ? AND email_key = ?`,
        [customerId, office]
      );
      if (!customer) return res.status(404).json({ error: 'No such customer' });

      const settings = await readLoyalty(office);
      const months = Math.min(
        Math.max(Number(settings.membership_term_months) || 12, 1), 60);

      // Today, or the expiry it already has if that is still ahead. Compared
      // as text in the server's own day, which is what the till shows and what
      // the back office badge reads.
      const today = new Date();
      const todayText = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0'),
      ].join('-');
      const from = customer.membership_expiry && customer.membership_expiry > todayText
        ? customer.membership_expiry
        : todayText;

      /*
       * A SEASON, IF THE VENUE RUNS ONE.
       *
       * "If the expired card was swiped today and they paid for a membership
       * the card would expire on 31/08/2027." A club's membership year ends
       * on a night, the same night for everybody, and the alternative — twelve
       * months from whenever each person happened to pay — is what the venue
       * is asking us to stop doing.
       *
       * IGNORED ONCE IT HAS PASSED, and this is the guard that makes the
       * feature safe to leave switched on. A season date is typed in months
       * ahead and there will be a morning after it when nobody has rolled it
       * forward yet. Renewing to it then would take ten pounds off somebody
       * and hand them a card that had already expired — at the counter, in
       * front of them. So a date in the past is treated as no date at all and
       * the rolling term takes over, which is a card that certainly works.
       * The back office warns about the stale date separately; the till must
       * not be the thing that discovers it.
       *
       * Not run through the "extend, do not shorten" rule above, deliberately.
       * That rule protects somebody renewing early under a rolling term. Under
       * a season there is nothing to protect: the date IS the answer for every
       * member, and a card already running to next August renews to next
       * August, which is what a season means.
       */
      const season = settings.membership_renewal_date;
      const useSeason = Boolean(season) && season >= todayText;

      // Added in SQL rather than in JavaScript: MySQL's INTERVAL already knows
      // that a year from the 29th of February is the 28th, and that a month
      // from the 31st of January is the 28th too. Doing it here with a Date
      // gives the 1st of March and the 3rd of March respectively, which is a
      // day nobody chose.
      const [[{ next_expiry: rolled }]] = await pool.query(
        'SELECT DATE_FORMAT(DATE_ADD(?, INTERVAL ? MONTH), \'%Y-%m-%d\') AS next_expiry',
        [from, months]
      );
      const expiry = useSeason ? season : rolled;

      await pool.execute(
        'UPDATE epos_customers SET membership_expiry = ? WHERE id = ? AND email_key = ?',
        [expiry, customerId, office]
      );
      broadcast({ type: 'customers.updated' });

      // The whole customer back, in the shape the till already reads from
      // /loyalty/card, so a renewal refreshes the local copy from one response
      // rather than needing a second lookup.
      const [[row]] = await pool.query(
        `SELECT id, name, phone, email, card_number, points_balance, tier_name,
                lifetime_spend_minor, visits, discount_type, discount_value,
                photo_url,
                DATE_FORMAT(membership_expiry, '%Y-%m-%d') AS membership_expiry
           FROM epos_customers WHERE id = ?`,
        [customerId]
      );
      res.json({
        ...row,
        renewed_from: from,
        term_months: months,
        // Which rule actually applied, so the till can say "renewed to 31
        // August 2027" rather than guessing, and so a support call about a
        // date somebody did not expect has an answer in one response.
        renewed_by: useSeason ? 'season' : 'term',
        points_value_minor: row.points_balance * settings.point_value_minor,
        redeemable: row.points_balance >= settings.min_redeem_points,
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
      // Awaited, unlike the wallet push below: this is an enrolment rather than
      // a sale, the row is about to be returned to the till, and a member who
      // appears on screen without a number would have to be re-fetched to get
      // one. It cannot throw — see src/member_numbers.js.
      await ensureMemberNumber(pool, office, id);
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
        /*
         * AN EXPIRED CARD CANNOT SPEND.
         *
         * "If a customer has expired, they can still use the loyalty card on
         * the till." The till now refuses at every door it owns, but the till
         * is a copy: it syncs customers and can be holding a membership that
         * ran out while it was on the counter, or be a version behind. This is
         * the door the venue's money actually goes through, so it is checked
         * here as well.
         *
         * REDEEMING ONLY, AND EARNING DELIBERATELY LEFT ALONE.
         *
         * A bill that renews a membership awards its points BEFORE it posts
         * the renewal — see the settle path in `ui/payment_page.dart`, where
         * the order matters because the fee has to be taken before the date
         * moves. Refusing to earn on an expired card would therefore rob the
         * one person who has just paid ten pounds to stop being expired. And
         * points earned onto a lapsed card cost the venue nothing: they are
         * unspendable until it is renewed, which is this check.
         *
         * Compared as days in the server's own calendar, and inclusive: a card
         * dated 31 March works all of the 31st. Told at the counter that their
         * card ran out today, on the day it says, is an argument no clerk
         * should have to have.
         */
        const [[{ expired }]] = await conn.query(
          'SELECT (? IS NOT NULL AND ? < CURDATE()) AS expired',
          [customer.membership_expiry, customer.membership_expiry]
        );
        if (expired) {
          await conn.rollback();
          return res.status(409).json({
            error: 'That membership has run out, so those points cannot be spent yet.',
            // A code as well as a sentence: the till turns this into the same
            // dialog a swipe produces, and matching on English would break the
            // first time anybody reworded it.
            code: 'membership_expired',
            points_balance: customer.points_balance,
          });
        }

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

      // Both kinds, because both cards changed. The loyalty card shows the
      // points; the membership card shows the tier, which a big enough spend
      // has just moved. Pushing one and not the other leaves a customer whose
      // wallet disagrees with itself.
      //
      // Deliberately not awaited. The response is what a till is waiting on,
      // and APNs is a network round trip to Apple — a customer's card being a
      // few seconds behind is nothing, whereas a queue at the counter is real.
      // notifyPassChanged never throws; the .catch is for the database being
      // unreachable, which the sale itself has already survived.
      for (const kind of ['loyalty', 'customer']) {
        applePush
          .notifyPassChanged({ pool, office, kind, subjectId: customerId })
          .catch(() => {});
      }

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
