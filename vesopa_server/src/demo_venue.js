/**
 * Demo venues: a practice copy of a venue, which is itself a venue.
 *
 * WHY THIS IS SMALL
 *
 * Every back-office route, every till call, every kitchen ticket and every
 * kiosk order already finds its venue the same way -- an office key that every
 * table is scoped by. So a practice venue needs no filtering, no `demo` column
 * on sales, and no second database: it is a tenant, and tenants already cannot
 * see one another. Nothing downstream has to learn that demo venues exist,
 * which is exactly why a trainee cannot reach live data -- there is no code
 * path that would let them, not a check that might be forgotten.
 *
 * WHAT THIS REPLACES
 *
 * Until now a training sale was answered 200 and written NOWHERE (training.js).
 * A trainee could practise, but nobody could ever look at what they had done,
 * and it was EPOS-only -- the kiosk, the menu and the back office knew nothing
 * about training at all. Now practice is real work in a practice venue: its own
 * X and Z, its own reports, its own kitchen screen. The live venue's figures
 * cannot contain any of it because it belongs to a different tenant.
 *
 * The old discard stays in place. A till too old to know about demo venues
 * still sends training sales to the live office, and training.js still throws
 * them away. The twin is where practice is meant to go; the discard is the
 * backstop for a till that never learnt about it.
 *
 * HOW A TILL GETS INTO ONE
 *
 * Not by a header on each request, which would be one forgotten check away
 * from a practice sale in the real ledger. A training account signs on, the
 * till asks for a demo terminal token (`POST /till/demo/token`), and that token
 * *carries the practice venue's office key*. From then on every existing route
 * serves the practice venue without knowing it has done anything unusual, and
 * the token is incapable of naming the live one.
 */
const express = require('express');

const { requireAuth, requireTerminal, issueTerminalToken } = require('./auth');

/** A demo office's address can never receive mail: .invalid cannot resolve (RFC 2606). */
const DEMO_EMAIL_DOMAIN = 'vesopa.invalid';

/**
 * The venue's SETUP: what a practice copy needs in order to be worth
 * practising on, in the order it has to be inserted.
 *
 * `links` name the columns that point at another table's auto-increment id.
 * Those cannot simply be copied -- the clone's rows get new ids -- so each is
 * rewritten through the map built as the parent table is copied. Tables absent
 * from a given database are skipped, not fatal: this list spans releases.
 */
const SETUP = [
  { table: 'bo_product_departments' },
  { table: 'bo_product_groups' },
  { table: 'bo_print_categories' },
  { table: 'bo_tax_rates' },
  // Products name their department and group by NAME, not by id, so only the
  // print category has to be rewritten.
  { table: 'bo_products', links: { print_category_id: 'bo_print_categories' } },

  { table: 'epos_screens' },
  { table: 'epos_screen_buttons', links: { screen_id: 'epos_screens' } },
  { table: 'epos_modifier_groups', links: { screen_id: 'epos_screens' } },
  { table: 'epos_product_modifiers', links: { group_id: 'epos_modifier_groups' } },

  { table: 'floor_rooms' },
  { table: 'floor_tables', links: { room_id: 'floor_rooms' } },

  { table: 'epos_till_settings' },
  { table: 'epos_tender_settings' },
  { table: 'epos_templates' },
  { table: 'epos_permission_groups' },
  { table: 'bo_user_roles' },
  { table: 'bo_error_reasons' },
  { table: 'cash_denominations' },
  { table: 'epos_rules' },
  { table: 'epos_branding' },
  { table: 'epos_fonts' },

  { table: 'epos_promotions' },
  { table: 'epos_promotion_products', links: { promotion_id: 'epos_promotions' } },
  { table: 'bo_mix_match' },
  { table: 'bo_mix_match_products', links: { mix_match_id: 'bo_mix_match' } },

  { table: 'epos_kitchen_screens' },
  { table: 'epos_express_settings' },

  { table: 'dinein_venue' },
  { table: 'dinein_sections' },
  { table: 'dinein_items', links: { section_id: 'dinein_sections' } },
  { table: 'dinein_item_meals', links: { item_id: 'dinein_items' } },
  { table: 'dinein_qr_designs' },

  // Settings only. The scheme's members are customers and are never copied --
  // see PRACTICE, and the note on privacy below.
  { table: 'epos_loyalty_settings' },
  { table: 'epos_loyalty_tiers' },
  { table: 'epos_card_settings' },
  { table: 'epos_card_sequences' },
  { table: 'epos_wallet_settings' },

  // Only the training accounts. A practice venue holding every real clerk's PIN
  // would be a copy of the venue's credentials for the sake of a rehearsal.
  { table: 'bo_clarks', where: 'COALESCE(training, 0) = 1' },
];

