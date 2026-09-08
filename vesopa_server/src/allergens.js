/**
 * The fourteen allergens a UK venue has to be able to declare.
 *
 * Fixed by the Food Information Regulations 2014, which is what makes a closed
 * list the right shape here: the set does not drift, so a code can mean the
 * same thing in the back office, on the QR menu, on a kitchen ticket and on the
 * customer display.
 *
 * ONE LIST, IN ONE PLACE
 *
 * Four surfaces show these. If each carried its own copy, one of them would
 * eventually say "Nuts" where another said "Tree nuts", and a customer with an
 * allergy would be reading two different answers to the same question. So the
 * labels live here and are served to anything that needs them; nothing
 * hardcodes its own spelling.
 *
 * WHY NOT FREE TEXT
 *
 * Free text cannot be filtered on, cannot be translated, and cannot be drawn as
 * a consistent chip. It also cannot be checked: "no nuts" typed into a box is
 * indistinguishable from nobody having answered. A venue that needs to say
 * something outside the fourteen says it in the product description, which is
 * where prose belongs.
 *
 * NULL vs [] — see schema_product_allergens.sql. NULL is "nobody has said",
 * [] is "somebody looked and it contains none of them". They are different
 * facts and the difference is the point.
 */

/** The fourteen, in the order the FSA lists them. */
const ALLERGENS = Object.freeze([
  { code: 'celery', label: 'Celery' },
  { code: 'gluten', label: 'Cereals containing gluten' },
  { code: 'crustaceans', label: 'Crustaceans' },
  { code: 'eggs', label: 'Eggs' },
  { code: 'fish', label: 'Fish' },
  { code: 'lupin', label: 'Lupin' },
  { code: 'milk', label: 'Milk' },
  { code: 'molluscs', label: 'Molluscs' },
  { code: 'mustard', label: 'Mustard' },
  { code: 'peanuts', label: 'Peanuts' },
  { code: 'sesame', label: 'Sesame' },
  { code: 'soya', label: 'Soya' },
  { code: 'sulphites', label: 'Sulphur dioxide and sulphites' },
  { code: 'tree_nuts', label: 'Tree nuts' },
]);

const BY_CODE = new Map(ALLERGENS.map((a) => [a.code, a]));

/**
 * Clean what a client sent into something storable, or null.
 *
 * Returns null for "nobody has said" and a JSON array string otherwise —
 * including '[]', which is a real answer meaning "none of the fourteen".
 *
 * Unknown codes are dropped rather than refused. A back office one release
 * ahead of a till must not make the till unable to save a product; the worst
 * case is a code that nothing can render being quietly ignored, which is
 * better than a save that fails with nothing useful to say.
 */
function cleanAllergens(value) {
  if (value === null || value === undefined || value === '') return null;

  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      // A comma-separated string is what a form post looks like before
      // anybody has thought about it. Accept it rather than lose the answer.
      list = list.split(',');
    }
  }
  if (!Array.isArray(list)) return null;

  const codes = [];
  for (const raw of list) {
    const code = String(raw ?? '').trim().toLowerCase();
    if (BY_CODE.has(code) && !codes.includes(code)) codes.push(code);
  }
  // Stored in the canonical order, not the order they were ticked, so two
  // products with the same allergens compare equal as strings.
  codes.sort(
    (a, b) =>
      ALLERGENS.findIndex((x) => x.code === a) -
      ALLERGENS.findIndex((x) => x.code === b)
  );
  return JSON.stringify(codes);
}

/**
 * Read a stored column back into an array of codes.
 *
 * Always an array — an unreadable column reads as "nobody has said" rather
 * than throwing, because a product row with a bad byte in it must not take
 * down the menu that lists it.
 */
function readAllergens(stored) {
  if (stored === null || stored === undefined || stored === '') return [];
  try {
    const list = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!Array.isArray(list)) return [];
    return list.map((c) => String(c)).filter((c) => BY_CODE.has(c));
  } catch {
    return [];
  }
}

/** Codes to labels, for anything that draws them. */
function labelsFor(codes) {
  return readAllergens(codes).map((c) => BY_CODE.get(c).label);
}

/**
 * What a menu item declares: its own answer, or the catalogue's.
 *
 * NULL on the item means "inherit", so a venue fills the catalogue in once and
 * only overrides the rare item whose menu entry differs from the product row
 * it points at. '[]' on the item is an override meaning none.
 */
function effectiveAllergens(itemStored, productStored) {
  if (itemStored === null || itemStored === undefined || itemStored === '') {
    return readAllergens(productStored);
  }
  return readAllergens(itemStored);
}

module.exports = {
  ALLERGENS,
  cleanAllergens,
  readAllergens,
  labelsFor,
  effectiveAllergens,
};
