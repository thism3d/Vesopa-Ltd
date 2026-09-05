const express = require('express');
const { requireAuth } = require('./auth');

/**
 * Who may do what, in the back office and on the till.
 *
 * TWO CATALOGUES, NOT ONE
 *
 * The till's list is about a person at a counter with four digits: may they
 * void a line, open the drawer, take a table off somebody else. It is checked
 * with the broadband down, against a list the terminal caches.
 *
 * The back office's list is about a login in a browser: may they see the
 * takings, change a price, add a member of staff. An accountant gets the
 * reports and nothing else, which is the case the customer described.
 *
 * They are kept apart because merging them would put "may edit the wallet pass
 * artwork" on every till and "may open the cash drawer" in every browser.
 *
 * NULL MEANS AS BEFORE
 *
 * A user with no role, and a clerk with no group, are unrestricted. Every row
 * that existed before this feature is one of those, so nothing changes for a
 * venue until somebody opens the screen and says otherwise. A default of "deny"
 * would have taken the refund key off every member of staff in the country on
 * the morning the migration ran.
 */

// ---------------------------------------------------------------------------
// The till
// ---------------------------------------------------------------------------

/**
 * The keys a venue actually asked for.
 *
 * Their previous system offered twenty-one, and they were explicit that they
 * did not want them all — "just the most obvious". So the ones that are about
 * administering a Windows machine rather than about running a bar (restart the
 * app, update the database, stop external applications, sync tables) are not
 * here. They are not permissions a manager can reason about, and a screen of
 * switches nobody understands is one that gets left on.
 */
const TILL_PERMISSIONS = [
  { column: 'is_manager', label: 'Is manager', hint: 'Opens the manager functions, and can approve another member of staff rather than needing approval.' },
  { column: 'can_refund', label: 'Can refund', hint: 'Money back out of the till.' },
  { column: 'can_void', label: 'Can void', hint: 'Remove a line from a bill that has already been rung up.' },
  { column: 'can_discount', label: 'Can discount', hint: 'Take money off a line or a bill.' },
  { column: 'can_no_sale', label: 'Can no sale', hint: 'Open the cash drawer without a sale.' },
  { column: 'can_set_price', label: 'Can set selling price', hint: 'Override a programmed price at the counter.' },
  { column: 'can_x_report', label: 'Can X report', hint: 'Read the day so far, without closing it.' },
  { column: 'can_z_report', label: 'Can Z report', hint: 'Close the day and reset the totals.' },
  { column: 'can_unlock_tables', label: 'Can unlock tables', hint: "Take over a table another member of staff has open." },
  { column: 'can_expense', label: 'Can record expenses', hint: 'Pay something out of the drawer and record why.' },
  { column: 'can_wastage', label: 'Can record wastage', hint: 'Write off stock that was spilled, dropped or sent back.' },
];

const TILL_COLUMNS = TILL_PERMISSIONS.map((p) => p.column);

/** The three a venue is offered on an empty screen. Staff, Supervisor, Manager. */
const STANDARD_GROUPS = [
  {
    name: 'Staff',
    sort_order: 10,
    granted: [],
  },
  {
    name: 'Supervisor',
    sort_order: 20,
    granted: ['can_void', 'can_discount', 'can_no_sale', 'can_x_report', 'can_unlock_tables', 'can_wastage'],
  },
  {
    name: 'Manager',
    sort_order: 30,
    granted: TILL_COLUMNS,
  },
];

// ---------------------------------------------------------------------------
// The back office
// ---------------------------------------------------------------------------

/**
 * One entry per page in the back office, grouped the way the menu is grouped.
 *
 * Deliberately shaped like the navigation rather than like the database: the
 * person ticking these boxes is looking at the same menu the role will see, and
 * a permission called "Sales Explorer" is one they can check by opening it.
 *
 * `edit` keys are per group rather than per page. "May look at products but not
 * change them" is the case that matters — it is the accountant — and a separate
 * edit switch for each of twelve programming pages is twelve more switches for
 * a distinction nobody has ever needed to draw.
 */
