const express = require('express');
const { requireAuth, requireTerminal } = require('./auth');
const { ensureMemberNumber } = require('./member_numbers');

/**
 * Magnetic swipe cards: what each prefix means, who holds which card, and the
 * numbers this venue has handed out.
 *
 * See schema_swipe_cards.sql for the shape of a card and why the default prefixes are
 * 9999 / 9998 / 9878 rather than something invented here.
 *
 * WHAT THE TILL DOES WITHOUT THIS SERVER
 *
 * A staff card is checked **locally**, against the cached staff list the till
 * already keeps for PIN sign-on. That is not an optimisation; it is the rule
 * this whole product is built on. A till that could only verify a card online
 * is a till that cannot open when the broadband is down, which is the one
 * moment nobody can afford it.
 *
 * A loyalty or gift card is looked up **here**, because that is where the
 * balance is and the till has never pretended otherwise: points are money-
 * adjacent and the same member can be at two tills at once. An offline till
 * says so plainly and rings the sale up without the member, rather than
 * awarding points from a stale cache that a second till has already spent.
 *
 * TENANCY
 *
 *   /till/cards/*   a commissioned till, terminal token. The office comes off
 *                   the signed token, never a query string -- these routes
 *                   issue credentials and resolve who a card belongs to.
 *   /api/cards/*    the back office, session token, scoped to the signed-in
 *                   office.
 */