/**
 * What a reset empties: everything a practice session PRODUCES.
 *
 * Deliberately also the list of what is never cloned in the first place. A
 * practice venue starts with no sales, no customers and no gift cards, because
 * a trainee rehearsing on copies of real people's names, balances and card
 * numbers is a data-protection incident waiting for somebody to notice.
 */
const PRACTICE = [
  'epos_payments',
  'epos_order_lines',
  'epos_orders',
  'epos_open_bill_revs',
  'epos_open_bill_tombstones',
  'epos_open_bills',
  'epos_kitchen_ticket_lines',
  'epos_kitchen_ticket_stations',
  'epos_kitchen_tickets',
  'epos_void_log',
  'epos_clerk_sessions',
  'epos_time_clock',
  'dinein_order_lines',
  'dinein_orders',
  'dinein_diners',
  'epos_express_orders',
  'epos_express_prints',
  'epos_express_counters',
  'epos_loyalty_txns',
  'epos_customers',
  'epos_gift_card_txns',
  'epos_gift_cards',
  'epos_deposits',
  'epos_card_issues',
  'epos_gym_visits',
  'bo_report_runs',
];

// ---------------------------------------------------------------------------
// Reading the shape of the database
//
// Discovered rather than declared, because the tenant key is not spelled the
// same everywhere: the legacy PHP tables call it `email`, the ones added since
// call it `office`, and a couple carry the numeric `office_id`. A hand-written
// list of which is which would be wrong the first time somebody added a table.
// ---------------------------------------------------------------------------

const shapeCache = new Map();

