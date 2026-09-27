/**
 * What selling (or wasting) one product actually takes off the shelf.
 *
 * Usually the product itself. But since 2026-09-22 two kinds of product stand
 * for OTHER products' stock, both things Newbridge did and the venue asked for:
 *
 *   A RECIPE -- a cocktail made of spirits and mixers. Selling one takes each
 *   ingredient off by its measure: two Aperol Spritzes take 2 x 50ml of Aperol
 *   and 2 x 75ml of prosecco. The cocktail has no shelf of its own.
 *
 *   A LINKED PRODUCT -- a half pint sells from the pint, a 175ml glass from the
 *   bottle. Selling one takes quantity x ratio off the parent: three half
 *   pints are 1.5 pints of the keg. The child has no shelf of its own.
 *
 * A recipe wins over a link where a product somehow has both, because a recipe
 * is the more specific statement of what it is made of. Both can nest -- a
 * recipe may list a linked product, which sells from its parent -- to a depth
 * of three, which is deeper than any real bar menu and shallow enough that a
 * cycle (a recipe that names itself) cannot run away. A product seen twice on
 * one path stops there rather than looping.
 *
 * This only answers WHICH products and HOW MUCH. Whether a target is counted
 * at all (a NULL stock_quantity means nobody counts it) is the caller's rule,
 * unchanged: sales.js and the document completion both keep it.
 */

const MAX_DEPTH = 3;

/**
 * @param conn   a connection or pool (anything with .query)
 * @param office the venue (bo_products.email / bo_recipe_lines.office)
 * @param pluid  the product sold or wasted
 * @param qty    how many of it
 * @returns [{ pluid, qty, via }] -- `via` names the product that caused the
 *          movement when it is not the target itself, for the ledger's reason.
 */
async function stockTargets(conn, office, pluid, qty, { depth = 0, via = null, seen = new Set() } = {}) {
  const key = Number(pluid);
  if (depth > MAX_DEPTH || seen.has(key)) return [{ pluid: key, qty, via }];
  const path = new Set(seen).add(key);

  const [lines] = await conn.query(
    `SELECT ingredient_pluid, quantity
       FROM bo_recipe_lines
      WHERE office = ? AND recipe_pluid = ?
      ORDER BY sort_order, created_at`,
    [office, key]
  );
  const [[product]] = await conn.query(
    `SELECT product_name, stock_parent_pluid, stock_ratio
       FROM bo_products WHERE email = ? AND pluid = ? LIMIT 1`,
    [office, key]
  );
  const name = (product && product.product_name) || `PLU ${key}`;

  if (lines.length) {
    const out = [];
    for (const line of lines) {
      const each = Number(line.quantity);
      if (!Number.isFinite(each) || each <= 0) continue;
      // eslint-disable-next-line no-await-in-loop -- a recipe has a handful of lines
      out.push(...await stockTargets(conn, office, line.ingredient_pluid, qty * each, {
        depth: depth + 1, via: via || name, seen: path,
      }));
    }
    return out;
  }

  const parent = product && Number(product.stock_parent_pluid);
  const ratio = product && Number(product.stock_ratio);
  if (parent && Number.isFinite(ratio) && ratio > 0 && parent !== key) {
    return stockTargets(conn, office, parent, qty * ratio, {
      depth: depth + 1, via: via || name, seen: path,
    });
  }

  return [{ pluid: key, qty, via }];
}

/**
 * Several products' targets, with the same product's quantities summed, so a
 * sale of two different cocktails that share a spirit writes one movement for
 * it per cause rather than a flurry. Order is kept as first seen.
 */
