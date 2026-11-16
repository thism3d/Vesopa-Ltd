/**
 * Vesopa AI's figures (owner, 2026-11-16: "never invent sales, profit, stock or
 * staff figures. Use backend calculations for numerical results and AI for
 * interpreting and explaining them").
 *
 * Every number Vesopa AI ever shows is worked out here, in SQL against the
 * venue's own sales, and comes back as a FACT: the figure, what it means, the
 * period and site it covers, when the latest sale in it was taken, and how to
 * open the records behind it. The model in ai_explain.js only ever receives
 * facts and only ever writes words about them; its answer is checked against
 * them before anybody reads it.
 *
 * TENANCY: every query takes the office from the caller's token (ai_advisor.js)
 * and every query is `WHERE email = ?` on it. Sites are narrowed with the
 * venue's own till list (bo_till_names), matched in JavaScript rather than by a
 * join, so a till table in another collation can never break a query.
 *
 * Money is in minor units (pence) throughout, as epos_orders keeps it.
 * cost_price on bo_products is in pounds, ex VAT (report_builders_sales.js).
 */
'use strict';

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The till's own reorder target: two weeks of cover at the recent rate. */
const COVER_DAYS = 14;
/** Days of sales the stock prediction reads. Four weeks: every weekday four times. */
const VELOCITY_DAYS = 28;

// ---- wall-clock time ---------------------------------------------------------
//
// The tills write closed_at in the venue's wall-clock time and the dashboard
// compares it with CURDATE(). So the clock here is the database's own NOW(),
// read once per request, and every date is a naive wall-clock time held as
// "milliseconds as if UTC". Nothing here ever converts a time zone.

