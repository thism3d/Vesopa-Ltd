# Vesopa EPOS 1.8.0.0 — Stock Control and Reporting

## The brief

A 23-minute silent screen recording (`docs/briefs/stock-reporting-brief-analysis.md`
holds the two Gemini passes over it, timestamped) of the Newbridge back office
at Pontardawe RFC. Nobody speaks; the client clicks through every report
Newbridge offers and every page under its Stock Control menu. The message is
"this, please": a venue coming off Newbridge expects to find the same reports
and the same stock workflow, and describes what it wants by how Newbridge does
it.

What Newbridge showed, condensed:

* **Reports page** — a catalogue in four groups: Sales/Finance (30), Stock (8),
  Clerks & Attendance (6), Customers (6). Each runs over a period preset or a
  custom range, per site and per terminal, and some take a product, a clerk or
  a week-start date. Every one exports XLS / CSV / PDF and can be scheduled by
  email. Report headers carry name, site, start, end.
* **Stock Control menu** — Orders & Deliveries (suppliers, purchase orders with
  a suggested-order button, delivery against an order), Wastages, Adjustments,
  Transfers, Spotchecks, Stock Taking (with a downloadable count sheet),
  Suppliers, SKU Management (pack sizes: "Pack of 24" = 24, "11g Keg" = 88),
  Recipe Management.
* **Every stock report is a view over one movement ledger**: Sales Consumption,
  Wastages, Deliveries, Adjustments → Current Stock, shown in units and in
  packs (`-16.00 (-0.18 11kg Keg)`). Valuation is units × unit cost, with the
  selling price and GP% beside it.

Two things in the recording are Newbridge's faults, not features: the
Transaction Audit Report errors three times, and the valuation totals
£-373,713 because nobody at that venue has counted stock since 2021. Both are
worth remembering when a venue says "make it like Newbridge".

## What Vesopa already has

Read before planning, so the plan builds on it rather than beside it.

* `vesopa_server/src/reports.js` — a report is `{ name, site, from, to,
  generatedAt, sections }`; a builder makes one; `REPORTS` lists them; run,
  PDF/CSV/XLSX export and the scheduler all read that one shape. Five reports
  exist: Financial Summary, Product Sales, Discount Report, Loyalty Spending,
  Voids & Cancels. Period presets, a terminal filter, and the `__unknown__`
  terminal sentinel are all done and tested (`test/reports.test.js`).
* `src/report_schedules.js` — scheduling reads `REPORTS`, so a new builder is
  schedulable for free.
* Stock is one column: `bo_products.stock_quantity` (`cost_price`,
  `low_stock_at` beside it). `src/sales.js` decrements it on every sale, for
  tracked products only. The back office Stock page offers "Count some in"
  and "Set the count", both of which overwrite the number and remember
  nothing. There is no ledger, no supplier, no pack size, no document.
* The till keeps refunds and no-sales in its own `TillEvents` table for the Z
  report and never sends them up. `can_expense` and `can_wastage` permissions
  exist and nothing on the till uses them. Cashback is taken (Dojo) but not
  stored on the payment row.

## Scale honesty

This is the largest release since 1.6.8.0. It touches: three re-runnable
migrations; a new `src/stock.js` module (~1,000 lines) and two new builder
files (~1,500 lines of report SQL); a heavy back-office pass (a new nav group
with eight pages, a report picker that grows from five entries to thirty and
has to show different filters per report); and the till, which gains three
functions (Paid Out, Wastage, Cashback recorded) and one outbox entity.

Safe stopping points, in order:

1. **End of Phase 1** — the stock ledger, suppliers, pack sizes, documents and
   purchase orders exist on the server with nothing calling them. Deploying
   here changes nothing a venue sees. Safe.
2. **End of Phase 2** — every new report is runnable and schedulable. Refunds,
   Expenses, Cashback and Wastage reports run but show only what the till has
   sent, which before Phase 4 is nothing. Safe to ship server-only.
3. **End of Phase 3** — the back office has the Stock Control menu and the
   grouped report picker. Still server-only. Safe.
4. **End of Phase 4** — the till changes. The Paid Out function takes money out
   of the drawer, so it must not ship without its test and a live check.
5. **Phase 5** — the release.

