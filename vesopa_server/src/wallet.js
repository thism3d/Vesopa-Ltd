const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('./auth');
const G = require('./wallet_google');

/**
 * Google Wallet passes: the back-office routes that configure and mint them,
 * and the public routes a QR code points at.
 *
 * Four passes, all built on the same two steps — register a class at Google
 * once, then create one object per person and hand out a signed link to it:
 *
 *   loyalty   the points card. Carries the balance and the tier, and updates
 *             in the customer's phone whenever the till moves either.
 *   customer  a membership card for a customer who is not on the points
 *             scheme — a standing discount, an account, a trade card.
 *   staff     a staff ID. Same barcode the swipe card carries, so a member of
 *             staff who left their card at home can still be identified.
 *   promo     an offer. Ends when the promotion ends.
 *
 * Nothing here fails hard when Wallet is unconfigured. An office with no
 * credentials gets a readable 503 from the wallet routes and a back office that
 * otherwise behaves exactly as before.
 */
function walletCore({ pool, secret }) {
  const config = G.readConfig();
  const client = config.configured ? G.makeClient(config) : null;

  const BRAND_DEFAULTS = {
    enabled: 0,
    program_name: '',
    issuer_name: '',
    logo_url: '',
    hero_url: '',
    hex_background: '',
    homepage_url: '',
    support_phone: '',
    terms: '',
    loyalty_enabled: 1,
    customer_enabled: 0,
    giftcard_enabled: 0,
    staff_enabled: 0,
    promo_enabled: 0,
  };
  const BRAND_FIELDS = Object.keys(BRAND_DEFAULTS);

  /**
   * The office's pass branding, falling back to its receipt branding.
   *
   * A venue that has already uploaded a logo and typed its name for receipts
   * should not have to do it again to get a wallet card, so epos_branding fills
   * in anything epos_wallet_settings leaves blank. The wallet row still wins
   * where it is set — the two are wanted at different sizes often enough that
   * overriding has to be possible.
   */
  async function readBrand(office) {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_wallet_settings WHERE office = ?',
      [office]
    );
    const [[receipt]] = await pool.query(
      'SELECT venue_name, logo_url, website, phone FROM epos_branding WHERE office = ?',
      [office]
    );
    const brand = { office, ...BRAND_DEFAULTS, ...(row || {}) };
    if (!brand.issuer_name) brand.issuer_name = receipt?.venue_name || '';
    if (!brand.program_name) {
      brand.program_name = brand.issuer_name ? `${brand.issuer_name} Rewards` : '';
    }
    if (!brand.logo_url) brand.logo_url = absolute(receipt?.logo_url) || '';
    if (!brand.homepage_url) brand.homepage_url = receipt?.website || '';
    if (!brand.support_phone) brand.support_phone = receipt?.phone || '';
    return brand;
  }

  /**
   * Google fetches pass artwork from the open internet with no credentials, so
   * a relative path or a localhost URL produces a card with a blank circle
   * where the logo should be and no error anywhere. Anything that is not an
   * absolute https:// URL is dropped rather than sent and silently ignored.
   */
  function absolute(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (/^https:\/\//i.test(value)) return value;
    const base = String(process.env.BACKOFFICE_URL || '').replace(/\/+$/, '');
    if (!base || !/^https:\/\//i.test(base)) return '';
    return `${base}/${value.replace(/^\/+/, '')}`;
  }

  /**
   * Does this column exist yet?
   *
   * Two of the fields a pass would like to show — `epos_customers.member_no`
   * and `bo_clarks.swipe_card` — are added by schema_cards.sql, a migration
   * that may not have run on a given database. A pass is worth issuing without
   * them, so they are probed rather than assumed, and the answer is cached: the
   * alternative is an information_schema hit on every card minted.
   *
   * Cached for the life of the process, which means a server that was running
   * when the migration was applied keeps saying no until it restarts. Deploys
   * restart it, so this costs nothing in practice and saves a query per mint.
   */
  const columnCache = new Map();
  async function hasColumn(table, column) {
    const key = `${table}.${column}`;
    if (columnCache.has(key)) return columnCache.get(key);
    let present = false;
    try {
      const [[row]] = await pool.query(
        `SELECT 1 AS present FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );
      present = Boolean(row);
    } catch {
      present = false;
    }
    columnCache.set(key, present);
    return present;
  }

  // ---- Subjects -----------------------------------------------------------
  //
  // What each kind of pass is *about*, normalised to the one shape buildPass
  // expects. The three source tables have three different id types and three
  // different notions of a name, which is exactly why this lives in one place.

  async function loadSubject(office, kind, subjectId) {
    if (kind === 'loyalty' || kind === 'customer') {
      const memberNo = (await hasColumn('epos_customers', 'member_no'))
        ? ', member_no'
        : '';
      const [[c]] = await pool.query(
        `SELECT id, name, phone, card_number, points_balance, tier_name,
                discount_type, discount_value, created_at${memberNo}
         FROM epos_customers WHERE id = ? AND email_key = ?`,
        [subjectId, office]
      );
      if (!c) return null;
      const discount =
        c.discount_type === 'percent'
          ? `${c.discount_value}% off`
          : c.discount_type === 'amount'
            ? `£${(c.discount_value / 100).toFixed(2)} off`
            : '';
      return {
        id: c.id,
        name: c.name,
        phone: c.phone || '',
        // The swipe card's number is the card number when there is one, so a
        // phone and a piece of plastic scan to the same customer.
        card_number: c.card_number || c.id,
        // The number a member quotes on the phone. Null for anyone who
        // predates card issuing, and left off the card rather than shown as a
        // blank field or invented on the spot.
        member_no: c.member_no == null ? '' : String(c.member_no),
        points: c.points_balance || 0,
        tier: c.tier_name || '',
        discount,
        member_since: c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '',
      };
    }

    if (kind === 'staff') {
      // bo_clarks predates both apps and is shared with vesopa_web's admin
      // panel; `clark_name` is its spelling, not a typo here.
      const [[s]] = await pool.query(
        `SELECT id, clark_name, pin_code, COALESCE(active, 1) AS active
         FROM bo_clarks WHERE id = ? AND email = ?`,
        [subjectId, office]
      );
      if (!s) return null;
      // The PIN is never put on the card. It is a door code for the till and
      // printing it on something the member of staff carries in public defeats
      // the point of having one.
      return {
        id: String(s.id),
        name: s.clark_name,
        role: 'Staff',
        card_number: await staffCardNumber(office, s.id),
        state: Number(s.active) ? 'ACTIVE' : 'INACTIVE',
      };
    }

    if (kind === 'giftcard') {
      const [[g]] = await pool.query(
        `SELECT g.id, g.code, g.balance_minor, g.currency, g.expires_on, g.status,
                g.recipient_name, g.created_at, g.updated_at, c.name AS customer_name
           FROM epos_gift_cards g
           LEFT JOIN epos_customers c ON c.id = g.customer_id
          WHERE g.id = ? AND g.office = ?`,
        [subjectId, office]
      );
      if (!g) return null;
      const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
      return {
        id: String(g.id),
        // The code, not the uuid. It is what is printed on the plastic and
        // typed into the till, so it is what the barcode has to encode.
        card_number: g.code,
        name: g.recipient_name || g.customer_name || '',
        balance_minor: g.balance_minor,
        currency: g.currency || 'GBP',
        // Not `new Date()`: the balance is as of the last movement on the
        // card, and stamping it with "now" on every mint would tell the holder
        // their balance was checked this second when it was not.
        balance_at: g.updated_at ? new Date(g.updated_at).toISOString() : undefined,
        issued_on: day(g.created_at),
        expires_on: day(g.expires_on),
        // A spent or voided card stays in the wallet, greyed out, rather than
        // vanishing — the holder needs to see that it was theirs and is empty.
        state: g.status === 'active' ? 'ACTIVE' : 'EXPIRED',
      };
    }

    if (kind === 'promo') {
      const [[p]] = await pool.query(
        `SELECT id, name, kind, value, badge_text, ends_on, active
         FROM epos_promotions WHERE id = ? AND office = ?`,
        [subjectId, office]
      );
      if (!p) return null;
      return {
        id: String(p.id),
        title: p.badge_text || p.name,
        details: p.name,
        card_number: `PROMO${p.id}`,
        ends_on: p.ends_on ? new Date(p.ends_on).toISOString().slice(0, 10) : '',
        state: Number(p.active) ? 'ACTIVE' : 'INACTIVE',
      };
    }

    return null;
  }

  /**
   * A staff card's barcode.
   *
   * `bo_clarks.swipe_card` when there is one, so the wallet card and the piece
   * of plastic carry the same number and scan to the same person.
   *
   * The fallback is permanent, not a stopgap for an unrun migration: the column
   * is nullable by design, because a venue can have staff who were never handed
   * plastic and they should still get a pass on their phone.
   */
  async function staffCardNumber(office, id) {
    if (await hasColumn('bo_clarks', 'swipe_card')) {
      const [[row]] = await pool.query(
        'SELECT swipe_card FROM bo_clarks WHERE id = ? AND email = ?',
        [id, office]
      );
      if (row && row.swipe_card) return String(row.swipe_card);
    }
    return `STAFF${id}`;
  }

  // ---- Minting ------------------------------------------------------------

  /**
   * Builds, registers and records one pass, and returns its save link.
   *
   * The class is upserted on every mint rather than once at setup. It is one
   * extra call against a template that rarely changes, and it buys the property
   * that a merchant who edits their logo sees it on the next card issued
   * without anyone remembering to press a sync button.
   *
   * When Google cannot be reached the pass is still issued — the link falls
   * back to carrying the whole class and object inline, and Google creates them
   * when the customer taps it. The row is left `pending` so a later sync can
   * reconcile it.
   */
  async function mint(office, kind, subjectId) {
    if (!G.KINDS[kind]) throw new G.WalletError(`Unknown pass kind "${kind}"`, 400);
    if (!config.configured) {
      throw new G.WalletError(
        `Google Wallet is not configured: ${config.problems.join('; ')}`,
        503
      );
    }

    const brand = await readBrand(office);
    const subject = await loadSubject(office, kind, subjectId);
    if (!subject) throw new G.WalletError('No such customer, staff member or promotion', 404);

    const built = G.buildPass({ kind, config, office, brand, subject });
    let state = 'pending';
    let link;
    let lastError = null;

    try {
      await client.upsertClass(kind, built.klass);
      await client.upsertObject(kind, built.object);
      state = 'active';
      // Registered, so the link only has to name the object. This is what keeps
      // it comfortably under the length at which browsers start truncating.
      link = G.saveUrl({ config, kind, ids: [built.objectId] });
    } catch (e) {
      lastError = e.message.slice(0, 500);
      link = G.saveUrl({ config, kind, klass: built.klass, object: built.object });
    }

    const [[existing]] = await pool.query(
      'SELECT id FROM epos_wallet_passes WHERE office = ? AND kind = ? AND subject_id = ?',
      [office, kind, String(subjectId)]
    );
    const id = existing ? existing.id : crypto.randomUUID();

    await pool.execute(
      `INSERT INTO epos_wallet_passes
         (id, office, kind, subject_id, object_id, card_number, state, save_url,
          last_error, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         object_id = VALUES(object_id), card_number = VALUES(card_number),
         state = VALUES(state), save_url = VALUES(save_url),
         last_error = VALUES(last_error), synced_at = VALUES(synced_at)`,
      [
        id,
        office,
        kind,
        String(subjectId),
        built.objectId,
        String(subject.card_number || ''),
        state,
        link.url,
        lastError,
        state === 'active' ? new Date() : null,
      ]
    );

    await pool.execute(
      `INSERT INTO epos_wallet_classes (office, kind, class_id, review_status, last_error, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         class_id = VALUES(class_id), review_status = VALUES(review_status),
         last_error = VALUES(last_error), synced_at = VALUES(synced_at)`,
      [
        office,
        kind,
        built.classId,
        config.reviewStatus,
        lastError,
        state === 'active' ? new Date() : null,
      ]
    );

    return {
      id,
      kind,
      subject_id: String(subjectId),
      object_id: built.objectId,
      class_id: built.classId,
      card_number: subject.card_number || '',
      state,
      save_url: link.url,
      // Over the safe length the save link may be truncated by the browser, so
      // the back office can warn instead of handing out a link that dies on a
      // customer's phone.
      too_long: link.tooLong,
      qr_url: shortLink(office, kind, subjectId),
      warning: lastError,
    };
  }

  /**
   * The URL a printed QR code points at.
   *
   * A save link is a signed JWT and runs to a couple of thousand characters —
   * far past what a QR readable off a receipt can hold. So the QR carries a
   * short link on our own domain instead, and the server redirects. That also
   * means the pass is built when it is scanned: a loyalty QR printed on a
   * receipt in March still hands over a card with March's points on it.
   */
  function shortLink(office, kind, subjectId) {
    const token = jwt.sign(
      { scope: 'wallet', office, kind, sub: String(subjectId) },
      secret,
      { expiresIn: '365d' }
    );
    const base = String(process.env.BACKOFFICE_URL || '').replace(/\/+$/, '');
    return `${base}/wallet/s/${token}`;
  }

  return {
    config,
    client,
    BRAND_DEFAULTS,
    BRAND_FIELDS,
    readBrand,
    loadSubject,
    mint,
    shortLink,
  };
}

/**
 * The back-office routes. Mounted under /api behind a session.
 *
 * Takes the core rather than building one, so the public QR routes and these
 * share a single OAuth token cache and a single read of the environment.
 */
function walletRoutes({ pool, broadcast, secret, core }) {
  const router = express.Router();
  const auth = requireAuth(secret);
  const { config, client, BRAND_FIELDS, readBrand, mint } = core || walletCore({ pool, secret });

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

  /**
   * Is Wallet usable, and what is missing if not.
   *
   * Answers 200 even when nothing is configured — the back office needs to be
   * able to render the setup screen, and a 503 here would leave it with no way
   * to say what to fix.
   */
  router.get('/wallet/status', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const [classes] = await pool.query(
        'SELECT kind, class_id, review_status, last_error, synced_at FROM epos_wallet_classes WHERE office = ?',
        [office]
      );
      const [[counts]] = await pool.query(
        `SELECT COUNT(*) AS total,
                SUM(state = 'active') AS active,
                SUM(state = 'pending') AS pending
         FROM epos_wallet_passes WHERE office = ?`,
        [office]
      );
      const brand = await readBrand(office);
      res.json({
        configured: config.configured,
        problems: config.problems,
        issuer_id: config.issuerId || null,
        service_account: config.email || null,
        origins: config.origins,
        review_status: config.reviewStatus,
        // The two things a merchant most often has wrong, checked here so the
        // back office can say so before a card comes out blank.
        logo_public: /^https:\/\//i.test(brand.logo_url || ''),
        hero_public: !brand.hero_url || /^https:\/\//i.test(brand.hero_url),
        classes,
        counts: counts || { total: 0, active: 0, pending: 0 },
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/wallet/settings', auth, async (req, res, next) => {
    try {
      res.json(await readBrand(await tenantEmail(req)));
    } catch (e) {
      next(e);
    }
  });

  router.put('/wallet/settings', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const current = await readBrand(office);
      const next_ = { ...current };
      for (const field of BRAND_FIELDS) {
        if (req.body[field] !== undefined) next_[field] = req.body[field];
      }

      // An http:// or relative logo is not a typo to be preserved — Google will
      // never load it. Refused here rather than accepted and silently unused.
      for (const [field, label] of [['logo_url', 'Logo'], ['hero_url', 'Banner']]) {
        const url = String(next_[field] || '').trim();
        if (url && !/^https:\/\//i.test(url)) {
          return res.status(400).json({
            error: `${label} must be a public https:// address — Google fetches it directly and cannot sign in.`,
          });
        }
      }
      const hex = String(next_.hex_background || '').trim();
      if (hex && !/^#[0-9a-f]{6}$/i.test(hex)) {
        return res.status(400).json({ error: 'Card colour must be a hex value like #0f5132' });
      }

      const cols = BRAND_FIELDS;
      const placeholders = cols.map(() => '?').join(', ');
      await pool.execute(
        `INSERT INTO epos_wallet_settings (office, ${cols.map((c) => `\`${c}\``).join(', ')})
         VALUES (?, ${placeholders})
         ON DUPLICATE KEY UPDATE ${cols
           .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
           .join(', ')}`,
        [
          office,
          // The four *_enabled switches arrive from the browser as booleans and
          // from a scripted call as 0/1. MySQL takes the numbers; a JavaScript
          // boolean binds as the string "true".
          ...cols.map((c) =>
            typeof next_[c] === 'boolean' ? (next_[c] ? 1 : 0) : next_[c]
          ),
        ]
      );

      broadcast({ type: 'wallet.settings' });
      res.json(await readBrand(office));
    } catch (e) {
      next(e);
    }
  });

  /**
   * Pushes the class for one kind up to Google without issuing anybody a card.
   *
   * Wanted on its own because a class has to exist before publishing access can
   * be requested, and because it is the cheapest way to find out that the
   * service account has not been given permission on the issuer.
   */
  router.post('/wallet/classes/:kind/sync', auth, async (req, res, next) => {
    try {
      const kind = String(req.params.kind);
      if (!G.KINDS[kind]) return res.status(400).json({ error: 'Unknown pass kind' });
      if (!config.configured) {
        return res.status(503).json({ error: config.problems.join('; ') });
      }
      const office = await tenantEmail(req);
      const brand = await readBrand(office);
      const built = G.buildPass({ kind, config, office, brand, subject: { id: 'template' } });

      let review = config.reviewStatus;
      let error = null;
      try {
        const saved = await client.upsertClass(kind, built.klass);
        review = (saved && saved.reviewStatus) || review;
      } catch (e) {
        error = e.message.slice(0, 500);
      }

      await pool.execute(
        `INSERT INTO epos_wallet_classes (office, kind, class_id, review_status, last_error, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           class_id = VALUES(class_id), review_status = VALUES(review_status),
           last_error = VALUES(last_error), synced_at = VALUES(synced_at)`,
        [office, kind, built.classId, review, error, error ? null : new Date()]
      );

      if (error) return res.status(502).json({ error, class_id: built.classId });
      res.json({ class_id: built.classId, review_status: review });
    } catch (e) {
      next(e);
    }
  });

  /** Mints (or refreshes) a pass and returns the save link and the QR target. */
  router.post('/wallet/passes/:kind/:subjectId', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const result = await mint(office, String(req.params.kind), String(req.params.subjectId));
      broadcast({ type: 'wallet.pass' });
      res.json(result);
    } catch (e) {
      if (e instanceof G.WalletError) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  /** Every pass this office has issued. */
  router.get('/wallet/passes', auth, async (req, res, next) => {
    try {
      const office = await tenantEmail(req);
      const kind = String(req.query.kind || '').trim();
      const [rows] = await pool.query(
        `SELECT p.*,
                CASE p.kind
                  WHEN 'staff' THEN (SELECT clark_name FROM bo_clarks WHERE id = p.subject_id AND email = p.office)
                  WHEN 'promo' THEN (SELECT name FROM epos_promotions WHERE id = p.subject_id AND office = p.office)
                  ELSE (SELECT name FROM epos_customers WHERE id = p.subject_id AND email_key = p.office)
                END AS subject_name
         FROM epos_wallet_passes p
         WHERE p.office = ? ${kind ? 'AND p.kind = ?' : ''}
         ORDER BY p.updated_at DESC
         LIMIT 500`,
        kind ? [office, kind] : [office]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Proves the credentials work, end to end, against Google.
   *
   * Three separate failures wear the same face in the back office — a key that
   * will not parse, a key Google will not accept, and a service account with no
   * permission on the issuer — so each is checked and reported on its own. This
   * is the route to run first when passes are not appearing.
   */
  router.post('/wallet/diagnose', auth, async (req, res, next) => {
    try {
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

      add('Configuration present', config.configured, config.problems.join('; '));
      if (!config.configured) return res.json({ ok: false, checks });

      try {
        crypto.createPrivateKey(config.key);
        add('Signing key parses', true);
      } catch (e) {
        add('Signing key parses', false, e.message);
        return res.json({ ok: false, checks });
      }

      try {
        await client.accessToken();
        add('Google accepts the service account', true);
      } catch (e) {
        add('Google accepts the service account', false, e.message);
        return res.json({ ok: false, checks });
      }

      try {
        const list = await client.listClasses('loyalty', config.issuerId);
        const n = (list && list.resources && list.resources.length) || 0;
        add(
          'Service account has access to the issuer',
          true,
          `${n} loyalty class${n === 1 ? '' : 'es'} on issuer ${config.issuerId}`
        );
      } catch (e) {
        add(
          'Service account has access to the issuer',
          false,
          `${e.message} — add ${config.email} under Users in the Google Pay & Wallet Console for issuer ${config.issuerId}.`
        );
        return res.json({ ok: false, checks });
      }

      const office = await tenantEmail(req);
      const brand = await readBrand(office);
      add(
        'Logo is a public https address',
        /^https:\/\//i.test(brand.logo_url || ''),
        brand.logo_url || 'No logo set — Google requires a 1:1 image of at least 660x660.'
      );

      res.json({ ok: checks.every((c) => c.ok), checks });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/**
 * The routes a QR code lands on. Mounted outside /api and deliberately
 * unauthenticated — the whole point is that a customer with a camera and no
 * account can reach them.
 */
function walletPublicRoutes({ pool, secret, core }) {
  const router = express.Router();
  const { mint, readBrand } = core || walletCore({ pool, secret });

  /**
   * The QR target: verify the signed token, build the pass, redirect to Google.
   *
   * A 302 rather than a page with a button. The customer has already expressed
   * intent by scanning; Google's own save page is the confirmation step, and
   * putting another one in front of it loses people.
   */
  router.get('/wallet/s/:token', async (req, res) => {
    let claims;
    try {
      claims = jwt.verify(String(req.params.token), secret);
    } catch {
      return res.status(400).type('html').send(page('This code has expired', 'Ask a member of staff for a new one.'));
    }
    if (claims.scope !== 'wallet') {
      return res.status(400).type('html').send(page('This code is not a wallet link', ''));
    }

    try {
      const result = await mint(claims.office, claims.kind, claims.sub);
      res.redirect(302, result.save_url);
    } catch (e) {
      res
        .status(e.status === 404 ? 404 : 502)
        .type('html')
        .send(page('That card could not be issued', e.message));
    }
  });

  /**
   * Self-enrolment. The QR on a poster or a table card lands here.
   *
   * Asks for a phone number and a name and nothing else. Every extra field on
   * this form costs sign-ups, and the phone number is already the thing the
   * till looks a customer up by.
   */
  router.get('/wallet/join/:office', async (req, res, next) => {
    try {
      const office = String(req.params.office);
      const brand = await readBrand(office);
      if (!Number(brand.enabled) || !Number(brand.loyalty_enabled)) {
        return res.status(404).type('html').send(page('Not available', 'This venue is not issuing loyalty cards.'));
      }
      res.type('html').send(joinPage(brand, office, null));
    } catch (e) {
      next(e);
    }
  });

  router.post('/wallet/join/:office', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const office = String(req.params.office);
      const brand = await readBrand(office);
      if (!Number(brand.enabled) || !Number(brand.loyalty_enabled)) {
        return res.status(404).type('html').send(page('Not available', ''));
      }

      const name = String(req.body.name || '').trim();
      const phone = String(req.body.phone || '').replace(/\s+/g, '');
      if (!name || !/^\+?\d{7,15}$/.test(phone)) {
        return res
          .status(400)
          .type('html')
          .send(joinPage(brand, office, 'Please enter your name and a valid phone number.'));
      }

      // Scanning the poster twice must not create a second account — the
      // second scan hands back the card they already have, with their points
      // on it.
      const [[existing]] = await pool.query(
        `SELECT id FROM epos_customers
         WHERE email_key = ? AND REPLACE(phone, ' ', '') = ?`,
        [office, phone]
      );

      let id = existing?.id;
      if (!id) {
        id = crypto.randomUUID();
        await pool.execute(
          'INSERT INTO epos_customers (id, email_key, name, phone) VALUES (?, ?, ?, ?)',
          [id, office, name, phone]
        );
      }

      const result = await mint(office, 'loyalty', id);
      res.redirect(302, result.save_url);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/** A bare, self-contained message page. No assets, so it renders offline. */
function page(title, detail) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
  .card{max-width:24rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0;color:#9aa7b4}
</style>
<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail || '')}</p></div>`;
}

/** The self-enrolment form. Same constraints: one file, no external assets. */
function joinPage(brand, office, error) {
  const name = escapeHtml(brand.issuer_name || 'Loyalty');
  const programme = escapeHtml(brand.program_name || 'Rewards');
  const colour = /^#[0-9a-f]{6}$/i.test(brand.hex_background || '')
    ? brand.hex_background
    : '#0f5132';
  const logo = /^https:\/\//i.test(brand.logo_url || '') ? brand.logo_url : '';
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${programme}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
  form{width:min(24rem,100%);background:#121821;border:1px solid #1e2733;border-radius:16px;padding:24px}
  img{width:72px;height:72px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 16px}
  h1{font-size:1.35rem;margin:0 0 .25rem;text-align:center}
  .sub{margin:0 0 20px;text-align:center;color:#9aa7b4;font-size:.95rem}
  label{display:block;font-size:.85rem;color:#9aa7b4;margin:14px 0 6px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #263244;
        background:#0b0f14;color:#e6edf3;font-size:16px}
  button{width:100%;margin-top:20px;padding:14px;border:0;border-radius:10px;background:${colour};
         color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  .err{margin:12px 0 0;color:#ff8f8f;font-size:.9rem}
  .fine{margin:16px 0 0;color:#6b7889;font-size:.78rem;text-align:center}
</style>
<form method="post" action="/wallet/join/${encodeURIComponent(office)}">
  ${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ''}
  <h1>${programme}</h1>
  <p class="sub">Join at ${name} and add your card to Google Wallet.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <label for="name">Your name</label>
  <input id="name" name="name" autocomplete="name" required>
  <label for="phone">Mobile number</label>
  <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required>
  <button type="submit">Add to Google Wallet</button>
  <p class="fine">We use your number to find your points at the till. Nothing else.</p>
</form>`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

module.exports = { walletCore, walletRoutes, walletPublicRoutes };