function mergeTargets(targets) {
  const out = new Map();
  for (const t of targets) {
    const k = `${t.pluid}|${t.via || ''}`;
    const had = out.get(k);
    if (had) had.qty += t.qty;
    else out.set(k, { ...t });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// How many more can be made (2026-09-27)
// ---------------------------------------------------------------------------
//
// The other side of stockTargets: not "what does selling one take off?" but
// "how many can we still sell?". The kitchen screen, the till, the back office,
// and -- since the QR menu and the kiosk sell with nobody behind the counter to
// say "we're out" -- the menus all ask it, so it is answered here once.
//
//   * A product nobody counts (stock_quantity NULL) or marked non-stock: no
//     limit (null).
//   * A linked product (a half, a glass): its parent's shelf over the ratio.
//   * A recipe: whichever ingredient runs out first. An uncounted ingredient
//     does not limit it.
//   * Anything else: its own count, never below zero.
//
// Same depth and cycle rule as stockTargets.

/** Units of `pluid` the shelf still holds, unrounded; null when unlimited. */
function onHand(pluid, byPlu, recipes, depth = 0, seen = new Set()) {
  const key = Number(pluid);
  const p = byPlu.get(key);
  if (!p || depth > MAX_DEPTH || seen.has(key)) return null;
  if (Number(p.non_stock)) return null;
  const path = new Set(seen).add(key);
  const lines = recipes.get(key);
  if (lines && lines.length) {
    let best = null;
    for (const l of lines) {
      const each = Number(l.quantity);
      if (!Number.isFinite(each) || each <= 0) continue;
      const s = onHand(l.ingredient_pluid, byPlu, recipes, depth + 1, path);
      if (s === null) continue;
      const n = Math.max(0, s) / each;
      best = best === null ? n : Math.min(best, n);
    }
    return best;
  }
  const parent = Number(p.stock_parent_pluid);
  const ratio = Number(p.stock_ratio);
  if (parent && parent !== key) {
    if (!(Number.isFinite(ratio) && ratio > 0)) return null;
    const s = onHand(parent, byPlu, recipes, depth + 1, path);
    return s === null ? null : Math.max(0, s) / ratio;
  }
  if (p.stock_quantity === null || p.stock_quantity === undefined || p.stock_quantity === '') return null;
  const own = Number(p.stock_quantity);
  return Number.isFinite(own) ? Math.max(0, own) : null;
}

/**
 * How many whole ones of a product can still be made; null when nothing
 * limits it. `byPlu` maps pluid to a bo_products row (stock_quantity,
 * non_stock, stock_parent_pluid, stock_ratio); `recipes` maps a recipe's
 * pluid to its bo_recipe_lines.
 */
function canMake(pluid, byPlu, recipes) {
  const n = onHand(pluid, byPlu, recipes);
  return n === null ? null : Math.max(0, Math.floor(n + 1e-9));
}

const schemaMissing = (e) =>
  e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054);

/**
 * canMake for several products of one venue, read in two queries. Returns a
 * Map of pluid -> whole number left, holding only the products something
 * limits. A server that has not run the stock schema yet limits nothing.
 */
async function canMakeMany(db, office, pluids) {
  const out = new Map();
  if (!pluids || !pluids.length) return out;
  let rows;
  let lines = [];
  try {
    [rows] = await db.query(
      'SELECT pluid, stock_quantity, non_stock, stock_parent_pluid, stock_ratio FROM bo_products WHERE email = ?',
      [office]
    );
  } catch (e) {
    if (schemaMissing(e)) return out;
    throw e;
  }
  try {
    [lines] = await db.query(
      'SELECT recipe_pluid, ingredient_pluid, quantity FROM bo_recipe_lines WHERE office = ? ORDER BY sort_order, created_at',
      [office]
    );
  } catch (e) {
    if (!schemaMissing(e)) throw e;
  }
  const byPlu = new Map((rows || []).map((r) => [Number(r.pluid), r]));
  const recipes = new Map();
  for (const l of lines || []) {
    const k = Number(l.recipe_pluid);
    if (!recipes.has(k)) recipes.set(k, []);
    recipes.get(k).push(l);
  }
  for (const plu of new Set(pluids.map(Number))) {
    const n = canMake(plu, byPlu, recipes);
    if (n !== null) out.set(plu, n);
  }
  return out;
}

module.exports = { stockTargets, mergeTargets, canMake, canMakeMany, MAX_DEPTH };
