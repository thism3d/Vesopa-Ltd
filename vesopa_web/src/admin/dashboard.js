/**
 * The dashboard: Vesopa's own money on the left, what the tills are doing on
 * the right, and the chase queue underneath.
 *
 * Both halves are on one screen because the question the admin actually has is
 * "is this business worth what it costs me to run" — subscription income next
 * to the trading volume it is buying.
 *
 * Every figure comes from one round trip. The tables are small now; the queries
 * are still written to be indexable rather than to be rewritten later.
 */

const express = require('express');
const { pool } = require('../db');
const {
  money, moneyShort, formatDate, subscriptionState, EXPIRING_WINDOW_DAYS,
  readFlash, navCounts, isoDate, daysUntil,
} = require('./util');

const router = express.Router();

/** Last N days as YYYY-MM-DD, oldest first — the x-axis for the charts. */
function lastDays(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    out.push(isoDate(day));
  }
  return out;
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const days = lastDays(30);
    const from = days[0];

    const [
      [officeStats],
      [collection],
      [tillTotals],
      ordersByDay,
      paymentsByDay,
      topOffices,
      methodSplit,
      renewals,
      recentPayments,
    ] = await Promise.all([
      // ---- Subscriptions ----------------------------------------------------
      pool.query(
        `SELECT
           COUNT(*)                                              AS total,
           SUM(status = 'active')                                AS active,
           SUM(status = 'paused')                                AS paused,
           SUM(is_demo = 1)                                      AS demo,
           SUM(CASE WHEN status = 'active' THEN monthly_fee_minor ELSE 0 END) AS mrr_minor,
           SUM(status = 'active'
               AND next_due_on IS NOT NULL
               AND next_due_on < CURDATE())                      AS overdue,
           SUM(status = 'active'
               AND next_due_on IS NOT NULL
               AND next_due_on >= CURDATE()
               AND next_due_on <= DATE_ADD(CURDATE(), INTERVAL ? DAY)) AS due_soon
         FROM offices`,
        [EXPIRING_WINDOW_DAYS]
      ).then((r) => r[0]),

      // ---- Collection -------------------------------------------------------
      //
      // "This quarter" is the calendar quarter, which is what the accountant
      // will ask for, not a rolling 90 days.
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN paid_on >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                             THEN amount_minor END), 0) AS month_minor,
           COALESCE(SUM(CASE WHEN paid_on >= MAKEDATE(YEAR(CURDATE()), 1)
                                  + INTERVAL QUARTER(CURDATE()) QUARTER
                                  - INTERVAL 1 QUARTER
                             THEN amount_minor END), 0) AS quarter_minor,
           COALESCE(SUM(CASE WHEN paid_on >= MAKEDATE(YEAR(CURDATE()), 1)
                             THEN amount_minor END), 0) AS year_minor,
           COALESCE(SUM(amount_minor), 0)               AS all_minor,
           COUNT(*)                                     AS payments
         FROM office_payments`
      ).then((r) => r[0]),

      // ---- Till activity ----------------------------------------------------
      pool.query(
        `SELECT
           COUNT(*)                                          AS orders,
           COALESCE(SUM(total_minor), 0)                     AS gross_minor,
           COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE()
                             THEN total_minor END), 0)       AS today_minor,
           SUM(DATE(created_at) = CURDATE())                 AS today_orders,
           COUNT(DISTINCT email)                             AS trading_sites
         FROM epos_orders
         WHERE created_at >= ?`,
        [`${from} 00:00:00`]
      ).then((r) => r[0]),

      pool.query(
        `SELECT DATE(created_at) AS d, COUNT(*) AS orders,
                COALESCE(SUM(total_minor), 0) AS gross_minor
         FROM epos_orders
         WHERE created_at >= ?
         GROUP BY DATE(created_at)`,
        [`${from} 00:00:00`]
      ).then((r) => r[0]),

      pool.query(
        `SELECT paid_on AS d, COALESCE(SUM(amount_minor), 0) AS amount_minor
         FROM office_payments
         WHERE paid_on >= ?
         GROUP BY paid_on`,
        [from]
      ).then((r) => r[0]),

      // Busiest sites. epos_orders keys off the office's email, so this joins
      // back through offices.contact_email to get a name to show.
      pool.query(
        `SELECT o.email,
                COALESCE(off.name, o.email)   AS name,
                off.id                        AS office_id,
                COUNT(*)                      AS orders,
                COALESCE(SUM(o.total_minor), 0) AS gross_minor
         FROM epos_orders o
         LEFT JOIN offices off ON off.contact_email = o.email
         WHERE o.created_at >= ?
         GROUP BY o.email, off.name, off.id
         ORDER BY gross_minor DESC
         LIMIT 8`,
        [`${from} 00:00:00`]
      ).then((r) => r[0]),

      pool.query(
        `SELECT p.method, COUNT(*) AS n, COALESCE(SUM(p.amount_minor), 0) AS amount_minor
         FROM epos_payments p
         JOIN epos_orders o ON o.id = p.order_id
         WHERE o.created_at >= ?
         GROUP BY p.method
         ORDER BY amount_minor DESC`,
        [`${from} 00:00:00`]
      ).then((r) => r[0]),

      // ---- The chase queue --------------------------------------------------
      //
      // Overdue first, then soonest. Nothing here is switched off; it is a
      // to-do list of people to email or ring.
      pool.query(
        `SELECT id, name, contact_email, contact_phone, contact_name, status,
                plan, monthly_fee_minor, term_months, next_due_on, trial_ends_on,
                reminded_at, is_demo
         FROM offices
         WHERE status = 'active'
           AND next_due_on IS NOT NULL
           AND next_due_on <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
         ORDER BY next_due_on ASC
         LIMIT 12`,
        [EXPIRING_WINDOW_DAYS]
      ).then((r) => r[0]),

      pool.query(
        `SELECT p.id, p.amount_minor, p.currency, p.paid_on, p.method, p.reference,
                o.name AS office_name, o.id AS office_id
         FROM office_payments p
         JOIN offices o ON o.id = p.office_id
         ORDER BY p.paid_on DESC, p.id DESC
         LIMIT 8`
      ).then((r) => r[0]),
    ]);

    // Sparse GROUP BY results filled out to one point per day, so a quiet
    // Sunday is a zero on the chart rather than a missing point that makes the
    // line jump across it.
    const orderMap = new Map(ordersByDay.map((r) => [isoDate(r.d), r]));
    const payMap = new Map(paymentsByDay.map((r) => [isoDate(r.d), r]));

    const series = days.map((d) => ({
      date: d,
      orders: Number(orderMap.get(d)?.orders || 0),
      gross_minor: Number(orderMap.get(d)?.gross_minor || 0),
      collected_minor: Number(payMap.get(d)?.amount_minor || 0),
    }));

    res.render('admin/dashboard', {
      title: 'Dashboard | Vesopa Admin',
      heading: 'Dashboard',
      nav: 'dashboard',
      counts: await navCounts(),
      flash: readFlash(req),

      officeStats,
      collection,
      tillTotals,
      series,
      topOffices,
      methodSplit,
      renewals: renewals.map((o) => ({ ...o, state: subscriptionState(o) })),
      recentPayments,

      money,
      moneyShort,
      formatDate,
      daysUntil,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = { dashboardRouter: router };
