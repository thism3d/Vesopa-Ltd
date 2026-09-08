# tasks.md — QR menu add-ons, allergens, notifications, kitchen/till accept — build plan

## Scale honesty

This is more than one sitting. It touches one schema, one server, one 4,544-line template literal, and three Flutter apps, and ends in three Store submissions. Every phase below is a safe stop point: commit and deploy at the end of a phase and the system is consistent.

- Phases A+B ship server + back-office value only (server deploy, no Store).
- Phases C+D ship the customer-facing QR menu changes (server deploy only — the QR page is served by the server, so no app release is needed for the bulk of the brief).
- Phases E, F, G change the Flutter apps and require msix builds.
- Phase H is the release. Only stop mid-phase if a task is fully done; never stop halfway through a task that edits `dinein_pages.js`.

## Order of work

A → B → C → D → deploy server → E, F, G (independent of each other, any order) → H.

## Decisions taken (so the executor does not re-litigate)

- **D1 — Add-ons reuse the existing modifier machinery** (`epos_modifier_groups`, `epos_product_modifiers`, screens with `surface='modifier'`). The till already sells these as child lines with `parentLineId`, and receipt, kitchen and display already indent them. One configuration serves till and QR menu; that is what "configurable options completely" means. No parallel add-on table.
- **D2 — Add-ons on QR orders are stored as child rows in `dinein_order_lines`** with new columns `parent_line_id` and `is_modifier`, mirroring the till model. No new order table.
- **D3 — Allergens are the fixed UK 14-allergen list**, stored as JSON arrays of codes. Canonical home is `bo_products.allergens`; `dinein_items.allergens` is a per-menu override (`NULL` = inherit from the linked product, `[]` = explicitly none); `epos_kitchen_ticket_lines.allergens` is a snapshot taken at ticket ingest so kitchen works offline. Labels come from one shared server module; apps never hardcode the list.
- **D4 — Notifications use `local_notifier`** (pure Dart, works from msix on Windows, no method-channel fragility on the low-end kitchen device). Central control is a set of new till-settings columns; each app also gets a local toggle. Effective = back-office master AND per-event column AND app-local toggle.
- **D5 — "If this product is not available" is a per-line choice** (`remove` default, `call`, `refund`), stored on `dinein_order_lines.unavailable_action`, chosen in the product sheet.
- **D6 — Tapping an item's name or image always opens the product sheet.** Tapping `+` adds directly only when the item has no add-on groups; otherwise `+` opens the sheet. The sheet is add-only; quantity edits happen via the badge pill.
- **D7 — Table can be re-picked at any time; the basket is kept.** One tap on the table pill reopens the picker.
- **D8 — Meta tags: three nullable columns on `dinein_venue`.** `NULL` means "use today's derived value". No behaviour change for venues that never touch the fields.
- **D9 — The display app gets notification capability but default OFF** (it is a customer-facing screen).
- **D10 — Autofocus is removed from the kitchen app entirely, and from the QR checkout form.** Focus only follows a user tap.
- **D11 — Add-on prices are always recomputed server-side from the PLU.** Client-sent prices are ignored.
- **D12 — "Frequently bought together" and group ordering in the screenshots are out of scope.** The brief does not ask for them.

## Global traps (read before touching anything)

1. **`vesopa_server/src/dinein_pages.js` is one template literal.** A backtick anywhere in the string — including comments — ends the literal and breaks the served page. Backslash escapes are eaten: `\s` arrives at the browser as `s`, `\d` as `d`. Use `[0-9]`, `[ ]`, `[A-Za-z0-9_]` in client-side regexes. To emit a literal `${` write `\${`. After EVERY edit to this file run `cd vesopa_server && npm test` — the guard test `test/dinein-stylesheet.test.js` exists because this has shipped bugs before.
2. **Migrations are replayed on every deploy** in `sort` order. Every migration must be guarded by an `information_schema` check and must sort after the file that creates the table it alters. Before naming a new file, run `ls vesopa_server/schema` and use the next numeric prefix above the highest existing one — that guarantees correct ordering. Mirror the guard style of an existing column-adding migration (`grep -l information_schema vesopa_server/schema`).
3. **Live testing:** sign in only as the account in `.env.claude-tools` (`VESOPA_TEST_EMAIL`) at `https://backoffice.vesopaepos.com`. Every other user is a paying customer. Delete test data by the ids you inserted, never by name.
4. **Store versions cannot be reused.** Bump both `version:` and `msix_config.msix_version` before every msix build.
5. **Till tests:** 3 known failures (`dojo_accreditation_live_test`, `dojo_terminal_live_test`, `programmed_grid_golden_test`). Do not chase them.

---

## PHASE A — Schema and server foundations

### T1 — Order-line modifier and availability columns

