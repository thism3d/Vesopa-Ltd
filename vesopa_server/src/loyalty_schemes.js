/**
 * Loyalty schemes: groups of customers, each with its own rewards.
 *
 * "We need the ability to create and manage different Loyalty Schemes. When
 * creating a new customer on the till, it should ask which Loyalty Scheme the
 * customer wants to be part of." (Nicki, 2 October 2026, after their old
 * system, Newbridge.) The table is in schema/schema_loyalty_schemes.sql; this
 * file is the arithmetic every route shares, kept free of Express so it can be
 * tested without a server.
 *
 * A SCHEME OVERRIDES, IT DOES NOT REPLACE
 *
 * epos_loyalty_settings is still the venue's rules. A scheme sets what it sets
 * and inherits the rest, so a customer in no scheme, at a venue with no
 * schemes, is priced exactly as before. [applyScheme] is that merge.
 *
 * THE MEMBERSHIP NUMBER
 *
 * "When a loyalty card is scanned, can we ignore the 9998 prefix when
 * assigning/displaying the member number? If the card number is 999800001,
 * the customer's membership number should be shown as 00001." The prefix says
 * what kind of card it is; the rest is who holds it. [memberNumber] is the one
 * place that turns a customer into the number people read.
 */

const REWARD_TYPES = ['none', 'percent', 'amount', 'price_level'];

/** A department list as stored: a JSON array of names, or null for all. */
function parseList(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};

const hhmm = (v, fallback) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
  if (!m) return fallback;
  const h = Math.min(Math.max(Number(m[1]), 0), 23);
  const min = Math.min(Math.max(Number(m[2]), 0), 59);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 8);

/** A row as the till and the back office read it. */
function normaliseScheme(row) {
  if (!row) return null;
  const reward = REWARD_TYPES.includes(row.reward_type) ? row.reward_type : 'none';
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    colour: row.colour || '#a5c715',
    reward_type: reward,
    discount_value: Number(row.discount_value) || 0,
    price_level: intOrNull(row.price_level),
    discount_departments: parseList(row.discount_departments),
    start_time: hhmm(row.start_time, '00:00'),
    end_time: hhmm(row.end_time, '23:59'),
    days_of_week: /^[01]{7}$/.test(String(row.days_of_week || ''))
      ? String(row.days_of_week)
      : '1111111',
    min_points_for_discount: Number(row.min_points_for_discount) || 0,
    earn_points: Number(row.earn_points) ? 1 : 0,
    points_per_pound: intOrNull(row.points_per_pound),
    point_value_minor: intOrNull(row.point_value_minor),
    min_spend_minor: intOrNull(row.min_spend_minor),
    welcome_points: Number(row.welcome_points) || 0,
    earn_departments: parseList(row.earn_departments),
    card_prefix: digitsOnly(row.card_prefix),
    membership_fee_minor: intOrNull(row.membership_fee_minor),
    membership_term_months: intOrNull(row.membership_term_months),
    is_default: Number(row.is_default) ? 1 : 0,
    offer_at_till: row.offer_at_till === undefined || Number(row.offer_at_till) ? 1 : 0,
    active: row.active === undefined || Number(row.active) ? 1 : 0,
    sort_order: Number(row.sort_order) || 0,
    notes: row.notes || null,
    members: row.members === undefined ? undefined : Number(row.members) || 0,
    // Membership plan (schema_memberships.sql). Read with defaults so a
    // database without the columns describes plain loyalty schemes.
    is_membership: Number(row.is_membership) ? 1 : 0,
    joining_fee_minor: intOrNull(row.joining_fee_minor),
    family_size: intOrNull(row.family_size),
    freeze_days_per_year: intOrNull(row.freeze_days_per_year),
    includes_gym: row.includes_gym === undefined || Number(row.includes_gym) ? 1 : 0,
    includes_classes: row.includes_classes === undefined || Number(row.includes_classes) ? 1 : 0,
    class_credits_per_month: intOrNull(row.class_credits_per_month),
    max_vehicles: intOrNull(row.max_vehicles),
    sell_online: Number(row.sell_online) ? 1 : 0,
    description: row.description || null,
  };
}

/**
 * The membership-plan fields, cleaned -- ONLY those the body actually sent.
 *
 * The loyalty scheme editor predates plans and does not send them; saving a
 * scheme there must not quietly turn a gym plan back into a loyalty group. So
 * a field that is absent stays as it is in the database.
 */
