const express = require('express');
const { requireAuth } = require('./auth');
const { requireAdmin } = require('./admin');

/**
 * Starter-data templates, applied when an office is created.
 *
 * A new venue with an empty catalogue cannot be demonstrated, so the platform
 * admin keeps templates ("Restaurant", "Café", "Bar") and assigns one at
 * signup. Applying a template *copies* rows into the office, so the venue can
 * then edit them freely without the template changing underneath them — and
 * editing a template never reaches back into offices already created from it.
 */
function templateRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  // What a template can carry. Everything is keyed by office on insert, so a
  // payload cannot smuggle rows into another tenant.
  const SECTIONS = ['departments', 'groups', 'products', 'tax_rates',
    'vouchers', 'promotions', 'finalise_keys', 'error_reasons'];

  router.get('/templates', auth, requireAdmin, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(
        'SELECT * FROM epos_templates ORDER BY is_default DESC, name');
      res.json(rows.map((r) => ({ ...r, payload: safeParse(r.payload) })));
    } catch (e) { next(e); }
  });

  router.get('/templates/:id', auth, requireAdmin, async (req, res, next) => {
    try {
      const [[row]] = await pool.query(
        'SELECT * FROM epos_templates WHERE id = ?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'No such template' });
      res.json({ ...row, payload: safeParse(row.payload) });
    } catch (e) { next(e); }
  });

  router.post('/templates', auth, requireAdmin, async (req, res, next) => {
    try {
      const [r] = await pool.execute(
        `INSERT INTO epos_templates (name, description, kind, payload, is_default, active)
         VALUES (?,?,?,?,?,?)`,
        [
          req.body.name || 'Template',
          req.body.description || null,
          req.body.kind || 'custom',
          JSON.stringify(req.body.payload ?? {}),
          req.body.is_default ? 1 : 0,
          req.body.active === false ? 0 : 1,
        ]
      );
      // Only one template can be the default, or provisioning is ambiguous.
      if (req.body.is_default) await clearOtherDefaults(r.insertId);
      broadcast({ type: 'templates' });
      res.status(201).json({ id: r.insertId });
    } catch (e) { next(e); }
  });

  router.put('/templates/:id', auth, requireAdmin, async (req, res, next) => {
    try {
      await pool.execute(
        `UPDATE epos_templates
         SET name = ?, description = ?, kind = ?, payload = ?, is_default = ?, active = ?
         WHERE id = ?`,
        [
          req.body.name || 'Template',
          req.body.description || null,
          req.body.kind || 'custom',
          JSON.stringify(req.body.payload ?? {}),
          req.body.is_default ? 1 : 0,
          req.body.active === false ? 0 : 1,
          req.params.id,
        ]
      );
      if (req.body.is_default) await clearOtherDefaults(req.params.id);
      broadcast({ type: 'templates' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.delete('/templates/:id', auth, requireAdmin, async (req, res, next) => {
    try {
      await pool.execute('DELETE FROM epos_templates WHERE id = ?', [req.params.id]);
      broadcast({ type: 'templates' });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  /**
   * Build a template from an office that is already set up the way the admin
   * wants — far quicker than authoring JSON by hand.
   */
  router.post('/templates/from-office/:officeId', auth, requireAdmin,
    async (req, res, next) => {
      try {
        const [[office]] = await pool.query(
          'SELECT * FROM offices WHERE id = ?', [req.params.officeId]);
        if (!office) return res.status(404).json({ error: 'No such office' });

        const email = office.contact_email;
        const payload = {};

        const [departments] = await pool.query(
          'SELECT name, sort_order FROM bo_product_departments WHERE office_id = ?',
          [office.id]);
        payload.departments = departments;

        const [groups] = await pool.query(
          'SELECT name, sort_order FROM bo_product_groups WHERE office_id = ?',
          [office.id]);
        payload.groups = groups;

        const [products] = await pool.query(
          `SELECT pluid, product_name, department_name, group_name,
                  accounting_code, price, tax_percentage, stock_quantity,
                  button_position, button_color, printer_routes,
                  print_to_receipt, emoji
           FROM bo_products WHERE email = ?`, [email]);
        payload.products = products;

        const [taxRates] = await pool.query(
          'SELECT * FROM bo_tax_rates WHERE office_id = ?', [office.id]);
        payload.tax_rates = taxRates.map(stripIds);

        const [r] = await pool.execute(
          `INSERT INTO epos_templates (name, description, kind, payload)
           VALUES (?,?,?,?)`,
          [
            req.body.name || `${office.name} template`,
            req.body.description || `Captured from ${office.name}`,
            req.body.kind || 'custom',
            JSON.stringify(payload),
          ]
        );
        broadcast({ type: 'templates' });
        res.status(201).json({ id: r.insertId, sections: Object.keys(payload) });
      } catch (e) { next(e); }
    });

  /**
   * Apply a template to an office.
   *
   * `replace` wipes the office's catalogue first. That is destructive, so it
   * is never the default — an admin has to ask for it explicitly.
   */
  router.post('/offices/:officeId/apply-template', auth, requireAdmin,
    async (req, res, next) => {
      const conn = await pool.getConnection();
      try {
        const [[office]] = await pool.query(
          'SELECT * FROM offices WHERE id = ?', [req.params.officeId]);
        if (!office) return res.status(404).json({ error: 'No such office' });

        const [[template]] = await pool.query(
          'SELECT * FROM epos_templates WHERE id = ?', [req.body.template_id]);
        if (!template) return res.status(404).json({ error: 'No such template' });

        const payload = safeParse(template.payload);
        const email = office.contact_email;
        const applied = {};

        await conn.beginTransaction();

        if (req.body.replace) {
          await conn.execute('DELETE FROM bo_products WHERE email = ?', [email]);
          await conn.execute('DELETE FROM bo_product_departments WHERE office_id = ?',
            [office.id]);
          await conn.execute('DELETE FROM bo_product_groups WHERE office_id = ?',
            [office.id]);
          await conn.execute('DELETE FROM bo_tax_rates WHERE office_id = ?',
            [office.id]);
        }

        for (const [i, d] of (payload.departments || []).entries()) {
          await conn.execute(
            `INSERT INTO bo_product_departments (office_id, name, sort_order)
             VALUES (?,?,?)`,
            [office.id, d.name, d.sort_order ?? i + 1]
          );
        }
        applied.departments = (payload.departments || []).length;

        for (const [i, g] of (payload.groups || []).entries()) {
          await conn.execute(
            `INSERT INTO bo_product_groups (office_id, name, sort_order)
             VALUES (?,?,?)`,
            [office.id, g.name, g.sort_order ?? i + 1]
          );
        }
        applied.groups = (payload.groups || []).length;

        for (const p of payload.products || []) {
          await conn.execute(
            `INSERT INTO bo_products
               (email, pluid, product_name, department_name, group_name,
                accounting_code, price, tax_percentage, stock_quantity,
                button_position, button_color, printer_routes,
                print_to_receipt, emoji)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              email, p.pluid, p.product_name, p.department_name || null,
              p.group_name || null, p.accounting_code || null,
              p.price ?? 0, p.tax_percentage ?? 0, p.stock_quantity ?? null,
              p.button_position ?? null, p.button_color || null,
              // A template exported before the stations were numbered carries
              // `printer_route`; read both so an old template still routes.
              p.printer_routes || p.printer_route || null,
              p.print_to_receipt === 0 || p.print_to_receipt === false ? 0 : 1,
              p.emoji || null,
            ]
          );
        }
        applied.products = (payload.products || []).length;

        for (const t of payload.tax_rates || []) {
          await conn.execute(
            `INSERT INTO bo_tax_rates (office_id, name, percentage, sort_order)
             VALUES (?,?,?,?)`,
            [office.id, t.name, t.percentage ?? 0, t.sort_order ?? 0]
          );
        }
        applied.tax_rates = (payload.tax_rates || []).length;

        await conn.execute('UPDATE offices SET template_id = ? WHERE id = ?',
          [template.id, office.id]);

        await conn.commit();
        broadcast({ type: 'catalogue.updated' });
        res.json({ ok: true, applied });
      } catch (e) {
        await conn.rollback();
        next(e);
      } finally { conn.release(); }
    });

  /**
   * Wipe an office's trading data.
   *
   * Guarded by an explicit confirmation string. This deletes real takings, and
   * a mis-click on a live tenant is not recoverable — requiring the office's
   * own email to be typed back means it cannot happen by accident.
   */
  router.post('/offices/:officeId/wipe', auth, requireAdmin, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const [[office]] = await pool.query(
        'SELECT * FROM offices WHERE id = ?', [req.params.officeId]);
      if (!office) return res.status(404).json({ error: 'No such office' });

      if (req.body.confirm !== office.contact_email) {
        return res.status(400).json({
          error: 'Type the office contact email to confirm this wipe',
        });
      }

      const email = office.contact_email;
      const scope = req.body.scope === 'all' ? 'all' : 'sales';
      const removed = {};

      await conn.beginTransaction();

      // Sales and everything that hangs off them.
      const [lines] = await conn.execute(
        `DELETE l FROM epos_order_lines l
         JOIN epos_orders o ON o.id = l.order_id WHERE o.email = ?`, [email]);
      const [payments] = await conn.execute(
        `DELETE p FROM epos_payments p
         JOIN epos_orders o ON o.id = p.order_id WHERE o.email = ?`, [email]);
      const [orders] = await conn.execute(
        'DELETE FROM epos_orders WHERE email = ?', [email]);
      removed.order_lines = lines.affectedRows;
      removed.payments = payments.affectedRows;
      removed.orders = orders.affectedRows;

      await conn.execute('DELETE FROM epos_loyalty_txns WHERE office = ?', [email]);
      await conn.execute('DELETE FROM epos_gift_card_txns WHERE office = ?', [email]);

      if (scope === 'all') {
        // Also the catalogue and the customer book.
        await conn.execute('DELETE FROM bo_products WHERE email = ?', [email]);
        await conn.execute('DELETE FROM epos_customers WHERE email_key = ?', [email]);
        await conn.execute('DELETE FROM epos_gift_cards WHERE office = ?', [email]);
        await conn.execute('DELETE FROM epos_deposits WHERE office = ?', [email]);
        await conn.execute('DELETE FROM epos_promotions WHERE office = ?', [email]);
        await conn.execute('DELETE FROM bo_product_departments WHERE office_id = ?',
          [office.id]);
        await conn.execute('DELETE FROM bo_product_groups WHERE office_id = ?',
          [office.id]);
        removed.catalogue = true;
      }

      await conn.commit();
      broadcast({ type: 'catalogue.updated' });
      res.json({ ok: true, scope, removed });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally { conn.release(); }
  });

  /** Subscription terms. Kept simple until a gateway is wired in. */
  router.put('/offices/:officeId/subscription', auth, requireAdmin,
    async (req, res, next) => {
      try {
        const fee = Math.round(Number(req.body.monthly_fee_minor) || 0);
        // A billing day above 28 does not exist in February.
        const day = Math.min(Math.max(Number(req.body.billing_day) || 1, 1), 28);

        await pool.execute(
          `UPDATE offices
           SET monthly_fee_minor = ?, billing_day = ?, next_due_on = ?,
               is_demo = ?, trial_ends_on = ?, plan = ?
           WHERE id = ?`,
          [
            fee, day,
            req.body.next_due_on || null,
            req.body.is_demo ? 1 : 0,
            req.body.trial_ends_on || null,
            req.body.plan || null,
            req.params.officeId,
          ]
        );
        const [[row]] = await pool.query('SELECT * FROM offices WHERE id = ?',
          [req.params.officeId]);
        broadcast({ type: 'offices' });
        res.json(row);
      } catch (e) { next(e); }
    });

  /** Offices with their subscription state, for the super-admin table. */
  router.get('/offices/subscriptions', auth, requireAdmin, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT o.id, o.name, o.contact_email, o.status, o.plan, o.created_at,
                o.monthly_fee_minor, o.billing_day, o.next_due_on, o.is_demo,
                o.trial_ends_on, o.template_id,
                t.name AS template_name,
                (SELECT COUNT(*) FROM backoffice_users u WHERE u.office_id = o.id) AS users,
                (SELECT COUNT(*) FROM epos_orders s WHERE s.email = o.contact_email) AS sales,
                (SELECT COALESCE(SUM(s.total_minor), 0) FROM epos_orders s
                  WHERE s.email = o.contact_email) AS gross_minor
         FROM offices o
         LEFT JOIN epos_templates t ON t.id = o.template_id
         ORDER BY o.created_at DESC`
      );
      res.json(rows);
    } catch (e) { next(e); }
  });

  async function clearOtherDefaults(keepId) {
    await pool.execute(
      'UPDATE epos_templates SET is_default = 0 WHERE id <> ?', [keepId]);
  }

  function stripIds(row) {
    const { id, office_id, ...rest } = row;
    return rest;
  }

  function safeParse(text) {
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  return router;
}

module.exports = { templateRoutes };