- **Ask:** QR orders must carry add-ons ("kitchen app needs to know that") and a per-product not-available choice ("By default remove that product is selected").
- **Files:** new `vesopa_server/schema/<NN>_dinein_line_modifiers.sql` (NN = next prefix, sorts after the files creating `dinein_orders` and `dinein_order_lines` — find them with `grep -l "CREATE TABLE.*dinein_order" vesopa_server/schema`).
- **Schema (guarded, re-runnable):**
  - `dinein_order_lines ADD parent_line_id INT NULL` (references the parent line's `id`; no FK constraint, matching the till's loose `line_no` approach)
  - `dinein_order_lines ADD is_modifier TINYINT(1) NOT NULL DEFAULT 0`
  - `dinein_order_lines ADD unavailable_action VARCHAR(16) NOT NULL DEFAULT 'remove'` — allowed values `remove`, `call`, `refund`
- **API:** none (consumed by T6).
- **UI:** none.
- **Test:** apply twice against the live-style local DB; second run is a no-op. Covered indirectly by T6 tests.
- **Done:** file sorts last in `ls vesopa_server/schema`, runs repeatedly without error, columns present.

### T2 — Allergen columns and the shared allergen list

- **Ask:** "Allergens options needed as well. In back office, display app, kitchen view and qr menu."
- **Files:**
  - new `vesopa_server/schema/<NN>_allergens.sql`
  - new `vesopa_server/src/allergens.js` — exports `ALLERGENS`, the fixed list of 14 `{code, label}`: `celery` Celery, `gluten` Cereals containing gluten, `crustaceans` Crustaceans, `eggs` Eggs, `fish` Fish, `lupin` Lupin, `milk` Milk, `molluscs` Molluscs, `mustard` Mustard, `peanuts` Peanuts, `sesame` Sesame, `soya` Soya, `sulphites` Sulphites, `tree_nuts` Tree nuts.
- **Schema (guarded):** `bo_products ADD allergens <json-type> NULL`; `dinein_items ADD allergens <json-type> NULL`; `epos_kitchen_ticket_lines ADD allergens <json-type> NULL`. Use the same column type as the existing `dinein_venue.theme_json` column for consistency.
- **API:** new public route `GET /api/allergens` → `{"allergens":[{code,label}, …]}` served from `src/allergens.js`. Add it in `src/backoffice.js` next to the other unauthenticated utility routes. No auth — it is a static list and the kitchen app needs it.
- **UI:** none (Phase B).
- **Test:** new `vesopa_server/test/allergens.test.js` — route returns 14 entries, codes unique, and the module is the same object the route serves.
- **Done:** `npm test` passes; `curl https://backoffice.vesopaepos.com/api/allergens` after deploy returns the list.

### T3 — Venue meta columns

- **Ask:** "The meta description and meta other tags are missing and is configurable from the back office check too." (They are derived today; make them editable with derived fallbacks.)
- **Files:** new `vesopa_server/schema/<NN>_dinein_venue_meta.sql`.
- **Schema (guarded):** `dinein_venue ADD meta_title VARCHAR(255) NULL`, `ADD meta_description TEXT NULL`, `ADD meta_image_url VARCHAR(512) NULL` (mirror the type of `logo_url`).
- **API:** the venue save route used by the back-office `/dine-in` page must whitelist the three new columns. Locate it by searching `vesopa_server/src/dinein.js` for the route that updates `dinein_venue` (it is the one `public/app.js` calls from the `/dine-in` form). Add the three names to its accepted-fields list. NULL/empty string stores NULL.
- **UI:** Phase B (T12), Phase C (T16).
- **Test:** extend/create `vesopa_server/test/dinein-meta.test.js` — PUT venue with `meta_description` set, row stores it; PUT with empty string stores NULL.
- **Done:** columns round-trip through the save route.

### T4 — Centralised notification settings

- **Ask:** "Microsoft native notifications … controlled from the back office or from the settings or the apps … give centralized option in the back office. Kitchen app, till notifications sound should be controlled from the apps and also from the back office."
- **Files:** new `vesopa_server/schema/<NN>_notify_settings.sql`; `vesopa_server/src/backoffice.js` (`TILL_FIELDS`, `TILL_DEFAULTS`).
- **Schema:** the columns go on the table that `TILL_FIELDS` in `src/backoffice.js` maps to (find it there; do not assume a name). All `TINYINT(1) NOT NULL DEFAULT …`, guarded:

  | column | default | meaning |
  |---|---|---|
  | `notify_master` | 1 | master switch, all apps |
  | `notify_till_dinein_new` | 1 | toast on till when a QR order is placed |
  | `notify_kitchen_dinein_new` | 1 | toast on kitchen when a QR order is placed |
  | `notify_kitchen_ticket_new` | 1 | toast on kitchen when a till sends a kitchen ticket |
  | `notify_till_sound` | 1 | till toast sound |
  | `notify_kitchen_sound` | 1 | kitchen toast sound |
  | `notify_display_enabled` | 0 | display app toasts (D9) |

