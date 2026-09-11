/**
 * The menu a customer orders from, and what a basket costs against it.
 *
 * Shared by the QR table menu (dinein.js) and the Vesopa Express kiosk
 * (express.js), and shared on purpose. Both sell the same venue's dishes at the
 * same prices with the same add-ons, and two copies of "what does this basket
 * cost" would be two answers the first time somebody changed one of them -- a
 * customer charged one figure on their phone and another at the kiosk by the
 * door, for the same burger, on the same evening.
 *
 * WHAT IS BELIEVED FROM THE CLIENT
 *
 * Menu item ids, quantities, notes and which add-ons were ticked. Nothing about
 * money. Every price and every name is read back out of the catalogue here, so
 * a customer who edits the page (or the kiosk's memory) changes what they see
 * and not what they are charged, and a price a manager changed while somebody
 * was reading is the price that applies.
 *
 * `db` is anything with mysql2's `query` -- the pool, or a connection inside a
 * transaction when the caller wants the prices read in the same transaction
 * that writes the order.
 */

const { readAllergens, effectiveAllergens } = require('./allergens');

/** The venue's tenancy email, which the catalogue is keyed by. */
async function emailOfOffice(db, officeId) {
  const [[office]] = await db.query(
    'SELECT contact_email FROM offices WHERE id = ?',
    [officeId]
  );
  return office ? office.contact_email : null;
}

/** The venue's numeric id, from its tenancy email. */
async function officeIdOf(db, email) {
  const [[office]] = await db.query(
    'SELECT id FROM offices WHERE contact_email = ?',
    [email]
  );
  return office ? office.id : null;
}

/**
 * The add-ons each of these PLUs offers, priced.
 *
 * WHY THIS REUSES THE TILL'S MODIFIERS RATHER THAN A TABLE OF ITS OWN
 *
 * A venue already answers "which mixer with that gin?" once, in the back
 * office, and the till already sells the answer as a child line that prices,
 * taxes, prints and reports as what it is. Giving the menu a parallel add-on
 * table would mean the same venue maintaining the same list twice and
 * discovering the difference when a customer is charged one price at the bar
 * and another on their phone.
 *
 * So this reads the same wiring the till reads:
 *
 *   epos_product_modifiers   which questions a product asks, in order
 *   epos_modifier_groups     the question, and how many answers it takes
 *   epos_screen_buttons      the answers -- a group owns a screen of them
 *   bo_products              what each answer costs
 *
 * Returns {} for a venue that has never made a modifier group, which is most
 * of them -- and an item with no groups goes straight into the basket.
 */
