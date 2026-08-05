/**
 * Packages.
 *
 * Every figure the public pricing page and the checkout use is editable here:
 * name, term, per-month rate, headline total, discounted total, VAT, saving
 * badge, feature bullets, which one is flagged Most Popular, which one new
 * offices default to, and the order they appear in.
 *
 * What editing does *not* do:
 *
 *   - it does not re-price an existing customer. Each office carries its own
 *     monthly_fee_minor, set when the admin put them on the plan.
 *   - it does not re-price a live PayPal subscription. PayPal plans are created
 *     at checkout against the numbers as they stood then, and PayPal bills
 *     against its own copy.
 *
 * So this screen is "what we quote from tomorrow", which is the only thing it
 * can safely be.
 */

const express = require('express');
const { pool } = require('../db');
const plansStore = require('../plans-store');
const {
  money, fromMinor, toMinor, formatDateTime,
  back, readFlash, navCounts, slugify, str, int,
} = require('./util');

const router = express.Router();

/*
 * Push a saved price straight into the in-memory pricing table.
 *
 * src/plans-store.js is what the public site, the checkout and PayPal all read
 * from, and it polls every five minutes. Without this the admin would save a
 * price, reload /pricing, and see the old one — and reasonably conclude the
 * save had not worked.
 *
 * On 'finish', not before the handler runs: refreshing first would re-read the
 * pre-write rows and leave the stale price live until the next poll.
 */
router.use((req, res, next) => {
  if (req.method === 'POST') res.on('finish', () => { plansStore.refresh(); });
  next();
});

/**
 * Fill in the totals the admin left blank.
 *
 * The four money figures are related but not derivable from each other in one
 * direction — a discounted total is a business decision, VAT is arithmetic. So:
 * anything typed is kept, anything blank is computed from what was typed, and
 * the saving badge is derived last so it can never disagree with the prices
 * printed next to it.
 */
function reconcile(body) {
  const months = Math.max(1, int(body.period_months, 1));
  const perMonth = toMinor(body.price_per_month);

  const total = toMinor(body.total) || perMonth * months;
  const discounted = toMinor(body.discounted) || total;

  const vatRate = Number(body.vat_rate);
  const vat = str(body.vat)
    ? toMinor(body.vat)
    : Number.isFinite(vatRate) && vatRate > 0
      ? Math.round(discounted * (vatRate / 100))
      : 0;

  const withVat = toMinor(body.total_with_vat) || discounted + vat;

  // Rounded, and floored at zero: a "save -3%" badge on a price rise is worse
  // than no badge.
  const save = total > 0 ? Math.max(0, Math.round(((total - discounted) / total) * 100)) : 0;

  return {
    period_months: months,
    price_per_month_minor: perMonth,
    total_minor: total,
    discounted_minor: discounted,
    vat_minor: vat,
    total_with_vat_minor: withVat,
    save_percentage: save,
  };
}

// ---- List / edit ----------------------------------------------------------

router.get('/plans', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM offices o WHERE o.plan = p.slug) AS offices,
              (SELECT COALESCE(SUM(x.amount_minor), 0) FROM office_payments x
                WHERE x.plan_slug = p.slug) AS collected_minor
       FROM web_plans p
       ORDER BY p.is_archived, p.sort_order, p.period_months`
    );

    res.render('admin/plans', {
      title: 'Packages | Vesopa Admin',
      heading: 'Packages',
      nav: 'plans',
      counts: await navCounts(),
      flash: readFlash(req),
      rows,
      money, fromMinor, formatDateTime,
    });
  } catch (e) {
    next(e);
  }
});

// ---- Create ---------------------------------------------------------------

router.post('/plans/new', async (req, res, next) => {
  const name = str(req.body.name, 120);
  if (!name) return back(res, '/admin/plans', { err: 'A package needs a name.' });

  const slug = slugify(str(req.body.slug, 64) || name);
  const m = reconcile(req.body);

  try {
    await pool.query(
      `INSERT INTO web_plans
         (slug, name, period_months, interval_label, interval_count,
          price_per_month_minor, total_minor, discounted_minor, vat_minor,
          total_with_vat_minor, save_percentage, currency, blurb, features,
          is_popular, is_active, sort_order, paypal_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug, name, m.period_months,
        str(req.body.interval_label, 32) || 'Month',
        Math.max(1, int(req.body.interval_count, 1)),
        m.price_per_month_minor, m.total_minor, m.discounted_minor, m.vat_minor,
        m.total_with_vat_minor, m.save_percentage,
        str(req.body.currency, 3).toUpperCase() || 'GBP',
        str(req.body.blurb, 500) || null,
        str(req.body.features, 4000) || null,
        req.body.is_popular ? 1 : 0,
        req.body.is_active ? 1 : 0,
        int(req.body.sort_order, 50),
        str(req.body.paypal_image, 255) || null,
      ]
    );

    // Only one of each flag can be true, and the winner is the row just saved.
    if (req.body.is_popular) {
      await pool.query('UPDATE web_plans SET is_popular = (slug = ?)', [slug]);
    }
    if (req.body.is_default) {
      await pool.query('UPDATE web_plans SET is_default = (slug = ?)', [slug]);
    }

    back(res, '/admin/plans', { ok: `${name} created.` });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, '/admin/plans', { err: `A package with the id "${slug}" already exists.` });
    }
    next(e);
  }
});