function cardRoutes({ pool, broadcast, secret }) {
  const router = express.Router();

  const CARD_DEFAULTS = {
    enabled: 1,
    // This venue's live numbers, copied from the system they are moving off so
    // that every card already in a customer's wallet keeps working. See
    // schema_swipe_cards.sql.
    clerk_prefix: '9999',
    loyalty_prefix: '9998',
    gift_prefix: '9878',
    // Empty, and deliberately so: this venue's current system has three
    // prefixes and no fourth, so switching a membership programme on for them
    // would be inventing a scheme they have not asked for and have no cards
    // for. An empty prefix matches nothing -- see classify().
    membership_prefix: '',
    number_digits: 5,
    auto_enrol: 1,
  };

  const KINDS = ['clerk', 'loyalty', 'gift', 'membership'];

  /**
   * A prefix as it may be stored.
   *
   * Digits only, and length-capped. A prefix with a space or a sentinel in it
   * matches nothing -- silently, on every card the venue owns -- so it is
   * rejected at the point somebody types it rather than discovered at a
   * counter. Empty is allowed and means "this venue does not run that
   * programme".
   */
  function cleanPrefix(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    return digits.slice(0, 8);
  }

  /**
   * What the reader typed, reduced to the digits on the card.
   *
   * A keyboard-wedge stripe reader types the sentinels too -- `;` at the front,
   * `?` at the back -- and track 2 may carry a field separator with service
   * data after it. None of that is the card's number. The till strips it before
   * it ever gets here; this repeats the work because a route that trusts its
   * caller to have done the sanitising is a route that stores `;999800001?` in
   * the column on the first day somebody calls it from a script.
   */
  function cleanNumber(value) {
    const raw = String(value ?? '').trim();
    const withoutSentinels = raw.replace(/^[;%B]+/, '').replace(/[?].*$/, '');
    const beforeSeparator = withoutSentinels.split(/[=^]/)[0];
    return beforeSeparator.replace(/\D/g, '').slice(0, 64);
  }

  async function readSettings(office) {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_card_settings WHERE office = ?',
      [office]
    );
    return row || { office, ...CARD_DEFAULTS };
  }

  /**
   * Which programme a number belongs to.
   *
   * Longest prefix first, so a venue that has configured 9998 for loyalty and
   * 99980 for something else gets the more specific answer rather than whichever
   * happened to be compared first. An empty prefix never matches -- otherwise
   * `startsWith('')` would make every card in the building a member of whatever
   * programme the venue had switched off.
   */
  function classify(settings, number) {
    const candidates = [
      { kind: 'clerk', prefix: String(settings.clerk_prefix || '') },
      { kind: 'loyalty', prefix: String(settings.loyalty_prefix || '') },
      { kind: 'gift', prefix: String(settings.gift_prefix || '') },
      { kind: 'membership', prefix: String(settings.membership_prefix || '') },
    ]
      .filter((c) => c.prefix.length > 0 && number.startsWith(c.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    return candidates[0] || null;
  }

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

  const auth = requireAuth(secret);
  const terminal = requireTerminal(secret);

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  router.get('/api/cards/settings', auth, async (req, res, next) => {
    try {
      res.json(await readSettings(await tenantEmail(req)));
    } catch (e) {
      next(e);
    }
  });

  router.put('/api/cards/settings', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);

      const fields = Object.keys(CARD_DEFAULTS).filter((f) =>
        Object.prototype.hasOwnProperty.call(req.body, f)
      );
      if (!fields.length) return res.json(await readSettings(office));

      const values = fields.map((field) => {
        const value = req.body[field];
        if (field.endsWith('_prefix')) return cleanPrefix(value);
        if (field === 'number_digits') {
          // Between four and twelve. Narrower than four and a venue runs out of
          // members inside a year; wider than twelve and it no longer fits a
          // track comfortably alongside the prefix.
          return Math.min(Math.max(Number(value) || 5, 4), 12);
        }
        return value ? 1 : 0;
      });

      const cols = ['office', ...fields];
      await pool.execute(
        `INSERT INTO epos_card_settings (${cols.map((c) => `\`${c}\``).join(',')})
         VALUES (${cols.map(() => '?').join(',')})
         ON DUPLICATE KEY UPDATE
           ${fields.map((f) => `\`${f}\`=VALUES(\`${f}\`)`).join(',')}`,
        [office, ...values]
      );

      broadcast({ type: 'cards' });
      res.json(await readSettings(office));
    } catch (e) {
      next(e);
    }
  });

  /**
   * The same settings, for a till.
   *
   * The till caches these and reads a swipe against the cache, so a terminal
   * that cannot reach the server still knows that 9999 means a staff card. A
   * till that has never successfully pulled them falls back to the defaults
   * above, which are this venue's real numbers -- so even the very first swipe
   * on a brand new terminal with no network behaves correctly.
   */
  router.get('/till/cards/settings', terminal, async (req, res, next) => {
    try {
      res.json(await readSettings(req.office));
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // Reading a card
  // ---------------------------------------------------------------------------
  //
  // There is deliberately no lookup route here.
  //
  // The till classifies a swipe itself, against the prefixes it cached from
  // /till/cards/settings above. That is not an optimisation: a till with no
  // network still has to know that 9999 means a staff card, because the staff
  // card is the one that has to work when the broadband is down. Having worked
  // out which programme a card belongs to, the till resolves it against
  // whichever store already owns that answer -- its own cached staff list for a
  // clerk, /api/loyalty/card for a member, /api/gift-cards/:code for a gift
  // card. A fourth route here would be a second way to ask three questions that
  // already have answers, and the two would drift.

  // ---------------------------------------------------------------------------
  // Writing a card
  // ---------------------------------------------------------------------------

  /**
   * Take the next number for a programme, under a lock.
   *
   * `INSERT ... ON DUPLICATE KEY UPDATE next_number = next_number + 1` and then
   * reading it back is the only form of this that is safe with two tills
   * issuing at once: the increment happens inside the row lock the statement
   * already takes. Reading first and writing second is the version that hands
   * two members the same card number, and the second one to be swiped silently
   * loads the first one's points.
   */
  async function nextNumber(conn, office, kind) {
    await conn.execute(
      `INSERT INTO epos_card_sequences (office, kind, next_number)
       VALUES (?,?,2)
       ON DUPLICATE KEY UPDATE next_number = next_number + 1`,
      [office, kind]
    );
    const [[row]] = await conn.query(
      'SELECT next_number FROM epos_card_sequences WHERE office = ? AND kind = ?',
      [office, kind]
    );
    // next_number now points at the *following* card, so the one just claimed
    // is one behind it. The seed above is 2 for exactly this reason: the first
    // card a venue ever issues is number 1.
    return Number(row.next_number) - 1;
  }

  /**
   * Issue a card and attach it to somebody.
   *
   * Returns the number to encode. **No stripe is written here** — this server
   * has no encoder attached to it and neither does the till. What it produces
   * is the authoritative number and the exact track the venue's own encoder
   * should be given, which is the half that has to be right; the plastic is
   * made with whatever writer they already own.
   */
  router.post('/till/cards/issue', terminal, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const office = req.office;
      const kind = KINDS.includes(req.body?.kind) ? req.body.kind : null;
      if (!kind) {
        return res.status(400).json({ error: 'kind must be clerk, loyalty or gift.' });
      }

      const settings = await readSettings(office);
      const prefix = String(
        {
          clerk: settings.clerk_prefix,
          loyalty: settings.loyalty_prefix,
          gift: settings.gift_prefix,
          membership: settings.membership_prefix,
        }[kind] || ''
      );
      if (!prefix) {
        return res.status(400).json({
          error: `No ${kind} prefix is set for this venue.`,
        });
      }

      const subjectId = String(req.body?.subject_id || '').trim() || null;
      const subjectName = String(req.body?.subject_name || '').trim() || null;
      const width = Math.min(Math.max(Number(settings.number_digits) || 5, 4), 12);

      await conn.beginTransaction();

      const number = await nextNumber(conn, office, kind);
      const cardNumber = `${prefix}${String(number).padStart(width, '0')}`;

      // Attach it. Each kind has its own column, and the write is inside the
      // same transaction as the sequence bump so a failure here cannot burn a
      // number on a card nobody holds.
      // A membership card names a customer, exactly as a loyalty card does, so
      // it is attached the same way. The difference between the two is what the
      // venue does with the row afterwards -- points against a balance, or a
      // subscription against `membership_expiry` -- and not how the card is
      // recognised.
      if ((kind === 'loyalty' || kind === 'membership') && subjectId) {
        // The card number only. `member_no` used to be set here too, from this
        // card's sequence number, which made a member's identity a side effect
        // of being handed plastic: sign up from a poster and you had none, get
        // a second card and it changed. It is allocated once at enrolment now —
        // see src/member_numbers.js — and reused here.
        await conn.execute(
          `UPDATE epos_customers SET card_number = ?
            WHERE id = ? AND email_key = ?`,
          [cardNumber, subjectId, office]
        );
      } else if (kind === 'clerk' && subjectId) {
        await conn.execute(
          'UPDATE bo_clarks SET swipe_card = ? WHERE id = ? AND email = ?',
          [cardNumber, subjectId, office]
        );
      } else if (kind === 'gift') {
        // A swipe gift card *is* its code, so issuing one and creating one are
        // the same act. Balance starts at zero and is loaded by the existing
        // gift-card routes -- this is a piece of plastic, not money, until
        // somebody pays for it.
        await conn.execute(
          `INSERT INTO epos_gift_cards
             (id, office, code, kind, initial_minor, balance_minor,
              recipient_name, issued_by)
           VALUES (UUID(),?,?,'swipe',0,0,?,?)`,
          [office, cardNumber, subjectName, String(req.body?.issued_by || '').slice(0, 120) || null]
        );
      }

      await conn.execute(
        `INSERT INTO epos_card_issues
           (office, kind, card_number, subject_id, subject_name, issued_by,
            terminal)
         VALUES (?,?,?,?,?,?,?)`,
        [
          office,
          kind,
          cardNumber,
          subjectId,
          subjectName,
          String(req.body?.issued_by || '').slice(0, 190) || null,
          String(req.body?.terminal || '').slice(0, 120) || null,
        ]
      );

      await conn.commit();

      // After the commit, and outside its transaction, because it takes the
      // member sequence's row lock and this one is already holding the card
      // sequence's. Taking two counters in one transaction is how two tills
      // issuing different kinds of card at the same moment deadlock.
      //
      // A member who enrolled through any of the four doors already has one, so
      // this is normally a single SELECT that finds it and stops.
      let memberNo = null;
      if ((kind === 'loyalty' || kind === 'membership') && subjectId) {
        memberNo = await ensureMemberNumber(pool, office, subjectId);
      }

      broadcast({ type: 'cards' });

      res.status(201).json({
        kind,
        number,
        member_no: memberNo,
        card_number: cardNumber,
        // What to hand an encoder: sentinels and all, because that is what a
        // stripe carries and what the reader will type back.
        track: `;${cardNumber}?`,
      });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        // Already rolled back, or the connection has gone. Either way the
        // original error is the one worth reporting.
      }
      next(e);
    } finally {
      conn.release();
    }
  });

  /**
   * Attach a card somebody already has to a member.
   *
   * The other half of issuing, and the one a venue moving from another system
   * needs most: their members are already holding cards, and those numbers were
   * not allocated here. So the number is taken as given, checked for shape, and
   * recorded -- rather than the sequence being wound forward to swallow it,
   * which would burn every number in between.
   */
  router.post('/till/cards/assign', terminal, async (req, res, next) => {
    try {
      const office = req.office;
      const number = cleanNumber(req.body?.card_number);
      const subjectId = String(req.body?.subject_id || '').trim();
      if (!number || !subjectId) {
        return res.status(400).json({
          error: 'A card number and who it belongs to are both required.',
        });
      }

      const settings = await readSettings(office);
      const match = classify(settings, number);
      if (!match) {
        return res.status(400).json({
          error:
            'That card does not start with a prefix this venue uses. Check the '
            + 'prefixes in the back office, or swipe a different card.',
        });
      }

      if (match.kind === 'loyalty' || match.kind === 'membership') {
        // Refused rather than moved. A card already in somebody's wallet being
        // silently reassigned is one member spending another's points, and the
        // person it was taken from finds out at the counter.
        const [[taken]] = await pool.query(
          `SELECT id, name FROM epos_customers
           WHERE email_key = ? AND card_number = ? AND id <> ?`,
          [office, number, subjectId]
        );
        if (taken) {
          return res.status(409).json({
            error: `That card already belongs to ${taken.name}.`,
          });
        }

        await pool.execute(
          'UPDATE epos_customers SET card_number = ? WHERE id = ? AND email_key = ?',
          [number, subjectId, office]
        );
      } else if (match.kind === 'clerk') {
        const [[taken]] = await pool.query(
          `SELECT id, clark_name FROM bo_clarks
           WHERE email = ? AND swipe_card = ? AND id <> ?`,
          [office, number, subjectId]
        );
        if (taken) {
          return res.status(409).json({
            error: `That card already belongs to ${taken.clark_name}.`,
          });
        }

        await pool.execute(
          'UPDATE bo_clarks SET swipe_card = ? WHERE id = ? AND email = ?',
          [number, subjectId, office]
        );
      } else {
        return res.status(400).json({
          error: 'Gift cards are created with their number, not assigned one.',
        });
      }

      await pool.execute(
        `INSERT INTO epos_card_issues
           (office, kind, card_number, subject_id, subject_name, issued_by,
            terminal)
         VALUES (?,?,?,?,?,?,?)`,
        [
          office,
          match.kind,
          number,
          subjectId,
          String(req.body?.subject_name || '').slice(0, 190) || null,
          String(req.body?.issued_by || '').slice(0, 190) || null,
          String(req.body?.terminal || '').slice(0, 120) || null,
        ]
      );

      broadcast({ type: 'cards' });
      res.json({ kind: match.kind, card_number: number });
    } catch (e) {
      next(e);
    }
  });

  // ---------------------------------------------------------------------------
  // The record
  // ---------------------------------------------------------------------------

  router.get('/api/cards/issues', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;

      const [rows] = await pool.query(
        `SELECT id, kind, card_number, subject_id, subject_name, issued_by,
                terminal, voided_at, void_reason, at
         FROM epos_card_issues
         WHERE office = ? ${kind ? 'AND kind = ?' : ''}
         ORDER BY at DESC, id DESC
         LIMIT ?`,
        kind ? [office, kind, limit] : [office, limit]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * A card has been lost, or has come back.
   *
   * Marks the issue voided and detaches the number from whoever held it, so a
   * swipe stops finding them. The row stays and the number is never reissued --
   * a lost card is still out there, and handing its number to the next member
   * would give a stranger their points.
   */
  router.post('/api/cards/issues/:id/void', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'No card.' });

      const [[issue]] = await pool.query(
        'SELECT * FROM epos_card_issues WHERE id = ? AND office = ?',
        [id, office]
      );
      if (!issue) return res.status(404).json({ error: 'No such card.' });

      await pool.execute(
        `UPDATE epos_card_issues
            SET voided_at = NOW(), void_reason = ?
          WHERE id = ? AND office = ?`,
        [String(req.body?.reason || 'Cancelled').slice(0, 190), id, office]
      );

      if (issue.kind === 'loyalty' || issue.kind === 'membership') {
        await pool.execute(
          `UPDATE epos_customers SET card_number = NULL
            WHERE email_key = ? AND card_number = ?`,
          [office, issue.card_number]
        );
      } else if (issue.kind === 'clerk') {
        await pool.execute(
          'UPDATE bo_clarks SET swipe_card = NULL WHERE email = ? AND swipe_card = ?',
          [office, issue.card_number]
        );
      } else if (issue.kind === 'gift') {
        await pool.execute(
          `UPDATE epos_gift_cards SET status = 'void'
            WHERE office = ? AND code = ?`,
          [office, issue.card_number]
        );
      }

      broadcast({ type: 'cards' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { cardRoutes };