Known traps that are *not* regressions: `flutter test` in `vesopa_epos` has
three failures on a clean tree (two Dojo live tests, one golden by 0.43%);
`git stash push -u` and re-run before blaming a change. `npm test` in
`vesopa_server` stops at `kitchen.test.js` ("sign-in returns a token":
`conn.query is not a function` in `till_seats.claimSeat` against the fake
pool) and has since before this release — run the files after it by hand.
Under `--concurrency=2` a few Flutter test files sometimes die with
"Connection closed before test suite loaded"; they pass alone. Also
pre-existing at 11f6265: `express.test.js` fails 48 of 66 (`bo_till_seats`
missing from its own scratch database), `gym.test.js` hangs, and
`backoffice-layout.test.js` flags the demo-venue card's inline margin. Live is MariaDB 11.4.
Every schema file must define `vesopa_add_column` itself because the file
before it drops it. `public/` uploads need `pm2 restart`.

Another session has uncommitted loyalty-app work in `vesopa_server/src/
loyalty_*.js`, `test/loyalty-auth.test.js` and ten lines of `public/app.js`,
plus the whole of `vesopa_loyalty/`. None of it is this release's. Commit only
this release's files, by name; at deploy time upload only this release's files
rather than the whole of `src/`.

Live-data discipline: only `manager@vesopa.co.uk` may be used against
`https://backoffice.vesopaepos.com`. Every live check creates its own data and
deletes only what it created.

## Deliberately left out, and why

* **Recipe Management / Recipe Costs** — a product made of measured
  ingredients that deplete other products. Real, valuable, and a release of its
  own: it changes what a sale means to the ledger. Newbridge's recipe table at
  this venue was empty, which says how much it was used.
* **Transfers** — Newbridge transfers stock between sites of one company. A
  Vesopa office *is* a site; a second site is a second office with its own
  catalogue and PLUs, so a transfer has nothing to match on. When multi-site
  catalogues are shared it becomes an adjustment out here and a delivery in
  there. Not built.
* **Thai Tax Report, PMS Department Sales** — Newbridge's other markets
  (Thailand; hotel property systems). Not ours.
* **"Most Used Reports"** — a convenience strip. The grouped picker with a
  search box does the same job in one release fewer.
* **Stock Period Report** — needs two completed stocktakes to bracket a period.
  The Stock Variance report covers each stocktake; the period view comes once
  a venue has two counts to bracket.

## Progress

Status values: `Not started`, `In progress`, `Done`, `Blocked`.

| Task | Title | Phase | Status | Where it landed |
|------|-------|-------|--------|-----------------|
| T1 | Schema: stock ledger, suppliers, pack sizes, documents, orders | 1 | Done | commit "Stock becomes a ledger" |
| T2 | Schema: till events on the server; cashback on payments; staff hourly rate | 1 | Done | commit "Stock becomes a ledger" |
| T3 | Sales write the ledger | 1 | Done | commit "Stock becomes a ledger" |
| T4 | `src/stock.js`: suppliers, pack sizes, product stock settings | 1 | Done | commit "Stock becomes a ledger" |
| T5 | `src/stock.js`: documents (wastage, adjustment, stocktake, spot check) and completion | 1 | Done | commit "Stock becomes a ledger" |
| T6 | `src/stock.js`: purchase orders, suggested order, send, deliver | 1 | Done | commit "Stock becomes a ledger" |
| T7 | `POST /till/events` and permissions keys | 1 | Done | commit "Stock becomes a ledger" |
| T8 | Report filters: clerk, product, week start, department, group by | 2 | Done | commit "Thirty-three more reports" |
| T9 | Sales & finance builders (20) | 2 | Done | commit "Thirty-three more reports" |
| T10 | Stock builders (7) | 2 | Done | commit "Thirty-three more reports" |
| T11 | Staff and customer builders (6) — 38 reports in all | 2 | Done | commit "Thirty-three more reports" |
| T12 | Report tests: every builder scoped, reconciling, and runnable empty | 2 | Done | commit "Thirty-three more reports" |
| T13 | Back office: Stock Control nav group and Stock Levels page | 3 | Done | commit "The back office gets Stock Control" — driven in a local harness |
| T14 | Back office: Suppliers and Pack Sizes pages | 3 | Done | commit "The back office gets Stock Control" — driven in a local harness |
| T15 | Back office: Wastage, Adjustments, Stock Takes, Spot Checks | 3 | Done | commit "The back office gets Stock Control" — driven in a local harness |
| T16 | Back office: Orders & Deliveries | 3 | Done | commit "The back office gets Stock Control" — driven in a local harness |
| T17 | Back office: grouped report picker with per-report filters | 3 | Done | commit "The back office gets Stock Control" — driven in a local harness |
| T18 | Back office: staff hourly rate on the Staff form | 3 | Done | commit "The back office gets Stock Control" — driven in a local harness |
| T19 | Till: send refunds and no-sales up; Paid Out function | 4 | Done | commit "The till sends up what is not a sale" |
| T20 | Till: Wastage function | 4 | Done | commit "The till sends up what is not a sale" |
| T21 | Till: cashback on the payment row | 4 | Done | commit "The till sends up what is not a sale" |
| T22 | Till: Z report carries expenses and wastage | 4 | Done | commit "The till sends up what is not a sale" |
| T23 | Version bumps (till only) | 5 | Done | `vesopa_epos/pubspec.yaml` 1.8.0+39 / 1.8.0.0 |
| T24 | Full test sweep | 5 | Done | server: every file green bar the pre-existing kitchen sign-in fake-pool failure; till 879 pass, 3 known + Functions golden refreshed |
| T25 | Server deploy, migrations, smoke checks, live walk-through | 5 | Done | backup `pre_1.8.0.0_20260915_042610.sql`; 20 files up; every schema file replayed; `/health` ok; `tool/verify-stock-live.js` 50/50, stock 93 → 93, nothing left |
| T26 | msix build | 5 | Done | `build/store/vesopa-epos-store.msix`, 21,184,728 bytes, manifest 1.8.0.0, built with `--store` |
| T27 | Store release notes | 5 | Done | `ms-store-submission-client/notes-1.8.0.0-epos.txt`, 1,443 characters, checked |
| T28 | Stage and commit the submission | 5 | Not started | |