// ---- Update ---------------------------------------------------------------

router.post('/plans/:id', async (req, res, next) => {
  const id = int(req.params.id, 0);
  if (!id) return back(res, '/admin/plans', { err: 'Unknown package.' });

  const name = str(req.body.name, 120);
  if (!name) return back(res, '/admin/plans', { err: 'A package needs a name.' });

  const m = reconcile(req.body);

  try {
    // The slug is the key offices and payments point at, so renaming it would
    // orphan them. Edited only when nothing is using it.
    const [[inUse]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM offices WHERE plan = w.slug)
            + (SELECT COUNT(*) FROM office_payments WHERE plan_slug = w.slug) AS n,
              w.slug
       FROM web_plans w WHERE w.id = ?`,
      [id]
    );
    if (!inUse) return back(res, '/admin/plans', { err: 'That package no longer exists.' });

    const wantedSlug = slugify(str(req.body.slug, 64) || name);
    const slug = Number(inUse.n) > 0 ? inUse.slug : wantedSlug;

    await pool.query(
      `UPDATE web_plans SET
         slug = ?, name = ?, period_months = ?, interval_label = ?, interval_count = ?,
         price_per_month_minor = ?, total_minor = ?, discounted_minor = ?, vat_minor = ?,
         total_with_vat_minor = ?, save_percentage = ?, currency = ?, blurb = ?,
         features = ?, is_popular = ?, is_active = ?, is_archived = ?, sort_order = ?,
         paypal_image = ?
       WHERE id = ?`,
      [
        slug, name, m.period_months,
        str(req.body.interval_label, 32) || 'Month',
        Math.max(1, int(req.body.interval_count, 1)),
        m.price_per_month_minor, m.total_minor, m.discounted_minor, m.vat_minor,
        m.total_with_vat_minor, m.save_percentage,
        str(req.body.currency, 3).toUpperCase() || 'GBP',
        str(req.body.blurb, 500) || null,
        str(req.body.features, 4000) || null,
        req.body.is_popular ? 1 : 0,
        req.body.is_active ? 1 : 0,
        req.body.is_archived ? 1 : 0,
        int(req.body.sort_order, 50),
        str(req.body.paypal_image, 255) || null,
        id,
      ]
    );

    if (req.body.is_popular) {
      await pool.query('UPDATE web_plans SET is_popular = (id = ?)', [id]);
    }
    if (req.body.is_default) {
      await pool.query('UPDATE web_plans SET is_default = (id = ?)', [id]);
    }

    const renamed = wantedSlug !== slug;
    back(res, '/admin/plans', {
      ok: `${name} saved.`,
      warn: renamed
        ? `The package id stayed "${slug}" — ${inUse.n} record${Number(inUse.n) === 1 ? '' : 's'} point at it.`
        : '',
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return back(res, '/admin/plans', { err: 'Another package already uses that id.' });
    }
    next(e);
  }
});

// ---- Delete ---------------------------------------------------------------

/** Only ever a real delete when nothing references it; otherwise archive. */
router.post('/plans/:id/delete', async (req, res, next) => {
  const id = int(req.params.id, 0);

  try {
    const [[plan]] = await pool.query('SELECT slug, name FROM web_plans WHERE id = ?', [id]);
    if (!plan) return back(res, '/admin/plans', { err: 'That package no longer exists.' });

    const [[use]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM offices WHERE plan = ?)
            + (SELECT COUNT(*) FROM office_payments WHERE plan_slug = ?) AS n`,
      [plan.slug, plan.slug]
    );

    if (Number(use.n) > 0) {
      await pool.query('UPDATE web_plans SET is_archived = 1, is_active = 0 WHERE id = ?', [id]);
      return back(res, '/admin/plans', {
        warn: `${plan.name} is archived rather than deleted — ${use.n} office/payment record${
          Number(use.n) === 1 ? '' : 's'
        } still point at it.`,
      });
    }

    await pool.query('DELETE FROM web_plans WHERE id = ?', [id]);
    back(res, '/admin/plans', { ok: `${plan.name} deleted.` });
  } catch (e) {
    next(e);
  }
});

module.exports = { plansRouter: router };