async function addOnsFor(db, email, pluIds) {
  if (!email || !pluIds.length) return {};

  const [links] = await db.query(
    'SELECT plu_id, group_id FROM epos_product_modifiers' +
      ' WHERE office = ? AND plu_id IN (' + pluIds.map(() => '?').join(',') + ')' +
      ' ORDER BY plu_id, sort_order',
    [email, ...pluIds]
  );
  if (!links.length) return {};

  const groupIds = [...new Set(links.map((l) => l.group_id))];
  const [groups] = await db.query(
    'SELECT id, name, min_select, max_select, screen_id' +
      '  FROM epos_modifier_groups' +
      ' WHERE office = ? AND id IN (' + groupIds.map(() => '?').join(',') + ')',
    [email, ...groupIds]
  );

  // The answers. A button that names no product, or names one that has since
  // been deleted, is dropped rather than shown as an option that cannot be
  // priced -- a customer must never be offered something the kitchen has no
  // record of.
  const screenIds = groups.map((g) => g.screen_id).filter(Boolean);
  let answers = [];
  if (screenIds.length) {
    const [rows] = await db.query(
      'SELECT b.screen_id, b.plu_id, b.label,' +
        '       COALESCE(NULLIF(TRIM(b.label), ""), p.product_name) AS name,' +
        '       p.price AS price, p.allergens AS allergens' +
        '  FROM epos_screen_buttons b' +
        '  JOIN bo_products p ON p.pluid = b.plu_id AND p.email = ?' +
        ' WHERE b.office = ? AND b.kind = "product"' +
        '   AND b.screen_id IN (' + screenIds.map(() => '?').join(',') + ')' +
        ' ORDER BY b.screen_id, b.grid_row, b.grid_col',
      [email, email, ...screenIds]
    );
    answers = rows;
  }

  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const out = {};
  for (const link of links) {
    const group = byGroup.get(link.group_id);
    if (!group) continue;
    const options = answers
      .filter((a) => a.screen_id === group.screen_id)
      .map((a) => ({
        // What the client sends back. Answers are products, and the basket is
        // priced from the catalogue by PLU -- nothing the client sends about
        // money is trusted.
        plu_id: a.plu_id,
        name: a.name,
        price_minor: Math.round(Number(a.price || 0) * 100),
        allergens: readAllergens(a.allergens),
      }));
    // A group nobody has laid out yet is a question with no answers. The till
    // treats that as nothing to ask and moves on; so does this, rather than
    // showing an empty sheet the customer cannot get past.
    if (!options.length) continue;
    (out[link.plu_id] ||= []).push({
      id: group.id,
      name: group.name,
      min_select: Number(group.min_select) || 0,
      max_select: Number(group.max_select) || 1,
      options,
    });
  }
  return out;
}

/**
 * The venue's curated menu: its active sections, each with its items priced
 * from the live catalogue and the add-ons each item asks about.
 *
 * The price is joined at read time and never stored on the menu row. A menu
 * carrying its own prices is a second price list, and the one that goes stale
 * is always the one the customer is reading.
 */
async function menuSections(db, officeId, email) {
  const [sections] = await db.query(
    'SELECT id, name, blurb, image_url FROM dinein_sections' +
      ' WHERE office_id = ? AND active = 1 ORDER BY sort_order, id',
    [officeId]
  );

  let items = [];
  if (sections.length) {
    const [rows] = await db.query(
      'SELECT i.id, i.section_id, i.plu_id, i.description, i.image_url,' +
        '       i.available, i.is_popular, i.is_featured, i.diet_tag,' +
        '       COALESCE(NULLIF(TRIM(i.name), ""), p.product_name) AS name,' +
        '       i.allergens AS item_allergens,' +
        '       p.allergens AS product_allergens,' +
        '       p.price AS price' +
        '  FROM dinein_items i' +
        '  JOIN bo_products p ON p.pluid = i.plu_id AND p.email = ?' +
        ' WHERE i.section_id IN (' + sections.map(() => '?').join(',') + ')' +
        ' ORDER BY i.sort_order, i.id',
      [email, ...sections.map((s) => s.id)]
    );
    items = rows;
  }

  // The questions each product asks, and the answers with their prices.
  // Resolved here rather than on the client because the answers live in the
  // till's screen machinery, which a menu page and a kiosk have none of.
  const addOns = await addOnsFor(db, email, [...new Set(items.map((i) => i.plu_id))]);

  return sections.map((s) => ({
    ...s,
    items: items
      .filter((i) => i.section_id === s.id)
      .map((i) => ({
        id: i.id,
        plu_id: i.plu_id,
        name: i.name,
        description: i.description,
        image_url: i.image_url,
        available: !!i.available,
        popular: !!i.is_popular,
        featured: !!i.is_featured,
        diet: i.diet_tag || null,
        // What the item declares, or what its product does. NULL on the item
        // means inherit; [] means somebody looked and it contains none of the
        // fourteen. See src/allergens.js.
        allergens: effectiveAllergens(i.item_allergens, i.product_allergens),
        // Whether anybody has answered the question at all, which the array
        // above cannot say: an unanswered dish and a dish that genuinely
        // contains none of the fourteen both arrive as []. "Contains no
        // allergens" and "nobody has filled this in" are different sentences
        // to read with an allergy.
        allergens_declared:
          (i.item_allergens !== null && i.item_allergens !== undefined &&
            i.item_allergens !== '') ||
          (i.product_allergens !== null && i.product_allergens !== undefined &&
            i.product_allergens !== ''),
        add_ons: addOns[i.plu_id] || [],
        price_minor: Math.round(Number(i.price || 0) * 100),
      })),
  }));
}