function cleanPlanInput(body, errors) {
  const has = (f) => Object.prototype.hasOwnProperty.call(body, f);
  const out = {};
  const ranged = (f, lo, hi, label) => {
    if (!has(f)) return;
    const n = intOrNull(body[f]);
    if (n != null && (n < lo || n > hi)) errors.push(`${label} must be from ${lo} to ${hi}.`);
    out[f] = n;
  };
  if (has('is_membership')) out.is_membership = body.is_membership ? 1 : 0;
  ranged('joining_fee_minor', 0, 1_000_000, 'The joining fee (in pence)');
  ranged('family_size', 1, 12, 'People on one membership');
  ranged('freeze_days_per_year', 0, 366, 'Freeze days a year');
  ranged('class_credits_per_month', 0, 999, 'Classes a month');
  ranged('max_vehicles', 0, 20, 'Cars per member');
  if (has('includes_gym')) out.includes_gym = body.includes_gym ? 1 : 0;
  if (has('includes_classes')) out.includes_classes = body.includes_classes ? 1 : 0;
  if (has('sell_online')) out.sell_online = body.sell_online ? 1 : 0;
  if (has('description')) out.description = String(body.description || '').trim().slice(0, 500) || null;
  return out;
}

/**
 * What the back office sent, cleaned into columns.
 *
 * Every field is checked rather than trusted: a negative percentage takes
 * money off the venue, a 120% discount pays the customer, and a price level
 * of 9 is a price no product has.
 */
function cleanSchemeInput(body = {}) {
  const errors = [];
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) errors.push('A scheme needs a name.');

  const reward = REWARD_TYPES.includes(body.reward_type) ? body.reward_type : 'none';
  let discount = Math.round(Number(body.discount_value) || 0);
  if (discount < 0) errors.push('A discount cannot be less than nothing.');
  if (reward === 'percent' && discount > 100) errors.push('A percentage discount is at most 100%.');
  if (reward !== 'percent' && reward !== 'amount') discount = 0;

  let level = intOrNull(body.price_level);
  if (reward === 'price_level') {
    if (level == null || level < 2 || level > 6) errors.push('Pick a price level from 2 to 6.');
  } else {
    level = null;
  }

  const days = /^[01]{7}$/.test(String(body.days_of_week || '')) ? String(body.days_of_week) : '1111111';
  if (days === '0000000') errors.push('Pick at least one day for the discount.');

  const nonNeg = (v, label) => {
    const n = intOrNull(v);
    if (n != null && n < 0) errors.push(`${label} cannot be negative.`);
    return n;
  };

  const term = intOrNull(body.membership_term_months);
  if (term != null && (term < 1 || term > 60)) errors.push('A membership runs for between 1 and 60 months.');

  const colour = /^#[0-9a-f]{6}$/i.test(String(body.colour || '')) ? String(body.colour) : '#a5c715';
  const list = (v) => {
    const names = parseList(v);
    return names.length ? JSON.stringify(names.slice(0, 200)) : null;
  };

  return {
    errors,
    values: {
      name,
      colour,
      reward_type: reward,
      discount_value: discount,
      price_level: level,
      discount_departments: list(body.discount_departments),
      start_time: hhmm(body.start_time, '00:00'),
      end_time: hhmm(body.end_time, '23:59'),
      days_of_week: days,
      min_points_for_discount: Math.max(0, Math.round(Number(body.min_points_for_discount) || 0)),
      earn_points: body.earn_points ? 1 : 0,
      points_per_pound: nonNeg(body.points_per_pound, 'Points per £1'),
      point_value_minor: nonNeg(body.point_value_minor, 'The value of a point'),
      min_spend_minor: nonNeg(body.min_spend_minor, 'The minimum spend'),
      welcome_points: Math.max(0, Math.round(Number(body.welcome_points) || 0)),
      earn_departments: list(body.earn_departments),
      card_prefix: digitsOnly(body.card_prefix),
      membership_fee_minor: nonNeg(body.membership_fee_minor, 'The membership fee'),
      membership_term_months: term,
      is_default: body.is_default ? 1 : 0,
      offer_at_till: body.offer_at_till === undefined || body.offer_at_till ? 1 : 0,
      active: body.active === undefined || body.active ? 1 : 0,
      sort_order: Math.round(Number(body.sort_order) || 0),
      notes: String(body.notes || '').trim().slice(0, 255) || null,
      ...cleanPlanInput(body, errors),
    },
  };
}

