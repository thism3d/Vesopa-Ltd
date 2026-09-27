/**
 * Each person's dashboard layout (2026-09-24): which cards, in which order,
 * at which width. public/dashboard.js owns the meaning; this keeps it.
 *
 *   GET /dashboard/layout   -> { layout: [...] | null }
 *   PUT /dashboard/layout   <- { layout: [{ key, size, hidden }, ...] }
 *
 * Keyed by venue AND person: two managers of one venue each have their own,
 * and one person who manages two venues can arrange each differently. The
 * layout is checked for shape only -- which keys exist is the page's business,
 * and it drops ones it does not know -- so a card added later needs no change
 * here.
 */

const express = require('express');

const { requireAuth } = require('./auth');

const MAX_ITEMS = 40;

/** A layout as stored: at most forty items of a short key, a size, hidden. */
function cleanLayout(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, MAX_ITEMS)) {
    const key = String((item && item.key) || '').trim();
    if (!/^[a-z0-9_-]{1,32}$/i.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, size: item.size === 'full' ? 'full' : 'half', hidden: Boolean(item.hidden) });
  }
  return out;
}

function dashboardLayoutRoutes({ pool, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (office) return office.contact_email;
    }
    return req.user.email;
  }
  const person = (req) => String(req.user.sub ?? req.user.id ?? req.user.email ?? '').slice(0, 120);

  router.get('/dashboard/layout', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [[row]] = await pool.query(
        'SELECT layout FROM bo_dashboard_layouts WHERE office = ? AND person = ?',
        [office, person(req)]
      );
      let layout = null;
      try {
        layout = row ? cleanLayout(JSON.parse(row.layout)) : null;
      } catch {
        layout = null;
      }
      res.json({ layout });
    } catch (e) {
      // Not migrated yet: no saved layout, and the page uses its own copy.
      if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) return res.json({ layout: null });
      next(e);
    }
  });

  router.put('/dashboard/layout', auth, async (req, res, next) => {
    try {
      const layout = cleanLayout(req.body && req.body.layout);
      if (!layout) return res.status(400).json({ error: 'A layout is a list of cards.' });
      const office = await tenantEmail(req);
      await pool.execute(
        `INSERT INTO bo_dashboard_layouts (office, person, layout, updated_at)
         VALUES (?, ?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE layout = VALUES(layout), updated_at = VALUES(updated_at)`,
        [office, person(req), JSON.stringify(layout)]
      );
      res.json({ ok: true, layout });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { dashboardLayoutRoutes, cleanLayout };