- **API:** add the seven names to `TILL_FIELDS` and `TILL_DEFAULTS` so `PUT /api/till-settings` accepts them and `GET` returns them. No new route.
- **UI:** Phase B (T13).
- **Test:** new `vesopa_server/test/till-settings-notify.test.js` — PUT each key, GET returns it; a key not in `TILL_FIELDS` is still rejected (existing whitelist behaviour intact).
- **Done:** settings round-trip; `npm test` green.

### T5 — Add-ons read API for the QR menu

- **Ask:** "Add ons can be added to each product from the back office and each price can be set, add ons open before the product add."
- **Files:** `vesopa_server/src/dinein.js`.
- **API:** new route `GET /api/dinein/:slug/items/:itemId/addons`

  Response 200:
  ```
  { "item": { "id": 123, "plu_id": 45 },
    "groups": [
      { "id": 7, "name": "Add Ons for Pasta", "min_select": 0, "max_select": 1,
        "options": [ { "plu_id": 91, "name": "Extra White Sauce", "price_minor": 15 } ] }
    ] }
  ```
  404 for unknown slug/item or unpublished venue (same behaviour as the existing menu route).
- **Resolution logic (D1):** `dinein_items.id` → `dinein_items.plu_id` → rows of `epos_product_modifiers` for `(office, plu_id)` ordered by `sort_order` → join `epos_modifier_groups` for name/min/max → resolve each group's `screen_id` to its buttons using the SAME server read path the till uses to fetch modifier screens — find it with `grep -rn "modifier" vesopa_server/src` where screens are served; do not build a parallel query. Each button's PLU gives `name` and `price_minor` from the same price source the till displays on modifier buttons. `price_minor` is computed here, never taken from the client (D11).
- **UI:** consumed by T19.
- **Test:** new `vesopa_server/test/dinein-addons.test.js` — seed office, product, group (`min_select 0 max_select 1`), modifier screen with two priced buttons, link via `epos_product_modifiers`, seed `dinein_items` row; assert response shape, order by `sort_order`, and prices from PLUs. Assert 404 for another office's item.
- **Done:** test passes; live check in T28.

### T6 — Order placement with add-ons, line note, availability action

- **Ask:** add-ons and special instructions must reach the order, the till and the kitchen.
- **Files:** `vesopa_server/src/dinein.js` (the existing place-order route — find the URL by locating `fetch(` with method POST in `dinein_pages.js`); possibly `src/allergens.js` (no change).
- **API:** extend the existing line objects in the POST body:
  ```
  { "plu_id": 45, "qty": 2,
    "note": "no mayo",                    // line note already has a column; accept it if not already accepted
    "unavailable_action": "remove",       // 'remove' | 'call' | 'refund'; default 'remove'; 400 on anything else
    "modifiers": [ { "plu_id": 91, "qty": 1 } ] }
  ```
  Server behaviour:
  1. Resolve the product's groups exactly as T5. Every `modifiers[].plu_id` must be an option of one of those groups, else 400.
  2. Enforce `min_select`/`max_select` per group (count summed modifier qty per group), else 400.
  3. Compute each modifier's `unit_price_minor` from the PLU (D11). Insert parent line, then child lines with `parent_line_id`, `is_modifier=1`, name/price snapshots, child's `note` NULL.
  4. `total_minor` includes children. Response keeps its existing shape; if it returns lines, include children.
  5. **Kitchen visibility:** if placement already creates kitchen tickets today (`grep -n kitchen vesopa_server/src/dinein.js`), extend that payload so child lines are included flagged as modifiers. If it does not, create the ticket here by calling the same internal function the till's sale path uses to create kitchen tickets (locate the route that INSERTs into `epos_kitchen_ticket_lines` and reuse its handler logic), with `is_modifier=1` on children. This is decided, not optional: the brief requires kitchen to see QR orders.
- **UI:** consumed by T19.
- **Test:** new `vesopa_server/test/dinein-order-modifiers.test.js` — place order with valid modifiers: child rows exist with correct `parent_line_id`, `is_modifier`, server-side prices, correct `total_minor`; unknown modifier plu → 400; exceeding `max_select` → 400; `unavailable_action: 'bogus'` → 400; `note` stored on the line.
- **Done:** tests pass; the order rows are visible in `dinein_order_lines` with children.

### T7 — Menu payload: allergens and image URLs

- **Ask:** allergens on the QR menu; images must load.
- **Files:** `vesopa_server/src/dinein.js` (the route that returns sections/items to the menu page).
- **API:** each item gains `"allergens": ["milk","gluten"]` — parse `dinein_items.allergens`; if NULL, fall back to `bo_products.allergens` via `plu_id` (D3). Join `bo_products` the same way existing code joins it (`grep -n "bo_products" vesopa_server/src/dinein.js`). Also guarantee `image_url` is absolute (prefix the request origin if stored relative) and trimmed.
- **UI:** consumed by Phase C/D.
- **Test:** extend `vesopa_server/test/dinein-allergens.test.js` (new) — item with own allergens returns them; item with NULL returns the product's; item with `[]` returns `[]` (explicitly none).
- **Done:** menu JSON carries codes; no relative image URLs.