/**
 * A venue's schemes, in the order the back office set.
 *
 * Answers [] on a database that has not had schema_loyalty_schemes.sql
 * applied: that is a deployment state, and a venue with no schemes is exactly
 * what such a database describes.
 */
async function listSchemes(pool, office, { activeOnly = false, withCounts = false } = {}) {
  if (!office) return [];
  try {
    const [rows] = await pool.query(
      `SELECT s.*${withCounts
        // The venue by value, not c.email_key = s.office: on the live server
        // those two columns have different collations, and comparing them
        // fails ("Illegal mix of collations"), which broke every plan list.
        ? ', (SELECT COUNT(*) FROM epos_customers c WHERE c.email_key = ? AND c.scheme_id = s.id) AS members'
        : ''}
         FROM epos_loyalty_schemes s
        WHERE s.office = ? ${activeOnly ? 'AND s.active = 1' : ''}
        ORDER BY s.sort_order, s.name`,
      withCounts ? [office, office] : [office]
    );
    return rows.map(normaliseScheme);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return [];
    throw e;
  }
}

/** The venue's card prefixes and number width, or the defaults. */
async function readCardSettings(pool, office) {
  try {
    const [[row]] = await pool.query(
      'SELECT * FROM epos_card_settings WHERE office = ?', [office]);
    return {
      loyalty_prefix: row ? digitsOnly(row.loyalty_prefix) : '9998',
      membership_prefix: row ? digitsOnly(row.membership_prefix) : '',
      number_digits: Math.min(Math.max(Number(row?.number_digits) || 5, 4), 12),
    };
  } catch {
    return { loyalty_prefix: '9998', membership_prefix: '', number_digits: 5 };
  }
}

/**
 * Every prefix that marks a card as a member's card, longest first.
 *
 * The venue's loyalty and membership prefixes, and each scheme's own. Longest
 * first so a scheme on 99981 is not mistaken for the venue's 9998.
 */
