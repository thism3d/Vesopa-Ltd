/**
 * Repricing a whole catalogue, one level at a time.
 *
 * "I want a product price level update like this but more advanced."
 *
 * The thing being improved on is one form: a base level, a target level, some
 * products, a percentage, and a green button that writes. What this adds is the
 * three things that form is missing, and every one of them is about the same
 * fear — that a manager types 80 where they meant 8 and finds out at the
 * counter.
 *
 *   1. NOTHING IS WRITTEN UNTIL IT HAS BEEN SEEN. `preview` runs the whole
 *      calculation and returns every line — what each product costs now and
 *      what it would cost — without touching a row. `apply` then re-runs the
 *      same calculation on the same inputs. It is deliberately NOT "write what
 *      the browser sent back": a preview the client could edit is a preview
 *      that decides nothing.
 *
 *   2. ROUNDING IS PART OF THE RULE, not an afterthought. 7.5% on £3.20 is
 *      £3.44, and no bar in the country prices like that. A venue picks the
 *      shape it actually charges in — nearest 5p, .99, whole pounds — and the
 *      preview shows what that does.
 *
 *   3. EVERY RUN CAN BE PUT BACK. Each product's old value is recorded, null
 *      included, so one press restores exactly what was there. A bulk price
 *      change without an undo is the feature people stop trusting after the
 *      first mistake.
 *
 * WHAT IS DELIBERATELY REFUSED
 *
 * A product with no price at the SOURCE level is skipped rather than treated as
 * zero, and it is named in the response. Null at a level means "charge Price 1"
 * (see `data/price_levels.dart` on the till), so reading it as £0.00 and
 * applying a discount would set a real price of nothing on the target level and
 * the till would sell it for nothing, silently, at the counter.
 *
 * A result below zero is clamped to zero and reported, for the same class of
 * reason: money that goes negative comes back as change owed.
 */

const express = require('express');

const { requireAuth } = require('./auth');

/** Level 1 is `price`; the rest are `price_N`. */
const COLUMN = { 1: 'price', 2: 'price_2', 3: 'price_3', 4: 'price_4', 5: 'price_5', 6: 'price_6' };

const METHODS = ['percent', 'amount', 'copy'];
const DIRECTIONS = ['up', 'down'];
const ROUNDINGS = ['none', '5p', '10p', '99', '95', 'pound'];

