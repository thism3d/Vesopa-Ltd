/**
 * Sites within a venue, and the live takings board (2026-10-19).
 *
 * Meirion: "Some customers need to link their information so they can see what
 * a site takes as a whole or can select site specific. Some have two tills per
 * site and some have 6 or more" -- Pontardawe's bar and lounge, Carmarthen
 * Council's nine tills a couple of miles apart.
 *
 * A site is a named group of tills (schema_till_sites.sql). Every sale already
 * records the till it was taken on, so the dashboard can show the whole venue,
 * one site, or one till with nothing changed on the tills. Live: each sale's
 * websocket nudge (scoped to its venue) makes an open board re-read its figures
 * over the manager's own session; no takings ever travel on the socket.
 *
 * A login that manages several venues (sites.js) also gets the group view:
 * every venue it manages, side by side, with the total.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('./auth');
const { attachAccess, requirePermission } = require('./permissions');

const missing = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');
const COLOURS = ['#6d5efc', '#17a673', '#f59f00', '#e5484d', '#0ea5e9', '#d946ef', '#84cc16', '#f97316'];

/**
 * The SQL that narrows sales to a site or a till, for any query on
 * epos_orders. [alias] is the orders table alias with its dot ('o.' or '').
 * Empty when the request asks for everything.
 */
async function siteScope(db, office, query, alias = '') {
  const till = String((query && query.till) || '').trim().slice(0, 120);
  const site = String((query && query.site) || '').trim();
  if (till) return { sql: ` AND ${alias}terminal = ?`, params: [till], label: till };
  if (site === 'none') {
    return {
      sql: ` AND (${alias}terminal IS NULL OR ${alias}terminal NOT IN (SELECT terminal FROM bo_till_names WHERE office = ? AND site_id IS NOT NULL))`,
      params: [office],
      label: 'Not in a site',
    };
  }
  if (/^\d+$/.test(site)) {
    return {
      sql: ` AND ${alias}terminal IN (SELECT terminal FROM bo_till_names WHERE office = ? AND site_id = ?)`,
      params: [office, Number(site)],
      label: `site ${site}`,
    };
  }
  return { sql: '', params: [], label: null };
}

/**
 * Whether a till is left out of the reports' terminal list (2026-11-25), on
 * bo_till_names. Added on first use.
 */
let hiddenColumn = null;
function ensureHiddenColumn(db) {
  if (!hiddenColumn) {
    hiddenColumn = db
      .query('ALTER TABLE bo_till_names ADD COLUMN hidden TINYINT(1) NOT NULL DEFAULT 0')
      .then(() => true)
      .catch((e) => {
        if (e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060)) return true;
        hiddenColumn = null;
        return false;
      });
  }
  return hiddenColumn;
}

/**
 * What every till is called in the reports, and whether it is shown there
 * (Nicky, Pontardawe RFC, 2026-11-24: "Neaten up how we display the terminals
 * on reporting, If there are 2 terminals It should be just Terminal 1 &
 * Terminal 2, and an option rename them. Ability to name Vesopa Go Terminals
 * ... or an option to hide from reporting").
 *
 * A sale records its till by the computer's name (epos_orders.terminal), so
 * that is the key. The name given in Sites (bo_till_names.label) wins;
 * otherwise the terminal number the till was signed in as (bo_terminals):
 * "Terminal 1", or "Vesopa Go 2" for a Go device; otherwise the computer's
 * name as before. Map: computer name -> { label, hidden, suggested }.
 */