function memberPrefixes(cardSettings, schemes = []) {
  const all = [
    cardSettings?.loyalty_prefix,
    cardSettings?.membership_prefix,
    ...schemes.filter((s) => s.active !== 0).map((s) => s.card_prefix),
  ].map(digitsOnly).filter(Boolean);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** The scheme whose prefix this card starts with, or null. Longest wins. */
function schemeForCard(schemes, cardNumber) {
  const number = String(cardNumber || '').replace(/\D/g, '');
  if (!number) return null;
  let best = null;
  for (const s of schemes) {
    if (!s.card_prefix || s.active === 0) continue;
    if (!number.startsWith(s.card_prefix)) continue;
    if (!best || s.card_prefix.length > best.card_prefix.length) best = s;
  }
  return best;
}

/**
 * The membership number people read: the card without its prefix.
 *
 * 999800001 is member 00001. A customer with no card, or whose card starts
 * with no prefix this venue knows, falls back to their allocated number,
 * padded to the venue's card width so the two look alike on one list. Null
 * when there is neither.
 */
function memberNumber(customer, prefixes = [], digits = 5) {
  const card = String(customer?.card_number || '').replace(/\D/g, '');
  if (card) {
    for (const p of prefixes) {
      if (p && card.startsWith(p) && card.length > p.length) return card.slice(p.length);
    }
  }
  if (customer?.member_no != null && customer.member_no !== '') {
    return String(customer.member_no).padStart(Math.min(Math.max(Number(digits) || 5, 1), 12), '0');
  }
  return null;
}

/**
 * The digits after a member prefix, as a number, for `member_no`. Null when
 * the card has no known prefix or the rest is not a sensible number.
 */
function memberNoFromCard(cardNumber, prefixes = []) {
  const card = String(cardNumber || '').replace(/\D/g, '');
  for (const p of prefixes) {
    if (p && card.startsWith(p) && card.length > p.length) {
      const n = Number(card.slice(p.length));
      return Number.isSafeInteger(n) && n > 0 && n < 4294967295 ? n : null;
    }
  }
  return null;
}

/**
 * The venue's loyalty settings with a scheme's own rules laid over them.
 *
 * Only what the scheme sets. A scheme that does not earn points answers
 * `earn_points: 0`, which /loyalty/points reads as "this customer earns
 * nothing"; a scheme with no point value of its own uses the venue's.
 */
function applyScheme(settings, scheme) {
  if (!scheme) return { ...settings, scheme: null };
  const pick = (own, inherited) => (own == null ? inherited : own);
  return {
    ...settings,
    points_per_pound: pick(scheme.points_per_pound, settings.points_per_pound),
    point_value_minor: pick(scheme.point_value_minor, settings.point_value_minor),
    min_spend_minor: pick(scheme.min_spend_minor, settings.min_spend_minor),
    membership_fee_minor: pick(scheme.membership_fee_minor, settings.membership_fee_minor),
    membership_term_months: pick(scheme.membership_term_months, settings.membership_term_months),
    earn_points: scheme.earn_points,
    scheme,
  };
}

/** Whether a scheme's discount window is open at [now] (venue local time). */
function discountActiveAt(scheme, now = new Date()) {
  if (!scheme || scheme.reward_type === 'none') return false;
  // Monday first, as promotions store it; getDay() is Sunday = 0.
  const day = (now.getDay() + 6) % 7;
  if (scheme.days_of_week[day] !== '1') return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = scheme.start_time.split(':').map(Number);
  const [eh, em] = scheme.end_time.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  // A window that crosses midnight, 18:00 to 02:00, is two windows.
  return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
}

/** A sentence a manager can check a scheme against. */
function describeScheme(scheme) {
  if (!scheme) return '';
  const parts = [];
  const where = scheme.discount_departments.length
    ? ` ${scheme.discount_departments.join(', ')}`
    : '';
  if (scheme.reward_type === 'percent') parts.push(`${scheme.discount_value}% off${where}`);
  if (scheme.reward_type === 'amount') parts.push(`£${(scheme.discount_value / 100).toFixed(2)} off${where}`);
  if (scheme.reward_type === 'price_level') parts.push(`Price ${scheme.price_level}${where}`);
  if (scheme.earn_points) {
    parts.push(scheme.points_per_pound != null
      ? `${scheme.points_per_pound} point${scheme.points_per_pound === 1 ? '' : 's'} per £1`
      : 'earns points');
  }
  if (scheme.welcome_points) parts.push(`${scheme.welcome_points} welcome points`);
  return parts.join(', ') || 'No rewards';
}

/**
 * Put a customer in a scheme, and give them its welcome points.
 *
 * Welcome points are given once, when somebody joins a scheme they were not
 * already in, and written to the points history so the balance can be
 * explained. Never throws: the callers are sign-ups, and a sign-up that failed
 * over a welcome gift is worse than one without it.
 */
async function joinScheme(pool, office, customerId, schemeId) {
  if (!office || !customerId || !schemeId) return null;
  try {
    const [[scheme]] = await pool.query(
      'SELECT * FROM epos_loyalty_schemes WHERE id = ? AND office = ? AND active = 1',
      [schemeId, office]
    );
    if (!scheme) return null;
    const s = normaliseScheme(scheme);

    const [result] = await pool.execute(
      `UPDATE epos_customers SET scheme_id = ?
        WHERE id = ? AND email_key = ? AND (scheme_id IS NULL OR scheme_id <> ?)`,
      [s.id, customerId, office, s.id]
    );
    if (result.affectedRows === 1 && s.welcome_points > 0) {
      await pool.execute(
        'UPDATE epos_customers SET points_balance = points_balance + ? WHERE id = ? AND email_key = ?',
        [s.welcome_points, customerId, office]
      );
      const [[row]] = await pool.query(
        'SELECT points_balance FROM epos_customers WHERE id = ?', [customerId]);
      await pool.execute(
        `INSERT INTO epos_loyalty_txns
           (id, office, customer_id, kind, points, balance_after, note)
         VALUES (UUID(), ?, ?, 'adjust', ?, ?, ?)`,
        [office, customerId, s.welcome_points, Number(row?.points_balance) || 0,
          `Welcome points: ${s.name}`.slice(0, 255)]
      ).catch(() => {});
    }
    return s;
  } catch (e) {
    console.error(`[schemes] could not put ${customerId} in scheme ${schemeId}: ${e.message}`);
    return null;
  }
}

/**
 * Which scheme a new customer joins: the one asked for, else the one their
 * card's prefix names, else the venue's default. Null when the venue has none.
 */
function pickSchemeForNewCustomer(schemes, { schemeId, cardNumber } = {}) {
  const live = schemes.filter((s) => s.active !== 0);
  if (schemeId != null && schemeId !== '') {
    const asked = live.find((s) => s.id === Number(schemeId));
    if (asked) return asked;
  }
  const byCard = schemeForCard(live, cardNumber);
  if (byCard) return byCard;
  return live.find((s) => s.is_default) || null;
}

/**
 * Add the membership number and the scheme to customer rows.
 *
 * Reads the schemes and the card settings once for the whole list. Leaves the
 * rows as they were on any failure: a list without its new columns is better
 * than no list.
 */
async function decorateCustomers(pool, office, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  try {
    const [schemes, cards] = await Promise.all([
      listSchemes(pool, office),
      readCardSettings(pool, office),
    ]);
    const prefixes = memberPrefixes(cards, schemes);
    const byId = new Map(schemes.map((s) => [s.id, s]));
    for (const row of rows) {
      row.member_number = memberNumber(row, prefixes, cards.number_digits);
      const s = row.scheme_id != null ? byId.get(Number(row.scheme_id)) : null;
      row.scheme_name = s ? s.name : null;
      row.scheme_colour = s ? s.colour : null;
    }
  } catch (e) {
    console.error(`[schemes] could not decorate customers: ${e.message}`);
  }
  return rows;
}

/**
 * Make a member's number match the card they hold.
 *
 * "The 9998 should not form part of the customer's membership number." When a
 * card with a member prefix is given to somebody, the rest of it becomes their
 * `member_no`, so the wallet pass, the receipt and the back office all say the
 * same number the card does. The venue's member counter is moved past it so
 * the number is never handed to anybody else. Never throws.
 */
async function syncMemberNoToCard(pool, office, customerId, cardNumber) {
  if (!office || !customerId || !cardNumber) return null;
  try {
    const [all, cards] = await Promise.all([listSchemes(pool, office), readCardSettings(pool, office)]);
    const n = memberNoFromCard(cardNumber, memberPrefixes(cards, all));
    if (n == null) return null;
    await pool.execute(
      'UPDATE epos_customers SET member_no = ? WHERE id = ? AND email_key = ?',
      [n, customerId, office]
    );
    await pool.execute(
      `INSERT INTO epos_card_sequences (office, kind, next_number) VALUES (?, 'member', ?)
       ON DUPLICATE KEY UPDATE next_number = GREATEST(next_number, VALUES(next_number))`,
      [office, n + 1]
    );
    return n;
  } catch (e) {
    console.error(`[schemes] could not match member number to card: ${e.message}`);
    return null;
  }
}

/**
 * The columns schemes added to a customer, saved where the database has them.
 * A back-office save is not lost because a migration has not run.
 */
async function saveCustomerExtras(pool, office, customerId, c = {}) {
  const sets = [];
  const vals = [];
  const put = (col, v) => { sets.push(`\`${col}\` = ?`); vals.push(v); };
  if (c.scheme_id !== undefined) put('scheme_id', c.scheme_id === '' || c.scheme_id == null ? null : Number(c.scheme_id) || null);
  if (c.marketing_opt_in !== undefined) put('marketing_opt_in', c.marketing_opt_in && c.marketing_opt_in !== '0' && c.marketing_opt_in !== 'false' ? 1 : 0);
  for (const col of ['address_line1', 'address_line2', 'town', 'postcode']) {
    if (c[col] !== undefined) put(col, String(c[col] || '').trim().slice(0, col === 'postcode' ? 16 : 120) || null);
  }
  if (!sets.length) return;
  try {
    await pool.execute(
      `UPDATE epos_customers SET ${sets.join(', ')} WHERE id = ? AND email_key = ?`,
      [...vals, customerId, office]
    );
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
  }
}

module.exports = {
  REWARD_TYPES,
  normaliseScheme,
  cleanSchemeInput,
  listSchemes,
  readCardSettings,
  memberPrefixes,
  schemeForCard,
  memberNumber,
  memberNoFromCard,
  applyScheme,
  discountActiveAt,
  describeScheme,
  joinScheme,
  pickSchemeForNewCustomer,
  decorateCustomers,
  syncMemberNoToCard,
  saveCustomerExtras,
};