async function shapeOf(db, table) {
  if (shapeCache.has(table)) return shapeCache.get(table);
  const [rows] = await db.query(
    `SELECT COLUMN_NAME AS name, EXTRA AS extra
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  if (!rows.length) {
    shapeCache.set(table, null);
    return null;
  }
  const names = rows.map((r) => r.name);
  const auto = rows.find((r) => String(r.extra || '').includes('auto_increment'));
  // In preference order: the two string keys first, because they are the tenant
  // key proper; office_id is a foreign key that only some tables carry.
  const tenant = ['office', 'email', 'office_id'].find((c) => names.includes(c)) || null;
  const shape = {
    columns: names,
    auto: auto ? auto.name : null,
    tenant,
    tenantIsId: tenant === 'office_id',
  };
  shapeCache.set(table, shape);
  return shape;
}

/** Forgotten after a migration, so a column added by a deploy is seen. */
function forgetShapes() {
  shapeCache.clear();
}

// ---------------------------------------------------------------------------
// Finding the twin
// ---------------------------------------------------------------------------

/** The office row for a tenant key. */
async function officeByEmail(db, email) {
  const [[row]] = await db.query(
    `SELECT id, name, contact_email, status, demo_of, demo_refreshed_at, demo_reset_at
       FROM offices WHERE contact_email = ?`,
    [email]
  );
  return row || null;
}

async function officeById(db, id) {
  const [[row]] = await db.query(
    `SELECT id, name, contact_email, status, demo_of, demo_refreshed_at, demo_reset_at
       FROM offices WHERE id = ?`,
    [id]
  );
  return row || null;
}

/**
 * The practice venue belonging to a live one, or null.
 *
 * A missing `demo_of` column (a server whose migration has not run) means no
 * venue has a twin, which is exactly true rather than an error.
 */
async function demoFor(db, liveEmail) {
  try {
    const live = await officeByEmail(db, liveEmail);
    if (!live || live.demo_of != null) return null;
    const [[row]] = await db.query(
      `SELECT id, name, contact_email, status FROM offices WHERE demo_of = ?`,
      [live.id]
    );
    return row || null;
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return null;
    throw e;
  }
}

/** Whether this tenant key is a practice venue. */
async function isDemo(db, email) {
  try {
    const office = await officeByEmail(db, email);
    return !!(office && office.demo_of != null);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

/**
 * Copy one table's rows from one venue to another, rewriting the tenant key and
 * any id that points at a table already copied.
 *
 * Row by row rather than `INSERT ... SELECT`, because the new ids have to be
 * learnt as they are assigned so the children can be pointed at them. A clone
 * runs on demand and rarely; being readable is worth more here than being fast.
 */
async function copyTable(db, entry, ctx) {
  const shape = await shapeOf(db, entry.table);
  if (!shape || !shape.tenant) return { table: entry.table, rows: 0, skipped: true };

  const fromValue = shape.tenantIsId ? ctx.fromId : ctx.fromEmail;
  const toValue = shape.tenantIsId ? ctx.toId : ctx.toEmail;

  const where = entry.where ? ` AND (${entry.where})` : '';
  let source;
  try {
    [source] = await db.query(
      `SELECT * FROM \`${entry.table}\` WHERE \`${shape.tenant}\` = ?${where}`,
      [fromValue]
    );
  } catch (e) {
    // A `where` naming a column this release does not have yet (training, say)
    // means there is nothing of that kind to copy.
    if (e.code === 'ER_BAD_FIELD_ERROR') return { table: entry.table, rows: 0, skipped: true };
    throw e;
  }
  if (!source.length) return { table: entry.table, rows: 0 };

  // The id map for this table, so children can find their new parents.
  const map = new Map();
  ctx.ids.set(entry.table, map);

  const copied = shape.columns.filter((c) => c !== shape.auto);
  const placeholders = copied.map(() => '?').join(', ');
  const columnList = copied.map((c) => `\`${c}\``).join(', ');

  for (const row of source) {
    const values = copied.map((column) => {
      if (column === shape.tenant) return toValue;
      // A table carrying BOTH keys (some do) must have both rewritten, or the
      // clone would point half at the practice venue and half at the real one.
      if (column === 'office' || column === 'email') return ctx.toEmail;
      if (column === 'office_id') return ctx.toId;
      const parent = entry.links && entry.links[column];
      if (parent && row[column] != null) {
        const parentMap = ctx.ids.get(parent);
        const mapped = parentMap && parentMap.get(row[column]);
        // A child whose parent was not copied keeps nothing rather than
        // pointing at a live row: a stray id across the tenant boundary is the
        // one thing this whole design exists to prevent.
        return mapped == null ? null : mapped;
      }
      return row[column];
    });

    const [res] = await db.execute(
      `INSERT INTO \`${entry.table}\` (${columnList}) VALUES (${placeholders})`,
      values
    );
    if (shape.auto && row[shape.auto] != null && res.insertId) {
      map.set(row[shape.auto], res.insertId);
    }
  }

  return { table: entry.table, rows: source.length };
}

/**
 * Fill a practice venue with a copy of the live venue's setup.
 *
 * Refuses anything but a practice venue as the destination, checked here rather
 * than trusted from the caller: this function writes to every table a venue
 * owns, and pointing it at a real office would overwrite a trading venue with a
 * second copy of itself.
 */