async function tillLabels(db, office) {
  const out = new Map();
  let devices = [];
  try {
    [devices] = await db.query(
      'SELECT kind, terminal_no, name, device_name, revoked_at FROM bo_terminals WHERE office = ?',
      [office]
    );
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const suggest = (raw) => {
    const match = devices
      .filter((d) => d.device_name === raw || d.name === raw)
      .sort((a, b) => (a.revoked_at ? 1 : 0) - (b.revoked_at ? 1 : 0));
    const d = match[0];
    if (!d) return null;
    return d.kind === 'go' ? `Vesopa Go ${d.terminal_no}` : `Terminal ${d.terminal_no}`;
  };
  let names = [];
  try {
    const withHidden = await ensureHiddenColumn(db);
    [names] = await db.query(
      `SELECT terminal, label${withHidden ? ', hidden' : ''} FROM bo_till_names WHERE office = ?`,
      [office]
    );
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const byName = new Map(names.map((n) => [n.terminal, n]));
  return {
    of(raw) {
      if (!raw) return { label: raw, hidden: false, suggested: null };
      const n = byName.get(raw) || {};
      const suggested = suggest(raw);
      return { label: (n.label && String(n.label).trim()) || suggested || raw, hidden: !!Number(n.hidden || 0), suggested };
    },
  };
}

function tillSitesRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);
  const attach = attachAccess({ pool });
  const guard = (key) => [auth, attach, requirePermission(key)];

  async function tenantEmail(req) {
    if (req.user.officeId) {
      const [[office]] = await pool.query('SELECT contact_email FROM offices WHERE id = ?', [req.user.officeId]);
      if (office) return office.contact_email;
    }
    return req.user.email;
  }

  async function setup(office) {
    let sites = [];
    let names = [];
    try {
      [sites] = await pool.query('SELECT id, name, address, colour, sort FROM bo_till_sites WHERE office = ? ORDER BY sort, name', [office]);
      [names] = await pool.query('SELECT terminal, label, site_id FROM bo_till_names WHERE office = ?', [office]);
    } catch (e) {
      if (!missing(e)) throw e;
    }
    const [seen] = await pool.query(
      `SELECT terminal, MIN(closed_at) AS first_sale, MAX(closed_at) AS last_sale,
              SUM(closed_at >= NOW() - INTERVAL 30 DAY) AS sales_30d
         FROM epos_orders
        WHERE email = ? AND terminal IS NOT NULL AND terminal <> '' AND closed_at IS NOT NULL
          AND closed_at >= NOW() - INTERVAL 400 DAY
        GROUP BY terminal`,
      [office]
    );
    const byName = new Map(names.map((n) => [n.terminal, n]));
    const labels = await tillLabels(pool, office);
    const tills = new Map();
    for (const s of seen) {
      const n = byName.get(s.terminal) || {};
      const l = labels.of(s.terminal);
      tills.set(s.terminal, {
        terminal: s.terminal, label: n.label || null, site_id: n.site_id || null,
        suggested: l.suggested, hidden: l.hidden,
        first_sale: s.first_sale, last_sale: s.last_sale, sales_30d: Number(s.sales_30d) || 0,
      });
    }
    for (const n of names) {
      if (!tills.has(n.terminal)) {
        const l = labels.of(n.terminal);
        tills.set(n.terminal, { terminal: n.terminal, label: n.label, site_id: n.site_id, suggested: l.suggested, hidden: l.hidden, last_sale: null, sales_30d: 0 });
      }
    }
    return {
      sites: sites.map((s, i) => ({ ...s, colour: s.colour || COLOURS[i % COLOURS.length] })),
      tills: [...tills.values()].sort((a, b) => String(a.label || a.terminal).localeCompare(String(b.label || b.terminal))),
    };
  }

  function changed(office) {
    broadcast({ type: 'till-sites.updated' }, { office });
  }

  // ---- Set-up -------------------------------------------------------------------

  router.get('/till-sites', guard('dashboard.view'), async (req, res, next) => {
    try {
      res.json(await setup(await tenantEmail(req)));
    } catch (e) { next(e); }
  });

  router.post('/till-sites', guard('programming.devices'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'Give the site a name, such as Bar, Lounge or Pembrey Country Park.' });
      const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM bo_till_sites WHERE office = ?', [office]);
      if (Number(n) >= 50) return res.status(400).json({ error: 'A venue can have up to 50 sites.' });
      const [r] = await pool.execute(
        'INSERT INTO bo_till_sites (office, name, address, colour, sort, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [office, name, String(b.address || '').trim().slice(0, 160) || null, /^#[0-9a-f]{6}$/i.test(b.colour || '') ? b.colour : COLOURS[Number(n) % COLOURS.length], Number(n), req.user.email || null]
      );
      changed(office);
      res.status(201).json({ id: r.insertId, ...(await setup(office)) });
    } catch (e) { next(e); }
  });

  router.put('/till-sites/:id', guard('programming.devices'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'Give the site a name.' });
      const [r] = await pool.execute(
        'UPDATE bo_till_sites SET name = ?, address = ?, colour = COALESCE(?, colour) WHERE id = ? AND office = ?',
        [name, String(b.address || '').trim().slice(0, 160) || null, /^#[0-9a-f]{6}$/i.test(b.colour || '') ? b.colour : null, Number(req.params.id), office]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'No such site.' });
      changed(office);
      res.json(await setup(office));
    } catch (e) { next(e); }
  });

  router.delete('/till-sites/:id', guard('programming.devices'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const id = Number(req.params.id);
      const [r] = await pool.execute('DELETE FROM bo_till_sites WHERE id = ? AND office = ?', [id, office]);
      if (!r.affectedRows) return res.status(404).json({ error: 'No such site.' });
      // Its tills stay, with their names; they are simply in no site now.
      await pool.execute('UPDATE bo_till_names SET site_id = NULL WHERE office = ? AND site_id = ?', [office, id]);
      changed(office);
      res.json({ ...(await setup(office)), message: 'Site removed. Its tills and their sales are kept.' });
    } catch (e) { next(e); }
  });

  /** Name a till and put it in a site (or none). */
  router.put('/till-names', guard('programming.devices'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const b = req.body || {};
      const terminal = String(b.terminal || '').trim().slice(0, 120);
      if (!terminal) return res.status(400).json({ error: 'Which till?' });
      const label = String(b.label || '').trim().slice(0, 80) || null;
      let siteId = b.site_id === null || b.site_id === '' || b.site_id === undefined ? null : Number(b.site_id);
      if (siteId != null) {
        const [[s]] = await pool.query('SELECT id FROM bo_till_sites WHERE id = ? AND office = ?', [siteId, office]);
        if (!s) siteId = null;
      }
      await pool.execute(
        `INSERT INTO bo_till_names (office, terminal, label, site_id, updated_by) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label), site_id = VALUES(site_id), updated_by = VALUES(updated_by)`,
        [office, terminal, label, siteId, req.user.email || null]
      );
      // Left out of the reports' terminal list, e.g. a Vesopa Go handset that
      // only sends orders to tables and takes no money.
      if (b.hidden !== undefined && (await ensureHiddenColumn(pool))) {
        await pool.execute('UPDATE bo_till_names SET hidden = ? WHERE office = ? AND terminal = ?', [
          b.hidden ? 1 : 0, office, terminal,
        ]);
      }
      changed(office);
      res.json(await setup(office));
    } catch (e) { next(e); }
  });

  // ---- The board -------------------------------------------------------------------

  /**
   * Takings by site and till for a window (?days=1 today, ?range=yesterday,
   * ?from=&to=), plus today's live figures, plus the group of venues this
   * login manages.
   */
  router.get('/analytics/sites', guard('dashboard.view'), async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const { from, to, label } = windowOf(req.query, pool);
      const s = await setup(office);
      const [rows] = await pool.query(
        `SELECT COALESCE(NULLIF(terminal, ''), '(unknown)') AS terminal, COUNT(*) AS sales,
                COALESCE(SUM(total_minor), 0) AS gross_minor, COALESCE(SUM(tax_minor), 0) AS tax_minor,
                COALESCE(SUM(covers), 0) AS covers, MAX(closed_at) AS last_sale
           FROM epos_orders
          WHERE email = ? AND closed_at IS NOT NULL AND closed_at >= ${from}${to ? ` AND closed_at < ${to}` : ''}
          GROUP BY terminal`,
        [office]
      );
      const [tenders] = await pool.query(
        `SELECT COALESCE(NULLIF(o.terminal, ''), '(unknown)') AS terminal, p.method,
                COALESCE(SUM(COALESCE(p.applied_minor, p.amount_minor)), 0) AS total_minor
           FROM epos_payments p JOIN epos_orders o ON o.id = p.order_id
          WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ${from}${to ? ` AND o.closed_at < ${to}` : ''}
          GROUP BY terminal, p.method`,
        [office]
      );
      const tillInfo = new Map(s.tills.map((t) => [t.terminal, t]));
      const tillRows = rows.map((r) => {
        const t = tillInfo.get(r.terminal) || {};
        const methods = {};
        for (const x of tenders) if (x.terminal === r.terminal) methods[x.method] = Number(x.total_minor);
        return {
          terminal: r.terminal, label: t.label || null, site_id: t.site_id || null,
          sales: Number(r.sales), gross_minor: Number(r.gross_minor), tax_minor: Number(r.tax_minor),
          covers: Number(r.covers), last_sale: r.last_sale, tenders: methods,
        };
      });
      // Tills set up but with no sales in the window still show, at nought.
      for (const t of s.tills) {
        if (!tillRows.some((r) => r.terminal === t.terminal) && (t.site_id || t.label)) {
          tillRows.push({ terminal: t.terminal, label: t.label, site_id: t.site_id, sales: 0, gross_minor: 0, tax_minor: 0, covers: 0, last_sale: t.last_sale, tenders: {} });
        }
      }
      const sum = (list, k) => list.reduce((a, r) => a + (Number(r[k]) || 0), 0);
      const groups = s.sites.map((site) => {
        const tills = tillRows.filter((r) => r.site_id === site.id).sort((a, b) => b.gross_minor - a.gross_minor);
        return { id: site.id, name: site.name, address: site.address, colour: site.colour, tills, sales: sum(tills, 'sales'), gross_minor: sum(tills, 'gross_minor'), covers: sum(tills, 'covers') };
      });
      const loose = tillRows.filter((r) => !r.site_id).sort((a, b) => b.gross_minor - a.gross_minor);
      if (loose.length) groups.push({ id: 'none', name: s.sites.length ? 'Not in a site' : 'All tills', colour: '#8a8f98', tills: loose, sales: sum(loose, 'sales'), gross_minor: sum(loose, 'gross_minor'), covers: sum(loose, 'covers') });

      // The group: every venue this login manages, side by side.
      let venues = [];
      try {
        const { sitesFor } = require('./sites');
        const mine = req.user.sub ? await sitesFor(pool, req.user.sub) : [];
        const real = mine.filter((v) => !v.demo);
        if (real.length > 1) {
          const [vrows] = await pool.query(
            `SELECT email, COUNT(*) AS sales, COALESCE(SUM(total_minor), 0) AS gross_minor, MAX(closed_at) AS last_sale
               FROM epos_orders WHERE email IN (?) AND closed_at IS NOT NULL AND closed_at >= ${from}${to ? ` AND closed_at < ${to}` : ''}
              GROUP BY email`,
            [real.map((v) => v.contact_email)]
          );
          venues = real.map((v) => {
            const r = vrows.find((x) => x.email === v.contact_email) || {};
            return { id: v.id, name: v.name, current: v.contact_email === office, sales: Number(r.sales) || 0, gross_minor: Number(r.gross_minor) || 0, last_sale: r.last_sale || null };
          });
        }
      } catch (e) {
        if (!missing(e)) throw e;
      }

      res.json({
        window: label,
        total: { sales: sum(tillRows, 'sales'), gross_minor: sum(tillRows, 'gross_minor'), covers: sum(tillRows, 'covers') },
        sites: groups,
        has_sites: s.sites.length > 0,
        venues,
        venues_total: venues.length ? { sales: sum(venues, 'sales'), gross_minor: sum(venues, 'gross_minor') } : null,
        at: new Date().toISOString(),
      });
    } catch (e) { next(e); }
  });

  return router;
}

/** The window as SQL bounds: today by default, like the dashboard. */
function windowOf(q, db) {
  if (q.range === 'yesterday') return { from: 'DATE_SUB(CURDATE(), INTERVAL 1 DAY)', to: 'CURDATE()', label: 'Yesterday' };
  const STAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/;
  if (STAMP.test(String(q.from || '')) && STAMP.test(String(q.to || ''))) {
    const f = String(q.from).replace('T', ' ');
    const t = String(q.to).replace('T', ' ');
    return { from: db.escape(f.length === 10 ? `${f} 00:00:00` : `${f}:00`), to: db.escape(t.length === 10 ? `${t} 23:59:59` : `${t}:00`), label: 'Custom' };
  }
  const days = Math.min(Math.max(Math.trunc(Number(q.days) || 1), 1), 730);
  return { from: `DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)`, to: null, label: days === 1 ? 'Today' : `Last ${days} days` };
}

module.exports = { tillSitesRoutes, siteScope, tillLabels };