### T8 — Live dine-in order events

- **Ask:** kitchen and till must react to new QR orders (accept, notify).
- **Files:** `vesopa_server/src/dinein.js`; whatever file implements the server end of the kitchen app's `data/live_link.dart` channel — read `vesopa_epos_kitchen/lib/data/live_link.dart` for the URL, then find the matching route in `vesopa_server/src`.
- **API:** when an order is placed, and when its status changes, publish on the existing channel: `{ "type": "dinein_order", "office_id": …, "order": { "public_id", "table_label", "customer_name", "status", "total_minor", "placed_at" } }`. If the channel turns out to be poll-based, skip this task and rely on polling in T23/T25 — record which in the commit message.
- **Test:** unit-test that the emit helper is invoked on placement (stub the channel). 
- **Done:** event fires on place and on status change.

### T9 — Accept/reject route usable by the apps

- **Ask:** "giving the kitchen app an option to accept the order and also option to accept from the till."
- **Files:** `vesopa_server/src/dinein.js`.
- **API:** the back-office `/dine-in/orders` page already changes order status — find the route by searching `public/app.js` for `accepted`. Reuse that exact route; do not create a parallel one. Extend its auth so that, in addition to the back-office session, a kitchen app token or till token for the same `office_id` may set `status` to `accepted` or `rejected` (with optional `status_note`). Kitchen sign-in is server-side already (`vesopa_epos_kitchen/lib/data/kitchen_session.dart` talks to it) — find that auth middleware and apply it.
- **Test:** extend `vesopa_server/test/dinein-order-modifiers.test.js` or new `dinein-accept.test.js` — kitchen-scoped token can accept an order in its office; cannot touch another office's order; invalid transition is rejected as the route rejects today.
- **Done:** both app credentials can accept/reject; back office still works.

---

## PHASE B — Back office

### T10 — Allergen editors (product form and dine-in item form)