const BACKOFFICE_PERMISSIONS = [
  {
    group: 'Dashboard',
    keys: [{ key: 'dashboard.view', label: 'View dashboard' }],
  },
  {
    group: 'Reports',
    keys: [
      { key: 'reports.financial_summary', label: 'Financial Summary' },
      { key: 'reports.report', label: 'Report' },
      { key: 'reports.product_sales', label: 'Product Sales Report' },
      { key: 'reports.discounts', label: 'Discount Report' },
      { key: 'reports.loyalty_spending', label: 'Customer Loyalty Spending' },
      { key: 'reports.voids', label: 'Voids & Cancels Report' },
      { key: 'reports.sales_explorer', label: 'Sales Explorer' },
      { key: 'reports.till_report', label: 'Till Report' },
      { key: 'reports.bill_report', label: 'Bill Report' },
      { key: 'reports.timesheets', label: 'Timesheets' },
      { key: 'reports.timesheets.edit', label: 'Correct a shift' },
      { key: 'reports.schedules', label: 'Scheduled reports' },
      { key: 'reports.schedules.edit', label: 'Create and change schedules' },
    ],
  },
  {
    group: 'Catalogue',
    keys: [
      { key: 'catalogue.products', label: 'Products' },
      { key: 'catalogue.stock', label: 'Stock' },
      { key: 'catalogue.edit', label: 'Change the catalogue' },
    ],
  },
  {
    group: 'Programming',
    keys: [
      { key: 'programming.screens', label: 'Screen programming' },
      { key: 'programming.departments', label: 'Departments' },
      { key: 'programming.groups', label: 'Sub Departments' },
      { key: 'programming.printer_categories', label: 'Printer categories' },
      { key: 'programming.import', label: 'Import' },
      { key: 'programming.modifiers', label: 'Modifiers' },
      { key: 'programming.mix_match', label: 'Mix & Match' },
      { key: 'programming.finalise_keys', label: 'Finalise Keys' },
      { key: 'programming.error_reasons', label: 'Error Reasons' },
      { key: 'programming.tax', label: 'Tax' },
      { key: 'programming.till_printers', label: 'Till & printers' },
      { key: 'programming.kitchen', label: 'Kitchen screens' },
      { key: 'programming.devices', label: 'Devices' },
      { key: 'programming.edit', label: 'Change programming' },
    ],
  },
  {
    group: 'Floor',
    keys: [
      { key: 'floor.tables', label: 'Table Designer' },
      { key: 'floor.edit', label: 'Change the floor plan' },
    ],
  },
  {
    group: 'People',
    keys: [
      { key: 'people.users', label: 'Back Office Users' },
      { key: 'people.roles', label: 'Back Office User Roles' },
      { key: 'people.staff', label: 'Staff' },
      { key: 'people.permission_groups', label: 'Staff Permissions' },
      { key: 'people.customers', label: 'Customers' },
      { key: 'people.vouchers', label: 'Vouchers' },
      { key: 'people.receipt_designer', label: 'Receipt designer' },
      { key: 'people.edit', label: 'Change people and their access' },
    ],
  },
  {
    group: 'Commerce',
    keys: [
      { key: 'commerce.promotions', label: 'Promotions' },
      { key: 'commerce.gift_cards', label: 'Gift cards' },
      { key: 'commerce.deposits', label: 'Deposits' },
      { key: 'commerce.loyalty', label: 'Loyalty' },
      { key: 'commerce.cards', label: 'Cards' },
      { key: 'commerce.wallet', label: 'Wallet passes' },
      { key: 'commerce.tender', label: 'Tender & gratuity' },
      { key: 'commerce.rules', label: 'Automation rules' },
      { key: 'commerce.edit', label: 'Change commerce settings' },
    ],
  },
];

/** Every valid key, flat. Anything not in here is dropped on read. */
const BACKOFFICE_KEYS = new Set(
  BACKOFFICE_PERMISSIONS.flatMap((g) => g.keys.map((k) => k.key))
);

/**
 * Roles a venue is offered on an empty screen.
 *
 * "Accountant" is here because it is the example the customer gave: somebody
 * who sees the money and nothing else.
 */
