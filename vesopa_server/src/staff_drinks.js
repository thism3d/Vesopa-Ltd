/**
 * Staff drinks (2026-10-30, schema_staff_items.sql).
 *
 * Nicky: "a check box on the product to say Staff Item. If this box is enabled
 * when they sell that item it will print out a slip with a barcode and voucher
 * code. This is then for the member of staff to keep and scan or tap the code
 * in to redeem their drink. Basically there's a big scam with staff saying they
 * have drinks bought for them off customers."
 *
 * The till makes the codes itself, so a slip prints with the internet down,
 * and sends them here once the bill is paid. Sending the same code twice is
 * harmless: the code is unique per venue. Redeeming is one UPDATE that only
 * matches a code nobody has redeemed, so two tills scanning the same slip at
 * the same moment cannot both pour it.
 *
 *   POST /api/till/staff-drinks          the codes a paid bill issued
 *   POST /api/till/staff-drinks/redeem   { code, by } once only
 *   GET  /api/till/staff-drinks/:code    what a slip is for, and if it is used
 *   GET  /api/staff-drinks               the back office's list
 */
const express = require('express');
const { requireAuth, requireTerminal } = require('./auth');

/** Codes as printed: letters and digits, no 0/O or 1/I, upper case. */
function cleanCode(v) {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
}

function staffDrinkRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  // A commissioned till or Vesopa Go: both carry a terminal token.
  const terminal = requireTerminal(secret);
  const till = (req, res, next) => terminal(req, res, () => {
    req.terminalName = null;
    next();
  });

  const shape = (r) => ({
    code: r.code,
    plu_id: r.plu_id,
    product_name: r.product_name,
    price_minor: r.price_minor,
    order_id: r.order_id,
    terminal: r.terminal,
    sold_by: r.sold_by,
    issued_at: r.issued_at,
    redeemed_at: r.redeemed_at,
    redeemed_by: r.redeemed_by,
    redeemed_terminal: r.redeemed_terminal,
  });

  router.post('/till/staff-drinks', till, async (req, res, next) => {
    try {
      const b = req.body || {};
      const drinks = Array.isArray(b.drinks) ? b.drinks.slice(0, 200) : [];
      let added = 0;
      for (const d of drinks) {
        const code = cleanCode(d.code);
        const name = String(d.product_name ?? '').trim().slice(0, 255);
        if (code.length < 6 || !name) continue;
        const [r] = await pool.execute(
          `INSERT IGNORE INTO epos_staff_drinks
             (office, code, plu_id, product_name, price_minor, order_id, terminal, sold_by, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()))`,
          [
            req.office,
            code,
            Number.isFinite(Number(d.plu_id)) ? Number(d.plu_id) : null,
            name,
            Math.round(Number(d.price_minor) || 0),
            String(b.order_id ?? '').slice(0, 64) || null,
            String(b.terminal ?? req.terminalName ?? '').slice(0, 120) || null,
            String(b.sold_by ?? '').slice(0, 120) || null,
            d.issued_at ? new Date(d.issued_at) : null,
          ]
        );
        added += r.affectedRows;
      }
      if (added) broadcast({ type: 'staff-drinks', office: req.office });
      res.json({ ok: true, added });
    } catch (e) { next(e); }
  });

  router.get('/till/staff-drinks/:code', till, async (req, res, next) => {
    try {
      const [[row]] = await pool.query(
        'SELECT * FROM epos_staff_drinks WHERE office = ? AND code = ?',
        [req.office, cleanCode(req.params.code)]
      );
      if (!row) return res.status(404).json({ error: 'That is not one of this venue\'s staff drink slips.' });
      res.json(shape(row));
    } catch (e) { next(e); }
  });

  router.post('/till/staff-drinks/redeem', till, async (req, res, next) => {
    try {
      const b = req.body || {};
      const code = cleanCode(b.code);
      if (!code) return res.status(400).json({ error: 'Scan or type the code on the slip.' });
      const [r] = await pool.execute(
        `UPDATE epos_staff_drinks
            SET redeemed_at = NOW(), redeemed_by = ?, redeemed_terminal = ?
          WHERE office = ? AND code = ? AND redeemed_at IS NULL`,
        [
          String(b.by ?? '').slice(0, 120) || null,
          String(b.terminal ?? req.terminalName ?? '').slice(0, 120) || null,
          req.office,
          code,
        ]
      );
      const [[row]] = await pool.query(
        'SELECT * FROM epos_staff_drinks WHERE office = ? AND code = ?',
        [req.office, code]
      );
      if (!row) return res.status(404).json({ error: 'That is not one of this venue\'s staff drink slips.' });
      if (!r.affectedRows) {
        return res.status(409).json({ error: 'This slip has already been used.', already: true, drink: shape(row) });
      }
      broadcast({ type: 'staff-drinks', office: req.office });
      res.json({ ok: true, drink: shape(row) });
    } catch (e) { next(e); }
  });

  /** The back office: the latest slips, issued and redeemed. */
  router.get('/staff-drinks', auth, async (req, res, next) => {
    try {
      let office = req.user.email;
      if (req.user.officeId) {
        const [[o]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
        if (o) office = o.contact_email;
      }
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 366);
      const [rows] = await pool.query(
        `SELECT * FROM epos_staff_drinks
          WHERE office = ? AND issued_at >= NOW() - INTERVAL ? DAY
          ORDER BY issued_at DESC LIMIT 2000`,
        [office, days]
      );
      res.json(rows.map(shape));
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return res.json([]);
      next(e);
    }
  });

  return router;
}

module.exports = { staffDrinkRoutes, cleanCode };