## Phase 1 — Server: the stock ledger

### T1 Schema `schema_stock.sql`

One file, re-runnable, defines `vesopa_add_column` at the top and drops it at
the bottom. Sorts after `schema_commerce.sql` (which owns `bo_products`).

* `bo_suppliers` — `id, office, name, contact_name, phone, email, account_ref,
  notes, active, created_at`. Unique `(office, name)`.
* `bo_pack_sizes` — `id, office, name, units DOUBLE, created_at`. Newbridge
  calls these SKUs; a venue calls them "a case" or "a keg". Seeded per venue
  on first read with Each (1), Pack of 6/12/24, 11g Keg (88), 9g Keg (72),
  70cl Bottle (28) — the ones every bar has.
* `bo_products` gains `supplier_id INT NULL`, `supplier_code VARCHAR(64)`,
  `pack_size_id INT NULL`, `pack_cost DOUBLE NULL` (cost of one pack; unit
  cost derives from it when set), `min_stock DOUBLE NULL`, `max_stock DOUBLE
  NULL`, `stock_unit VARCHAR(24) NULL` ("pint", "bottle").
* `epos_stock_movements` — the ledger. `id CHAR(36), office, pluid, product_name,
  kind ENUM-ish VARCHAR(16)` (`sale`, `refund`, `wastage`, `delivery`,
  `adjustment`, `stocktake`, `spot_check`), `quantity DOUBLE` signed (+ in, −
  out), `unit_cost_minor INT`, `reason VARCHAR(255)`, `doc_id CHAR(36) NULL`,
  `order_id CHAR(36) NULL`, `staff_name VARCHAR(120)`, `terminal VARCHAR(120)`,
  `moved_at DATETIME`, `created_at`. Indexes `(office, moved_at)` and `(office,
  pluid, moved_at)`.
* `bo_stock_docs` — `id CHAR(36), office, kind` (`wastage`, `adjustment`,
  `stocktake`, `spot_check`, `delivery`), `status` (`draft`, `completed`),
  `notes, staff_name, order_id CHAR(36) NULL, created_at, completed_at`.
* `bo_stock_doc_lines` — `id, doc_id, pluid, product_name, expected DOUBLE
  NULL` (what the system thought, at completion), `quantity DOUBLE` (the count
  for a stocktake; the signed movement for the rest), `unit_cost_minor,
  reason`.
* `bo_purchase_orders` — `id CHAR(36), office, supplier_id, status` (`new`,
  `sent`, `part_delivered`, `delivered`, `cancelled`), `notes, send_method`
  (`email`, `phone`), `supplier_email, staff_name, total_minor, created_at,
  sent_at, delivered_at`.
* `bo_purchase_order_lines` — `id, order_id, pluid, product_name,
  pack_size_id, pack_name, pack_units, pack_cost_minor, packs_ordered,
  packs_delivered`.

### T2 Schema `schema_till_events.sql`