/** A level a venue actually has. */
function level(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

/**
 * Apply the venue's rounding to a price in pence.
 *
 * `99` and `95` mean "end the price in that", which is a different operation
 * from rounding to a multiple: £3.44 with a .99 ending is £3.99 if you round
 * up and £2.99 if you round down, and the one a manager means is the NEAREST.
 * A price under a pound keeps its pounds at zero rather than becoming £0.99
 * when it was 40p — going up by two and a half times is not rounding.
 */
function round(pence, rule) {
  if (!Number.isFinite(pence)) return 0;
  const p = Math.max(0, Math.round(pence));

  switch (rule) {
    case '5p':
      return Math.round(p / 5) * 5;
    case '10p':
      return Math.round(p / 10) * 10;
    case 'pound':
      return Math.round(p / 100) * 100;
    case '99':
    case '95': {
      const ending = rule === '99' ? 99 : 95;
      /*
       * The two candidate prices either side, and then the nearer.
       *
       * `floor(p / 100) * 100 + ending` is the obvious way to get the one
       * below and it is wrong: for £3.44 it gives £3.99, which is above. Every
       * price whose pence are under the ending would then round UP — £3.44
       * becoming £3.99 is a 16% rise on a change the manager asked to be 7.5%.
       *
       * Subtracting the ending before flooring is what actually finds the
       * largest ending-price at or below `p`.
       */
      const below = Math.floor((p - ending) / 100) * 100 + ending;
      const above = below + 100;
      const candidate = p - below <= above - p ? below : above;
      // A price under a pound keeps its pounds at zero rather than being
      // inflated into the ending: 40p is not £1.99.
      return candidate < ending ? ending : candidate;
    }
    default:
      return p;
  }
}

/** What one product's target price becomes. Pence in, pence out. */
function repriced({ basePence, method, direction, amount, rounding }) {
  let next = basePence;

  if (method === 'percent') {
    const factor = direction === 'down' ? 1 - amount / 100 : 1 + amount / 100;
    next = basePence * factor;
  } else if (method === 'amount') {
    next = direction === 'down' ? basePence - amount : basePence + amount;
  }
  // `copy` leaves it exactly as the base level has it, which is how a venue
  // seeds a new level before nudging it.

  return round(next, rounding);
}

function priceLevelRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /** The office's own key, which is what `bo_products` is scoped by. */
  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query(
        'SELECT contact_email FROM offices WHERE id = ?',
        [req.user.officeId],
      );
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  /**
   * Read and check what the form sent.
   *
   * Returns `{ error }` or a settled rule. Every value is checked here and
   * nowhere else, so `preview` and `apply` cannot drift into accepting
   * different things — which would mean a preview that showed one answer and a
   * write that made another.
   */
  function rule(body) {
    const source = level(body.source_level);
    const target = level(body.target_level);
    if (!source || !target) return { error: 'Choose a price level to read and one to write.' };

    // Level 1 is THE price. A venue that overwrote it from a level would have a
    // catalogue whose shelf price came from a happy hour, and no way back to
    // what the products actually cost.
    if (target === 1) {
      return {
        error: 'Price 1 is the product’s own price and cannot be written by a '
          + 'bulk update. Pick one of the other levels as the target.',
      };
    }

    const method = METHODS.includes(body.method) ? body.method : null;
    if (!method) return { error: 'Choose how to change the price.' };

    const direction = DIRECTIONS.includes(body.direction) ? body.direction : 'up';
    const rounding = ROUNDINGS.includes(body.rounding) ? body.rounding : 'none';

    let amount = 0;
    if (method !== 'copy') {
      amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return { error: 'Enter how much to change the price by.' };
      }
      // A percentage over 100 down is a free product; over 1000 up is a typo.
      if (method === 'percent' && direction === 'down' && amount > 100) {
        return { error: 'A price cannot come down by more than 100%.' };
      }
      if (method === 'percent' && amount > 1000) {
        return { error: 'That percentage looks like a mistake. The most is 1000%.' };
      }
    }

    const plus = Array.isArray(body.plu_ids)
      ? [...new Set(body.plu_ids.map(Number).filter(Number.isInteger))]
      : [];
    if (!plus.length) return { error: 'Pick at least one product.' };

    return { source, target, method, direction, amount, rounding, plus };
  }

  /**
   * Work out what would change, without changing anything.
   *
   * Shared by `preview` and `apply` so the two can never disagree about what a
   * rule means — the whole value of showing somebody a preview rests on the
   * write doing exactly what the preview said.
   */
  async function calculate(email, r) {
    const [rows] = await pool.query(
      `SELECT pluid, product_name, department_name,
              ${COLUMN[r.source]} AS base, ${COLUMN[r.target]} AS current
         FROM bo_products
        WHERE email = ? AND pluid IN (${r.plus.map(() => '?').join(',')})
        ORDER BY department_name, product_name`,
      [email, ...r.plus],
    );

    const changes = [];
    const skipped = [];

    for (const row of rows) {
      // Null at the source is "no price here", not zero. See the header.
      if (row.base === null || row.base === undefined) {
        skipped.push({
          pluid: row.pluid,
          name: row.product_name,
          reason: `no price at ${r.source === 1 ? 'Price 1' : `level ${r.source}`}`,
        });
        continue;
      }

      const basePence = Math.round(Number(row.base) * 100);
      const beforePence = row.current === null || row.current === undefined
        ? null
        : Math.round(Number(row.current) * 100);
      const afterPence = repriced({
        basePence,
        method: r.method,
        direction: r.direction,
        amount: r.amount,
        rounding: r.rounding,
      });

      // Nothing to write, so nothing to show. A preview padded with two hundred
      // unchanged rows is a preview nobody reads.
      if (beforePence === afterPence) {
        skipped.push({
          pluid: row.pluid,
          name: row.product_name,
          reason: 'already at that price',
        });
        continue;
      }

      changes.push({
        pluid: row.pluid,
        name: row.product_name,
        department: row.department_name,
        base_minor: basePence,
        before_minor: beforePence,
        after_minor: afterPence,
        delta_minor: beforePence === null ? null : afterPence - beforePence,
      });
    }

    return { changes, skipped };
  }

  /** What a venue calls each level, so the page never says "Price Level 2". */
  async function levelNames(email) {
    const [[row]] = await pool.query(
      'SELECT price_level_names FROM epos_till_settings WHERE office = ?',
      [email],
    );
    let named = {};
    try {
      const parsed = row && row.price_level_names ? JSON.parse(row.price_level_names) : null;
      if (parsed && typeof parsed === 'object') named = parsed;
    } catch {
      // A malformed blob reads as "named nothing", which is the state every
      // venue is in until it names one. A page that would not open because a
      // settings string was bad would be a much worse failure.
    }
    return [1, 2, 3, 4, 5, 6].map((n) => ({
      level: n,
      name: n === 1 ? 'Price 1' : String(named[n] || named[String(n)] || `Price ${n}`),
    }));
  }

  // ------------------------------------------------------------------ read
  router.get('/price-levels', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const [products] = await pool.query(
        `SELECT pluid, product_name, department_name,
                price, price_2, price_3, price_4, price_5, price_6
           FROM bo_products
          WHERE email = ? AND active = 1
          ORDER BY department_name, product_name`,
        [email],
      );
      res.json({ levels: await levelNames(email), products });
    } catch (e) {
      next(e);
    }
  });

  // --------------------------------------------------------------- preview
  router.post('/price-levels/preview', auth, async (req, res, next) => {
    try {
      const r = rule(req.body || {});
      if (r.error) return res.status(400).json({ error: r.error });
      const email = await tenantEmail(req);
      res.json(await calculate(email, r));
    } catch (e) {
      next(e);
    }
  });

  // ----------------------------------------------------------------- apply
  router.post('/price-levels/apply', auth, async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
      const r = rule(req.body || {});
      if (r.error) return res.status(400).json({ error: r.error });
      const email = await tenantEmail(req);

      /*
       * Recalculated here rather than taking the browser's word for it.
       *
       * The preview the manager approved is a picture of this calculation, not
       * an input to it — a request that carried prices would let anything that
       * could reach this route write any price it liked onto any product.
       */
      const { changes, skipped } = await calculate(email, r);
      if (!changes.length) {
        return res.json({ applied: 0, skipped, run_id: null });
      }

      await connection.beginTransaction();

      const [run] = await connection.execute(
        `INSERT INTO bo_price_level_runs
           (email, source_level, target_level, method, direction, amount,
            rounding, product_count, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          email, r.source, r.target, r.method, r.direction, r.amount,
          r.rounding, changes.length, req.user.email || null,
        ],
      );

      const column = COLUMN[r.target];
      for (const change of changes) {
        await connection.execute(
          `UPDATE bo_products SET ${column} = ? WHERE email = ? AND pluid = ?`,
          [change.after_minor / 100, email, change.pluid],
        );
        await connection.execute(
          `INSERT INTO bo_price_level_run_items
             (run_id, plu_id, before_price, after_price)
           VALUES (?, ?, ?, ?)`,
          [
            run.insertId,
            change.pluid,
            change.before_minor === null ? null : change.before_minor / 100,
            change.after_minor / 100,
          ],
        );
      }

      await connection.commit();

      // Tills hold a local copy of the catalogue; tell them to refresh it.
      broadcast({ type: 'catalogue.updated' });
      res.json({ applied: changes.length, skipped, run_id: run.insertId });
    } catch (e) {
      await connection.rollback().catch(() => {});
      next(e);
    } finally {
      connection.release();
    }
  });

  // ------------------------------------------------------------------ runs
  router.get('/price-levels/runs', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT id, source_level, target_level, method, direction, amount,
                rounding, product_count, created_by, created_at,
                undone_at, undone_by
           FROM bo_price_level_runs
          WHERE email = ?
          ORDER BY created_at DESC
          LIMIT 25`,
        [email],
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // ------------------------------------------------------------------ undo
  router.post('/price-levels/runs/:id/undo', auth, async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
      const email = await tenantEmail(req);

      const [[run]] = await pool.query(
        'SELECT * FROM bo_price_level_runs WHERE id = ? AND email = ?',
        [req.params.id, email],
      );
      // Scoped, and a 404 rather than a 403: another venue's run is not this
      // venue's business to know exists.
      if (!run) return res.status(404).json({ error: 'No such price update.' });
      if (run.undone_at) {
        return res.status(409).json({ error: 'That update has already been put back.' });
      }

      const [items] = await pool.query(
        'SELECT plu_id, before_price FROM bo_price_level_run_items WHERE run_id = ?',
        [run.id],
      );

      await connection.beginTransaction();
      const column = COLUMN[run.target_level];
      for (const item of items) {
        /*
         * Exactly what was there, null included.
         *
         * Null at a level means "no price here, charge Price 1". Writing 0
         * back over a null would set a real price of nothing and the till
         * would sell that product for nothing.
         */
        await connection.execute(
          `UPDATE bo_products SET ${column} = ? WHERE email = ? AND pluid = ?`,
          [item.before_price, email, item.plu_id],
        );
      }
      await connection.execute(
        'UPDATE bo_price_level_runs SET undone_at = NOW(), undone_by = ? WHERE id = ?',
        [req.user.email || null, run.id],
      );
      await connection.commit();

      broadcast({ type: 'catalogue.updated' });
      res.json({ restored: items.length });
    } catch (e) {
      await connection.rollback().catch(() => {});
      next(e);
    } finally {
      connection.release();
    }
  });

  return router;
}

module.exports = { priceLevelRoutes, round, repriced };