async function cloneSetup(db, { fromEmail, toEmail }) {
  const live = await officeByEmail(db, fromEmail);
  const demo = await officeByEmail(db, toEmail);
  if (!live) throw new Error(`No such venue: ${fromEmail}`);
  if (!demo) throw new Error(`No such venue: ${toEmail}`);
  if (demo.demo_of == null) {
    throw new Error('Refusing to clone into a venue that is not a practice one.');
  }
  if (Number(demo.demo_of) !== Number(live.id)) {
    throw new Error('That practice venue belongs to a different venue.');
  }

  const ctx = {
    fromEmail: live.contact_email,
    fromId: live.id,
    toEmail: demo.contact_email,
    toId: demo.id,
    ids: new Map(),
  };

  const report = [];
  for (const entry of SETUP) {
    report.push(await copyTable(db, entry, ctx));
  }
  await db.execute('UPDATE offices SET demo_refreshed_at = NOW() WHERE id = ?', [demo.id]);
  return report;
}

/** Empty a practice venue's own setup, so a refresh replaces rather than doubles. */
async function clearSetup(db, demoEmail, demoId) {
  // Reverse order: children before the parents they point at.
  for (const entry of [...SETUP].reverse()) {
    const shape = await shapeOf(db, entry.table);
    if (!shape || !shape.tenant) continue;
    const value = shape.tenantIsId ? demoId : demoEmail;
    await db.execute(`DELETE FROM \`${entry.table}\` WHERE \`${shape.tenant}\` = ?`, [value]);
  }
}

/**
 * Throw away what a practice venue has produced, keeping what it was given.
 *
 * The setup stays, so a trainee can carry straight on; the sales, bills,
 * tickets and practice customers go.
 */
async function resetDemo(db, demoEmail) {
  const demo = await officeByEmail(db, demoEmail);
  if (!demo || demo.demo_of == null) {
    throw new Error('That is not a practice venue.');
  }
  for (const table of PRACTICE) {
    const shape = await shapeOf(db, table);
    if (!shape || !shape.tenant) continue;
    const value = shape.tenantIsId ? demo.id : demo.contact_email;
    await db.execute(`DELETE FROM \`${table}\` WHERE \`${shape.tenant}\` = ?`, [value]);
  }
  await db.execute('UPDATE offices SET demo_reset_at = NOW() WHERE id = ?', [demo.id]);
  return demo;
}

/**
 * The practice venue for a live one, made if it is not there yet.
 *
 * The address is `.invalid`, which cannot resolve and so cannot be delivered
 * to. That is not decoration: a practice venue that could email would
 * eventually email a real customer a rehearsal.
 */
async function ensureDemo(db, liveEmail) {
  const live = await officeByEmail(db, liveEmail);
  if (!live) throw new Error(`No such venue: ${liveEmail}`);
  if (live.demo_of != null) throw new Error('That venue is already a practice one.');

  const existing = await demoFor(db, liveEmail);
  if (existing) return existing;

  const email = `demo.${live.id}@${DEMO_EMAIL_DOMAIN}`;
  await db.execute(
    `INSERT INTO offices (name, contact_email, status, plan, demo_of)
     VALUES (?, ?, 'active', NULL, ?)`,
    [`${live.name} — Demo`, email, live.id]
  );
  const demo = await officeByEmail(db, email);
  await cloneSetup(db, { fromEmail: live.contact_email, toEmail: demo.contact_email });
  return demo;
}

// ---------------------------------------------------------------------------
// Getting a till into one
// ---------------------------------------------------------------------------

/**
 * A terminal token for the practice venue.
 *
 * Short-lived, unlike the real one: a practice session is an afternoon, and a
 * ten-year credential for a venue nobody watches is a credential worth stealing.
 * It carries `demo` so a seat is never taken for it (till_seats.js) and so the
 * back office can tell a practice till from a real one at a glance.
 */
function demoTerminalToken(demo, commissionedBy, secret) {
  return issueTerminalToken(
    {
      officeEmail: demo.contact_email,
      officeId: demo.id,
      email: commissionedBy || null,
    },
    secret,
    '12h'
  );
}