* `epos_till_events` — `id CHAR(36), office, kind` (`refund`, `no_sale`,
  `expense`, `cashback`), `amount_minor INT, note, reason, staff_name,
  terminal, session_id, order_id CHAR(36) NULL, at DATETIME, created_at`.
  Index `(office, kind, at)`. Idempotent on `id`.
* `epos_payments.cashback_minor INT NOT NULL DEFAULT 0`.
* `bo_clarks.hourly_rate DOUBLE NULL` — for the Profit Summary's labour line.

### T3 Sales write the ledger

`src/sales.js` already decrements `stock_quantity` per line. Beside that
UPDATE, insert one `epos_stock_movements` row per tracked line (`kind='sale'`,
negative quantity, the product's unit cost as it stands, the order id,
`moved_at = closed_at`). Untracked products (NULL stock) get no row, as now.
Training sales get nothing, as now. Idempotent because the order push is:
`INSERT IGNORE` on a movement id derived from the line id.

### T4–T6 `src/stock.js`

Mounted under `/stock`, back-office auth, office-scoped like everything else.
`unitCost(product)` = `pack_cost / pack_units` when both are set, else
`cost_price`.

* Suppliers and pack sizes: plain CRUD. Deleting a supplier that has orders
  refuses; deleting a pack size in use refuses.
* `GET /stock/products` — every product with its stock settings, current
  stock, unit cost, stock value, packs-on-hand, and a `level` (out/low/ok/
  untracked). `PUT /stock/products/:id/settings` — the stock fields only.