const STANDARD_ROLES = [
  {
    display_name: 'Owner',
    description: 'Everything.',
    permissions: [...BACKOFFICE_KEYS],
  },
  {
    display_name: 'Manager',
    description: 'Runs the venue day to day. No access to back-office logins.',
    permissions: [...BACKOFFICE_KEYS].filter(
      (k) => !['people.users', 'people.roles'].includes(k)
    ),
  },
  {
    display_name: 'Accountant',
    description: 'The figures, and nothing that can change them.',
    permissions: [
      'dashboard.view',
      'reports.financial_summary',
      'reports.report',
      'reports.product_sales',
      'reports.discounts',
      'reports.loyalty_spending',
      'reports.voids',
      'reports.sales_explorer',
      'reports.till_report',
      'reports.bill_report',
      'reports.timesheets',
      'reports.schedules',
      'reports.schedules.edit',
    ],
  },
  {
    display_name: 'Staff',
    description: 'Look, do not touch.',
    permissions: ['dashboard.view', 'catalogue.products', 'people.customers'],
  },
];

/** Parse the stored JSON, keeping only keys this build still recognises. */
function parsePermissions(raw) {
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return [];
    // Filtered rather than trusted: a key removed from the catalogue when a
    // page was retired must stop granting anything, and a key that was never in
    // it must never have granted anything.
    return list.filter((k) => BACKOFFICE_KEYS.has(k));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * What this request's user may do.
 *
 * Resolved per request rather than carried in the token. A session lasts hours;
 * a role edited at eleven has to bite at eleven, not at the end of the shift —
 * and revoking access that stays granted until a token expires is not revoking
 * access.
 *
 * Sets `req.access` to `{ unrestricted, granted:Set }`. `unrestricted` covers
 * the platform admin and every user who has not been given a role, which is
 * every user that existed before this feature.
 */
function attachAccess({ pool }) {
  return async (req, _res, next) => {
    try {
      req.access = { unrestricted: true, granted: new Set() };

      if (!req.user || req.user.role === 'admin') return next();

      const [[row]] = await pool.query(
        `SELECT r.permissions
           FROM backoffice_users u
           JOIN bo_user_roles r ON r.id = u.role_id
          WHERE u.id = ?`,
        [req.user.sub]
      );
      if (row) {
        req.access = {
          unrestricted: false,
          granted: new Set(parsePermissions(row.permissions)),
        };
      }
      next();
    } catch (e) {
      // A role that could not be read must not be a role that grants
      // everything. Fail closed, and say so.
      req.access = { unrestricted: false, granted: new Set() };
      next(e);
    }
  };
}

/**
 * `guard('people.edit')` — sign in, work out what they may do, then insist on
 * this one key. Three middlewares, in the only order that works.
 *
 * Exists because the alternative is spelling all three out at every route, and
 * the failure mode of forgetting the middle one is silent: `requirePermission`
 * with no `attachAccess` in front of it has nothing to read.
 */
function accessGuard({ pool, secret }) {
  const auth = requireAuth(secret);
  const attach = attachAccess({ pool });
  return (key) => [auth, attach, requirePermission(key)];
}

/** Express middleware: refuses a request the signed-in user has no key for. */
function requirePermission(key) {
  return (req, res, next) => {
    const access = req.access;
    if (!access) {
      // attachAccess was not mounted. Refusing is the only safe reading of
      // "nobody worked out what this user may do".
      return res.status(500).json({ error: 'Permissions were not resolved.' });
    }
    if (access.unrestricted || access.granted.has(key)) return next();
    res.status(403).json({ error: 'Your role does not include this.', permission: key });
  };
}

module.exports = {
  TILL_PERMISSIONS,
  TILL_COLUMNS,
  STANDARD_GROUPS,
  BACKOFFICE_PERMISSIONS,
  BACKOFFICE_KEYS,
  STANDARD_ROLES,
  parsePermissions,
  attachAccess,
  requirePermission,
  accessGuard,
  permissionRoutes,
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function permissionRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /**
   * Changing who may do what is itself a permission, and it has to be.
   *
   * Roles only ever subtract, so a user who can edit roles can restore their
   * own access by deleting the role that limits them — which makes an
   * unguarded management route the one hole that empties every other one. An
   * accountant may read these screens only if somebody gave them
   * `people.edit`, and by default nobody has.
   */
  const guard = accessGuard({ pool, secret });
  const mayEdit = guard('people.edit');

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

  const scope = (req, email) =>
    req.user.role === 'admin' && req.query.office_email
      ? req.query.office_email
      : email;

  const office = async (req) => scope(req, await tenantEmail(req));

  /** Both catalogues, so the browser draws the switches this build supports. */
  router.get('/permissions/catalogue', auth, (_req, res) => {
    res.json({ till: TILL_PERMISSIONS, backoffice: BACKOFFICE_PERMISSIONS });
  });

  // ---- Till: staff permission groups --------------------------------------

  router.get('/permission-groups', auth, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, name, sort_order, ${TILL_COLUMNS.join(', ')}
           FROM epos_permission_groups
          WHERE email = ?
          ORDER BY sort_order, name`,
        [await office(req)]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /** Coerce the body's switches to 0/1, ignoring anything not in the catalogue. */
  function tillValues(body) {
    return TILL_COLUMNS.map((c) => (body?.[c] ? 1 : 0));
  }

  function validName(name) {
    const trimmed = String(name || '').trim();
    return trimmed.length >= 1 && trimmed.length <= 64 ? trimmed : null;
  }

  router.post('/permission-groups', mayEdit, async (req, res, next) => {
    try {
      const name = validName(req.body?.name);
      if (!name) return res.status(400).json({ error: 'A name is required.' });

      const [result] = await pool.execute(
        `INSERT INTO epos_permission_groups
           (email, name, sort_order, ${TILL_COLUMNS.join(', ')})
         VALUES (?, ?, ?, ${TILL_COLUMNS.map(() => '?').join(', ')})`,
        [
          await office(req),
          name,
          Number(req.body?.sort_order) || 0,
          ...tillValues(req.body),
        ]
      );
      broadcast({ type: 'staff.updated' });
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A group with that name already exists.' });
      }
      next(e);
    }
  });

  router.put('/permission-groups/:id', mayEdit, async (req, res, next) => {
    try {
      const name = validName(req.body?.name);
      if (!name) return res.status(400).json({ error: 'A name is required.' });

      const [result] = await pool.execute(
        `UPDATE epos_permission_groups
            SET name = ?, sort_order = ?,
                ${TILL_COLUMNS.map((c) => `${c} = ?`).join(', ')}
          WHERE id = ? AND email = ?`,
        [
          name,
          Number(req.body?.sort_order) || 0,
          ...tillValues(req.body),
          req.params.id,
          await office(req),
        ]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ error: 'No such permission group.' });
      }
      broadcast({ type: 'staff.updated' });
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A group with that name already exists.' });
      }
      next(e);
    }
  });

  /**
   * Delete a group.
   *
   * The staff who were in it become unrestricted rather than locked out. That
   * is the same rule as everywhere else here — a null group is "as before" —
   * and it is the one that cannot strand a venue mid-service because somebody
   * tidied up the permissions screen.
   */
  router.delete('/permission-groups/:id', mayEdit, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const email = await office(req);

      const [result] = await conn.execute(
        'DELETE FROM epos_permission_groups WHERE id = ? AND email = ?',
        [req.params.id, email]
      );
      if (!result.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ error: 'No such permission group.' });
      }
      await conn.execute(
        `UPDATE bo_clarks SET permission_group_id = NULL
          WHERE permission_group_id = ? AND email = ?`,
        [req.params.id, email]
      );
      await conn.commit();
      broadcast({ type: 'staff.updated' });
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  });

  /** Staff, Supervisor and Manager, for a venue starting from nothing. */
  router.post('/permission-groups/standard', mayEdit, async (req, res, next) => {
    try {
      const email = await office(req);
      let made = 0;
      for (const group of STANDARD_GROUPS) {
        const values = TILL_COLUMNS.map((c) => (group.granted.includes(c) ? 1 : 0));
        const [result] = await pool.execute(
          `INSERT IGNORE INTO epos_permission_groups
             (email, name, sort_order, ${TILL_COLUMNS.join(', ')})
           VALUES (?, ?, ?, ${TILL_COLUMNS.map(() => '?').join(', ')})`,
          [email, group.name, group.sort_order, ...values]
        );
        made += result.affectedRows;
      }
      broadcast({ type: 'staff.updated' });
      res.status(201).json({ created: made });
    } catch (e) {
      next(e);
    }
  });

  // ---- Back office: user roles --------------------------------------------

  router.get('/user-roles', auth, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT r.id, r.display_name, r.description, r.permissions,
                (SELECT COUNT(*) FROM backoffice_users u WHERE u.role_id = r.id) AS users
           FROM bo_user_roles r
          WHERE r.email = ?
          ORDER BY r.display_name`,
        [await office(req)]
      );
      res.json(
        rows.map((r) => ({ ...r, permissions: parsePermissions(r.permissions) }))
      );
    } catch (e) {
      next(e);
    }
  });

  /** Keep only keys this build knows, so an old browser cannot invent one. */
  function cleanPermissions(body) {
    const list = Array.isArray(body?.permissions) ? body.permissions : [];
    return JSON.stringify([...new Set(list.filter((k) => BACKOFFICE_KEYS.has(k)))]);
  }

  router.post('/user-roles', mayEdit, async (req, res, next) => {
    try {
      const name = validName(req.body?.display_name);
      if (!name) return res.status(400).json({ error: 'A name is required.' });

      const [result] = await pool.execute(
        `INSERT INTO bo_user_roles (email, display_name, description, permissions)
         VALUES (?, ?, ?, ?)`,
        [
          await office(req),
          name,
          String(req.body?.description || '').slice(0, 255) || null,
          cleanPermissions(req.body),
        ]
      );
      broadcast({ type: 'users.updated' });
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A role with that name already exists.' });
      }
      next(e);
    }
  });

  router.put('/user-roles/:id', mayEdit, async (req, res, next) => {
    try {
      const name = validName(req.body?.display_name);
      if (!name) return res.status(400).json({ error: 'A name is required.' });

      const [result] = await pool.execute(
        `UPDATE bo_user_roles
            SET display_name = ?, description = ?, permissions = ?
          WHERE id = ? AND email = ?`,
        [
          name,
          String(req.body?.description || '').slice(0, 255) || null,
          cleanPermissions(req.body),
          req.params.id,
          await office(req),
        ]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ error: 'No such role.' });
      }
      broadcast({ type: 'users.updated' });
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A role with that name already exists.' });
      }
      next(e);
    }
  });

  router.delete('/user-roles/:id', mayEdit, async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const email = await office(req);

      const [result] = await conn.execute(
        'DELETE FROM bo_user_roles WHERE id = ? AND email = ?',
        [req.params.id, email]
      );
      if (!result.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ error: 'No such role.' });
      }
      // Same rule as the till: losing a role restores the access somebody had
      // before there were roles, rather than locking them out of their own
      // back office.
      await conn.execute(
        'UPDATE backoffice_users SET role_id = NULL WHERE role_id = ? AND office_id IS NOT NULL',
        [req.params.id]
      );
      await conn.commit();
      broadcast({ type: 'users.updated' });
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      next(e);
    } finally {
      conn.release();
    }
  });

  /** Owner, Manager, Accountant and Staff, for a venue starting from nothing. */
  router.post('/user-roles/standard', mayEdit, async (req, res, next) => {
    try {
      const email = await office(req);
      let made = 0;
      for (const role of STANDARD_ROLES) {
        const [result] = await pool.execute(
          `INSERT IGNORE INTO bo_user_roles
             (email, display_name, description, permissions)
           VALUES (?, ?, ?, ?)`,
          [email, role.display_name, role.description, JSON.stringify(role.permissions)]
        );
        made += result.affectedRows;
      }
      broadcast({ type: 'users.updated' });
      res.status(201).json({ created: made });
    } catch (e) {
      next(e);
    }
  });

  /**
   * What the signed-in user may do, for the browser's own use.
   *
   * The menu hides what a role cannot open. That is a courtesy and not the
   * enforcement — every route checks for itself — but a menu full of pages that
   * answer 403 is a worse thing to hand somebody than a shorter menu.
   */
  router.get('/me/access', auth, async (req, res, next) => {
    try {
      if (req.user.role === 'admin') {
        return res.json({ unrestricted: true, permissions: [...BACKOFFICE_KEYS] });
      }
      const [[row]] = await pool.query(
        `SELECT r.display_name, r.permissions
           FROM backoffice_users u
           JOIN bo_user_roles r ON r.id = u.role_id
          WHERE u.id = ?`,
        [req.user.sub]
      );
      if (!row) {
        return res.json({ unrestricted: true, permissions: [...BACKOFFICE_KEYS] });
      }
      res.json({
        unrestricted: false,
        role: row.display_name,
        permissions: parsePermissions(row.permissions),
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