function parseNaive(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(text || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

function naive(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** A Date from mysql2 (read as local) or a string, as naive wall-clock ms. */
function wallMs(value) {
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes(), value.getSeconds());
  }
  return parseNaive(value);
}

const midnight = (ms) => ms - (((ms % DAY) + DAY) % DAY);
const weekday = (ms) => new Date(ms).getUTCDay();
const dayText = (ms) => { const d = new Date(ms); return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const timeText = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

async function databaseNow(pool) {
  try {
    const [[row]] = await pool.query('SELECT NOW() AS now');
    const ms = wallMs(row && row.now);
    if (Number.isFinite(ms)) return ms;
  } catch { /* fall through: the server's own clock */ }
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

// ---- periods -----------------------------------------------------------------

function periodOf(key, label, fromMs, toMs, partial = false) {
  return {
    key, label, partial,
    from: naive(fromMs), to: naive(toMs),
    fromMs, toMs,
    days: Math.max(1, Math.round((toMs - fromMs) / DAY)),
  };
}

/**
 * A period from a spec the intent parser (or the model) produced. Unknown
 * specs are today. `now` is databaseNow().
 *
 *   { kind: 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month'
 *           | 'last_month' | 'last_days' | 'day' | 'weekday', days?, date?, dow? }
 */
function resolvePeriod(spec, now) {
  const s = spec || {};
  const today = midnight(now);
  switch (s.kind) {
    case 'yesterday':
      return periodOf('yesterday', `Yesterday (${dayText(today - DAY)})`, today - DAY, today);
    case 'day': {
      const d = midnight(parseNaive(s.date));
      if (Number.isFinite(d) && d <= today) {
        if (d === today) return resolvePeriod({ kind: 'today' }, now);
        return periodOf('day', dayText(d), d, d + DAY);
      }
      return resolvePeriod({ kind: 'today' }, now);
    }
    case 'weekday': {
      // "Saturday": the most recent Saturday that has finished.
      const dow = Number(s.dow);
      if (!(dow >= 0 && dow <= 6)) return resolvePeriod({ kind: 'yesterday' }, now);
      let back = (weekday(today) - dow + 7) % 7;
      if (back === 0) back = 7;
      const d = today - back * DAY;
      return periodOf('weekday', `${DAYS[dow]} (${dayText(d)})`, d, d + DAY);
    }
    case 'this_week': {
      const monday = today - ((weekday(today) + 6) % 7) * DAY;
      return periodOf('this_week', `This week (${dayText(monday)} to now, ${timeText(now)})`, monday, now, true);
    }
    case 'last_week': {
      const monday = today - ((weekday(today) + 6) % 7) * DAY - 7 * DAY;
      return periodOf('last_week', `Last week (${dayText(monday)} to ${dayText(monday + 6 * DAY)})`, monday, monday + 7 * DAY);
    }
    case 'this_month': {
      const d = new Date(today);
      const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      return periodOf('this_month', `This month (1 ${MONTHS[d.getUTCMonth()]} to now, ${timeText(now)})`, first, now, true);
    }
    case 'last_month': {
      const d = new Date(today);
      const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
      const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      return periodOf('last_month', `Last month (${MONTHS[new Date(first).getUTCMonth()]} ${new Date(first).getUTCFullYear()})`, first, end);
    }
    case 'last_days': {
      const n = Math.min(Math.max(Math.trunc(Number(s.days) || 7), 1), 365);
      // N whole days ending with today, as the dashboard's "last 7 days".
      return periodOf('last_days', `Last ${n} days (${dayText(today - (n - 1) * DAY)} to now)`, today - (n - 1) * DAY, now, true);
    }
    case 'today':
    default:
      return periodOf('today', `Today (${dayText(today)}, to ${timeText(now)})`, today, now, true);
  }
}

/**
 * What a period is fairly compared with. Hospitality trades by weekday, so a
 * day is compared with the same weekday a week earlier, and a period still
 * running is compared only up to the same point (today to 14:30 against last
 * Monday to 14:30, never against the whole of last Monday).
 */
function comparisonFor(p) {
  const span = p.toMs - p.fromMs;
  switch (p.key) {
    case 'today':
    case 'yesterday':
    case 'day':
    case 'weekday': {
      const from = p.fromMs - 7 * DAY;
      const to = from + span;
      const label = p.partial
        ? `Same time last ${DAYS[weekday(from)]} (${dayText(from)}, to ${timeText(to)})`
        : `The ${DAYS[weekday(from)]} before (${dayText(from)})`;
      return periodOf('compare', label, from, to, p.partial);
    }
    case 'this_week':
    case 'last_week':
      return periodOf('compare', p.partial ? `Same point last week (${dayText(p.fromMs - 7 * DAY)} to ${dayText(p.toMs - 7 * DAY)} ${timeText(p.toMs)})` : `The week before (${dayText(p.fromMs - 7 * DAY)} to ${dayText(p.fromMs - DAY)})`,
        p.fromMs - 7 * DAY, p.toMs - 7 * DAY, p.partial);
    case 'this_month': {
      const d = new Date(p.fromMs);
      const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
      const end = Math.min(first + span, p.fromMs);
      return periodOf('compare', `Same point last month (${dayText(first)} to ${dayText(end)})`, first, end, true);
    }
    case 'last_month': {
      const d = new Date(p.fromMs);
      const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
      return periodOf('compare', `The month before (${MONTHS[new Date(first).getUTCMonth()]})`, first, p.fromMs);
    }
    default:
      return periodOf('compare', `The ${Math.round(span / DAY)} days before`, p.fromMs - span, p.fromMs, false);
  }
}

// ---- sites -------------------------------------------------------------------

/**
 * The venue's sites and which till belongs to which. A venue with none set up
 * is one "All tills" site.
 */
async function siteMap(pool, office) {
  const out = { sites: [], tillSite: new Map() };
  try {
    const [sites] = await pool.query('SELECT id, name FROM bo_till_sites WHERE office = ? ORDER BY sort, name', [office]);
    const [tills] = await pool.query('SELECT terminal, site_id, label FROM bo_till_names WHERE office = ?', [office]);
    out.sites = sites.map((s) => ({ id: Number(s.id), name: String(s.name) }));
    for (const t of tills) if (t.site_id != null) out.tillSite.set(String(t.terminal), Number(t.site_id));
  } catch (e) {
    if (!(e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR'))) throw e;
  }
  return out;
}

/**
 * The SQL that narrows a query to what this person may see and asked for.
 *
 *   allowed: null (every site) or [site ids] (an invited person's sites)
 *   site:    null (all they may see) or one site id
 *
 * Returns { sql, params, label, empty } — `empty` when the narrowing leaves
 * no till at all, so the caller answers "no sales" instead of querying.
 */
function siteFilter(map, { allowed = null, site = null } = {}, column = 'o.terminal') {
  const ids = site != null ? [Number(site)] : allowed;
  if (allowed && site != null && !allowed.includes(Number(site))) {
    return { sql: ' AND 1 = 0', params: [], label: 'No site you may see', empty: true };
  }
  if (!ids) return { sql: '', params: [], label: map.sites.length ? 'All sites' : 'Whole venue', empty: false };
  const tills = [...map.tillSite.entries()].filter(([, s]) => ids.includes(s)).map(([t]) => t);
  const names = map.sites.filter((s) => ids.includes(s.id)).map((s) => s.name);
  const label = names.length ? names.join(', ') : 'No site';
  if (!tills.length) return { sql: ' AND 1 = 0', params: [], label, empty: true };
  return { sql: ` AND ${column} IN (?)`, params: [tills], label, empty: false };
}

// ---- queries -----------------------------------------------------------------

const num = (v) => Number(v) || 0;

async function summary(pool, office, f, p) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS sales,
            COALESCE(SUM(o.total_minor), 0)    AS takings_minor,
            COALESCE(SUM(o.tax_minor), 0)      AS tax_minor,
            COALESCE(SUM(o.discount_minor), 0) AS discount_minor,
            COALESCE(SUM(o.covers), 0)         AS covers,
            MAX(o.closed_at)                   AS last_sale
       FROM epos_orders o
      WHERE o.email = ? AND o.closed_at IS NOT NULL
        AND o.closed_at >= ? AND o.closed_at < ?${f.sql}`,
    [office, p.from, p.to, ...f.params]);
  const sales = num(r.sales);
  const takings = num(r.takings_minor);
  return {
    sales,
    takings_minor: takings,
    net_minor: takings - num(r.tax_minor),
    discount_minor: num(r.discount_minor),
    covers: num(r.covers),
    average_minor: sales ? Math.round(takings / sales) : 0,
    last_sale: r.last_sale ? naive(wallMs(r.last_sale)) : null,
  };
}

async function byHour(pool, office, f, p) {
  const [rows] = await pool.query(
    `SELECT HOUR(o.closed_at) AS hour, COUNT(*) AS sales, COALESCE(SUM(o.total_minor), 0) AS takings_minor
       FROM epos_orders o
      WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?${f.sql}
      GROUP BY HOUR(o.closed_at) ORDER BY hour`,
    [office, p.from, p.to, ...f.params]);
  return rows.map((r) => ({ hour: num(r.hour), sales: num(r.sales), takings_minor: num(r.takings_minor) }));
}

async function byDay(pool, office, f, p) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(o.closed_at, '%Y-%m-%d') AS day, COUNT(*) AS sales, COALESCE(SUM(o.total_minor), 0) AS takings_minor
       FROM epos_orders o
      WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?${f.sql}
      GROUP BY day ORDER BY day`,
    [office, p.from, p.to, ...f.params]);
  return rows.map((r) => ({ day: String(r.day), sales: num(r.sales), takings_minor: num(r.takings_minor) }));
}

/**
 * Lines by product: quantity, takings, VAT, cost and gross profit. Takings are
 * the line price times quantity less the line's discount (VAT included, as the
 * product sales report). Gross profit is takings ex VAT less cost, and only
 * means something where the product has a cost price, so `costed_minor` says
 * how much of the takings that covers.
 */
async function byProduct(pool, office, f, p) {
  const [rows] = await pool.query(
    `SELECT l.plu_id, MAX(l.name) AS name,
            MAX(COALESCE(NULLIF(TRIM(pr.department_name), ''), 'Unassigned')) AS department,
            SUM(l.quantity) AS qty,
            SUM(l.quantity * l.unit_price_minor - COALESCE(l.discount_minor, 0)) AS takings_minor,
            SUM((l.quantity * l.unit_price_minor - COALESCE(l.discount_minor, 0))
                * COALESCE(l.tax_percentage, 0) / (100 + COALESCE(l.tax_percentage, 0))) AS tax_minor,
            SUM(l.quantity * COALESCE(pr.cost_price, 0) * 100) AS cost_minor,
            MAX(CASE WHEN COALESCE(pr.cost_price, 0) > 0 THEN 1 ELSE 0 END) AS costed
       FROM epos_order_lines l
       JOIN epos_orders o ON o.id = l.order_id
       LEFT JOIN bo_products pr ON pr.pluid = l.plu_id AND pr.email = o.email
      WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?${f.sql}
        AND COALESCE(l.is_modifier, 0) = 0
      GROUP BY l.plu_id, l.name`,
    [office, p.from, p.to, ...f.params]);
  return rows.map((r) => {
    const takings = Math.round(num(r.takings_minor));
    const net = takings - Math.round(num(r.tax_minor));
    const costed = num(r.costed) === 1;
    const cost = Math.round(num(r.cost_minor));
    return {
      plu: r.plu_id == null ? null : Number(r.plu_id),
      name: String(r.name || 'Unnamed'),
      department: String(r.department || 'Unassigned'),
      qty: Math.round(num(r.qty) * 100) / 100,
      takings_minor: takings,
      net_minor: net,
      costed,
      cost_minor: costed ? cost : null,
      profit_minor: costed ? net - cost : null,
      margin_pct: costed && net > 0 ? Math.round(((net - cost) / net) * 1000) / 10 : null,
    };
  });
}

async function byClerk(pool, office, f, p) {
  const [rows] = await pool.query(
    `SELECT COALESCE(NULLIF(o.clerk_name, ''), 'Unknown') AS clerk, COUNT(*) AS sales,
            COALESCE(SUM(o.total_minor), 0) AS takings_minor,
            COALESCE(SUM(o.discount_minor), 0) AS discount_minor
       FROM epos_orders o
      WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?${f.sql}
      GROUP BY clerk`,
    [office, p.from, p.to, ...f.params]);
  return rows.map((r) => ({
    clerk: String(r.clerk), sales: num(r.sales), takings_minor: num(r.takings_minor),
    discount_minor: num(r.discount_minor),
    average_minor: num(r.sales) ? Math.round(num(r.takings_minor) / num(r.sales)) : 0,
  }));
}

/** Voids by member of staff: the log, since a voided line leaves no sale. */
async function voids(pool, office, f, p) {
  try {
    const [rows] = await pool.query(
      `SELECT COALESCE(c.clark_name, CONCAT('PIN ', v.clerk_pin), 'Unknown') AS clerk,
              COUNT(*) AS count, COALESCE(SUM(v.amount_minor), 0) AS total_minor
         FROM epos_void_log v
         LEFT JOIN bo_clarks c ON c.pin_code = v.clerk_pin AND c.email = v.email
        WHERE v.email = ? AND v.voided_at >= ? AND v.voided_at < ?${f.sql.replace(/o\.terminal/g, 'v.terminal')}
        GROUP BY clerk`,
      [office, p.from, p.to, ...f.params]);
    return rows.map((r) => ({ clerk: String(r.clerk), count: num(r.count), total_minor: num(r.total_minor) }));
  } catch (e) {
    if (e && e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

async function bySite(pool, office, map, allowed, p) {
  const [rows] = await pool.query(
    `SELECT COALESCE(NULLIF(o.terminal, ''), '') AS terminal, COUNT(*) AS sales, COALESCE(SUM(o.total_minor), 0) AS takings_minor
       FROM epos_orders o
      WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ? AND o.closed_at < ?
      GROUP BY terminal`,
    [office, p.from, p.to]);
  const out = new Map();
  for (const s of map.sites) if (!allowed || allowed.includes(s.id)) out.set(s.id, { id: s.id, name: s.name, sales: 0, takings_minor: 0 });
  for (const r of rows) {
    const id = map.tillSite.get(String(r.terminal));
    if (id == null) {
      if (allowed) continue;
      if (!out.has('none')) out.set('none', { id: null, name: map.sites.length ? 'Not in a site' : 'All tills', sales: 0, takings_minor: 0 });
      const n = out.get('none');
      n.sales += num(r.sales); n.takings_minor += num(r.takings_minor);
      continue;
    }
    const s = out.get(id);
    if (!s) continue;
    s.sales += num(r.sales); s.takings_minor += num(r.takings_minor);
  }
  return [...out.values()];
}

/**
 * Stock with a count, and how fast it sells: the last 28 days' quantity over
 * 28 days. Days of cover is stock over that daily rate; the predicted stockout
 * is that many days from now; the suggested order brings it back to two weeks'
 * cover. A product with stock and no sales in 28 days is slow (money sitting on
 * a shelf), valued at cost where it has one.
 */
async function stock(pool, office, f, now) {
  const from = naive(midnight(now) - (VELOCITY_DAYS - 1) * DAY);
  const [rows] = await pool.query(
    `SELECT p.pluid, p.product_name, p.department_name, p.stock_quantity, p.low_stock_at, p.cost_price,
            COALESCE(s.qty, 0) AS sold
       FROM bo_products p
       LEFT JOIN (
         SELECT l.plu_id, SUM(l.quantity) AS qty
           FROM epos_order_lines l JOIN epos_orders o ON o.id = l.order_id
          WHERE o.email = ? AND o.closed_at IS NOT NULL AND o.closed_at >= ?${f.sql}
            AND COALESCE(l.is_modifier, 0) = 0
          GROUP BY l.plu_id
       ) s ON s.plu_id = p.pluid
      WHERE p.email = ? AND p.stock_quantity IS NOT NULL`,
    [office, from, ...f.params, office]);
  return rows.map((r) => stockLine(r, now));
}

function stockLine(r, now) {
  const qty = num(r.stock_quantity);
  const sold = num(r.sold);
  const rate = sold / VELOCITY_DAYS;
  const cover = rate > 0 ? qty / rate : null;
  const reorder = rate > 0 ? Math.max(0, Math.ceil(rate * COVER_DAYS - qty)) : 0;
  return {
    plu: r.pluid == null ? null : Number(r.pluid),
    name: String(r.product_name || 'Unnamed'),
    department: String(r.department_name || 'Unassigned'),
    stock: qty,
    low_at: r.low_stock_at == null ? null : num(r.low_stock_at),
    sold_28d: Math.round(sold * 100) / 100,
    per_day: Math.round(rate * 100) / 100,
    days_cover: cover == null ? null : Math.round(cover * 10) / 10,
    stockout: cover == null || qty <= 0 ? (qty <= 0 ? naive(midnight(now)).slice(0, 10) : null) : naive(midnight(now) + Math.floor(cover) * DAY).slice(0, 10),
    reorder_qty: reorder,
    value_minor: num(r.cost_price) > 0 && qty > 0 ? Math.round(qty * num(r.cost_price) * 100) : null,
  };
}

// ---- facts -------------------------------------------------------------------
//
// A fact is what both clients draw and what the model is allowed to talk
// about. `values` are the numbers; `meta` says what they mean and where they
// came from; `chart` is optional; `records` is how to open the rows behind it.

const money = (minor) => {
  const v = (Number(minor) || 0) / 100;
  return `${v < 0 ? '-' : ''}£${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const pct = (now, before) => (before ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null);

function meta(p, f, definition, lastSale, extra = {}) {
  return {
    period: p.label, from: p.from, to: p.to,
    site: f.label,
    definition,
    freshness: lastSale ? `Latest sale in this period: ${lastSale.slice(0, 16)}` : 'No sales in this period',
    last_sale: lastSale || null,
    ...extra,
  };
}

const DEF = {
  takings: 'Takings: closed bills, VAT included, after discounts and before refunds. The same figure as the Dashboard\'s Takings.',
  average: 'Average spend: takings divided by the number of closed bills.',
  product: 'Product takings: line price times quantity, less the line\'s discount, VAT included. Modifiers are not counted as products.',
  profit: 'Gross profit: product takings without VAT, less quantity times the product\'s cost price. Only products with a cost price are counted.',
  staff: 'Takings by the member of staff who closed each bill. Voids are from the void log (lines removed after they were rung up).',
  sites: 'Takings by site: each sale counts for the site its till belongs to.',
  stock: `Stock prediction: the current count over the last ${VELOCITY_DAYS} days' average daily sales. Suggested order brings it back to ${COVER_DAYS} days of cover.`,
};

module.exports = {
  DAY, DAYS, VELOCITY_DAYS, COVER_DAYS, DEF,
  parseNaive, naive, wallMs, midnight, dayText, timeText,
  databaseNow, resolvePeriod, comparisonFor, periodOf,
  siteMap, siteFilter,
  summary, byHour, byDay, byProduct, byClerk, voids, bySite, stock, stockLine,
  money, pct, meta,
};
