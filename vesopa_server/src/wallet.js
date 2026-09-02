const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('./auth');
const G = require('./wallet_google');
// Only ever asked whether this deployment can sign a `.pkpass`, so that a
// customer on an iPhone is not offered a Google button and nothing else — or,
// worse, refused a card because Google is the half that is broken.
const A = require('./wallet_apple');
const { wantsApple } = require('./wallet_apple_service');
const { ensureMemberNumber } = require('./member_numbers');

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
    // Apple's half. Two more colours, because Apple takes three and works none
    // of them out, and its own switch — a venue can be live on one platform and
    // not the other, and one flag for both would mean a Google outage turning
    // off cards that work. See schema_wallet_apple.sql.
    hex_foreground: '',
    hex_label: '',
    apple_enabled: 1,
    // The venue's own word in the public enrolment URL. Null until one is
    // chosen or generated — never '', because the unique index that stops two
    // venues sharing a code counts '' as a value and NULL as an absence. See
    // schema_wallet_join_code.sql.
    join_slug: null,
    // Where the venue is, so Apple can offer the card on the lock screen as
    // somebody walks in. Null rather than 0 — 0,0 is a real place in the
    // Atlantic. See schema_wallet_venue.sql.
    latitude: null,
    longitude: null,
    // What the venue writes on the back of the card, and the photograph behind
    // the strip. All nullable, and null rather than '' so that "this venue has
    // not answered" stays distinguishable from "this venue answered with
    // nothing" — the pass drops an empty field either way, but the back office
    // shows a placeholder for the first and the venue's own blank for the
    // second. See schema_wallet_copy.sql.
    earning_text: null,
    redeeming_text: null,
    tier_text: null,
    scanfail_text: null,
    expiry_text: null,
    address_text: null,
    hours_text: null,
    photo_url: null,
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

  // ---- The sign-up code ---------------------------------------------------
  //
  // The word in /wallet/join/<here>. One per venue, unique across the estate,
  // and the venue administrator's to change.

  // Deliberately not the whole alphabet. No vowels, so a generated code cannot
  // spell anything unfortunate in English or Welsh; no 0/O/1/I/l, which are the
  // pairs people get wrong reading a poster aloud or typing it from across a
  // table.
  const SLUG_ALPHABET = 'bcdfghjkmnpqrstvwxyz23456789';

  /** A venue's code must survive being read aloud, written down and typed back. */
  const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

  // Words a venue must not be able to claim, because the enrolment URLs sit in
  // the same path space as the rest of the site and a venue calling itself
  // "api" would shadow it.
  const SLUG_RESERVED = new Set([
    'api', 'admin', 'assets', 'join', 'wallet', 'apple-wallet', 'till', 'www',
    'static', 'public', 'login', 'signin', 'signout', 'help', 'support',
  ]);

  /**
   * Turn a venue's name into a code a human would have chosen.
   *
   * "The Vesopa Kitchen" becomes `vesopa-kitchen`: leading articles dropped,
   * because every second venue is called The Something and a wall of codes all
   * beginning "the-" is no easier to tell apart than a wall of email addresses.
   */
  function slugFromName(name) {
    const base = String(name || '')
      .toLowerCase()
      .replace(/^(the|a|an)\s+/, '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '');
    return SLUG_SHAPE.test(base) && !SLUG_RESERVED.has(base) ? base : '';
  }

  /** Six characters from the reduced alphabet. */
  function randomSlug() {
    const bytes = crypto.randomBytes(6);
    let out = '';
    for (const b of bytes) out += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
    return out;
  }

  /**
   * The code this venue's poster should carry, generating one if it has none.
   *
   * Tries the venue's own name first and falls back to random characters, then
   * keeps trying with a suffix until the insert is accepted. The uniqueness is
   * decided by the database, not by the SELECT above it: two venues saving
   * their settings in the same second would both read "free" and one would
   * overwrite the other, and the unique index is the only thing that cannot be
   * raced.
   */
  async function ensureJoinSlug(office, brand) {
    if (brand.join_slug) return brand.join_slug;

    const seed = slugFromName(brand.issuer_name) || randomSlug();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = attempt === 0 ? seed : `${seed}-${randomSlug().slice(0, 3)}`;
      try {
        await pool.execute(
          `INSERT INTO epos_wallet_settings (office, join_slug) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE join_slug = COALESCE(join_slug, VALUES(join_slug))`,
          [office, candidate]
        );
        const [[row]] = await pool.query(
          'SELECT join_slug FROM epos_wallet_settings WHERE office = ?',
          [office]
        );
        if (row && row.join_slug) return row.join_slug;
      } catch (e) {
        // ER_DUP_ENTRY: somebody else holds it. Any other error is real.
        if (e.code !== 'ER_DUP_ENTRY') throw e;
      }
    }
    return null;
  }

  // ---- Programmes ---------------------------------------------------------
  //
  // One venue runs up to five, and a venue reasonably wants its gift card to
  // look nothing like its staff pass. epos_wallet_programs holds the
  // differences; everything it leaves NULL falls back to the venue's own
  // branding, so a venue that has never opened the screen still has five
  // programmes that look like its brand.

  /**
   * The design for one programme: the venue's branding with the programme's
   * own overrides laid on top.
   *
   * Returns the same shape `readBrand` does, so everything downstream --
   * buildPassJson, the Google class builder, the preview -- takes one kind of
   * object and does not need to know a programme even exists.
   */
  async function readProgramBrand(office, kind, brand) {
    const base = brand || (await readBrand(office));
    let row = null;
    try {
      const [[found]] = await pool.query(
        'SELECT * FROM epos_wallet_programs WHERE office = ? AND kind = ?',
        [office, kind]
      );
      row = found || null;
    } catch {
      // The migration may not have run. A programme with no overrides is
      // exactly what the venue's own branding already describes.
      row = null;
    }
    if (!row) return { ...base, kind };

    const merged = { ...base, kind };
    // Only a value the venue actually set overrides the default. '' is a
    // cleared field and means "inherit", the same as NULL -- otherwise
    // emptying a box would paint the card black rather than restoring it.
    for (const field of [
      'program_name', 'hex_background', 'hex_foreground', 'hex_label',
      'strip_url', 'terms', 'change_message',
    ]) {
      const value = row[field];
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        merged[field] = value;
      }
    }
    merged.program_code = row.code || null;
    return merged;
  }

  /** Every programme for a venue, designs resolved, for the back office. */
  async function readPrograms(office) {
    const brand = await readBrand(office);
    const out = [];
    for (const kind of Object.keys(G.PASS_TYPES)) {
      const design = await readProgramBrand(office, kind, brand);
      out.push({
        kind,
        label: G.PASS_TYPES[kind].label,
        apple_type: G.PASS_TYPES[kind].appleType,
        enabled: Number(brand[`${kind}_enabled`]) ? 1 : 0,
        code: design.program_code || (await ensureProgramCode(office, kind, brand)),
        program_name: design.program_name || '',
        hex_background: design.hex_background || '',
        hex_foreground: design.hex_foreground || '',
        hex_label: design.hex_label || '',
        strip_url: design.strip_url || '',
        terms: design.terms || '',
        change_message: design.change_message || '',
      });
    }
    return out;
  }

  /**
   * The programme's own code, generated on first ask.
   *
   * Shaped `<venue>-<programme>` so it reads as what it is on a poster --
   * `vesopa-kitchen-giftcard` -- and falls back to random characters for a
   * venue with no usable name. Uniqueness is settled by the index, not by the
   * SELECT above it, for the same reason the venue's own code is.
   */
  async function ensureProgramCode(office, kind, brand) {
    try {
      const [[row]] = await pool.query(
        'SELECT code FROM epos_wallet_programs WHERE office = ? AND kind = ?',
        [office, kind]
      );
      if (row && row.code) return row.code;

      const base = brand || (await readBrand(office));
      const venue = base.join_slug || slugFromName(base.issuer_name) || randomSlug();
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const candidate = attempt === 0
          ? `${venue}-${kind}`
          : `${venue}-${kind}-${randomSlug().slice(0, 3)}`;
        try {
          await pool.execute(
            `INSERT INTO epos_wallet_programs (office, kind, code) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE code = COALESCE(code, VALUES(code))`,
            [office, kind, candidate]
          );
          const [[saved]] = await pool.query(
            'SELECT code FROM epos_wallet_programs WHERE office = ? AND kind = ?',
            [office, kind]
          );
          if (saved && saved.code) return saved.code;
        } catch (e) {
          if (e.code !== 'ER_DUP_ENTRY') throw e;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** The office and kind a programme code belongs to, or null. */
  async function programForCode(code) {
    try {
      const [[row]] = await pool.query(
        'SELECT office, kind FROM epos_wallet_programs WHERE code = ?',
        [String(code || '').trim().toLowerCase()]
      );
      return row || null;
    } catch {
      return null;
    }
  }

  /**
   * Which office a code in the URL belongs to.
   *
   * The code first, then the office's own email — which is what every link
   * printed before codes existed carries, and those table cards are already on
   * tables. They keep working for as long as the venue's email does.
   */
  async function officeForHandle(handle) {
    const value = String(handle || '').trim();
    if (!value) return '';
    const [[row]] = await pool.query(
      'SELECT office FROM epos_wallet_settings WHERE join_slug = ?',
      [value.toLowerCase()]
    );
    return row ? row.office : value;
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

  /**
   * The last few points movements, for the back of the card.
   *
   * A balance with no explanation behind it is the single most common thing a
   * customer asks a member of staff about, and the member of staff cannot see
   * it either without going to a screen. Putting the ledger on the back of the
   * pass answers it before it is asked.
   *
   * Six rows: enough to cover a normal month of visits, few enough that the
   * back of the pass stays readable on a phone. Missing table or column means
   * no history rather than no pass -- epos_loyalty_txns arrived with
   * schema_commerce.sql and a database that predates it must still issue cards.
   */
  async function pointsHistory(office, customerId, limit = 6) {
    try {
      const [rows] = await pool.query(
        `SELECT kind, points, balance_after, spend_minor, created_at
           FROM epos_loyalty_txns
          WHERE office = ? AND customer_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
        [office, String(customerId), limit]
      );
      return rows.map((r) => ({
        kind: r.kind,
        points: Number(r.points || 0),
        balance_after: Number(r.balance_after || 0),
        spend_minor: Number(r.spend_minor || 0),
        at: r.created_at ? new Date(r.created_at).toISOString() : '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * The two numbers that make a points balance mean something.
   *
   * Returned as part of the subject rather than looked up again by the pass
   * builder, because the builder has no pool — it is handed everything it needs
   * and does no I/O, which is what makes it testable without a database.
   *
   * Zeroes when a venue has no loyalty settings row. The pass drops the field
   * rather than showing "0 to go", which would read as an achievement.
   */
  async function rewardRules(office) {
    try {
      const [[row]] = await pool.query(
        `SELECT min_redeem_points, point_value_minor, points_per_pound
           FROM epos_loyalty_settings WHERE office = ?`,
        [office]
      );
      if (!row) return { reward_floor: 0, point_value_minor: 0, points_per_pound: 0 };
      return {
        reward_floor: Number(row.min_redeem_points) || 0,
        point_value_minor: Number(row.point_value_minor) || 0,
        points_per_pound: Number(row.points_per_pound) || 0,
      };
    } catch {
      return { reward_floor: 0, point_value_minor: 0, points_per_pound: 0 };
    }
  }

  /**
   * A gift card's movements, and what was loaded onto it in total.
   *
   * `loaded` is the sum of the issues and reloads rather than the current
   * balance: "£25.50 of £50.00 loaded" tells a holder how much of the card they
   * have spent, which the balance alone cannot.
   *
   * Twelve rows is what fits on the back of a card before it becomes a
   * statement. The full ledger lives on /wallet/balance/:token, which can
   * scroll.
   */
  async function giftMovements(office, cardId) {
    try {
      const [rows] = await pool.query(
        `SELECT kind, amount_minor, balance_after, created_at
           FROM epos_gift_card_txns
          WHERE gift_card_id = ? AND office = ?
          ORDER BY created_at DESC
          LIMIT 12`,
        [cardId, office]
      );
      const [[totals]] = await pool.query(
        `SELECT COALESCE(SUM(amount_minor), 0) AS loaded
           FROM epos_gift_card_txns
          WHERE gift_card_id = ? AND office = ?
            AND kind IN ('issue', 'reload')`,
        [cardId, office]
      );
      return {
        movements: rows || [],
        loaded_minor: Number(totals && totals.loaded) || 0,
      };
    } catch {
      // A venue whose gift cards predate the ledger still gets a working card.
      return { movements: [], loaded_minor: 0 };
    }
  }

  /**
   * "Mon–Fri, 5–7pm", from a day mask and a happy-hour window.
   *
   * The mask is seven characters with Monday first, which is the format the
   * till already reads — so this is a rendering of something the venue has
   * already told us rather than a new thing to configure.
   *
   * Runs of consecutive days collapse to a range, because "Mon, Tue, Wed, Thu,
   * Fri" is five words for a thing everybody calls weekdays. All seven says
   * "Every day" and is then usually dropped by the caller, since an offer with
   * no restriction does not need a line saying so.
   */
  function whenLine(mask, startTime, endTime) {
    const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const bits = String(mask || '1111111').padEnd(7, '0').slice(0, 7);

    let days = '';
    if (bits === '1111111') days = 'Every day';
    else if (bits === '1111100') days = 'Mon–Fri';
    else if (bits === '0000011') days = 'Weekends';
    else {
      // Collapse consecutive runs: 1110001 becomes "Mon–Wed, Sun".
      const parts = [];
      let run = -1;
      for (let i = 0; i <= 7; i++) {
        const on = i < 7 && bits[i] === '1';
        if (on && run === -1) run = i;
        if (!on && run !== -1) {
          const last = i - 1;
          parts.push(
            last - run >= 2 ? `${NAMES[run]}–${NAMES[last]}`
              : last === run ? NAMES[run]
                : `${NAMES[run]}, ${NAMES[last]}`
          );
          run = -1;
        }
      }
      days = parts.join(', ');
    }

    const window = [clockTime(startTime), clockTime(endTime)].filter(Boolean).join('–');
    return [days, window].filter(Boolean).join(', ');
  }

  /** `17:00:00` as `5pm`, or `5.30pm`. A card has no room for seconds. */
  function clockTime(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const suffix = hour < 12 ? 'am' : 'pm';
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return minute ? `${twelve}.${String(minute).padStart(2, '0')}${suffix}` : `${twelve}${suffix}`;
  }

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
        history: await pointsHistory(office, c.id),
        // What the points are *for*. `min_redeem_points` and `point_value_minor`
        // are the two numbers that turn a balance into a sentence a customer can
        // act on — "forty more and you can spend them" rather than "you have
        // 260 points" — and both have been in epos_loyalty_settings since
        // loyalty existed. The card had no way to reach them until now.
        ...(await rewardRules(office)),
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
        // What has happened to the card, and what was put on it. The balance on
        // the front answers "how much is left"; this is the answer to "where did
        // it go", which is the question somebody asks when the number is lower
        // than they expected and the only alternative is ringing the venue.
        ...(await giftMovements(office, g.id)),
      };
    }

    if (kind === 'promo') {
      const [[p]] = await pool.query(
        `SELECT id, name, kind, value, badge_text, ends_on, active,
                days_of_week, start_time, end_time
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
        // When the offer is actually on. `days_of_week` is a 7-character mask
        // with Monday first, and the two times are a happy-hour window — all
        // three have been on epos_promotions since promotions existed, and the
        // card had no way to say "Mon–Fri, 5–7pm" without them.
        when: whenLine(p.days_of_week, p.start_time, p.end_time),
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
    // Pure, and exported so the day-mask collapsing can be tested without a
    // database. "1110001" reading as "Mon–Wed, Sun" is the sort of thing that
    // is either right or quietly nonsense on somebody's card.
    whenLine,
    // The sign-up code's rules, so the route that validates a typed one and
    // the core that generates one cannot drift apart on what a code may be.
    SLUG_SHAPE,
    SLUG_RESERVED,
    ensureJoinSlug,
    officeForHandle,
    readProgramBrand,
    readPrograms,
    ensureProgramCode,
    programForCode,
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
  const {
    config, client, BRAND_FIELDS, readBrand, mint,
    SLUG_SHAPE, SLUG_RESERVED, ensureJoinSlug,
  } = core || walletCore({ pool, secret });

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
      const office = await tenantEmail(req);
      const brand = await readBrand(office);
      // Generated on first read rather than at signup, so a venue that
      // predates sign-up codes gets one the moment somebody opens the screen
      // -- and so the poster never shows an email address waiting for
      // somebody to notice a blank field.
      if (!brand.join_slug) brand.join_slug = await ensureJoinSlug(office, brand);
      res.json(brand);
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

      // The sign-up code. Lower-cased on the way in rather than rejected for
      // case: a manager typing their venue's name into this box means the same
      // thing whichever way they capitalise it, and URLs do not.
      const slug = String(next_.join_slug || '').trim().toLowerCase();
      if (slug) {
        if (!SLUG_SHAPE.test(slug)) {
          return res.status(400).json({
            error: 'A sign-up code is 3 to 64 characters: letters, numbers and hyphens, '
              + 'starting and ending with a letter or number.',
          });
        }
        if (SLUG_RESERVED.has(slug)) {
          return res.status(400).json({ error: `"${slug}" is reserved and cannot be used as a sign-up code` });
        }
        const [[taken]] = await pool.query(
          'SELECT office FROM epos_wallet_settings WHERE join_slug = ? AND office <> ?',
          [slug, office]
        );
        if (taken) {
          return res.status(409).json({ error: `The sign-up code "${slug}" is already taken by another venue` });
        }
      }
      // '' would be a value the unique index enforces; absence has to be NULL.
      next_.join_slug = slug || null;

      // Coordinates, if the venue has pasted them out of a maps app. Blank
      // clears them; anything outside the real range is a typo, and a card
      // that offers itself on the lock screen in the wrong hemisphere is
      // worse than one that never offers itself at all.
      for (const [field, limit, name] of [['latitude', 90, 'Latitude'], ['longitude', 180, 'Longitude']]) {
        const raw = String(next_[field] ?? '').trim();
        if (raw === '') { next_[field] = null; continue; }
        const value = Number(raw);
        if (!Number.isFinite(value) || Math.abs(value) > limit) {
          return res.status(400).json({ error: `${name} must be a number between -${limit} and ${limit}` });
        }
        next_[field] = value;
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
        // Every text comparison here is forced to one collation on both sides.
        // The four tables genuinely disagree on the live database:
        // epos_wallet_passes.office and .subject_id are utf8mb4_general_ci,
        // epos_customers.id/.email_key and epos_promotions.office are
        // utf8mb4_uca1400_ai_ci (MariaDB 11.4's default for a bare utf8mb4),
        // and bo_clarks.email is utf8mb3. MariaDB will not compare two of
        // those without being told which collation to use: left alone it
        // raises ER_CANT_AGGREGATE_2COLLATIONS and this listing 500s for
        // every venue. It is raised when the statement is prepared, so an
        // empty table fails just as loudly as a full one.
        //
        // Collating in the query rather than converting the columns keeps a
        // live ALTER off tables the till writes to. epos_customers needs it on
        // `id` as well as on the office -- that column is CHAR(36) in the same
        // uca1400 collation. bo_clarks.id and epos_promotions.id are INT, so
        // those comparisons are numeric and need nothing.
        `SELECT p.*,
                CASE p.kind
                  WHEN 'staff' THEN (SELECT clark_name FROM bo_clarks WHERE id = p.subject_id
                                      AND CONVERT(email USING utf8mb4) COLLATE utf8mb4_general_ci
                                        = CONVERT(p.office USING utf8mb4) COLLATE utf8mb4_general_ci)
                  WHEN 'promo' THEN (SELECT name FROM epos_promotions WHERE id = p.subject_id
                                      AND CONVERT(office USING utf8mb4) COLLATE utf8mb4_general_ci
                                        = CONVERT(p.office USING utf8mb4) COLLATE utf8mb4_general_ci)
                  ELSE (SELECT name FROM epos_customers
                         WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_general_ci
                             = CONVERT(p.subject_id USING utf8mb4) COLLATE utf8mb4_general_ci
                           AND CONVERT(email_key USING utf8mb4) COLLATE utf8mb4_general_ci
                             = CONVERT(p.office USING utf8mb4) COLLATE utf8mb4_general_ci)
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
  const { mint, readBrand, officeForHandle } = core || walletCore({ pool, secret });

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
      // Google could not issue. Before showing an error, check whether the
      // other half can — a venue running Apple only would otherwise turn every
      // QR code it has ever printed into a dead end, including the ones on
      // receipts and table cards that predate Apple support entirely.
      //
      // Only for a device that can actually open a `.pkpass`, and that is not
      // caution: `/wallet/c/:token` sends everything non-Apple back here, so
      // redirecting an Android phone to it would bounce the two routes off each
      // other until the browser gave up.
      //
      // 404 is excluded on purpose: that is "no such customer", which no amount
      // of Apple configuration fixes.
      if (e.status !== 404 && wantsApple(req) && A.cachedConfig().configured) {
        return res.redirect(302, `/wallet/c/${encodeURIComponent(req.params.token)}`);
      }
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
      // `handle` is whatever the poster carries -- the venue's sign-up code, or
      // its email on a card printed before codes existed. The form posts back
      // to the same one, so a mistyped phone number does not turn the pretty
      // URL in the address bar into an email address.
      const handle = String(req.params.office);
      const office = await officeForHandle(handle);
      const brand = await readBrand(office);
      const offered = selfServePrograms(brand);
      if (!Number(brand.enabled) || !offered.length) {
        return res.status(404).type('html').send(page('Not available', 'This venue is not issuing cards.'));
      }
      res.type('html').send(joinPage(brand, handle, null, offered));
    } catch (e) {
      next(e);
    }
  });

  router.post('/wallet/join/:office', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const handle = String(req.params.office);
      const office = await officeForHandle(handle);
      const brand = await readBrand(office);
      const offered = selfServePrograms(brand);
      if (!Number(brand.enabled) || !offered.length) {
        return res.status(404).type('html').send(page('Not available', ''));
      }

      // The programme the customer picked, checked against what is actually
      // offered rather than trusted: this is a public form, and `kind` arriving
      // as "giftcard" must not mint one.
      const wanted = String(req.body.kind || '').trim();
      const kind = offered.some((p) => p.kind === wanted) ? wanted : offered[0].kind;

      const name = String(req.body.name || '').trim();
      const phone = String(req.body.phone || '').replace(/\s+/g, '');
      if (!name || !/^\+?\d{7,15}$/.test(phone)) {
        return res
          .status(400)
          .type('html')
          .send(joinPage(brand, handle, 'Please enter your name and a valid phone number.', offered));
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

      // Their member number, which the card is about to show. Allocated here
      // rather than when a piece of plastic is issued, because most of these
      // people will never hold one — they scanned a poster — and "Member VK ·
      // 0241" is what they read out on the phone either way.
      await ensureMemberNumber(pool, office, id);

      // Google is minted best-effort, and its failure is not this customer's
      // problem.
      //
      // This threw once, on a live venue with Apple configured and Google not.
      // `mint` raises a 503, `next(e)` hands it to the global error handler,
      // and that answers `res.json({error})` — so an iPhone customer who filled
      // in the form was handed a **.json file to download**. Their account had
      // already been created two statements earlier, so scanning again gave
      // them the same file, forever.
      //
      // The lesson is not "catch this error". It is that the two platforms must
      // fail independently: a customer holding an iPhone is not served by a
      // Google outage, an unconfigured Google project or an expired service
      // account, and neither is a customer holding an Android when the Wallet
      // certificates are missing. So each half is attempted, each is allowed to
      // fail, and the page below offers whichever ones actually worked.
      let googleReady = false;
      try {
        await mint(office, kind, id);
        googleReady = true;
      } catch (e) {
        // Named in the log, because a venue with Google silently off for a
        // month is a venue losing every Android sign-up.
        console.error(
          `[wallet] Google pass not minted for ${office}/${kind}: ${e.message}`
        );
      }

      // Apple needs no minting — a `.pkpass` is built on demand — so the
      // question is only whether this deployment can sign one at all.
      const appleReady = A.cachedConfig().configured &&
        Number(brand.apple_enabled ?? 1) === 1;

      if (!googleReady && !appleReady) {
        // Neither platform can issue. The customer is still enrolled and their
        // card exists at the till, which is worth saying — they have not wasted
        // the scan, and staff can look them up by the phone number they just
        // typed.
        return res
          .status(200)
          .type('html')
          .send(
            page(
              'You’re signed up',
              'Your card could not be added to this phone just now. ' +
                'Show your phone number at the till and it will be found.'
            )
          );
      }

      // Both badges, on one page, rather than a redirect to Google.
      //
      // The customer is holding a phone we cannot see. `/wallet/c/:token`
      // does sniff the user agent and would usually get it right, but "usually"
      // here means a customer on an iPhone landing in Google Wallet, and the
      // fix for that is a page with two buttons on it rather than a cleverer
      // guess.
      //
      // A badge is only shown when the platform behind it can actually deliver.
      // An "Add to Google Wallet" button that leads to an error page is worse
      // than no button: the customer believes the venue's card is broken rather
      // than that their phone is the wrong one.
      const token = jwt.sign(
        { scope: 'wallet', office, kind, sub: String(id) },
        secret,
        { expiresIn: '365d' }
      );
      res.type('html').send(
        addPage(brand, token, { apple: appleReady, google: googleReady })
      );
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
<meta name="theme-color" content="#111111">
<link rel="icon" href="/assets/favicon.png">
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
/**
 * The programmes a customer can sign themselves up for.
 *
 * Loyalty and membership only. The other three are issued *to* somebody by the
 * venue and must never be self-serve: a gift card carries a balance somebody
 * paid for, a staff pass opens a till, and an offer is the venue's to hand out.
 * A public form that minted any of the three would be a way to help yourself.
 */
const SELF_SERVE_KINDS = ['loyalty', 'customer'];

function selfServePrograms(brand) {
  return SELF_SERVE_KINDS
    .filter((kind) => Number(brand[`${kind}_enabled`]))
    .map((kind) => ({
      kind,
      label: kind === 'loyalty' ? 'Points card' : 'Membership',
      hint: kind === 'loyalty'
        ? 'Collect points on what you spend'
        : 'Your membership and any standing discount',
    }));
}

/**
 * The head every customer-facing wallet page shares.
 *
 * WHY THIS EXISTS
 *
 * These links get shared -- pasted into WhatsApp, texted between staff,
 * dropped in a group chat by the customer who just joined. Without Open Graph
 * tags that share renders as a bare URL: no name, no logo, nothing that says
 * which venue it belongs to. With them it renders as the venue's card.
 *
 * The image has to be an absolute https:// URL. Every scraper that reads these
 * -- iMessage, WhatsApp, Slack, Facebook -- fetches it from the open internet
 * with no session and no relative-path resolution, so a path like
 * `/assets/logo.png` silently produces a preview with a blank square, which is
 * indistinguishable from having no tag at all.
 */
function socialHead({ title, description, brand, url }) {
  const base = String(process.env.BACKOFFICE_URL || '').replace(/\/+$/, '');
  const absolute = (value) => {
    const v = String(value || '').trim();
    if (/^https:\/\//i.test(v)) return v;
    if (!v || !base) return '';
    return `${base}/${v.replace(/^\/+/, '')}`;
  };

  // The venue's own logo when it has one, and Vesopa's mark when it does not.
  // A preview with the wrong logo would be worse; a preview with no logo is
  // just a link again.
  const image = absolute(brand.logo_url) || absolute('/assets/wallet/logo@2x.png');
  const themeColour = /^#[0-9a-f]{6}$/i.test(brand.hex_background || '')
    ? brand.hex_background
    : '#111111';

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="${escapeHtml(themeColour)}">
<link rel="icon" href="${escapeHtml(absolute('/assets/favicon.png'))}">
<link rel="apple-touch-icon" href="${escapeHtml(image)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(brand.issuer_name || 'Vesopa')}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}
${url ? `<meta property="og:url" content="${escapeHtml(absolute(url))}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
${image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : ''}`;
}

function joinPage(brand, office, error, offered = []) {
  const name = escapeHtml(brand.issuer_name || 'Loyalty');
  const programme = escapeHtml(brand.program_name || 'Rewards');
  const colour = /^#[0-9a-f]{6}$/i.test(brand.hex_background || '')
    ? brand.hex_background
    : '#0f5132';
  const logo = /^https:\/\//i.test(brand.logo_url || '') ? brand.logo_url : '';
  return `<!doctype html>
${socialHead({
    title: `${brand.program_name || 'Rewards'} — ${brand.issuer_name || 'Join'}`,
    description: `Join at ${brand.issuer_name || 'our venue'} and keep your card in Apple Wallet or Google Wallet.`,
    brand,
    url: `/wallet/join/${office}`,
  })}
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
  form{width:min(24rem,100%);background:#121821;border:1px solid #1e2733;border-radius:16px;padding:24px}
  /* Contained, and not a circle. A venue's logo is as often a wide wordmark as
     a round badge, and cover-cropping inside a 72px circle reduces a wordmark
     to the two letters in the middle of it. */
  img{max-width:180px;max-height:72px;width:auto;height:auto;object-fit:contain;
      display:block;margin:0 auto 16px}
  h1{font-size:1.35rem;margin:0 0 .25rem;text-align:center}
  .sub{margin:0 0 20px;text-align:center;color:#9aa7b4;font-size:.95rem}
  label{display:block;font-size:.85rem;color:#9aa7b4;margin:14px 0 6px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #263244;
        background:#0b0f14;color:#e6edf3;font-size:16px}
  button{width:100%;margin-top:20px;padding:14px;border:0;border-radius:10px;background:${colour};
         color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  .err{margin:12px 0 0;color:#ff8f8f;font-size:.9rem}
  .pick{border:0;padding:0;margin:18px 0 0}
  .pick legend{font-size:.85rem;color:#9aa7b4;padding:0;margin-bottom:8px}
  .pick-one{display:flex;gap:10px;align-items:flex-start;padding:11px 12px;margin-bottom:8px;
            border:1px solid #263244;border-radius:10px;cursor:pointer}
  .pick-one input{margin:2px 0 0;width:auto;accent-color:${colour}}
  .pick-one span{display:block;font-size:.92rem}
  .pick-one em{display:block;font-style:normal;color:#9aa7b4;font-size:.8rem;margin-top:1px}
  .pick-one:has(input:checked){border-color:${colour};background:rgba(255,255,255,.03)}
  .fine{margin:16px 0 0;color:#6b7889;font-size:.78rem;text-align:center}
</style>
<form method="post" action="/wallet/join/${encodeURIComponent(office)}">
  ${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ''}
  <h1>${programme}</h1>
  <p class="sub">Join at ${name} and add your card to your phone.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  ${offered.length > 1 ? `
  <fieldset class="pick">
    <legend>What would you like?</legend>
    ${offered.map((p, i) => `
    <label class="pick-one">
      <input type="radio" name="kind" value="${escapeHtml(p.kind)}"${i === 0 ? ' checked' : ''}>
      <span><strong>${escapeHtml(p.label)}</strong><em>${escapeHtml(p.hint)}</em></span>
    </label>`).join('')}
  </fieldset>` : offered.length === 1
    ? `<input type="hidden" name="kind" value="${escapeHtml(offered[0].kind)}">`
    : ''}
  <label for="name">Your name</label>
  <input id="name" name="name" autocomplete="name" required>
  <label for="phone">Mobile number</label>
  <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required>
  <button type="submit">Get my card</button>
  <p class="fine">We use your number to find your points at the till. Nothing else.</p>
</form>`;
}

/**
 * The two wallet badges, as inline SVG.
 *
 * Apple's and Google's own artwork, drawn into the page rather than linked.
 * This page is served to a phone standing in a venue, often on wifi that is
 * captive or slow, and an <img> that fails to load leaves an unlabelled gap
 * where the only two buttons on the page should be. Inline SVG cannot fail
 * separately from the document that carries it.
 *
 * Both are the dark variant, on the dark card this page already uses, and both
 * keep the wording and proportions their owners require -- these are
 * trademarks, and "Add to Apple Wallet" / "Add to Google Wallet" is the whole
 * of what either is licensed to say.
 */
function appleWalletBadge() {
  return `<svg viewBox="0 0 199 55" role="img" aria-label="Add to Apple Wallet" focusable="false">
  <rect x=".5" y=".5" width="198" height="54" rx="9" fill="#000" stroke="#3c3c3c"/>
  <g transform="translate(20 15)">
    <rect x="0" y="0" width="30" height="4.5" rx="1.6" fill="#ea4b3b"/>
    <rect x="0" y="4" width="30" height="4.5" rx="1.6" fill="#f5a623"/>
    <rect x="0" y="8" width="30" height="4.5" rx="1.6" fill="#4cb050"/>
    <rect x="0" y="11" width="30" height="14" rx="3" fill="#e8e6e1"/>
    <path d="M9 11h5.5a2.6 2.6 0 0 0 5 0H25" fill="none" stroke="#c9c6bf" stroke-width="1.4"/>
  </g>
  <text x="62" y="25" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,sans-serif" font-size="13">Add to</text>
  <text x="62" y="43" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,sans-serif" font-size="20" font-weight="500">Apple Wallet</text>
</svg>`;
}

function googleWalletBadge() {
  return `<svg viewBox="0 0 199 55" role="img" aria-label="Add to Google Wallet" focusable="false">
<rect x="0.5" y="0.5" width="198" height="54" rx="27" fill="#1F1F1F"/>
<path d="M57 23.791H21V18.1456C21 15.0809 23.6422 12.5001 26.7798 12.5001H51.2202C54.3578 12.5001 57 15.0809 57 18.1456V23.791Z" fill="#34A853"/>
<path d="M57 29H21V23C21 19.7429 23.6422 17 26.7798 17H51.2202C54.3578 17 57 19.7429 57 23V29Z" fill="#FBBC04"/>
<path d="M57 34H21V28C21 24.7429 23.6422 22 26.7798 22H51.2202C54.3578 22 57 24.7429 57 28V34Z" fill="#EA4335"/>
<path d="M21 25.2409L43.8493 30.4025C46.4795 31.0477 49.4384 30.4025 51.5753 28.7895L57 24.9183V37.0157C57 40.0804 54.3699 42.4999 51.2466 42.4999H26.7534C23.6301 42.4999 21 40.0804 21 37.0157V25.2409Z" fill="url(#vesopa_gwallet)"/>
<path d="M69.195 21.5L72.705 12.192H74.33L77.853 21.5H76.28L75.422 19.108H71.626L70.768 21.5H69.195ZM73.134 14.935L72.107 17.782H74.941L73.914 14.935L73.563 13.869H73.485L73.134 14.935ZM81.5143 21.708C80.9163 21.708 80.3747 21.5607 79.8893 21.266C79.4127 20.9627 79.0313 20.5467 78.7453 20.018C78.468 19.4807 78.3293 18.8697 78.3293 18.185C78.3293 17.5003 78.468 16.8937 78.7453 16.365C79.0313 15.8363 79.4127 15.4203 79.8893 15.117C80.3747 14.8137 80.9163 14.662 81.5143 14.662C82.0257 14.662 82.4633 14.7747 82.8273 15C83.2 15.2253 83.473 15.481 83.6463 15.767H83.7243L83.6463 14.844V12.192H85.0373V21.5H83.7243V20.616H83.6463C83.473 20.902 83.2 21.1577 82.8273 21.383C82.4633 21.5997 82.0257 21.708 81.5143 21.708ZM81.7223 20.421C82.069 20.421 82.394 20.33 82.6973 20.148C83.0093 19.966 83.2563 19.7103 83.4383 19.381C83.629 19.043 83.7243 18.6443 83.7243 18.185C83.7243 17.7257 83.629 17.3313 83.4383 17.002C83.2563 16.664 83.0093 16.404 82.6973 16.222C82.394 16.04 82.069 15.949 81.7223 15.949C81.3757 15.949 81.0507 16.04 80.7473 16.222C80.444 16.404 80.197 16.664 80.0063 17.002C79.8157 17.3313 79.7203 17.7257 79.7203 18.185C79.7203 18.6443 79.8157 19.043 80.0063 19.381C80.197 19.7103 80.444 19.966 80.7473 20.148C81.0507 20.33 81.3757 20.421 81.7223 20.421ZM89.4616 21.708C88.8636 21.708 88.3219 21.5607 87.8366 21.266C87.3599 20.9627 86.9786 20.5467 86.6926 20.018C86.4153 19.4807 86.2766 18.8697 86.2766 18.185C86.2766 17.5003 86.4153 16.8937 86.6926 16.365C86.9786 15.8363 87.3599 15.4203 87.8366 15.117C88.3219 14.8137 88.8636 14.662 89.4616 14.662C89.9729 14.662 90.4106 14.7747 90.7746 15C91.1473 15.2253 91.4203 15.481 91.5936 15.767H91.6716L91.5936 14.844V12.192H92.9846V21.5H91.6716V20.616H91.5936C91.4203 20.902 91.1473 21.1577 90.7746 21.383C90.4106 21.5997 89.9729 21.708 89.4616 21.708ZM89.6696 20.421C90.0163 20.421 90.3413 20.33 90.6446 20.148C90.9566 19.966 91.2036 19.7103 91.3856 19.381C91.5763 19.043 91.6716 18.6443 91.6716 18.185C91.6716 17.7257 91.5763 17.3313 91.3856 17.002C91.2036 16.664 90.9566 16.404 90.6446 16.222C90.3413 16.04 90.0163 15.949 89.6696 15.949C89.3229 15.949 88.9979 16.04 88.6946 16.222C88.3913 16.404 88.1443 16.664 87.9536 17.002C87.7629 17.3313 87.6676 17.7257 87.6676 18.185C87.6676 18.6443 87.7629 19.043 87.9536 19.381C88.1443 19.7103 88.3913 19.966 88.6946 20.148C88.9979 20.33 89.3229 20.421 89.6696 20.421ZM98.3745 19.576V16.092H97.2175V14.87H98.3745V12.998H99.7785V14.87H101.404V16.092H99.7785V19.277C99.7785 19.6063 99.8435 19.8577 99.9735 20.031C100.112 20.2043 100.342 20.291 100.663 20.291C100.827 20.291 100.966 20.2693 101.079 20.226C101.2 20.1827 101.321 20.122 101.443 20.044V21.409C101.295 21.4697 101.139 21.5173 100.975 21.552C100.81 21.5867 100.615 21.604 100.39 21.604C99.7742 21.604 99.2845 21.4263 98.9205 21.071C98.5565 20.707 98.3745 20.2087 98.3745 19.576ZM105.617 21.708C104.932 21.708 104.33 21.552 103.81 21.24C103.29 20.928 102.882 20.5077 102.588 19.979C102.293 19.4503 102.146 18.8523 102.146 18.185C102.146 17.5263 102.293 16.9327 102.588 16.404C102.882 15.8667 103.29 15.442 103.81 15.13C104.33 14.818 104.932 14.662 105.617 14.662C106.293 14.662 106.891 14.818 107.411 15.13C107.931 15.442 108.338 15.8667 108.633 16.404C108.927 16.9327 109.075 17.5263 109.075 18.185C109.075 18.8523 108.927 19.4503 108.633 19.979C108.338 20.5077 107.931 20.928 107.411 21.24C106.891 21.552 106.293 21.708 105.617 21.708ZM105.617 20.421C105.981 20.421 106.319 20.3343 106.631 20.161C106.943 19.979 107.194 19.7233 107.385 19.394C107.584 19.056 107.684 18.653 107.684 18.185C107.684 17.717 107.584 17.3183 107.385 16.989C107.194 16.651 106.943 16.3953 106.631 16.222C106.319 16.04 105.981 15.949 105.617 15.949C105.253 15.949 104.91 16.04 104.59 16.222C104.278 16.3953 104.022 16.651 103.823 16.989C103.632 17.3183 103.537 17.717 103.537 18.185C103.537 18.653 103.632 19.056 103.823 19.394C104.022 19.7233 104.278 19.979 104.59 20.161C104.91 20.3343 105.253 20.421 105.617 20.421Z" fill="white"/>
<path d="M76.14 41.772C75.2673 41.772 74.4457 41.6133 73.675 41.296C72.9157 40.9787 72.2413 40.5367 71.652 39.97C71.0627 39.392 70.598 38.7177 70.258 37.947C69.9293 37.165 69.765 36.3207 69.765 35.414C69.765 34.5073 69.9293 33.6687 70.258 32.898C70.598 32.116 71.057 31.4417 71.635 30.875C72.2243 30.297 72.9043 29.8493 73.675 29.532C74.4457 29.2147 75.2673 29.056 76.14 29.056C77.0693 29.056 77.925 29.2203 78.707 29.549C79.5003 29.8777 80.1633 30.3367 80.696 30.926L79.404 32.201C79.0073 31.759 78.5313 31.419 77.976 31.181C77.432 30.943 76.82 30.824 76.14 30.824C75.3353 30.824 74.593 31.0167 73.913 31.402C73.233 31.776 72.6833 32.3087 72.264 33C71.856 33.68 71.652 34.4847 71.652 35.414C71.652 36.3433 71.8617 37.1537 72.281 37.845C72.7003 38.525 73.25 39.0577 73.93 39.443C74.61 39.817 75.3523 40.004 76.157 40.004C76.8937 40.004 77.5623 39.868 78.163 39.596C78.7637 39.3127 79.2453 38.916 79.608 38.406C79.982 37.896 80.2087 37.284 80.288 36.57H76.123V34.921H82.039C82.107 35.227 82.141 35.55 82.141 35.89V35.907C82.141 37.0857 81.8803 38.117 81.359 39.001C80.849 39.8737 80.1407 40.5537 79.234 41.041C78.3273 41.5283 77.296 41.772 76.14 41.772ZM87.6149 41.772C86.7195 41.772 85.9319 41.568 85.2519 41.16C84.5719 40.752 84.0392 40.2023 83.6539 39.511C83.2685 38.8197 83.0759 38.0377 83.0759 37.165C83.0759 36.3037 83.2685 35.5273 83.6539 34.836C84.0392 34.1333 84.5719 33.578 85.2519 33.17C85.9319 32.762 86.7195 32.558 87.6149 32.558C88.4989 32.558 89.2809 32.762 89.9609 33.17C90.6409 33.578 91.1735 34.1333 91.5589 34.836C91.9442 35.5273 92.1369 36.3037 92.1369 37.165C92.1369 38.0377 91.9442 38.8197 91.5589 39.511C91.1735 40.2023 90.6409 40.752 89.9609 41.16C89.2809 41.568 88.4989 41.772 87.6149 41.772ZM87.6149 40.089C88.0909 40.089 88.5329 39.9757 88.9409 39.749C89.3489 39.511 89.6775 39.1767 89.9269 38.746C90.1875 38.304 90.3179 37.777 90.3179 37.165C90.3179 36.553 90.1875 36.0317 89.9269 35.601C89.6775 35.159 89.3489 34.8247 88.9409 34.598C88.5329 34.36 88.0909 34.241 87.6149 34.241C87.1389 34.241 86.6912 34.36 86.2719 34.598C85.8639 34.8247 85.5295 35.159 85.2689 35.601C85.0195 36.0317 84.8949 36.553 84.8949 37.165C84.8949 37.777 85.0195 38.304 85.2689 38.746C85.5295 39.1767 85.8639 39.511 86.2719 39.749C86.6912 39.9757 87.1389 40.089 87.6149 40.089ZM97.9078 41.772C97.0125 41.772 96.2248 41.568 95.5448 41.16C94.8648 40.752 94.3322 40.2023 93.9468 39.511C93.5615 38.8197 93.3688 38.0377 93.3688 37.165C93.3688 36.3037 93.5615 35.5273 93.9468 34.836C94.3322 34.1333 94.8648 33.578 95.5448 33.17C96.2248 32.762 97.0125 32.558 97.9078 32.558C98.7918 32.558 99.5738 32.762 100.254 33.17C100.934 33.578 101.467 34.1333 101.852 34.836C102.237 35.5273 102.43 36.3037 102.43 37.165C102.43 38.0377 102.237 38.8197 101.852 39.511C101.467 40.2023 100.934 40.752 100.254 41.16C99.5738 41.568 98.7918 41.772 97.9078 41.772ZM97.9078 40.089C98.3838 40.089 98.8258 39.9757 99.2338 39.749C99.6418 39.511 99.9705 39.1767 100.22 38.746C100.481 38.304 100.611 37.777 100.611 37.165C100.611 36.553 100.481 36.0317 100.22 35.601C99.9705 35.159 99.6418 34.8247 99.2338 34.598C98.8258 34.36 98.3838 34.241 97.9078 34.241C97.4318 34.241 96.9842 34.36 96.5648 34.598C96.1568 34.8247 95.8225 35.159 95.5618 35.601C95.3125 36.0317 95.1878 36.553 95.1878 37.165C95.1878 37.777 95.3125 38.304 95.5618 38.746C95.8225 39.1767 96.1568 39.511 96.5648 39.749C96.9842 39.9757 97.4318 40.089 97.9078 40.089ZM108.031 45.444C107.271 45.444 106.614 45.3193 106.059 45.07C105.515 44.832 105.073 44.5203 104.733 44.135C104.393 43.761 104.149 43.3757 104.002 42.979L105.702 42.265C105.883 42.7183 106.172 43.0867 106.569 43.37C106.977 43.6647 107.464 43.812 108.031 43.812C108.824 43.812 109.447 43.574 109.901 43.098C110.365 42.622 110.598 41.9477 110.598 41.075V40.242H110.496C110.224 40.65 109.844 40.9787 109.357 41.228C108.881 41.466 108.337 41.585 107.725 41.585C106.988 41.585 106.314 41.398 105.702 41.024C105.09 40.65 104.597 40.1287 104.223 39.46C103.849 38.78 103.662 37.9867 103.662 37.08C103.662 36.162 103.849 35.3687 104.223 34.7C104.597 34.02 105.09 33.493 105.702 33.119C106.314 32.745 106.988 32.558 107.725 32.558C108.337 32.558 108.881 32.6827 109.357 32.932C109.844 33.1813 110.224 33.51 110.496 33.918H110.598V32.83H112.349V41.041C112.349 41.9817 112.162 42.7807 111.788 43.438C111.425 44.0953 110.921 44.594 110.275 44.934C109.629 45.274 108.881 45.444 108.031 45.444ZM108.048 39.919C108.501 39.919 108.92 39.8113 109.306 39.596C109.691 39.3693 110.003 39.0463 110.241 38.627C110.479 38.1963 110.598 37.6807 110.598 37.08C110.598 36.4567 110.479 35.9353 110.241 35.516C110.003 35.0853 109.691 34.7623 109.306 34.547C108.92 34.3317 108.501 34.224 108.048 34.224C107.594 34.224 107.169 34.3373 106.773 34.564C106.387 34.7793 106.076 35.0967 105.838 35.516C105.6 35.9353 105.481 36.4567 105.481 37.08C105.481 37.692 105.6 38.2133 105.838 38.644C106.076 39.0633 106.387 39.3807 106.773 39.596C107.169 39.8113 107.594 39.919 108.048 39.919ZM114.514 41.5V29.328H116.35V41.5H114.514ZM122.392 41.772C121.542 41.772 120.783 41.5737 120.114 41.177C119.446 40.7803 118.919 40.2363 118.533 39.545C118.159 38.8537 117.972 38.066 117.972 37.182C117.972 36.3547 118.154 35.5897 118.516 34.887C118.879 34.1843 119.383 33.6233 120.029 33.204C120.687 32.7733 121.44 32.558 122.29 32.558C123.186 32.558 123.945 32.7507 124.568 33.136C125.203 33.5213 125.685 34.0483 126.013 34.717C126.342 35.3857 126.506 36.1393 126.506 36.978C126.506 37.1027 126.501 37.216 126.489 37.318C126.489 37.42 126.484 37.4993 126.472 37.556H119.774C119.865 38.4173 120.165 39.0633 120.675 39.494C121.197 39.9247 121.786 40.14 122.443 40.14C123.033 40.14 123.52 40.0097 123.905 39.749C124.291 39.477 124.597 39.1427 124.823 38.746L126.336 39.477C125.962 40.157 125.452 40.7123 124.806 41.143C124.16 41.5623 123.356 41.772 122.392 41.772ZM122.307 34.122C121.695 34.122 121.174 34.309 120.743 34.683C120.313 35.057 120.024 35.5557 119.876 36.179H124.687C124.665 35.8843 124.568 35.5783 124.398 35.261C124.228 34.9437 123.968 34.6773 123.616 34.462C123.276 34.2353 122.84 34.122 122.307 34.122ZM133.979 41.5L130.715 29.328H132.789L134.727 37.233L134.931 38.287H135.033L135.288 37.233L137.736 29.328H139.606L141.952 37.233L142.207 38.27H142.309L142.513 37.233L144.451 29.328H146.508L143.295 41.5H141.323L138.994 33.425L138.722 32.286H138.62L138.331 33.425L135.9 41.5H133.979ZM149.922 41.772C149.299 41.772 148.743 41.653 148.256 41.415C147.769 41.1657 147.389 40.82 147.117 40.378C146.845 39.936 146.709 39.4317 146.709 38.865C146.709 38.253 146.868 37.7317 147.185 37.301C147.514 36.859 147.95 36.5247 148.494 36.298C149.038 36.0713 149.639 35.958 150.296 35.958C150.84 35.958 151.316 36.009 151.724 36.111C152.143 36.213 152.461 36.3207 152.676 36.434V35.975C152.676 35.4083 152.472 34.955 152.064 34.615C151.656 34.275 151.129 34.105 150.483 34.105C150.041 34.105 149.622 34.207 149.225 34.411C148.828 34.6037 148.511 34.87 148.273 35.21L147.015 34.241C147.389 33.7197 147.882 33.3117 148.494 33.017C149.117 32.711 149.797 32.558 150.534 32.558C151.792 32.558 152.761 32.8697 153.441 33.493C154.121 34.105 154.461 34.9663 154.461 36.077V41.5H152.676V40.429H152.574C152.347 40.7803 152.007 41.092 151.554 41.364C151.101 41.636 150.557 41.772 149.922 41.772ZM150.245 40.276C150.721 40.276 151.14 40.1627 151.503 39.936C151.866 39.7093 152.149 39.4147 152.353 39.052C152.568 38.678 152.676 38.2757 152.676 37.845C152.415 37.6977 152.109 37.5787 151.758 37.488C151.407 37.386 151.033 37.335 150.636 37.335C149.888 37.335 149.355 37.488 149.038 37.794C148.721 38.0887 148.562 38.4513 148.562 38.882C148.562 39.29 148.715 39.6243 149.021 39.885C149.327 40.1457 149.735 40.276 150.245 40.276ZM156.499 41.5V29.328H158.335V41.5H156.499ZM160.517 41.5V29.328H162.353V41.5H160.517ZM168.395 41.772C167.545 41.772 166.786 41.5737 166.117 41.177C165.449 40.7803 164.922 40.2363 164.536 39.545C164.162 38.8537 163.975 38.066 163.975 37.182C163.975 36.3547 164.157 35.5897 164.519 34.887C164.882 34.1843 165.386 33.6233 166.032 33.204C166.69 32.7733 167.443 32.558 168.293 32.558C169.189 32.558 169.948 32.7507 170.571 33.136C171.206 33.5213 171.688 34.0483 172.016 34.717C172.345 35.3857 172.509 36.1393 172.509 36.978C172.509 37.1027 172.504 37.216 172.492 37.318C172.492 37.42 172.487 37.4993 172.475 37.556H165.777C165.868 38.4173 166.168 39.0633 166.678 39.494C167.2 39.9247 167.789 40.14 168.446 40.14C169.036 40.14 169.523 40.0097 169.908 39.749C170.294 39.477 170.6 39.1427 170.826 38.746L172.339 39.477C171.965 40.157 171.455 40.7123 170.809 41.143C170.163 41.5623 169.359 41.772 168.395 41.772ZM168.31 34.122C167.698 34.122 167.177 34.309 166.746 34.683C166.316 35.057 166.027 35.5557 165.879 36.179H170.69C170.668 35.8843 170.571 35.5783 170.401 35.261C170.231 34.9437 169.971 34.6773 169.619 34.462C169.279 34.2353 168.843 34.122 168.31 34.122ZM174.882 38.984V34.428H173.369V32.83H174.882V30.382H176.718V32.83H178.843V34.428H176.718V38.593C176.718 39.0237 176.803 39.3523 176.973 39.579C177.154 39.8057 177.454 39.919 177.874 39.919C178.089 39.919 178.27 39.8907 178.418 39.834C178.576 39.7773 178.735 39.698 178.894 39.596V41.381C178.701 41.4603 178.497 41.5227 178.282 41.568C178.066 41.6133 177.811 41.636 177.517 41.636C176.712 41.636 176.072 41.4037 175.596 40.939C175.12 40.463 174.882 39.8113 174.882 38.984Z" fill="white"/>
<!-- fill="none" is not in Google's exported artwork and has to be: an SVG rect
     with no fill paints solid black by default, and this one is drawn last, so
     without it the border ring covers the entire badge. -->
<rect x="0.5" y="0.5" width="198" height="54" rx="27" fill="none" stroke="#747775"/>
<defs>
<linearGradient id="vesopa_gwallet" x1="37.2843" y1="34.0448" x2="18.7823" y2="55.7227" gradientUnits="userSpaceOnUse">
<stop stop-color="#4285F4"/>
<stop offset="1" stop-color="#1B74E8"/>
</linearGradient>
</defs>
</svg>`;
}

/**
 * "You're in" -- the page a customer lands on after joining.
 *
 * Both badges, always, rather than sniffing the user agent and showing one.
 * `/wallet/c/:token` does sniff, and is right nearly always; the times it is
 * wrong are an iPhone being handed a Google Wallet page, in a venue, with a
 * member of staff watching. Two buttons costs one tap and cannot be wrong.
 *
 * The venue's name is deliberately not in the sentence: half of them begin
 * with "The", and "Add your The Crown card" is what that produces.
 */
function addPage(brand, token, available = { apple: true, google: true }) {
  const logo = /^https:\/\//i.test(brand.logo_url || '') ? brand.logo_url : '';
  return `<!doctype html>
${socialHead({
    title: `Your ${brand.issuer_name || ''} card`.replace(/\s+/g, ' ').trim(),
    description: 'Add it to Apple Wallet or Google Wallet.',
    brand,
  })}
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#e6edf3;
       font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
  .card{width:min(24rem,100%);background:#121821;border:1px solid #1e2733;border-radius:16px;
        padding:24px;text-align:center}
  .logo{max-width:180px;max-height:64px;width:auto;height:auto;object-fit:contain;
        display:block;margin:0 auto 16px}
  h1{font-size:1.35rem;margin:0 0 .25rem}
  p{margin:0 0 20px;color:#9aa7b4;font-size:.95rem}
  a{display:block;margin-top:12px;text-decoration:none}
  a svg{display:block;width:100%;height:auto;max-width:15rem;margin:0 auto}
  .fine{margin:18px 0 0;color:#6b7889;font-size:.78rem}
</style>
<div class="card">
  ${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="">` : ''}
  <h1>You're in</h1>
  <p>Add your card to your phone.</p>
  ${available.apple ? `<a href="/wallet/c/${encodeURIComponent(token)}">${appleWalletBadge()}</a>` : ''}
  ${available.google ? `<a href="/wallet/s/${encodeURIComponent(token)}">${googleWalletBadge()}</a>` : ''}
  <p class="fine">Show the card at the till to collect points.</p>
</div>`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

module.exports = { walletCore, walletRoutes, walletPublicRoutes };
