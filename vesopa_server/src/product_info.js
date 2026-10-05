/**
 * The extra things a product carries since the step-by-step form (2026-10-01).
 *
 * Kept out of the big INSERT and UPDATE in backoffice.js on purpose. Those two
 * statements name every column they write, and a back office deployed before
 * schema_product_wizard.sql has run would fail every product save if they
 * named these too. Written here instead, as a second statement that names only
 * the fields the caller sent, and that steps aside (logging once) when the
 * columns are not there yet.
 */

const { cleanAllergens } = require('./allergens');

/** Diet labels, in the order the form shows them. */
const DIETARY = Object.freeze([
  { code: 'vegetarian', label: 'Vegetarian' },
  { code: 'vegan', label: 'Vegan' },
  { code: 'gluten_free', label: 'Gluten free' },
  { code: 'dairy_free', label: 'Dairy free' },
  { code: 'halal', label: 'Halal' },
]);
const DIET_CODES = new Set(DIETARY.map((d) => d.code));

/** A list of diet codes as stored: a JSON array, or null for "not said". */
function cleanDietary(value) {
  if (value === null || value === undefined || value === '') return null;
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = list.split(',');
    }
  }
  if (!Array.isArray(list)) list = [list];
  const codes = [];
  for (const raw of list) {
    const code = String(raw ?? '').trim().toLowerCase();
    if (DIET_CODES.has(code) && !codes.includes(code)) codes.push(code);
  }
  codes.sort(
    (a, b) => DIETARY.findIndex((d) => d.code === a) - DIETARY.findIndex((d) => d.code === b)
  );
  return JSON.stringify(codes);
}

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'p', 'br', 'ul', 'ol', 'li', 'h3', 'h4', 'a',
]);

/**
 * The Information step's text, cut down to tags that are safe to show on a
 * public menu page.
 *
 * Every tag outside a short list is dropped (its text kept), every attribute
 * is dropped except an http(s) or mailto href on a link, and the whole thing
 * is capped. It is shown on the QR menu and the kiosk, which a stranger can
 * open, so anything the editor might paste in from a web page has to go.
 */
function cleanDescription(value) {
  if (value === null || value === undefined) return null;
  let html = String(value).slice(0, 20000);
  // Whole elements whose content is never text.
  html = html.replace(/<(script|style|iframe|object|embed|template|svg|math)[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (whole, rawTag, attrs) => {
    const tag = rawTag.toLowerCase();
    const closing = whole.startsWith('</');
    if (tag === 'div') return closing ? '' : '<br>';
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (closing) return tag === 'br' ? '' : `</${tag}>`;
    if (tag === 'a') {
      const m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
      if (!/^(https?:|mailto:)/i.test(href)) return '<a>';
      const safe = href.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
      return `<a href="${safe}" target="_blank" rel="noopener">`;
    }
    return `<${tag}>`;
  });
  // Stray angle brackets left by a broken tag cannot open a new one.
  html = html.replace(/<(?![/]?(b|strong|i|em|u|s|p|br|ul|ol|li|h3|h4|a)[\s>])/gi, '&lt;');
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  return text ? html.trim() : null;
}

/** A form checkbox: "1", 1, true, "on" are on; anything else is off. */
const onOff = (v) => (v === 1 || v === '1' || v === true || v === 'true' || v === 'on' ? 1 : 0);

/** Calories as stored: a whole number from 0 to 20000, or null. */
function cleanCalories(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 20000 ? n : null;
}

/** The writable fields, and how each is cleaned. */
const FIELDS = {
  short_description: (v) => String(v ?? '').trim().slice(0, 160) || null,
  description: cleanDescription,
  calories: cleanCalories,
  may_contain: cleanAllergens,
  dietary: cleanDietary,
  is_weighted: onOff,
  manual_weight: onOff,
};

/**
 * Open price (schema_open_price.sql): the till asks what to charge, and what
 * it was for. Kept apart from FIELDS so a database without that migration
 * still saves, and still hands the till, everything above.
 */
const OPEN_PRICE_FIELDS = {
  open_price: onOff,
  open_price_note: onOff,
};

/**
 * Write whichever of the extra fields the caller sent onto one product.
 *
 * A field that is absent is left alone, the same rule PUT /products follows:
 * an import that knows nothing about calories must not blank them.
 */
async function saveProductExtras(pool, id, email, body) {
  const main = await saveFields(pool, id, email, body, FIELDS, 'schema_product_wizard.sql');
  const open = await saveFields(pool, id, email, body, OPEN_PRICE_FIELDS, 'schema_open_price.sql');
  return main || open;
}

const warnedFor = new Set();

async function saveFields(pool, id, email, body, fields, migration) {
  const sets = [];
  const values = [];
  for (const [field, clean] of Object.entries(fields)) {
    if (!body || body[field] === undefined) continue;
    sets.push(`${field} = ?`);
    values.push(clean(body[field]));
  }
  if (!sets.length) return false;
  try {
    await pool.execute(
      `UPDATE bo_products SET ${sets.join(', ')} WHERE id = ? AND email = ?`,
      [...values, id, email]
    );
    return true;
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    if (!warnedFor.has(migration)) {
      warnedFor.add(migration);
      console.warn(`[products] ${migration} has not run; those product fields were not saved`);
    }
    return false;
  }
}

module.exports = {
  DIETARY,
  cleanDietary,
  cleanDescription,
  cleanCalories,
  saveProductExtras,
  PRODUCT_EXTRA_FIELDS: Object.keys(FIELDS),
  OPEN_PRICE_FIELDS: Object.keys(OPEN_PRICE_FIELDS),
};