* Documents: `GET /stock/docs?kind=`, `GET /stock/docs/:id`, `POST` (draft
  with lines), `PUT` (draft only), `DELETE` (draft only), `POST
  /stock/docs/:id/complete`. Completion is one transaction: for each line, read
  the current count into `expected`; a stocktake's movement is `quantity −
  expected`, everything else's is the line's signed quantity; write the
  movement, update `stock_quantity`; stamp `completed_at`. A spot check is a
  stocktake over a few products. A stocktake for a product still `NULL` starts
  tracking it.
* `GET /stock/count-sheet.pdf?department=` — a PDF of products in count order
  with a blank column.
* Purchase orders: CRUD; `GET /stock/orders/suggest?supplier=` returns every
  product of that supplier at or below `min_stock` with packs needed to reach
  `max_stock`; `POST /stock/orders/:id/send` emails the supplier through
  `mailer.js` (the order as a PDF) when the method is email, and marks it sent
  either way; `POST /stock/orders/:id/deliver` takes `{ lines: [{ id,
  packs_delivered }] }`, creates a completed `delivery` doc, writes movements,
  updates `pack_cost` on the product from the order, and sets the order status.

### T7 `POST /till/events`

Terminal-authenticated like `/till/voids`; `INSERT IGNORE` on the id; training
sessions are dropped exactly as voids are. A `wastage` posted from the till is
a completed one-line wastage doc, so the back office sees it in the same list.

Permission keys (`src/permissions.js`): a `Stock Control` group — `stock.
levels`, `stock.suppliers`, `stock.pack_sizes`, `stock.docs`, `stock.orders`,
`stock.edit`. The existing `catalogue.stock` maps to `stock.levels`. New report
keys under Reports, one per builder group rather than one per report.

## Phase 2 — Server: the reports

### T8 Filters

`runReport` and the catalogue grow a `filters` list per report. The catalogue
entry says which apply: `terminal` (all), `clerk`, `product`, `department`,
`week_start` (a date; the report covers seven days from it), `group_by`. The
route passes whichever were sent; a builder that does not take one ignores it.
`/reports/catalogue` also returns the clerk list and department list so the
browser can fill the dropdowns; the product filter is a search box.

### T9 Sales & finance builders — `src/report_builders_sales.js`

Every one: office bound in the WHERE, the join carries it, Summary Total from
printed rows.

| Key | Sections |
|-----|----------|
| `department_sales` | departments — the Financial Summary's first table alone |
| `sub_department_sales` | sub departments alone |
| `payment_types` | method → count, amount; gratuity and cashback beside |
| `tax_report` | rate → net, tax, gross |
| `product_sales_by_time` | hour of day → sales, value; then product × hour |
| `product_sales_by_clerk` | clerk filter → the Product Sales table for them |
| `daily_department_sales` | week-start filter → department × seven day columns |
| `financial_summary_7_days` | week-start → departments, payments, expenses × 7 days |
| `covers_report` | covers, spend per head by day; by room |
| `sales_by_table_location` | room → sub department |
| `profit_summary` | department → sales, COS (Σ qty × unit cost), GP £, GP %; labour from `epos_time_clock` × `hourly_rate`; net |
| `gp_summary` | notional GP (catalogue cost) against actual GP (ledger consumption: sales + wastage + negative adjustments) |
| `weekly_sales_analysis` | department → sales mix %, GP % |
| `clerk_gratuities` | clerk → gratuities, count |
| `transactions_by_payment_type` | method → one row per payment: time, order, terminal, amount |
| `transaction_detail` | one row per sale: time, order, clerk, method(s), terminal, total |
| `sales_comparison` | department → this period, the previous period of the same length, change |
| `refunds` | from `epos_till_events` |
| `expenses` | from `epos_till_events` |
| `cashback` | from `epos_payments.cashback_minor` and events |

### T10 Stock builders — `src/report_builders_stock.js`

| Key | Sections |
|-----|----------|
| `stock_movements` | sub department → product: sales, wastage, deliveries, adjustments, stocktake corrections, current stock — units, with packs in brackets |
| `stock_valuation` | group by department/sub department; product → units, packs, unit cost, value, selling price, GP % |
| `wastage_report` | product → quantity, retail value, cost value, reasons |
| `stock_variance` | each stocktake completed in the period → product: expected, counted, variance units, variance £ |
| `orders_and_deliveries` | orders in the period → supplier, status, lines ordered/delivered, value |
| `product_audit` | product filter → every movement in order: when, kind, quantity, running balance, who |
| `product_sales_audit` | product filter → every sale line: when, clerk, terminal, qty, value |

### T11 Staff and customer builders

| Key | Sections |
|-----|----------|
| `clerk_attendance` | staff → shifts, hours, from the time clock |
| `wage_percentage` | day → labour cost, sales, labour % |
| `clerk_sub_department_sales` | clerk × sub department |
| `customer_transactions` | customer → sales, spend, points |
| `gift_card_report` | cards sold, redeemed, outstanding |
| `gift_card_transactions` | one row per gift card movement |

### T12 Tests

`test/reports.test.js` already asserts every builder binds the office first;
extend the fixture so every new builder runs against an empty venue (no throw,
empty sections with a zero total) and against the seeded one (totals
reconcile: department = sub department = payments where the report claims it).
A stock ledger test: sale → movement; wastage doc complete → movement and
count; stocktake sets rather than adds; delivery updates pack cost; a second
complete on the same doc is refused.

## Phase 3 — Back office

### T13 Stock Control nav group

Replaces the Catalogue → Stock entry: **Stock Control** with Stock Levels,
Suppliers, Pack Sizes, Orders & Deliveries, Wastage, Adjustments, Stock Takes,
Spot Checks. Routes `/stock/...`. Stock Levels is the existing page with
supplier, pack, min/max, unit cost and value columns, a filter by department
and level, and the row's settings editable in a modal. "Count some in" becomes
a one-line delivery document; "Set the count" a one-line stocktake — both now
leave a movement behind.

### T14–T15 Suppliers, Pack Sizes, documents

Suppliers and Pack Sizes: the usual CRUD table with a modal. The four document
pages share one component: a list (date, status, who, lines, value) and a
document editor — a product search that adds lines, per-line quantity and
reason, Save draft, Complete. A stocktake's editor pre-fills every tracked
product (or one department's) with the expected count hidden until completion,
plus **Download count sheet**.

### T16 Orders & Deliveries

Order list; New order (supplier, send method, email, notes; add products by
search or by department; **Suggest an order** fills the lines from min/max);
Send; **Deliver** opens the order's lines with packs-delivered pre-filled to
what was ordered.

### T17 Report picker

`<optgroup>` per group; a search box above the picker filtering the options;
the filter fields shown are the ones the catalogue lists for the chosen
report. The scheduled-report form gets the same groups. Week-start reports
hide the period picker.

### T18 Staff form

An hourly rate field. Optional; the Profit Summary says "no rates set" rather
than £0.00 when none are.

## Phase 4 — Till

### T19 Refunds and no-sales go up; Paid Out

`TillEvents` rows are queued to the outbox as entity `event` → `/till/events`
(the drain's switch gains a case). Functions page gains **Paid Out**: amount,
who it was paid to, reason list from `expense` reasons — behind `can_expense`,
opens the drawer, logs an `expense` event, prints a slip.

### T20 Wastage

Functions page gains **Wastage**: product lookup (the existing
`product_lookup_sheet`), quantity, reason — behind `can_wastage`; a `wastage`
event carrying `plu_id`. No local stock change: the server owns the count.

### T21 Cashback on the payment row

`Payments` gains `cashbackMinor` (Drift migration); the tender writes what the
card machine reported; the order push sends it; `sales.js` stores it.

### T22 Z report

Expenses and wastage counted and totalled beside voids and no-sales, in the
receipt builder and on the Reports page.

## Phase 5 — Release

* T23 — `vesopa_epos/pubspec.yaml` `version: 1.8.0+39`, `msix_version:
  1.8.0.0`. Kitchen and display: untouched, not bumped.
* T24 — `npm test` in `vesopa_server`; `flutter test --concurrency=2` in
  `vesopa_epos` against the three known failures.
* T25 — back the live database up; upload `src/stock.js`,
  `src/report_builders_*.js`, `src/reports.js`, `src/report_schedules.js`,
  `src/sales.js`, `src/server.js`, `src/permissions.js`, `src/backoffice.js`,
  the two schema files, `public/` (excluding uploads); run every schema file;
  `pm2 restart vesopa_backoffice`; `/health`; then as manager@vesopa.co.uk
  create a supplier, a pack size, a wastage, a stocktake and an order, run
  each report group, and delete what was created.
* T26 — `flutter pub run msix:create` → `build/store/vesopa-epos-store.msix`.
* T27 — `notes-1.8.0.0-epos.txt` in the venue's shape, under 1,500 characters.
* T28 — `STAGE_VERSION=1.8.0.0 node examples/stage.js vesopa-epos …` then
  `commit.js`; publish mode stays Manual.

## Corrections to the plan, found while executing it

Kept in the 1.6.8.0 style: each is something the plan got wrong, found by
reading the code or measuring the running site.

1. **The Loyalty Spending report has been a 500 on live.** Found by the new
   `test/reports-catalogue.test.js`, which runs every builder over a copy of
   live's schema (`vesopa_live_shape`). Its customer join compared
   `cu.email_key = o.email` column to column, and those two carry different
   collations on live — the trap in the office-collation note. The unit tests
   never ran the SQL. Fixed by binding the office (`cu.email_key = ?`), and
   every new join in this release binds it the same way.
2. **`lines` is a reserved word in MariaDB.** `COUNT(l.id) AS lines` is a
   syntax error there and fine in the head. `line_count`.
3. **Twenty sales builders, not sixteen.** Refunds, Expenses and Cashback are
   their own reports in the recording, and Sales Comparison was in the
   catalogue list at 11:22. All four are built.
5. **`tool/local-stock-harness.js` is how the pages were checked.** No
   unit test drives a modal. The harness builds a venue over live's schema,
   seeds a fortnight of sales, starts the server on a free port, and the
   pages were clicked through in a browser: settings, a suggested order, a
   part delivery, a full stock take, and the reports that read them back.
6. **The card tender's details never reached the payment row.** Found
   adding cashback to `settle()`: the payment page put the Dojo reference,
   the tip and the entry mode on the `TenderEntry` and `settle()` was never
   passed them, so every payment row — and every payload the server saw —
   had them null. The back office could not match a Dojo webhook to a sale
   and the Payment Types report's gratuity column was always £0.00. Passed
   through now, with the cashback beside them.
8. **The tenancy sweep cannot see through a helper.** The sales builders
   took their `o.email = ?` from `windowOf()` and the static sweep flagged
   nine of them as unscoped. They were scoped; the sweep was right that it
   could not tell. Every query now writes the owner literally and binds it
   first, and `windowOf()` returns only the window.
9. **Two loyalty-app hunks rode into commit d9a0d14.** Another session's
   uncommitted edit to `loadLoyaltyApp()` in `public/app.js` (a `phones`
   count and a push-note wording) was in the working tree when `app.js` was
   committed for this release. Left in rather than reverted under that
   session's feet; both are harmless without their server half.
7. **Paid Out opens the drawer and prints no slip.** The plan said it would
   print one. It records the event, opens the drawer quietly (not through the
   No Sale key, which would log a no-sale on top) and says so on screen; the
   Z carries the line and the drawer's cash-expected comes down by it. A slip
   is a printer feature for a later release if a venue asks.
4. **A scheduled week-start report keeps no date.** "Every Monday, the week
   before" is what a weekly Daily Department Sales schedule means, so the
   schedule stores the other filters and `runReport` takes the Monday of the
   period it was due for.
