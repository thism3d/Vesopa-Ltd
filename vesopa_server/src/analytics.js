const express = require('express');
const { requireAuth } = require('./auth');

/**
 * Analytics for the back office: the numbers behind the charts.
 *
 * Aggregation happens in SQL rather than by shipping rows to the browser and
 * summing them there — a venue with a year of trading has hundreds of
 * thousands of lines, and the dashboard must not depend on downloading them.
 *
 * Every query is scoped by office. A tenant must never see another's takings.
 */
function analyticsRoutes({ pool, secret }) {
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

  /** Days to look back. Bounded so a stray ?days=99999 cannot table-scan. */
  function windowDays(req, fallback = 30) {
    const days = Number(req.query.days);
    if (!Number.isFinite(days)) return fallback;
    return Math.min(Math.max(Math.trunc(days), 1), 730);
  }

  /**
   * Headline figures plus the series the dashboard charts.
   *
   * Returned in one call rather than six: the dashboard needs all of it at
   * once, and six round trips on a slow connection is what makes a back office
   * feel sluggish.
   */
  router.get('/analytics/overview', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const days = windowDays(req);

      const [[totals]] = await pool.query(
        `SELECT
           COUNT(*)                              AS sales,
           COALESCE(SUM(total_minor), 0)         AS gross_minor,
           COALESCE(SUM(tax_minor), 0)           AS tax_minor,
           COALESCE(SUM(discount_minor), 0)      AS discount_minor,
           COALESCE(SUM(gratuity_minor), 0)      AS gratuity_minor,
           COALESCE(SUM(voucher_minor), 0)       AS voucher_minor,
           COALESCE(SUM(promo_minor), 0)         AS promo_minor,
           COALESCE(SUM(covers), 0)              AS covers,
           COALESCE(AVG(total_minor), 0)         AS average_minor
         FROM epos_orders
         WHERE email = ? AND closed_at IS NOT NULL
           AND closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [office, days]
      );

      // The previous window of the same length, so the dashboard can show a
      // trend rather than a number with no context.
      const [[previous]] = await pool.query(
        `SELECT
           COUNT(*)                      AS sales,
           COALESCE(SUM(total_minor), 0) AS gross_minor
         FROM epos_orders
         WHERE email = ? AND closed_at IS NOT NULL
           AND closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
           AND closed_at <  DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [office, days * 2, days]
      );

      const [daily] = await pool.query(
        `SELECT DATE(closed_at)                  AS day,
                COUNT(*)                         AS sales,
                COALESCE(SUM(total_minor), 0)    AS gross_minor,
                COALESCE(SUM(gratuity_minor), 0) AS gratuity_minor
         FROM epos_orders
         WHERE email = ? AND closed_at IS NOT NULL
           AND closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY DATE(closed_at)
         ORDER BY day`,
        [office, days]
      );

      // Trade by hour: what a venue staffs to.
      const [hourly] = await pool.query(
        `SELECT HOUR(closed_at)               AS hour,
                COUNT(*)                      AS sales,
                COALESCE(SUM(total_minor), 0) AS gross_minor
         FROM epos_orders
         WHERE email = ? AND closed_at IS NOT NULL
           AND closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY HOUR(closed_at)
         ORDER BY hour`,
        [office, days]
      );

      const [weekday] = await pool.query(
        `SELECT DAYOFWEEK(closed_at)          AS dow,
                COUNT(*)                      AS sales,
                COALESCE(SUM(total_minor), 0) AS gross_minor
         FROM epos_orders
         WHERE email = ? AND closed_at IS NOT NULL
           AND closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY DAYOFWEEK(closed_at)
         ORDER BY dow`,
        [office, days]
      );

      const [tenders] = await pool.query(
        `SELECT p.method,
                COUNT(*)                        AS count,
                COALESCE(SUM(p.amount_minor), 0) AS total_minor
         FROM epos_payments p
         JOIN epos_orders o ON o.id = p.order_id
         WHERE o.email = ? AND o.closed_at IS NOT NULL
           AND o.closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY p.method
         ORDER BY total_minor DESC`,
        [office, days]
      );

      const [topProducts] = await pool.query(
        `SELECT l.name,
                SUM(l.quantity)                                  AS qty,
                COALESCE(SUM(l.unit_price_minor * l.quantity), 0) AS gross_minor
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
         WHERE o.email = ? AND o.closed_at IS NOT NULL
           AND o.closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY l.name
         ORDER BY gross_minor DESC
         LIMIT 12`,
        [office, days]
      );

      const [departments] = await pool.query(
        `SELECT COALESCE(p.department_name, 'Unassigned')        AS department,
                SUM(l.quantity)                                  AS qty,
                COALESCE(SUM(l.unit_price_minor * l.quantity), 0) AS gross_minor
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
         LEFT JOIN bo_products p ON p.pluid = l.plu_id AND p.email = o.email
         WHERE o.email = ? AND o.closed_at IS NOT NULL
           AND o.closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY department
         ORDER BY gross_minor DESC`,
        [office, days]
      );

      const [[stock]] = await pool.query(
        `SELECT
           COUNT(*) AS products,
           SUM(CASE WHEN stock_quantity IS NOT NULL
                     AND low_stock_at IS NOT NULL
                     AND stock_quantity <= low_stock_at THEN 1 ELSE 0 END) AS low_stock,
           SUM(CASE WHEN stock_quantity IS NOT NULL
                     AND stock_quantity <= 0 THEN 1 ELSE 0 END)            AS out_of_stock
         FROM bo_products WHERE email = ?`,
        [office]
      );

      const [[customers]] = await pool.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(points_balance), 0) AS points_outstanding,
                SUM(CASE WHEN last_visit >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                         THEN 1 ELSE 0 END) AS active_30d
         FROM epos_customers WHERE email_key = ?`,
        [office]
      );

      // Liabilities: money the venue already holds and still owes in goods.
      const [[liabilities]] = await pool.query(
        `SELECT
           (SELECT COALESCE(SUM(balance_minor), 0) FROM epos_gift_cards
             WHERE office = ? AND status = 'active')            AS gift_card_minor,
           (SELECT COALESCE(SUM(amount_minor - redeemed_minor), 0)
              FROM epos_deposits WHERE office = ? AND status = 'held') AS deposit_minor`,
        [office, office]
      );

      res.json({
        window_days: days,
        totals,
        previous,
        daily,
        hourly,
        weekday,
        tenders,
        top_products: topProducts,
        departments,
        stock,
        customers,
        liabilities,
      });
    } catch (e) { next(e); }
  });

  /** Per-clerk performance, for the People section. */
  router.get('/analytics/clerks', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const days = windowDays(req);
      const [rows] = await pool.query(
        `SELECT COALESCE(o.clerk_name, o.clerk_pin, 'Unknown') AS clerk,
                COUNT(*)                              AS sales,
                COALESCE(SUM(o.total_minor), 0)       AS gross_minor,
                COALESCE(AVG(o.total_minor), 0)       AS average_minor,
                COALESCE(SUM(o.gratuity_minor), 0)    AS gratuity_minor,
                COALESCE(SUM(o.discount_minor), 0)    AS discount_minor
         FROM epos_orders o
         WHERE o.email = ? AND o.closed_at IS NOT NULL
           AND o.closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY clerk
         ORDER BY gross_minor DESC`,
        [office, days]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  /** How promotions and vouchers are actually performing. */
  router.get('/analytics/promotions', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const days = windowDays(req);

      const [promotions] = await pool.query(
        `SELECT l.promotion_name                      AS name,
                COUNT(*)                              AS uses,
                COALESCE(SUM(l.discount_minor), 0)    AS discount_minor,
                SUM(l.quantity)                       AS qty
         FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id
         WHERE o.email = ? AND o.closed_at IS NOT NULL
           AND l.promotion_name IS NOT NULL
           AND o.closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY l.promotion_name
         ORDER BY discount_minor DESC`,
        [office, days]
      );

      const [vouchers] = await pool.query(
        `SELECT voucher_code                          AS code,
                COUNT(*)                              AS uses,
                COALESCE(SUM(voucher_minor), 0)       AS discount_minor
         FROM epos_orders
         WHERE email = ? AND closed_at IS NOT NULL
           AND voucher_code IS NOT NULL
           AND closed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY voucher_code
         ORDER BY discount_minor DESC`,
        [office, days]
      );

      res.json({ promotions, vouchers });
    } catch (e) { next(e); }
  });

  /** Loyalty health: points issued vs redeemed, and the tier spread. */
  router.get('/analytics/loyalty', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const days = windowDays(req);

      const [movement] = await pool.query(
        `SELECT DATE(created_at)  AS day,
                kind,
                SUM(ABS(points))  AS points
         FROM epos_loyalty_txns
         WHERE office = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY day, kind
         ORDER BY day`,
        [office, days]
      );

      const [tiers] = await pool.query(
        `SELECT COALESCE(tier_name, 'No tier') AS tier,
                COUNT(*)                        AS customers,
                COALESCE(SUM(points_balance), 0) AS points,
                COALESCE(SUM(lifetime_spend_minor), 0) AS lifetime_minor
         FROM epos_customers
         WHERE email_key = ?
         GROUP BY tier
         ORDER BY lifetime_minor DESC`,
        [office]
      );

      const [top] = await pool.query(
        `SELECT id, name, phone, points_balance, tier_name,
                lifetime_spend_minor, visits, last_visit
         FROM epos_customers
         WHERE email_key = ?
         ORDER BY lifetime_spend_minor DESC
         LIMIT 20`,
        [office]
      );

      res.json({ movement, tiers, top_customers: top });
    } catch (e) { next(e); }
  });

  /** Stock: what is running out and what is not moving. */
  router.get('/analytics/stock', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [rows] = await pool.query(
        `SELECT p.id, p.pluid, p.product_name, p.department_name,
                p.stock_quantity, p.low_stock_at, p.price, p.cost_price,
                COALESCE(sold.qty, 0) AS sold_30d
         FROM bo_products p
         LEFT JOIN (
           SELECT l.plu_id, SUM(l.quantity) AS qty
           FROM epos_order_lines l
           JOIN epos_orders o ON o.id = l.order_id
           WHERE o.email = ? AND o.closed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
           GROUP BY l.plu_id
         ) sold ON sold.plu_id = p.pluid
         WHERE p.email = ?
         ORDER BY
           -- Out of stock first, then low, then everything else.
           CASE WHEN p.stock_quantity <= 0 THEN 0
                WHEN p.low_stock_at IS NOT NULL
                 AND p.stock_quantity <= p.low_stock_at THEN 1
                ELSE 2 END,
           p.stock_quantity`,
        [office, office]
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { analyticsRoutes };