function demoRoutes({ pool, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);
  const terminal = requireTerminal(secret);

  /**
   * A till whose trainee has just signed on asks to be moved to the practice
   * venue. Answered only for a staff member who really is a training account --
   * the till asking is not enough, or a tampered till could put a real sale
   * somewhere it is never counted.
   */
  router.post('/till/demo/token', terminal, async (req, res, next) => {
    try {
      const training = require('./training');
      const office = req.office;
      if (await isDemo(pool, office)) {
        return res.status(400).json({ error: 'This till is already in training mode.' });
      }
      const body = req.body || {};
      const isTrainee =
        (await training.isTrainingStaff(pool, office, body.staff_id)) ||
        (await training.isTrainingPin(pool, office, body.clerk_pin));
      if (!isTrainee) {
        return res.status(403).json({ error: 'That is not a training account.' });
      }
      const demo = await ensureDemo(pool, office);
      res.json({
        token: demoTerminalToken(demo, req.terminal && req.terminal.commissionedBy, secret),
        venue: { name: demo.name, email: demo.contact_email },
        demo: true,
      });
    } catch (e) {
      next(e);
    }
  });

  /** Whether this venue has a practice copy, and when it was last refreshed. */
  router.get('/api/demo', auth, async (req, res, next) => {
    try {
      const office = await officeById(pool, req.user.officeId);
      if (!office) return res.status(404).json({ error: 'No venue on this login.' });
      if (office.demo_of != null) {
        const live = await officeById(pool, office.demo_of);
        return res.json({
          is_demo: true,
          live: live ? { id: live.id, name: live.name } : null,
          refreshed_at: office.demo_refreshed_at,
          reset_at: office.demo_reset_at,
        });
      }
      const demo = await demoFor(pool, office.contact_email);
      const full = demo ? await officeById(pool, demo.id) : null;
      res.json({
        is_demo: false,
        demo: full
          ? {
              id: full.id,
              name: full.name,
              refreshed_at: full.demo_refreshed_at,
              reset_at: full.demo_reset_at,
            }
          : null,
      });
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') return res.json({ is_demo: false, demo: null });
      next(e);
    }
  });

  /** Make the practice venue, or re-copy the setup into the one that exists. */
  router.post('/api/demo/refresh', auth, async (req, res, next) => {
    try {
      const office = await officeById(pool, req.user.officeId);
      if (!office || office.demo_of != null) {
        return res.status(400).json({ error: 'Switch to the live venue first.' });
      }
      forgetShapes();
      const demo = await ensureDemo(pool, office.contact_email);
      // ensureDemo clones on creation; an existing one is replaced rather than
      // doubled, or a second refresh would give the venue two of every product.
      const existed = demo.demo_refreshed_at != null;
      if (existed) {
        await clearSetup(pool, demo.contact_email, demo.id);
        await cloneSetup(pool, {
          fromEmail: office.contact_email,
          toEmail: demo.contact_email,
        });
      }
      res.json({ ok: true, demo: { id: demo.id, name: demo.name } });
    } catch (e) {
      next(e);
    }
  });

  /** Throw away the practice data, keep the practice venue. */
  router.post('/api/demo/reset', auth, async (req, res, next) => {
    try {
      const office = await officeById(pool, req.user.officeId);
      if (!office) return res.status(404).json({ error: 'No venue on this login.' });
      const target =
        office.demo_of != null ? office : await demoFor(pool, office.contact_email);
      if (!target) return res.status(404).json({ error: 'There is no practice venue yet.' });
      await resetDemo(pool, target.contact_email);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = {
  SETUP,
  PRACTICE,
  DEMO_EMAIL_DOMAIN,
  shapeOf,
  forgetShapes,
  demoFor,
  isDemo,
  ensureDemo,
  cloneSetup,
  clearSetup,
  resetDemo,
  demoTerminalToken,
  demoRoutes,
};
