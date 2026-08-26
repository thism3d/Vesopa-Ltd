const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { requireAuth } = require('./auth');

// Product images. Stored on disk under public/uploads and served statically.
// Capped and type-checked, so an upload cannot fill the disk or smuggle in a
// script disguised as an image.
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'public', 'uploads'),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    cb(ok.includes(file.mimetype) ? null : new Error('Images only'), ok.includes(file.mimetype));
  },
});

/**
 * Back-office API. Replaces the PHP pages.
 *
 * Every mutation broadcasts over the WebSocket, so an open back-office tab and
 * every till on the floor see the change immediately — that is what "live data"
 * means here, rather than the operator hitting refresh.
 */
function backofficeRoutes({ pool, broadcast, secret }) {
  const router = express.Router();
  const auth = requireAuth(secret);

  /**
   * The tenant key. Catalogue rows carry the office's contact email — an
   * inheritance from the PHP schema — so every read and write must be scoped by
   * it. Without this, one customer sees (and can delete) another customer's
   * products.
   *
   * The platform admin is scoped to whichever office they are inspecting, or to
   * nothing, rather than being handed every office's rows in one undifferentiated
   * list.
   */
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

  /** Admins may read across offices; everyone else is pinned to their own. */
  function scope(req, email) {
    return req.user.role === 'admin' && req.query.office_email
      ? req.query.office_email
      : email;
  }

  // ---- Products -----------------------------------------------------------

  /**
   * The kitchen stations a product may be routed to.
   *
   * Fixed at six because the till's printer setup has six slots: offering a
   * seventh here would let a manager route food to a station no terminal can
   * print to, and the failure would surface in the kitchen at service rather
   * than in the form.
   */
  const KP_STATIONS = ['kp1', 'kp2', 'kp3', 'kp4', 'kp5', 'kp6'];

  /**
   * Normalise whatever the form sent into a stored routing string.
   *
   * Accepts an array (what the checkbox form posts) or a comma-separated
   * string (what an older client or an import sends), and understands the two
   * pre-numbering names so a legacy row edited in the new form is upgraded
   * rather than blanked. Unknown stations are dropped: a typo must not become
   * a route to a printer that does not exist.
   *
   * Returns null for "no kitchen", which is what the column means by empty.
   */
  function normaliseRoutes(value) {
    const parts = Array.isArray(value)
      ? value
      : String(value ?? '').split(',');

    const seen = new Set();
    for (const raw of parts) {
      const key = String(raw ?? '').trim().toLowerCase();
      if (!key) continue;
      const station = key === 'kitchen' ? 'kp1' : key === 'bar' ? 'kp2' : key;
      if (KP_STATIONS.includes(station)) seen.add(station);
    }

    // Sorted so the stored value is stable: "kp3,kp1" and "kp1,kp3" are the
    // same routing and should not read as an edit in the activity log.
    const routes = KP_STATIONS.filter((s) => seen.has(s));
    return routes.length ? routes.join(',') : null;
  }

  /**
   * The single station an older till should use for this product.
   *
   * The lowest-numbered one it is routed to, translated back into the names
   * that release understands. A product on KP 1 and KP 3 reaches an old
   * terminal as "kitchen" — one of its two printers rather than neither, which
   * is the better failure while a venue is mid-rollout.
   */
  function legacyRoute(p) {
    const routes = normaliseRoutes(p.printer_routes ?? p.printer_route);
    if (!routes) return null;
    const first = routes.split(',')[0];
    return first === 'kp1' ? 'kitchen' : first === 'kp2' ? 'bar' : first;
  }

  /** A form checkbox: absent means off, and "0" means off rather than truthy. */
  const flag = (v, fallback = 1) => {
    if (v === undefined || v === null || v === '') return fallback;
    return v === 0 || v === '0' || v === false || v === 'false' ? 0 : 1;
  };

  router.get('/products', auth, async (req, res, next) => {
    try {
      const email = scope(req, await tenantEmail(req));
      const [rows] = await pool.query(
        `SELECT id, pluid, product_name, department_name, group_name,
                accounting_code, price, tax_percentage, stock_quantity,
                button_position, button_color, printer_routes,
                print_to_receipt, emoji, image_url
         FROM bo_products
         WHERE email = ?
         ORDER BY department_name, button_position IS NULL, button_position,
                  product_name`,
        [email]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /** One product, for the edit form. Scoped, so you cannot read another
      office's row by guessing its id. */
  router.get('/products/:id', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const [[row]] = await pool.query(
        `SELECT * FROM bo_products
         WHERE id = ? AND (email = ? OR ? = 'admin')`,
        [req.params.id, email, req.user.role]
      );
      if (!row) return res.status(404).json({ error: 'No such product' });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.post('/products', auth, async (req, res, next) => {
    const p = req.body;
    try {
      const email = await tenantEmail(req);

      // A PLU is the catalogue's key everywhere it matters: a screen button
      // carries one, the till indexes its products by one, and a kitchen route
      // is looked up through one. Two rows sharing it means one of the two is
      // unreachable — and nobody finds out until a clerk presses a key and the
      // wrong thing goes on the bill.
      //
      // So it is still required, and still unique — but it is no longer asked
      // for. The form stopped offering the field: "which numbers am I not
      // using" is a question about this table, and this is the only place that
      // can answer it without racing a second manager adding a product at the
      // same moment. An explicit pluid is still honoured, so an import or an
      // older client that sends one keeps working.
      if (p.pluid === undefined || p.pluid === null || p.pluid === '') {
        const [[row]] = await pool.query(
          'SELECT COALESCE(MAX(pluid), 0) + 1 AS next FROM bo_products WHERE email = ?',
          [email]
        );
        p.pluid = row.next;
      } else {
        // Refused on create only. Rows that already share a PLU are left alone
        // rather than made uneditable, and the products list flags them so a
        // venue can see what it has; PUT never changes a pluid.
        const [[clash]] = await pool.query(
          'SELECT id, product_name FROM bo_products WHERE email = ? AND pluid = ?',
          [email, p.pluid]
        );
        if (clash) {
          return res.status(409).json({
            error:
              `PLU ${p.pluid} is already used by "${clash.product_name}". ` +
              'Give this one a number of its own.',
          });
        }
      }

      const [result] = await pool.execute(
        `INSERT INTO bo_products
           (email, pluid, product_name, department_name, group_name,
            accounting_code, price, tax_percentage, stock_quantity,
            button_position, button_color, printer_route, printer_routes,
            print_to_receipt, emoji, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          // The office's key, not the individual's: two managers in one shop
          // must add to the same catalogue.
          await tenantEmail(req),
          p.pluid,
          p.product_name,
          p.department_name ?? null,
          p.group_name ?? null,
          p.accounting_code ?? null,
          p.price ?? 0,
          p.tax_percentage ?? 0,
          p.stock_quantity ?? 0,
          p.button_position || null,
          p.button_color || null,
          // The legacy column keeps the first station, so a terminal on the
          // previous release still routes this product somewhere sensible
          // instead of stopping. Dropped once no till reports an old version.
          legacyRoute(p),
          normaliseRoutes(p.printer_routes ?? p.printer_route),
          flag(p.print_to_receipt),
          p.emoji || null,
          p.image_url || null,
        ]
      );

      // Tills hold a local copy of the catalogue; tell them to refresh it.
      broadcast({ type: 'catalogue.updated' });
      // The PLU goes back with the id because the client no longer knows it —
      // this route allocated it. Anything that has to key off a product the
      // moment it is created needs it: attaching modifier groups to a new
      // product is one round trip, not a re-fetch of the catalogue to find out
      // what number it was given.
      res.status(201).json({ id: result.insertId, pluid: p.pluid });
    } catch (e) {
      next(e);
    }
  });

  router.put('/products/:id', auth, async (req, res, next) => {
    const p = req.body;
    try {
      // Button colour is no longer on the product form — the screen editor owns
      // how a key looks. The column stays, and a save that does not mention it
      // leaves it exactly as it was: dropping the field from the form must not
      // quietly strip the colour off every product somebody edits the price of.
      // An explicit value (from an import, or an older client) still applies.
      const colourSql = p.button_color === undefined ? 'button_color' : '?';
      await pool.execute(
        `UPDATE bo_products
         SET product_name = ?, department_name = ?, group_name = ?,
             accounting_code = ?, price = ?, tax_percentage = ?,
             stock_quantity = ?, button_position = ?, button_color = ${colourSql},
             printer_route = ?, printer_routes = ?, print_to_receipt = ?,
             emoji = ?, image_url = ?
         WHERE id = ? AND email = ?`,
        [
          p.product_name,
          p.department_name ?? null,
          p.group_name ?? null,
          p.accounting_code ?? null,
          p.price ?? 0,
          p.tax_percentage ?? 0,
          p.stock_quantity ?? 0,
          p.button_position || null,
          ...(p.button_color === undefined ? [] : [p.button_color || null]),
          legacyRoute(p),
          normaliseRoutes(p.printer_routes ?? p.printer_route),
          flag(p.print_to_receipt),
          p.emoji || null,
          p.image_url || null,
          req.params.id,
          // Scoped: editing another office's product must be impossible even if
          // its id is guessed.
          await tenantEmail(req),
        ]
      );
      broadcast({ type: 'catalogue.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/products/:id', auth, async (req, res, next) => {
    try {
      const [r] = await pool.execute(
        'DELETE FROM bo_products WHERE id = ? AND email = ?',
        [req.params.id, await tenantEmail(req)]
      );
      // Zero rows means it was not theirs to delete.
      if (r.affectedRows === 0) {
        return res.status(404).json({ error: 'No such product' });
      }
      broadcast({ type: 'catalogue.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- Receipt branding ---------------------------------------------------
  //
  // What the till prints around the sale: logo, address, VAT number, footer
  // copy and the layout switches the Receipt Designer drives. One row per
  // office, created on first save.

  /** Columns the designer may write. Anything else in the body is ignored. */
  const BRANDING_FIELDS = [
    'venue_name', 'logo_url', 'address_line1', 'address_line2', 'city',
    'postcode', 'phone', 'website', 'vat_number', 'company_number',
    'header_note', 'footer_message', 'footer_note', 'social_line',
    'paper_width_mm', 'show_logo', 'show_vat_breakdown', 'show_barcode',
    'show_qr', 'qr_url', 'show_served_by', 'show_powered_by',
  ];

  const BRANDING_DEFAULTS = {
    venue_name: '', logo_url: null, address_line1: '', address_line2: '',
    city: '', postcode: '', phone: '', website: '', vat_number: '',
    company_number: '', header_note: '',
    footer_message: 'Thank you for your custom', footer_note: '',
    social_line: '', paper_width_mm: 80, show_logo: 1, show_vat_breakdown: 1,
    show_barcode: 1, show_qr: 0, qr_url: '', show_served_by: 1,
    show_powered_by: 1,
  };

  /**
   * Read the branding for the caller's office.
   *
   * Returns defaults rather than 404 when a venue has never saved any: the
   * till prints a receipt either way, and a missing row is not an error.
   */
  router.get('/branding', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const [[row]] = await pool.query(
        'SELECT * FROM epos_branding WHERE office = ?',
        [email]
      );
      res.json(row || { office: email, ...BRANDING_DEFAULTS });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The till's copy. Unauthenticated by design — a terminal fetches its own
   * venue's print header at sign-in, and this exposes nothing a customer does
   * not already read off their receipt.
   */
  router.get('/branding/public', async (req, res, next) => {
    try {
      const office = String(req.query.office || '').trim();
      if (!office) return res.status(400).json({ error: 'office is required' });
      const [[row]] = await pool.query(
        'SELECT * FROM epos_branding WHERE office = ?',
        [office]
      );
      res.json(row || { office, ...BRANDING_DEFAULTS });
    } catch (e) {
      next(e);
    }
  });

  /** Create-or-update the caller's branding. */
  router.put('/branding', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);

      // Only known columns, so the body cannot reach anything it should not.
      const given = BRANDING_FIELDS.filter((f) =>
        Object.prototype.hasOwnProperty.call(req.body, f)
      );

      const values = given.map((f) => {
        const v = req.body[f];
        if (f === 'paper_width_mm') {
          // Anything other than the two real roll widths is a mistake.
          return Number(v) === 58 ? 58 : 80;
        }
        if (f.startsWith('show_')) return v ? 1 : 0;
        if (f === 'logo_url') return v || null;
        return v == null ? '' : String(v);
      });

      const cols = ['office', ...given];
      const params = [email, ...values];
      const update = given.map((f) => `\`${f}\` = VALUES(\`${f}\`)`);

      await pool.execute(
        `INSERT INTO epos_branding (${cols.map((c) => `\`${c}\``).join(', ')})
         VALUES (${cols.map(() => '?').join(', ')})
         ${update.length ? `ON DUPLICATE KEY UPDATE ${update.join(', ')}` : ''}`,
        params
      );

      const [[row]] = await pool.query(
        'SELECT * FROM epos_branding WHERE office = ?',
        [email]
      );
      // Tills cache branding; tell them it moved so receipts change without
      // anyone restarting a terminal.
      broadcast({ type: 'branding' });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  // ---- Till behaviour: idle screen & staff sign-off -----------------------
  //
  // How the terminal behaves *between* sales, as opposed to what it prints
  // around one. One row per office, created on first save.

  /** Columns the till-behaviour editor may write. */
  /**
   * The printer slots a venue can name, in the order they are shown. The
   * receipt printer is last because that is where it was asked for, and
   * because a venue reading this list is nearly always looking for a kitchen
   * station.
   */
  const PRINTER_SLOTS = ['kp1', 'kp2', 'kp3', 'kp4', 'kp5', 'kp6', 'receipt'];
  const PRINTER_NAME_FIELDS = PRINTER_SLOTS.map((s) => `printer_name_${s}`);

  /**
   * Where each kitchen station's tickets come out: a printer, a Vesopa EPOS
   * Kitchen screen, or both.
   *
   * On this row rather than in a table of its own for the same reason the
   * printer *names* are: the till already fetches this row on startup and
   * re-polls it, and the till-settings broadcast already cache-busts it on
   * every terminal. Six short strings do not justify their own sync.
   *
   * The receipt printer has no mode. It is a routing destination — a product
   * routed there prints at the counter, which is the point of it — but it is
   * not a kitchen station, so it is deliberately absent from this list while
   * being present in the one above.
   */
  const KITCHEN_MODE_FIELDS = PRINTER_SLOTS
    .filter((s) => s !== 'receipt')
    .map((s) => `kitchen_mode_${s}`);

  const KITCHEN_MODES = ['printer', 'screen', 'both'];

  const TILL_FIELDS = [
    'idle_enabled', 'idle_image_url', 'idle_after_sale', 'idle_require_pin',
    'idle_message', 'signoff_seconds', 'change_window_seconds',
    'receipt_auto_print', 'buttons_show_prices',
    ...PRINTER_NAME_FIELDS,
    ...KITCHEN_MODE_FIELDS,
  ];

  const TILL_DEFAULTS = {
    idle_enabled: 1,
    idle_image_url: null,
    idle_after_sale: 1,
    idle_require_pin: 1,
    idle_message: 'Touch to begin',
    signoff_seconds: 180,
    change_window_seconds: 30,
    // Off by default, and deliberately: the till no longer asks whether the
    // customer wants a receipt, so leaving this on would have every venue
    // that upgrades start printing paper for every sale without being asked.
    // A venue that wants one every time switches it on once.
    receipt_auto_print: 0,
    buttons_show_prices: 1,
    // Null, not "KP 1". An empty name means "use the built-in label", so a
    // venue that never opens this screen sees exactly what it always saw —
    // and a venue that later clears a name gets the default back rather than
    // an empty chip.
    ...Object.fromEntries(PRINTER_NAME_FIELDS.map((f) => [f, null])),
    // Every station on a printer, which is what every venue does today. A
    // venue that upgrades and never opens the kitchen page prints exactly as
    // it did yesterday.
    ...Object.fromEntries(KITCHEN_MODE_FIELDS.map((f) => [f, 'printer'])),
  };

  /**
   * Clamp the sign-off timer to something a shift can actually work with.
   *
   * 0 disables it. Below ~20s the till would lock while a clerk was still
   * reading the screen; above an hour it has stopped being a security measure
   * and the venue may as well switch it off honestly.
   */
  function signoffSeconds(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(3600, Math.max(20, Math.round(n)));
  }

  /**
   * Clamp how long the change box stays up before the till signs off.
   *
   * 0 means "wait for a tap", the behaviour before this setting existed. The
   * floor is 5 seconds rather than 20: unlike the sign-off timer this one is
   * counting down in front of a customer who is being handed money, and a venue
   * that wants it brisk should be allowed to have it brisk. The ceiling is five
   * minutes — past that it is not a change window, it is the till being left.
   */
  function changeWindowSeconds(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(300, Math.max(5, Math.round(n)));
  }

  router.get('/till-settings', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const [[row]] = await pool.query(
        'SELECT * FROM epos_till_settings WHERE office = ?',
        [email]
      );
      res.json(row || { office: email, ...TILL_DEFAULTS });
    } catch (e) {
      next(e);
    }
  });

  /**
   * The till's copy. Unauthenticated like branding: it says which picture to
   * show between sales and how long to wait before locking, which is not a
   * credential. The staff list this pairs with is *not* public — see
   * /till/staff, which needs a terminal token.
   */
  router.get('/till-settings/public', async (req, res, next) => {
    try {
      const office = String(req.query.office || '').trim();
      if (!office) return res.status(400).json({ error: 'office is required' });
      const [[row]] = await pool.query(
        'SELECT * FROM epos_till_settings WHERE office = ?',
        [office]
      );
      res.json(row || { office, ...TILL_DEFAULTS });
    } catch (e) {
      next(e);
    }
  });

  router.put('/till-settings', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);

      const given = TILL_FIELDS.filter((f) =>
        Object.prototype.hasOwnProperty.call(req.body, f)
      );

      const values = given.map((f) => {
        const v = req.body[f];
        if (f === 'signoff_seconds') return signoffSeconds(v);
        if (f === 'change_window_seconds') return changeWindowSeconds(v);
        if (f === 'idle_image_url') {
          // Same rule as the note-key images: the picture has to live here, or
          // a till with no route to the open internet shows a broken frame.
          const url = v ? String(v) : null;
          if (url && !/^\/(uploads|assets)\//.test(url)) return null;
          return url;
        }
        if (f === 'receipt_auto_print' || f === 'buttons_show_prices') {
          return v ? 1 : 0;
        }
        // A printer name is free text, trimmed, and blank means "no name" —
        // stored as NULL so the till falls back to the built-in label rather
        // than showing a station with an empty string for a name.
        if (f.startsWith('printer_name_')) {
          const name = String(v ?? '').trim().slice(0, 40);
          return name || null;
        }
        // Anything unrecognised becomes 'printer'. A back office sent a mode
        // it does not know about must leave the kitchen printing, not leave it
        // silent — the failure of the safe default is paper nobody wanted, and
        // of the other one is food nobody cooks.
        if (f.startsWith('kitchen_mode_')) {
          return KITCHEN_MODES.includes(v) ? v : 'printer';
        }
        if (f.startsWith('idle_') && f !== 'idle_message') return v ? 1 : 0;
        return v == null ? '' : String(v);
      });

      const cols = ['office', ...given];
      const params = [email, ...values];
      const update = given.map((f) => `\`${f}\` = VALUES(\`${f}\`)`);

      await pool.execute(
        `INSERT INTO epos_till_settings (${cols.map((c) => `\`${c}\``).join(', ')})
         VALUES (${cols.map(() => '?').join(', ')})
         ${update.length ? `ON DUPLICATE KEY UPDATE ${update.join(', ')}` : ''}`,
        params
      );

      const [[row]] = await pool.query(
        'SELECT * FROM epos_till_settings WHERE office = ?',
        [email]
      );
      // Tills cache this; tell them it moved so a new idle picture appears
      // without anyone restarting a terminal.
      broadcast({ type: 'till-settings' });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  /** Upload an idle-screen background; returns the URL to store on the row. */
  router.post('/till-settings/idle-image', auth, (req, res) => {
    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file' });
      res.status(201).json({ url: `/uploads/${req.file.filename}` });
    });
  });

  /** Upload a venue logo; returns the URL to store on the branding row. */
  router.post('/branding/logo', auth, (req, res) => {
    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file' });
      res.status(201).json({ url: `/uploads/${req.file.filename}` });
    });
  });

  /** Upload a product image; returns the URL to store on the product. */
  router.post(
    '/product-image',
    auth,
    (req, res) => {
      upload.single('image')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file' });
        res.status(201).json({ url: `/uploads/${req.file.filename}` });
      });
    }
  );

  // Departments & groups are served by the programming router's CRUD factory
  // (with sort_order, edit and reorder). They used to have read-only handlers
  // here; removed so the fuller routes are not shadowed by mount order.

  // ---- Staff --------------------------------------------------------------
  //
  // Still stored in `bo_clarks`, which predates both apps and which vesopa_web's
  // admin panel also writes to — so the table keeps its name while the UI calls
  // these people Staff. Both paths are served: /staff is what the back office
  // now calls, /clerks stays so nothing already pointing at it breaks.
  //
  const STAFF_PATHS = ['/staff', '/clerks'];

  /**
   * Exactly four digits.
   *
   * Not "four or more": the till's PIN pad submits as soon as the fourth digit
   * lands, which is what makes signing on a one-second act. A five-digit PIN
   * would be checked after four and fail, so allowing one only lets a manager
   * create a staff member who can never sign in.
   */
  function validPin(pin) {
    return /^\d{4}$/.test(String(pin || ''));
  }

  /**
   * The staff list, PIN included.
   *
   * The PIN *is* returned here, unlike everywhere else a credential appears in
   * this API. That is a deliberate decision, not an oversight: a manager has to
   * be able to read a PIN back to the member of staff who forgot it, and this
   * page is already behind a back-office sign-in and scoped to one office. It is
   * a door code, not a password — nothing but a till accepts it.
   */
  router.get(STAFF_PATHS, auth, async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, pluid, clark_name, pin_code, COALESCE(active, 1) AS active
         FROM bo_clarks WHERE email = ?
         ORDER BY pluid, clark_name`,
        [scope(req, await tenantEmail(req))]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.post(STAFF_PATHS, auth, async (req, res, next) => {
    const { clark_name, pin_code, pluid, active } = req.body;
    if (!clark_name || !pin_code) {
      return res.status(400).json({ error: 'Name and PIN are required' });
    }
    if (!validPin(pin_code)) {
      return res
        .status(400)
        .json({ error: 'A PIN must be exactly 4 digits, numbers only.' });
    }
    try {
      const email = await tenantEmail(req);

      // Two people on one PIN means the till cannot tell them apart, and every
      // sale either of them rings up is attributed to whichever row was found
      // first. Refused rather than silently mis-attributed.
      const [[clash]] = await pool.query(
        'SELECT clark_name FROM bo_clarks WHERE email = ? AND pin_code = ?',
        [email, String(pin_code)]
      );
      if (clash) {
        return res.status(409).json({
          error: `That PIN is already in use by ${clash.clark_name}.`,
        });
      }

      const [result] = await pool.execute(
        `INSERT INTO bo_clarks (email, pluid, clark_name, pin_code, active)
         VALUES (?, ?, ?, ?, ?)`,
        [email, pluid ?? 0, clark_name, pin_code, active === 0 ? 0 : 1]
      );
      broadcast({ type: 'staff.updated' });
      res.status(201).json({ id: result.insertId });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Edit a clerk. The PIN is only overwritten when a new one is supplied —
   * blank means "leave the existing PIN", so a manager fixing a typo in a name
   * does not have to know or re-enter the operator's PIN.
   */
  router.put(
    STAFF_PATHS.map((p) => `${p}/:id`),
    auth,
    async (req, res, next) => {
    const { clark_name, pin_code, pluid, active } = req.body || {};
    if (!clark_name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (pin_code && !validPin(pin_code)) {
      return res
        .status(400)
        .json({ error: 'A PIN must be exactly 4 digits, numbers only.' });
    }
    try {
      const email = await tenantEmail(req);

      if (pin_code) {
        const [[clash]] = await pool.query(
          `SELECT clark_name FROM bo_clarks
           WHERE email = ? AND pin_code = ? AND id <> ?`,
          [email, String(pin_code), req.params.id]
        );
        if (clash) {
          return res.status(409).json({
            error: `That PIN is already in use by ${clash.clark_name}.`,
          });
        }
      }

      const sets = ['clark_name = ?', 'pluid = ?'];
      const params = [clark_name, pluid ?? 0];
      if (pin_code) {
        sets.push('pin_code = ?');
        params.push(pin_code);
      }
      if (active !== undefined) {
        sets.push('active = ?');
        params.push(active ? 1 : 0);
      }
      params.push(req.params.id, email);

      const [r] = await pool.execute(
        `UPDATE bo_clarks SET ${sets.join(', ')} WHERE id = ? AND email = ?`,
        params
      );
      if (r.affectedRows === 0) {
        return res.status(404).json({ error: 'No such staff member' });
      }
      broadcast({ type: 'staff.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  }
  );

  router.delete(
    STAFF_PATHS.map((p) => `${p}/:id`),
    auth,
    async (req, res, next) => {
      try {
        const [r] = await pool.execute(
          'DELETE FROM bo_clarks WHERE id = ? AND email = ?',
          [req.params.id, await tenantEmail(req)]
        );
        if (r.affectedRows === 0) {
          return res.status(404).json({ error: 'No such staff member' });
        }
        broadcast({ type: 'staff.updated' });
        res.json({ ok: true });
      } catch (e) {
        next(e);
      }
    }
  );

  // ---- Back-office users (managers / employees) ---------------------------

  /**
   * The people who can sign into the back office, as opposed to clerks, who
   * only have a till PIN.
   *
   * An office user sees only their own office's users; the platform admin sees
   * everyone. Scoping this in SQL rather than in the UI is what actually stops
   * one customer reading another's staff list.
   */
  router.get('/users', auth, async (req, res, next) => {
    try {
      const admin = req.user.role === 'admin';
      const [rows] = await pool.query(
        `SELECT u.id, u.email, u.name, u.approved, u.role, u.office_id,
                o.name AS office_name
         FROM backoffice_users u
         LEFT JOIN offices o ON o.id = u.office_id
         ${admin ? '' : 'WHERE u.office_id = ?'}
         ORDER BY o.name, u.name`,
        admin ? [] : [req.user.officeId]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.post('/users', auth, async (req, res, next) => {
    const { email, name, password, approved } = req.body || {};
    if (!email || !name || !password) {
      return res
        .status(400)
        .json({ error: 'Name, email and password are required' });
    }

    // A non-admin can only add people to their own office — never to someone
    // else's, and never as a platform admin.
    const officeId =
      req.user.role === 'admin'
        ? req.body.office_id || null
        : req.user.officeId;

    try {
      const hash = await bcrypt.hash(password, 12);
      const [r] = await pool.execute(
        `INSERT INTO backoffice_users
           (email, password, name, approved, role, office_id)
         VALUES (?, ?, ?, ?, 'office', ?)`,
        [email, hash, name, approved === false ? 'N' : 'Y', officeId]
      );
      broadcast({ type: 'users.updated' });
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'That email is already in use' });
      }
      next(e);
    }
  });

  /** Reset someone's password. */
  router.post('/users/:id/password', auth, async (req, res, next) => {
    const { password } = req.body || {};
    if (!password || password.length < 6) {
      return res
        .status(400)
        .json({ error: 'Password must be at least 6 characters' });
    }
    try {
      const [[target]] = await pool.query(
        'SELECT office_id, role FROM backoffice_users WHERE id = ?',
        [req.params.id]
      );
      if (!target) return res.status(404).json({ error: 'No such user' });

      // Stop an office user resetting the password of anyone outside their
      // office — including the platform admin.
      if (
        req.user.role !== 'admin' &&
        target.office_id !== req.user.officeId
      ) {
        return res.status(403).json({ error: 'Not your office' });
      }

      const hash = await bcrypt.hash(password, 12);
      await pool.execute('UPDATE backoffice_users SET password = ? WHERE id = ?', [
        hash,
        req.params.id,
      ]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/users/:id', auth, async (req, res, next) => {
    try {
      const [[target]] = await pool.query(
        'SELECT office_id, role FROM backoffice_users WHERE id = ?',
        [req.params.id]
      );
      if (!target) return res.status(404).json({ error: 'No such user' });

      if (Number(req.params.id) === Number(req.user.sub)) {
        return res.status(400).json({ error: 'You cannot delete yourself' });
      }
      if (target.role === 'admin') {
        return res
          .status(403)
          .json({ error: 'The platform administrator cannot be deleted' });
      }
      if (req.user.role !== 'admin' && target.office_id !== req.user.officeId) {
        return res.status(403).json({ error: 'Not your office' });
      }

      await pool.execute('DELETE FROM backoffice_users WHERE id = ?', [
        req.params.id,
      ]);
      broadcast({ type: 'users.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- Live trading -------------------------------------------------------

  /** Today's takings, for the dashboard. */
  router.get('/live', auth, async (_req, res, next) => {
    try {
      const [[totals]] = await pool.query(
        `SELECT COUNT(*) AS orders,
                COALESCE(SUM(total_minor), 0) AS gross_minor,
                COALESCE(SUM(tax_minor), 0)   AS tax_minor
         FROM epos_orders
         WHERE DATE(closed_at) = CURDATE()`
      );
      const [recent] = await pool.query(
        `SELECT id, table_number, total_minor, closed_at
         FROM epos_orders
         WHERE closed_at IS NOT NULL
         ORDER BY closed_at DESC LIMIT 12`
      );
      const [byTender] = await pool.query(
        `SELECT p.method AS label, SUM(p.amount_minor) AS amount_minor
         FROM epos_payments p
         JOIN epos_orders o ON o.id = p.order_id
         WHERE DATE(o.closed_at) = CURDATE()
         GROUP BY p.method
         ORDER BY amount_minor DESC`
      );
      const [byDept] = await pool.query(
        `SELECT COALESCE(pr.department_name, 'Other') AS label,
                SUM(l.unit_price_minor * l.quantity)  AS amount_minor
         FROM epos_order_lines l
         JOIN epos_orders o  ON o.id = l.order_id
         LEFT JOIN bo_products pr ON pr.pluid = l.plu_id
         WHERE DATE(o.closed_at) = CURDATE()
         GROUP BY label
         ORDER BY amount_minor DESC`
      );

      res.json({ ...totals, recent, by_tender: byTender, by_department: byDept });
    } catch (e) {
      next(e);
    }
  });

  /** The report breakdowns. Not time-boxed to today — this is the history. */
  router.get('/reports', auth, async (_req, res, next) => {
    try {
      const bucket = (labelExpr, joinProducts) => `
        SELECT ${labelExpr} AS label,
               SUM(l.unit_price_minor * l.quantity) AS amount_minor
        FROM epos_order_lines l
        JOIN epos_orders o ON o.id = l.order_id
        ${joinProducts ? 'LEFT JOIN bo_products pr ON pr.pluid = l.plu_id' : ''}
        WHERE o.closed_at IS NOT NULL
        GROUP BY label
        ORDER BY amount_minor DESC
        LIMIT 12`;

      const [groups] = await pool.query(
        bucket("COALESCE(pr.group_name, 'Ungrouped')", true)
      );
      const [departments] = await pool.query(
        bucket("COALESCE(pr.department_name, 'Other')", true)
      );
      const [plu] = await pool.query(bucket('l.name', false));

      const [clerks] = await pool.query(
        `SELECT COALESCE(c.clark_name, CONCAT('PIN ', o.clerk_pin), 'Unassigned') AS label,
                SUM(o.total_minor) AS amount_minor
         FROM epos_orders o
         LEFT JOIN bo_clarks c ON c.pin_code = o.clerk_pin
         WHERE o.closed_at IS NOT NULL
         GROUP BY label
         ORDER BY amount_minor DESC
         LIMIT 12`
      );

      res.json({ groups, departments, plu, clerks });
    } catch (e) {
      next(e);
    }
  });

  // ---- Customers ----------------------------------------------------------

  router.get('/customers', auth, async (req, res, next) => {
    try {
      const email = scope(req, await tenantEmail(req));
      const q = req.query.q ? `%${req.query.q}%` : null;
      const [rows] = await pool.query(
        `SELECT id, name, phone, email, card_number, discount_type,
                discount_value, points_balance,
                DATE_FORMAT(membership_expiry, '%Y-%m-%d') AS membership_expiry
         FROM epos_customers
         WHERE email_key = ?
         ${q ? 'AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)' : ''}
         ORDER BY name
         LIMIT 200`,
        q ? [email, q, q, q] : [email]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.post('/customers', auth, async (req, res, next) => {
    const c = req.body || {};
    if (!c.name) return res.status(400).json({ error: 'A name is required' });
    try {
      const { randomUUID } = require('crypto');
      const id = c.id || randomUUID();
      await pool.execute(
        `INSERT INTO epos_customers
           (id, email_key, name, phone, email, card_number,
            discount_type, discount_value, points_balance,
            membership_expiry, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          await tenantEmail(req),
          c.name,
          c.phone ?? null,
          c.email ?? null,
          c.card_number ?? null,
          c.discount_type ?? 'none',
          c.discount_value ?? 0,
          c.points_balance ?? 0,
          c.membership_expiry || null,
          c.notes ?? null,
        ]
      );
      broadcast({ type: 'customers.updated' });
      res.status(201).json({ id });
    } catch (e) {
      next(e);
    }
  });

  router.put('/customers/:id', auth, async (req, res, next) => {
    const c = req.body || {};
    try {
      const [r] = await pool.execute(
        `UPDATE epos_customers
         SET name = ?, phone = ?, email = ?, card_number = ?,
             discount_type = ?, discount_value = ?, points_balance = ?,
             membership_expiry = ?, notes = ?
         WHERE id = ? AND email_key = ?`,
        [
          c.name,
          c.phone ?? null,
          c.email ?? null,
          c.card_number ?? null,
          c.discount_type ?? 'none',
          c.discount_value ?? 0,
          c.points_balance ?? 0,
          c.membership_expiry || null,
          c.notes ?? null,
          req.params.id,
          await tenantEmail(req),
        ]
      );
      if (r.affectedRows === 0) {
        return res.status(404).json({ error: 'No such customer' });
      }
      broadcast({ type: 'customers.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/customers/:id', auth, async (req, res, next) => {
    try {
      const [r] = await pool.execute(
        'DELETE FROM epos_customers WHERE id = ? AND email_key = ?',
        [req.params.id, await tenantEmail(req)]
      );
      if (r.affectedRows === 0) {
        return res.status(404).json({ error: 'No such customer' });
      }
      broadcast({ type: 'customers.updated' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /** Void log — who voided what, why, and for how much. */
  router.get('/voids', auth, async (req, res, next) => {
    try {
      const email = scope(req, await tenantEmail(req));
      const [rows] = await pool.query(
        `SELECT v.id, v.order_id, v.reason, v.items, v.scope, v.amount_minor,
                v.voided_at,
                COALESCE(c.clark_name, v.clerk_pin, '—') AS clerk
         FROM epos_void_log v
         LEFT JOIN bo_clarks c
           ON c.pin_code = v.clerk_pin AND c.email = v.email
         WHERE v.email = ?
         ORDER BY v.voided_at DESC
         LIMIT 200`,
        [email]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * One full order — header, lines and tenders — for the receipt viewer and
   * PDF in Sales Explorer / Bill Report. Scoped to the tenant so a manager
   * cannot pull another office's receipt by guessing an id; the platform admin
   * may read any.
   */
  router.get('/receipts/:id', auth, async (req, res, next) => {
    try {
      const email = await tenantEmail(req);
      const [[order]] = await pool.query(
        `SELECT * FROM epos_orders
         WHERE id = ? AND (email = ? OR ? = 'admin')`,
        [req.params.id, email, req.user.role]
      );
      if (!order) return res.status(404).json({ error: 'No such receipt' });

      const [lines] = await pool.query(
        `SELECT name, quantity, unit_price_minor, tax_percentage, note,
                is_modifier
         FROM epos_order_lines WHERE order_id = ? ORDER BY line_no`,
        [req.params.id]
      );
      const [payments] = await pool.query(
        `SELECT method, amount_minor, taken_at
         FROM epos_payments WHERE order_id = ?`,
        [req.params.id]
      );
      res.json({ order, lines, payments });
    } catch (e) {
      next(e);
    }
  });

  /** Sales history. */
  router.get('/sales', auth, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT id, table_number, tax_minor, total_minor, closed_at
         FROM epos_orders
         WHERE closed_at IS NOT NULL
         ORDER BY closed_at DESC
         LIMIT 100`
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { backofficeRoutes };