/** A basket that cannot be priced, with the status and sentence to answer. */
class BasketError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'BasketError';
    this.status = status;
  }
}

/**
 * Price a basket against the live catalogue.
 *
 * `basket` is what the client sent: [{ item_id, qty, note,
 * unavailable_action, add_ons: [plu_id | {item_id}] }]. Returns
 *
 *   { lines, subtotal }
 *
 * where each line is { plu_id, name, qty, unit, tax_percentage, note,
 * unavailable, isModifier, parentIndex, item_id } in reading order -- a dish
 * immediately followed by its add-ons -- and subtotal is in pence. Throws a
 * BasketError for an empty basket, an item that has left the menu, or an item
 * that has sold out: silently dropping one would send somebody food they did
 * not order and leave off the thing they did.
 */
async function priceBasket(db, { officeId, email, basket }) {
  const wanted = new Map();
  for (const line of Array.isArray(basket) ? basket : []) {
    const id = Number(line && line.item_id);
    const qty = Math.max(1, Math.min(99, Number(line && line.qty) || 1));
    if (!Number.isInteger(id) || id <= 0) continue;
    const note = String((line && line.note) || '').trim().slice(0, 300);

    // What to do if the kitchen cannot make it. Per line, because a customer
    // who would lose the side but wants a call about the main course is the
    // ordinary case. Anything unrecognised is 'remove' -- the answer that needs
    // nobody to be reachable. See schema_menu_dinein_ordering.sql.
    const action = String((line && line.unavailable_action) || '')
      .trim()
      .toLowerCase();
    const unavailable = ['remove', 'call', 'refund'].includes(action)
      ? action
      : 'remove';

    // The add-ons chosen against this line, by PLU. Priced from the catalogue
    // below, never from what the client sent.
    const addOns = Array.isArray(line && line.add_ons)
      ? [...new Set(
          line.add_ons
            .map((a) => Number(a && a.item_id !== undefined ? a.item_id : a))
            .filter((n) => Number.isInteger(n) && n > 0)
        )]
      : [];

    // Two of the same item differing in note, add-ons or what to do when it
    // is off are two lines, not one of quantity four. The key carries
    // everything that makes them different.
    const key = [id, note, unavailable, addOns.join('+')].join('|');
    wanted.set(key, { id, qty, note, unavailable, addOns });
  }
  if (!wanted.size) {
    throw new BasketError(400, 'There is nothing in the basket.');
  }

  const ids = [...new Set([...wanted.values()].map((w) => w.id))];
  const [rows] = await db.query(
    'SELECT i.id, i.plu_id, i.available,' +
      '       COALESCE(NULLIF(TRIM(i.name), ""), p.product_name) AS name,' +
      '       i.allergens AS item_allergens, p.allergens AS product_allergens,' +
      '       p.price AS price, p.tax_percentage AS tax_percentage' +
      '  FROM dinein_items i' +
      '  JOIN bo_products p ON p.pluid = i.plu_id AND p.email = ?' +
      ' WHERE i.office_id = ? AND i.id IN (' + ids.map(() => '?').join(',') + ')',
    [email, officeId, ...ids]
  );
  const priced = new Map(rows.map((r) => [r.id, r]));

  // Add-ons are priced against the CATALOGUE, by PLU -- not against
  // dinein_items. An answer to a modifier question is a till product
  // ("Lemonade", "Extra shot"), and those are almost never on the menu as items
  // of their own. Resolving them the way parents are resolved silently dropped
  // every add-on and undercharged the order -- which is what a first pass at
  // this did, and what a live order caught.
  //
  // Restricted to PLUs the menu actually offers as answers, so a crafted
  // request cannot attach an arbitrary product at a price of its choosing.
  const wantedAddOns = [...new Set([...wanted.values()].flatMap((w) => w.addOns))];
  const offered = new Set();
  if (wantedAddOns.length) {
    for (const groups of Object.values(
      await addOnsFor(db, email, [...new Set(rows.map((r) => r.plu_id))])
    )) {
      for (const g of groups) for (const o of g.options) offered.add(o.plu_id);
    }
  }
  const addOnPrices = new Map();
  const allowed = wantedAddOns.filter((plu) => offered.has(plu));
  if (allowed.length) {
    const [addRows] = await db.query(
      'SELECT pluid, product_name, price, allergens, tax_percentage FROM bo_products' +
        ' WHERE email = ? AND pluid IN (' + allowed.map(() => '?').join(',') + ')',
      [email, ...allowed]
    );
    for (const r of addRows) addOnPrices.set(r.pluid, r);
  }

  const lines = [];
  let subtotal = 0;
  for (const want of wanted.values()) {
    const item = priced.get(want.id);
    if (!item) {
      throw new BasketError(
        409,
        'Something on the menu changed while you were ordering. Please check your basket.'
      );
    }
    if (!item.available) {
      throw new BasketError(409, 'Sorry, ' + item.name + ' has just sold out.');
    }
    const unit = Math.round(Number(item.price || 0) * 100);
    subtotal += unit * want.qty;
    lines.push({
      item_id: item.id,
      plu_id: item.plu_id,
      name: item.name,
      qty: want.qty,
      unit,
      tax_percentage: Number(item.tax_percentage) || 0,
      note: want.note || null,
      unavailable: want.unavailable,
      isModifier: false,
      parentIndex: null,
    });
    const parentIndex = lines.length - 1;

    // The add-ons, as child lines naming the parent -- the same shape the till
    // uses, which is why the kitchen ticket and the receipt already indent
    // them.
    for (const addOnPlu of want.addOns) {
      const chosen = addOnPrices.get(addOnPlu);
      // An add-on the menu does not offer, or a product that has since gone,
      // is dropped rather than failing the whole order. The customer loses the
      // extra shot; they do not lose their dinner, and the kitchen sees
      // exactly what is being made.
      if (!chosen) continue;
      const addUnit = Math.round(Number(chosen.price || 0) * 100);
      // Quantity follows the parent, as it does on the till: two double gins
      // want two dashes of coke.
      subtotal += addUnit * want.qty;
      lines.push({
        item_id: null,
        plu_id: chosen.pluid,
        name: chosen.product_name,
        qty: want.qty,
        unit: addUnit,
        tax_percentage: Number(chosen.tax_percentage) || 0,
        note: null,
        unavailable: want.unavailable,
        isModifier: true,
        parentIndex,
      });
    }
  }

  return { lines, subtotal };
}

/**
 * The VAT inside a set of VAT-inclusive lines, in pence.
 *
 * UK menu prices include VAT, so the tax is the part of each line's gross that
 * the rate accounts for: gross x rate / (100 + rate). Worked per line and
 * rounded once at the end, so a basket of twelve items does not collect twelve
 * roundings.
 */
function inclusiveTax(lines) {
  let tax = 0;
  for (const l of lines) {
    const rate = Number(l.tax_percentage) || 0;
    if (rate <= 0) continue;
    tax += (l.unit * l.qty * rate) / (100 + rate);
  }
  return Math.round(tax);
}

module.exports = {
  emailOfOffice,
  officeIdOf,
  addOnsFor,
  menuSections,
  priceBasket,
  inclusiveTax,
  BasketError,
};