- **Ask:** "Allergens options needed … In back office."
- **Files:** `vesopa_server/public/app.js`, `vesopa_server/public/style.css`.
- **UI:** product form fields are declared as the existing `{label,name,type,value,hint}` array. Add a new field type `'allergens'` to the form renderer: it fetches `GET /api/allergens` once and renders 14 checkboxes in two columns; checked state comes from the JSON array value; saving submits a JSON array of codes. Add `{label:'Allergens', name:'allergens', type:'allergens', hint:'Shown in the QR menu, on kitchen tickets and on the customer display.'}` to the `bo_products` form — the product save route must accept the new column (find the product update route's field whitelist where `is_modifier`/`barcode` are accepted, and add `allergens`). Add the same field to the dine-in menu item form saving `dinein_items.allergens`, with hint `'Leave empty to inherit from the linked product. Tick none to show no allergens.'`
- **Test:** manual in back office: tick Milk + Gluten on a product, save, reload, still ticked; check DB stores `["milk","gluten"]`.
- **Done:** both forms round-trip; QR menu API (T7) reflects saved values.

### T11 — Add-ons configuration: reuse, plus hint

- **Ask:** "Add ons can be added to each product from the back office and each price can be set."
- **Files:** `vesopa_server/public/app.js`.
- **UI:** the product form already has a field of `type:'modifiers'` editing `epos_product_modifiers`, and prices live on the PLUs. No new editor. Change its hint to: `'Also shown in the QR menu as Add Ons, asked before the item is added. Prices come from the products on the modifier screen.'` Nothing else. `screens.js` needs no change.
- **Done:** hint renders; existing modifier editing unchanged.

### T12 — Meta tag fields on the venue form

- **Files:** `vesopa_server/public/app.js` (`/dine-in` page).
- **UI:** add three fields to the venue form: `meta_title` (text, hint `'Leave blank to use the venue name.'`), `meta_description` (text, hint `'Leave blank to use the tagline. Shown in search results and link previews.'`), `meta_image_url` (use existing `type:'image'`, hint `'Leave blank to use the banner, then the logo.'`). Save via the route whitelisted in T3.
- **Done:** fields save and reload; NULLs when blank.

### T13 — Notification matrix UI

- **Files:** `vesopa_server/public/app.js` (the settings page whose inputs carry `data-idle`), `vesopa_server/public/style.css`.
- **UI:** new section "Notifications" on that page. Inputs bind with `data-idle` to the T4 columns, so saving flows through the existing `PUT /api/till-settings` path with no new plumbing:
  - Master: checkbox `notify_master` — "Windows notifications in all apps".
  - Events: `notify_till_dinein_new` "New QR order — Till", `notify_kitchen_dinein_new` "New QR order — Kitchen", `notify_kitchen_ticket_new` "New kitchen ticket from till — Kitchen".
  - Sound: `notify_till_sound` "Till sound", `notify_kitchen_sound` "Kitchen sound".
  - Display: `notify_display_enabled` "Customer display notifications (default off)".
  Each with a `.field-hint` line. Group with subheadings "Events", "Sound", "Display".
- **Done:** toggles round-trip through save/load; apps read them in Phases E–G.

---

## PHASE C — QR menu visual fixes (`vesopa_server/src/dinein_pages.js`)

Run `cd vesopa_server && npm test` after EVERY task in this phase (template-literal guard, trap 1). All selectors below must be located by searching the file; line numbers drift.

### T14 — Product images load and render at quality

- **Ask:** "products with images are not loading not showing me the quality."
- **Diagnose first, against live using the test venue:** fetch the menu JSON (T7 route), `curl -I` every `image_url` — expect 200 and an `image/*` content-type; open the page and collect console/network failures. Likely suspects, in order: relative URLs (fixed by T7), CSS mangled by eaten backslashes in an inline `background-image`, mixed http/https.
- **Fix:** render images as `<img>` (not CSS background) with `object-fit: cover; width:100%; height:100%; display:block;` inside a fixed-aspect container; add `loading="lazy"` and `decoding="async"`. Use the original `image_url`; do not downscale in markup beyond the card size.
- **Done:** live test venue menu shows every image, no 404s in the network tab, images fill their frames without distortion.

### T15 — Logo: remove white surround, circular cover crop

- **Ask:** "logo behind showing a white background around it remove that white big border … show that image logo in the circle and show cover centering the image."
- **Files:** `dinein_pages.js` — find the logo markup/CSS via `logo_url`.
- **UI:** container `border-radius:50%; overflow:hidden; background:none; padding:0; border:0; box-shadow:none;` at its current size; inner `<img>` `width:100%; height:100%; object-fit:cover; object-position:center;`. If a specific uploaded logo itself contains a white matte, `object-fit:cover` with the square crop will trim the edges — that is acceptable and noted, not a code problem.
- **Done:** circular logo, image fills the circle, no white ring on the live test venue.

### T16 — Meta tags from venue columns

- **Files:** `dinein_pages.js` (head section; the tags already exist in derived form).
- **Change:** description content becomes `meta_description` if set else the current derived expression; `og:title`/`twitter:title` use `meta_title` if set else current; `og:image`/`twitter:image` use `meta_image_url` if set else the current fallback chain. Keep `robots`, `canonical`, `og:type`, `og:url`, `twitter:card` as-is.
- **Test:** `test/dinein-meta.test.js` — render with `meta_description` set: served HTML contains it; with NULL: contains the tagline-derived value.
- **Done:** `view-source:` on the live test venue shows the custom values after T12 data is saved.

### T17 — Table picker: arrow, attention animation, changeable

- **Ask:** "Tap to say which table you're at should show an arrow icon to the right and also show growing background colours … Once a table is picked it cannot be changed … Give an option for that."
- **Files:** `dinein_pages.js` — markup near the existing `'<span class="dot"></span>Tap to say which table you are at'` (~line 1896).
- **UI:**
  - Right-align a `›` span inside the pill (no icon font dependency).
  - Attention animation, pure CSS keyframes on the pill, infinite, 1.6s: background pulses between the venue `accent_colour` at 15% and 45% opacity, with a matching soft box-shadow growing and shrinking. Use `rgba()` values computed server-side from `accent_colour` when the page is rendered (it is already injected for theming).
  - After a table is chosen the pill reads `At table {label} · change ›` and remains tappable; tapping reopens the same picker at any time (D7). Picking a new table updates the state wherever it is stored today; the basket is kept; no confirm dialog.
- **Done:** pulse visible, arrow visible, table re-pickable before and after an order is placed; guard test passes.

---

## PHASE D — QR menu basket and product sheet (`dinein_pages.js`)

Guard test after every task. No backticks, no backslash escapes, character classes only.

### T18 — Quantity badge expand animation

- **Ask:** "Once plus button is clicked it expands with an animation to view the quantity and add and subtract buttons … That number will work like a plus button animation expansion." Reference: foodpanda screenshots 1–6.
- **Behaviour, exactly:**
  - Text-only rows: a 32px circular button on the right. Not in basket: outline circle with `+`. In basket: solid dark filled circle showing the quantity. Nothing else on the row moves in any state.
  - Image cards (list and the 2-column "Popular" grid): identical badge, absolutely positioned bottom-right on the image; the image container gets `position:relative`.
  - Tapping the number expands the circle horizontally in place into a white pill (~112px) over 180ms ease (animate `width`; opacity-fade the inner controls): left button is a bin icon when qty is 1, a `−` when qty > 1; centre is the quantity; right is `+`. Bin at qty 1 removes the line and the badge returns to `+`. The pill stays open until the user taps elsewhere on the page or taps the quantity again.
  - `+` on an item WITH add-on groups opens the product sheet (T19, D6) instead of incrementing; `+` on an item without groups increments with the same pop.
  - Bin icon: inline SVG trash, currentColor. No emoji, no icon font.
- **Implementation:** one JS state function `setQty(itemId, qty)` that all three layouts call; badge markup generated by one function so text rows, image cards and grid cards cannot drift apart. CSS transitions only — this page must stay light.
- **Test:** manual against live test venue plus guard test. Checklist: text row + → number → pill → bin back to `+`; image card identical; grid card identical; row layout of neighbours never shifts.
- **Done:** matches screenshots 1–6 behaviourally.

### T19 — Product sheet: add-ons, dietary, special instructions, availability

- **Ask:** "add ons open before the product add"; "Special instructions which is the notes in the till, give options for that"; "If the product is not available then remove that product or talk to me regarding this or refund that amount. By default remove that product is selected." Reference: screenshots 7–9.
- **UI:** bottom sheet, opened by tapping item name/image, or `+` when the item has groups. Contents in order:
  1. Hero image (`object-fit:cover`, ~180px) if the item has one; close `×`.
  2. Name; `from {price}` line.
  3. If `diet_tag` set: chip with its text plus an `(i)`; tapping opens a "Dietary information" sheet showing the chip, the allergen labels for the item's `allergens` codes (labels from a page-level `ALLERGENS` constant the server injects at render time from `src/allergens.js`), the sentence "Please contact the venue for details.", and a "Got it" button.
  4. Description.
  5. Add-on groups from T5: group name, "Optional" when `min_select=0` else "Required", "Select one" when `max_select=1` (render radios) else "Select up to {max_select}" (render checkboxes). Option row: name left, `+ {price}` right. Render all options; no collapse.
  6. "Special instructions": textarea, `maxlength=500`, live `0/500` counter, placeholder `e.g. no mayo`. Sent as the line `note` in T6.
  7. "If this product is not available" row → chooser sheet with three radios: "Remove it from my order" (SELECTED BY DEFAULT), "Call me", "Refund this item", and an "Apply" button. Maps to `unavailable_action` `remove|call|refund`.
  8. Sticky footer: `− qty +` stepper and a full-width "Add to cart" showing the line total including chosen add-ons.
- **Behaviour:** Add posts the line into the basket state (including modifiers, note, unavailable_action); the badge shows the quantity; sheet closes. Required groups block Add until satisfied. Checkout POST already includes these fields via T6.
- **Test:** manual E2E in T28. Guard test after editing.
- **Done:** sheet matches the flow above; basket line carries add-ons with prices; server accepts the order (T6).

### T20 — Offer activation sparkle

- **Ask:** "Once the offer is activated after adding items show a sparkling animation to the bottom." Reference: screenshot 10.
- **UI:** when the venue has `offer_active` and the basket subtotal crosses `offer_min_spend_minor` upward, (a) show the green tick line above the cart bar — `You've got {offer_percent}% off your order!` (use `offer_label` when set) — if the page does not already show it, and (b) fire `sparkleBurst()`: ~20 absolutely positioned spans spawned at the cart bar, random left offsets, 4–8px, accent colour plus gold, CSS keyframe fall+fade 900ms, removed after 1s. Fire once per crossing; re-arm only if the subtotal drops below the threshold again. Pure CSS/JS, no library.
- **Done:** crossing the threshold on the live test venue shows the tick line and one sparkle burst; adding more items does not re-fire it.

### T21 — No autofocus in QR checkout

- **Ask:** "After I'm trying to order as a guest, it's focusing a field which shouldn't be done."
- **Files:** `dinein_pages.js` — search for `autofocus` and `.focus(`.
- **Change:** remove autofocus attributes and any programmatic focus-on-open in the guest checkout (name/phone fields shown per `require_name`/`require_phone`). Focus must only follow a user tap.
- **Done:** opening checkout as a guest never raises the keyboard by itself.

---

## PHASE E — Kitchen app (`vesopa_epos_kitchen`)

### T22 — Remove autofocus everywhere

- **Ask:** "it's focusing a field which shouldn't be done anywhere in the kitchen app as we're working on a lower end device and very low screen."
- **Files:** `grep -rn "autofocus\|requestFocus" vesopa_epos_kitchen/lib` — at minimum `ui/sign_in_page.dart`.
- **Change:** delete `autofocus: true` and any `FocusNode.requestFocus` on page open.
- **Test:** new `vesopa_epos_kitchen/test/no_autofocus_test.dart` — pump the sign-in page, assert nothing holds primary focus. If the project has no test harness yet, add this one test; also run `flutter analyze`.
- **Done:** sign-in opens without the keyboard on the small device.

### T23 — Incoming QR orders: accept/reject, allergens, modifiers

- **Ask:** "giving the kitchen app an option to accept the order"; "kitchen app needs to know that" (add-ons); "Allergens … kitchen view."
- **Files:** `data/kitchen_api.dart` (add `fetchDineinOrders(status: 'placed')` and `setDineinOrderStatus(publicId, status)` calling the T9 route and the orders list route the back office uses — find the list URL in `public/app.js` on the `/dine-in/orders` page), `data/live_link.dart` (subscribe to the T8 event; fall back to a 20s poll), `data/ticket.dart` (add `List<String> allergens` to the line model), `ui/open_board.dart`, `ui/kitchen_shell.dart`, `ui/settings_page.dart`, `data/providers.dart`.
- **Server support (do in this task, in `vesopa_server/src`):** at kitchen ticket ingest (the route that INSERTs `epos_kitchen_ticket_lines`), for each line with a PLU, copy `bo_products.allergens` into the new `allergens` column. Find the route with `grep -rn "epos_kitchen_ticket_lines" vesopa_server/src`. This covers till and QR tickets in one place (D3).
- **UI:**
  - A strip at the top of the open board: "QR orders" cards showing `table_label`, `customer_name`, line count, `total_minor`, with large Accept (green) and Reject (red) buttons — big touch targets for the low-end device. Accept/Reject call T9. On reject, also remove the ticket from the board using the existing bump mechanism.
  - Ticket lines: child lines (`is_modifier`) already indent — verify, do not rebuild. When a line's `allergens` is non-empty render a wrapping row of small amber chips "Contains: Milk, Gluten" under the line name. Codes→labels come from `GET /api/allergens`, fetched once at startup and cached in `providers.dart`.
- **Test:** manual on the low-end device or a narrow window; covered live in T28.
- **Done:** place a QR order with an add-on and an allergen-bearing product on the live test venue: the order card appears, Accept sets status `accepted` (visible on the customer page), the ticket shows the indented add-on and the allergen chips.

### T24 — Kitchen notifications and sound

- **Ask:** "Microsoft native notifications should be added to every apps … controlled … Kitchen app, till notifications sound should be controlled from the apps and also from the back office."
- **Files:** `vesopa_epos_kitchen/pubspec.yaml` (add `local_notifier`, run `flutter pub get`), new `lib/notifications.dart`, `ui/settings_page.dart`, `data/kitchen_api.dart` (fetch till-settings so the T4 columns reach the app — if kitchen has no settings fetch today, add one against the existing GET the till uses, using the kitchen token), `lib/main.dart` (init).
- **Behaviour:** wrapper class `AppNotifications` with `init()` and `show(title, body, {sound})` mapping to `local_notifier` (`silent: !sound`). Toasts: on `dinein_order` event with status `placed` (if `notify_kitchen_dinein_new`) and on new kitchen ticket (if `notify_kitchen_ticket_new`); sound iff `notify_kitchen_sound` AND the app's local Sound toggle; everything gated by `notify_master` AND the local Notifications toggle (D4). Add the two local toggles to `settings_page.dart`, persisted the same way that page already persists its other settings.
- **Done:** toggling each layer demonstrably silences/enables toasts and sound on the device.

---

## PHASE F — Till (`vesopa_epos`)

### T25 — QR orders inbox with accept

- **Ask:** "option to accept from the till."
- **Files:** locate the till's held/parked orders screen with `grep -rln "park\|held" vesopa_epos/lib` and add alongside it: a "QR ORDERS" button with a pending-count badge, and a dialog listing `placed` orders: table, customer name, lines with modifiers indented, line notes, allergen line, `unavailable_action`, total; Accept/Reject buttons calling the T9 route. Poll the orders list route every 15s while the dialog is open and on the home screen for the badge. Use the till's existing API client and token.
- **Test:** new `vesopa_epos/test/qr_orders_inbox_test.dart` — widget test with a fake API: list renders, accept calls the API and removes the card. Follow existing test patterns in `vesopa_epos/test`.
- **Done:** `flutter test` passes (773 existing + new; ignore the 3 known failures); live accept works in T28.

### T26 — Till notifications, sound, and allergens toward the display

- **Files:** `vesopa_epos/pubspec.yaml` (add `local_notifier`), new `lib/notifications.dart` (same wrapper as T24), the till settings storage (find where the till persists local preferences and add Notifications + Sound toggles), the code that builds the payload sent to the customer display (find it with `grep -rln "display" vesopa_epos/lib` where line data is serialised) — add `allergens` per line from the product record so the display can render them in T27; ensure the till's product sync model carries the new `bo_products.allergens` column (find the product model and the server route feeding it; if the route selects explicit columns, add `allergens`).
- **Behaviour:** toast on new QR order when `notify_master` AND `notify_till_dinein_new` AND local toggle; sound per `notify_till_sound` AND local Sound toggle.
- **Test:** `flutter test`; live check T28.
- **Done:** toast fires on placement; display payload includes allergen codes.

---

## PHASE G — Display app (`vesopa_epos_display`)

### T27 — Allergens on lines; notification capability (default off)

- **Ask:** "Allergens … display app."; "Microsoft native notifications should be added to every apps."
- **Files:** find the line-rendering widget with `grep -rln "OrderLine\|lines" vesopa_epos_display/lib`; `pubspec.yaml` (add `local_notifier`); new `lib/notifications.dart`; the settings screen if one exists, else constants.
- **UI:** under each line with non-empty `allergens` (from the T26 payload), render a small "Contains: …" line. Labels: fetch `GET /api/allergens` once at startup, cache, fall back to raw codes offline.
- **Notifications:** wrapper present and wired to a "new order started" toast, gated by `notify_master` AND `notify_display_enabled` (default 0 — D9) AND a local toggle.
- **Done:** run a sale on the till with an allergen product: the display shows the Contains line; with `notify_display_enabled=0` no toast appears, with 1 it does.

---

## PHASE H — Release

### T28 — Full tests and live end-to-end verification

- **Automated:** `cd vesopa_server && npm test` (0 exit, includes T2/T3/T4/T5/T6/T7/T16 new tests and the stylesheet guard). `cd vesopa_epos && flutter test` (773 + new pass; the 3 known failures stay). `cd vesopa_epos_kitchen && flutter test` and `cd vesopa_epos_display && flutter test` (or `flutter analyze` where no tests exist).
- **Live, as `VESOPA_TEST_EMAIL` only, against `https://backoffice.vesopaepos.com`, using the test venue:**
  1. Menu images all load, no console 404s (T14). Logo circular, no white ring (T15).
  2. `view-source:` shows the meta saved via the new back-office fields (T16/T12).
  3. Table pill pulses with `›`; pick a table; change it again (T17).
  4. Text item: `+` → number → pill → bin → `+` (T18). Image item with add-ons: sheet opens, required group enforced, special instructions capped at 500, availability defaults to Remove (T19).
  5. Cross the offer threshold: tick line + one sparkle burst (T20).
  6. Guest checkout: no autofocus (T21).
  7. **OTP:** sign in on the QR page with `+447848494341`. Read the latest code from the `dinein_otp` table for that number, submit, confirm the session completes. One attempt only — this sends a real SMS to the client's phone; tell the user it was sent and ask them to confirm arrival.
  8. Place the order with an add-on and an allergen product. Back office `/dine-in/orders` shows parent+child lines. Kitchen app shows the incoming card; Accept → customer page shows accepted; ticket shows indented add-on and Contains chips (T23). Till inbox shows/accepts (T25). Toasts fire per the T4 matrix; toggle each switch and re-verify (T13/T24/T26). Display shows the Contains line (T27).
- **Cleanup:** delete every order, order line, item and venue change created for this test, by id.
- **Done:** checklist written into the commit/PR description, all boxes ticked.

### T29 — Versions, builds, deploy, push

- **Apps changed (all three need rebuilding):** `vesopa_epos` → `version: 1.6.7+28`; `vesopa_epos_display` → `version: 1.6.7+7`; `vesopa_epos_kitchen` → `version: 1.6.7+8`. Set `msix_config.msix_version: 1.6.7.0` in all three `pubspec.yaml`. `vesopa_web` and `vesopa_hosting` are untouched — no build.
- **Build:** in each app, `dart run msix:create --store`.
- **Server deploy:** `python .claude/skills/vesopa-ops/scripts/vesopa_ssh.py put src "@app/src"`, also `put schema` and `put public`, then `pm2 restart vesopa_backoffice`. Confirm the new migrations applied (they are idempotent; check logs or query `information_schema`).
- **Git:** one commit per phase was made along the way; final `git push` to `main` from a clean tree.
- **Done:** live site serves the new QR menu; three msix artefacts for 1.6.7.0 exist.

### T30 — Store release notes and upload; then stop

- **Release notes (<1500 characters each), then upload each msix to its Partner Center draft submission. Do NOT submit — the user submits.**
- **Till (vesopa_epos) 1.6.7.0:** "QR menu orders now support add-ons with prices, per-item special instructions and a choice of what to do if an item is unavailable (remove, call or refund — remove is the default). New QR Orders inbox at the till: see incoming QR orders and accept or reject them. Allergen information from the back office is shown on order lines and sent to the customer display. Windows notifications for new QR orders, with sound controls in the app and central notification settings in the back office."
- **Kitchen (vesopa_epos_kitchen) 1.6.7.0:** "Accept or reject incoming QR menu orders directly from the kitchen board. QR orders appear as they are placed. Add-ons are shown indented under their item and allergen warnings appear on ticket lines. Windows notifications for new QR orders and new tickets, with sound and notification toggles in Settings and central control from the back office. Sign-in no longer pops the keyboard on small screens."
- **Display (vesopa_epos_display) 1.6.7.0:** "Allergen information is shown under order lines when set on products in the back office. Notification support added, off by default, controllable from the back office."
- **Done:** all three packages uploaded as draft updates, release notes pasted, versions 1.6.7.0. Stop and hand to the user for submission.
