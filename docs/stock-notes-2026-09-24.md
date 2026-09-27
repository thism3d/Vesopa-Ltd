# Dylan's stock and back office notes — 21 and 24 September 2026

Three emails from Dylan King (via Meirion), testing the back office against
Newbridge, the till a Vesopa venue is coming off. Recorded here so the next
round of notes starts from what is already done.

## 21 September — built 22 September (commit b99db01), live

| Note | Where it is |
|------|-------------|
| Spot checks and stock takes: add many products at once, or a department or sub-department | `skPick()` in `public/stock.js`; "Add a department / sub-department" on counts |
| Case size on the product list, changeable from a dropdown | product list column, `PATCH /stock/products/:id` |
| Products would not add to wastage, adjustments or stock takes | the box took only an exact name; `skResolve()` now matches any part |
| Link half pints to pints, glasses to the bottle | `stock_parent_pluid` / `stock_ratio`, `src/stock_effects.js` |
| GP calculator and a recommended price | `gpFigures()`, the product form's GP panel |
| Recipes for cocktails | Stock Control → Recipes |
| Non-stock option; only case-sized products on a stock take | `non_stock`, `stock_item` in `decorate()` |
| Stock info from the product list; mass-apply case sizes; unit cost on the list; attach a supplier | product list row button, bulk edit, columns |

## 24 September — built 27 September

| Note | What was built | Commit |
|------|----------------|--------|
| Case size visible on a stock take, and changeable there | a case-size dropdown on every line of every stock document; saves on the product | 6442b22 |
| Quantities by case or by unit on stock takes, wastage and adjustments | Cases and Units boxes on every line; the ledger is still sent units | 6442b22 |
| The Add a product box needs Enter before anything shows | it lists products the moment it is clicked, stock items first on a count, narrowing as you type (orders too) | 6442b22 |
| Stock take lines ordered by sub-department | counts laid out by department › sub-department with a heading each | 6442b22 |
| Product form in headed sections (product details, stock, modifiers, printing, images) | the form has those five sections and a sticky strip of section buttons; still one form and one Save | 3707b26 |
| Parent and child products — "I still don't see a way" | the link existed but was set from the child in a hidden popup. Now a **Child products** panel in the parent's Stock section lists its children with their cost, makes new ones and links existing ones | 3707b26 |
| Create child products while creating a product (Newbridge), and add existing ones from a list (better than Newbridge) | same panel; works on Add product too | 3707b26 |
| Scheduler for screen programming, like ICR Touch | **Schedule…** beside Save layout keeps the layout for a date and time; **Scheduled** lists, applies now or cancels | 4a55f90 |
| Move widgets around on the dashboard | **Customise**: drag, arrows, half/full width, hide; kept per person | f5a733e |

"Let me run this past Nicky" was said of the sectioned product form. It is
built; if Nicky prefers the old single list, the sections are one array in
`productFields()` and come out by deleting the five `type: 'section'` entries.

## How the Newbridge and ICR Touch versions compare

* **ICR Touch** (TouchOffice Web): programming "can be performed live, or set
  on a schedule to take place in the future such as the start of the month"
  ([ICRTouch](https://icrtouch.com/products/touchoffice-web/)). Vesopa's
  version keeps a whole copy of the layout as it was when scheduled rather than
  a diff, so what goes live is exactly what the manager saw; lists every
  pending change for the venue with who and when; and can apply or cancel any
  of them in one press. Tills pick it up on the minute, or the moment they next
  read their screens.
* **Newbridge** (stock set-up guide:
  [help centre](https://help-newbridgeepos.theaccessgroup.com/en/articles/12744929-stock-control)):
  child products are created from the parent's screen once it has a stock
  unit, new products only. Vesopa's panel also links products that already
  exist, and shows each child's cost from the parent's cost as it is typed.
  Cases-or-units entry and sub-department ordering follow Newbridge's count
  screens from the 23-minute recording in `docs/briefs/`.

## To go live

Server-only: no till, kitchen or display build is needed. Two new re-runnable
schema files (`schema_screens_schedule.sql`, `schema_dashboard_layouts.sql`),
new `src/screen_schedules.js` and `src/dashboard_layout.js`, and changes to
`src/screens.js`, `src/server.js` and `public/` (`app.js`, `stock.js`,
`screens.js`, `dashboard.js`, `index.html`, `style.css`). Until the schema
runs, Schedule… reports an error, the Scheduled list is empty, and the
dashboard keeps its layout in the browser only. Nothing else is affected.

## 27 September, second round: the till, the kitchen screen, and live

The owner: every item must reach the till too, and stock should reach the
kitchen. Built by extending what was there, not beside it:

| Where | What | Commit |
|-------|------|--------|
| Server | `/till/stock/...` and `/api/kitchen/stock/...`: the back office's own stock routes on a terminal or kitchen token (the kitchen may only read, record wastage and mark sold out) | 603b06c, 132e09e |
| Server | `.../stock/availability` (how many more can be made: own count, a half from its keg, a recipe from its scarcest ingredient) and `.../stock/sold-out`, which is the QR menu's existing `dinein_items.available` switch | 132e09e |
| Server | `PATCH /till/products/:pluid`, `POST /till/products/new`; `/till/products` carries case size | 7a2c9a3, 603b06c |
| Till | Stock page (stock take, spot check, wastage, adjustment; list on tap; many at once; sub-department groups; case size per line; cases or units; print) | c5fe1bd |
| Till | Wastage key by cases or units, products listed on open | c5fe1bd |
| Till | Products page on the ledger (no false "Out of stock" for child, recipe, non-stock); case size dropdown, unit cost, supplier, mass-apply case size; stock button books in or counts through the ledger (it used to change this till only) | 7a2c9a3 |
| Till | Product editor in sections, saving for every till: details, stock (GP calculator, child products, recipe, non-stock, Sold out), printing, images | 7a2c9a3, a9d8e3d |
| Till | Scheduled screen changes reach a running till, and a till that was offline asks again on reconnect | 6d5713c |
| Kitchen | Counts show "5 left"; a Stock tab with Sold out and Waste; recipe measures under ticket lines | 1c0cedc |
| Back office | A child product needs its measure before anything saves; Use this price works first click | 801af6f |

Screen programming stays in the back office only; the till has no editor and
listens for changes. The customer display needed nothing found so far.

**Live, 27 September 01:48 (server time).** Backup
`backup/pre_dylan_notes_20260927_014806.sql` (1.78 MB); the replaced files are
in `backup/pre_dylan_files/`. Thirteen files uploaded, the two new schema files
run (both tables present), `pm2 restart backoffice.vesopaepos.com`, `/health`
ok, new assets served, every new route refuses without a token, and
`/till/products` carries case sizes on a real venue (83 products, 5 with a
case).

Versions: EPOS 1.9.0.0 (+42), Kitchen 1.7.0.0 (+13). Display, Express and
Loyalty have no changes.
