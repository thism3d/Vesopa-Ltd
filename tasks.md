# Vesopa EPOS 1.6.8.0 — build plan

## Scale honesty

This release touches one MySQL migration, about seven new server routes across
`vesopa_server`, a heavy pass over the back-office front end (`public/app.js`,
`public/index.html`, `public/style.css`, `public/charts.js`), and one of the
three Flutter apps — the till, `vesopa_epos`. The kitchen display and customer
display get version bumps and rebuilds only; no behavioural changes.

Safe stopping points, in order:

1. **End of Phase 1** — the server gains routes and a column that nothing yet
   calls. Deploying here changes nothing the venue can see. Safe.
2. **End of Phase 2** — the back office looks and reads differently (nav,
   colours, wording, new pickers). The till is untouched, so this could ship as
   a server-only release on its own if the till work slips. Safe.
3. **End of Phase 3** — the till changes. The two money-path changes (split
   bill portions, membership renewal) are the highest-risk work in the release
   and must not ship without their tests. Do not stop halfway through T23
   (split bill) and deploy.
4. **Phase 4** — the release itself.

Known traps that are *not* regressions: `flutter test` in `vesopa_epos` has
three failures on a clean tree (`dojo_accreditation_live_test.dart` and
`dojo_terminal_live_test.dart` need live Dojo credentials;
`programmed_grid_golden_test.dart` fails by 0.43% deliberately). Before
blaming any change for a test failure, `git stash push -u` (the `-u` matters)
and re-run.

Live-data discipline: only `manager@vesopa.co.uk` may be used against
`https://backoffice.vesopaepos.com`. Every other record belongs to a real
customer. Any live check creates its own data and deletes only what it created.

## Progress

Filled in as work lands. A later session should be able to pick the release up
from this table and the task bodies without re-reading anything else. Status
values: `Not started`, `In progress`, `Done`, `Blocked`.

| Task | Title | Phase | Status | Where it landed (commit / notes) |
|------|-------|-------|--------|----------------------------------|
| T1 | Schema: `epos_customers.photo_url` (re-runnable) | 1 | Done | `schema/schema_membership.sql` — three guarded columns; photo, term, fee |
| T2 | Loyalty: membership term, fee, renewal route | 1 | Done | `src/commerce.js` — LOYALTY_DEFAULTS, validated PUT, `POST /loyalty/renew` |
| T3 | Customer photo upload + loyalty lookups | 1 | Done | `src/backoffice.js` — `POST /api/customer-photo`; all three lookups carry `photo_url` |
| T4 | Customers bulk-update route | 1 | Done | `src/backoffice.js` — `PATCH /customers/bulk`, expiry only, UUID ids |
| T5 | Mix & Match deal-product routes | 1 | Done | `src/programming.js` — GET/PUT `/mix-match/:id/products`, plus a `product_count` |
| T6 | Till staff creation + permission-group list | 1 | Done | `src/server.js` — `POST /till/staff`, `GET /till/permission-groups` |
| T7 | Nav: "Reports" and "Sales Overview" | 2 | Done | renamed to Reports / Sales Overview — see correction 1 |
| T8 | Navigation title case (thirteen labels) | 2 | Done | thirteen labels, their headings, and a browser tab that names the page |
| T9 | Collapse nav groups by default | 2 | Done | `vesopa_nav_open_v2`; the current view's group opens without being remembered |
| T10 | Green dashboard palette | 2 | Done | `--chart-1`…`--chart-8` per theme; charts resolve them at draw time |
| T11 | Dark-mode select chevron fix | 2 | Done | cause was a shorthand/longhand clash — see correction 2 |
| T12 | Mix & Match product picker UI | 2 | Done | a `products` field type: search, tick, chips; `afterSave` writes the join table |
| T13 | Customers bulk-edit UI | 2 | Done | search, membership filter, picks, shift-click and a bulk expiry modal |
| T14 | Customer photo picker UI | 2 | Done | a square crop posted to `/api/customer-photo`; a face or initials in the table |
| T15 | Shift-click range select on Products | 2 | Done | shift-click over `visibleProducts()`, on `click` not `change` |
| T16 | Back-office polish list | 2 | Done | sort-arrow gap, rail bottom padding, and a Find a page box — see correction 6 |
| T17 | British English pass | 2 | In progress | extraction and the audit script are in `tool/extract_copy.py`; two findings so far, one applied, one a false positive |
| T18 | Drift: customer `photoUrl` column + migration | 3 | Not needed | the till reads the photo off the loyalty payload it already fetches; no local column, no Drift migration |
| T19 | Till: refuse expired memberships | 3 | Done | `LoyaltyCustomer.membershipExpired`; the expiry day itself still works |
| T20 | Till: take renewal fee and renew | 3 | Done | the fee is a line, the date moves at settle; `membership_plu` decides the VAT |
| T21 | Till: show customer photo on attach | 3 | Done | `MemberFace`, shown when the venue has taken a photograph and not otherwise |
| T22 | Pay key: amount beside the label | 3 | Done | programmed_bar only — `pay` is a BAR key, never a grid one, so the grid is untouched |
| T23 | Split bill: divide a quantity line | 3 | Done | `data/split_portions.dart`; the odd penny is on the first glass |
| T24 | Till: add staff / replace card from Functions | 3 | Done | `ui/staff_admin.dart`, behind manager approval, refused with no network |
| T25 | Version bumps, three apps | 4 | Done | the till only — see correction 7 |
| T26 | Full test sweep | 4 | Done | server `npm test` 0; till 810 pass with the 3 known failures; 22 + 16 live checks against backoffice.vesopaepos.com, both tidy |
| T27 | Server deploy + smoke checks | 4 | Done | src, schema, public (uploads excluded), migrations x3 silent, pm2 restart, /health ok — and index.html needs that restart |
| T28 | Three msix builds | 4 | Done | `vesopa-epos-store.msix`, 21,031,053 bytes, Identity Version 1.6.8.0 |
| T29 | Store release notes, three apps | 4 | Done | `notes-1.6.8.0-epos.txt`, 1,376 characters, the venue's shape, checked by `src/release-notes.js` |
| T30 | Upload and publish submissions | 4 | Done | submission 1152921505701835902 committed; blob read back byte for byte; status Certification, targetPublishMode Immediate |

## Corrections to the plan, found while executing it

The 1.6.7.0 plan kept a list like this and it earned its place, so it is kept
here. Each of these is something the plan got wrong, found by reading the code
or measuring the running site rather than by thinking harder about the brief.

1. **The rename is two renames, not one.** The plan read "Financial Report →
   Reports" as a clash with the group heading and settled on "Overview". It is
   not a clash: `run_report` is the page that *runs* five reports from a
   dropdown, and its own heading already read "Reports" before the chosen
   report replaced it — the nav promising one named report is the fault the
   venue is describing. So that item takes "Reports", and the item beside it
   called "Report" — the biggest-sellers breakdown, which is genuinely an
   overview — becomes "Sales Overview". Both bullets in the brief are then
   answered, and nothing is called two things.

2. **The overlapping arrows are a Night-mode-only bug, and the plan's first
   two guesses were both wrong.** Measured on the live Products page at 1440,
   1180, 1024, 900, 700 and 560 px in Day: `appearance: none`,
   `background-image: none`, nothing overlapping anything. The sort arrow in
   the header was the second guess and it fits inside its column. The actual
   cause only appears in Night: `.cell-edit { background: transparent }` is a
   **shorthand**, so it clears the chevron the generic `select` rule sets — but
   the dark rules set `background-image` **alone**, on a selector that outranks
   `.cell-edit`, so the image comes back while its position and size stay at
   `0% 0%` and `auto`. A 17px chevron is then painted over the first letters of
   the department name and tiled across the box. Evidence:
   `Documents\Vesopa-Claude-Images\2026-09-08-backoffice-1680\before-dark-products.png`.
   The venue works in Night, which is why they can see it and the plan could
   not.

3. **`pathlib.Path.write_text` turns every newline into CRLF on this machine.**
   Nine source files came out CRLF from the first round of patch scripts. Git
   warns on every add, and `test/backoffice-products.test.js` broke outright:
   it lifts `cellSelect` out of `public/app.js` by searching for `\n}\n`, and
   there were no bare newlines left to find. Patch scripts write bytes, or open
   with `newline=""`.

4. **`epos_customers.id` is a UUID, not a number.** The plan specified
   `{ ids: number[] }` for the bulk edit, copying `PATCH /products/bulk` where
   the ids genuinely are integers. Coercing a CHAR(36) id with `Number()`
   yields `NaN`, and the filter that follows would have dropped every id and
   answered "choose some customers first" on a full selection.

5. **The Mix & Match list needed a count as well as a picker.** A deal with no
   products never fires on the till, and until now there was no way to see that
   from anywhere — the products were invisible in the back office entirely. The
   CRUD factory grew one option, `extraSelect`, and the list carries a
   "no products" badge.

6. **Folding every group needed something in its place.** With all eight
   sections closed, somebody who knows a page is called "Timesheets" has to
   know it is filed under Reports before they can reach it — which is a thing
   they did not have to know yesterday. The rail has a **Find a page** box now:
   typing shows every matching item wherever it lives, folded or not, and
   clearing it puts the rail back exactly as it was. Two things were found
   building it: the first version showed the heading and nothing under it,
   because a matching item still carried `hidden-by-group`; and the box failed
   `backoffice-tablet.test.js` at 13px, because Safari zooms the page in on any
   field under 16px and does not zoom back out. Both are fixed and the second
   is why that guard exists.

7. **Only the till is released as 1.6.8.0.** The kitchen and the customer
   display have no changes at all this release — the whole diff since 1.6.7.0
   is `vesopa_epos` and `vesopa_server` — so pushing identical binaries through
   certification would be a download for every venue and nothing to show for
   it. The display could not have been submitted anyway: its 1.6.7.0 is in
   certification right now, and the Store allows one submission at a time.

8. **`put public` alone does not update the page.** `index.html` is read into a
   constant at start-up and rewritten with asset versions — see `sendShell` in
   `src/server.js` — so a markup change is invisible until `pm2 restart`. The
   search box was uploaded, served from disk, and absent from the page for one
   confusing round trip.

9. **The chart palette had one caller outside charts.js.** `Charts.PALETTE` was
   read by the loyalty tier editor to colour a new tier. Making the palette a
   function per theme would have thrown there on Add tier — caught by grep
   rather than by anything failing, which is the argument for grepping.

## Decisions taken for the client

These were decided here, not by the client. They are called out so they can be
argued with before the work lands, not after.

1. **"Financial Report" becomes "Reports", and "Report" becomes "Sales
   Overview".** ~~The item becomes "Overview" and the group heading stays
   "Reports".~~ **Superseded — see correction 1 below.** There is no nav item
   called "Financial Report": the client means `data-view="run_report"`,
   labelled "Financial Summary". That page is not one report, it is the page
   that runs five of them, so it takes the name **Reports**; and the item
   beside it called "Report" — the biggest-sellers breakdown — is the one that
   "is more of an overview", so it becomes **Sales Overview**. The group
   heading "Reports" stays.
2. **Existing operators get the collapsed nav once.** People who have already
   opened or closed groups have a saved preference in `localStorage` under
   `vesopa_nav_open`, and today that preference wins over the default. The
   storage key is bumped to `vesopa_nav_open_v2`, so everyone gets
   all-groups-collapsed exactly once; anything they toggle afterwards persists
   under the new key. The old key is simply no longer read.
3. **Split-bill remainder pennies stay on the parent's remaining portion.**
   When a line is divided and the pennies do not divide, each portion taken is
   floored and the leftover pennies stay with whatever is left of the parent
   line (in the pool, until it is allocated). Shares plus pool therefore always
   sum to the outstanding bill to the penny, and no share ever pays a penny it
   should not.
4. **Modifiers divide in proportion to their parent.** When part of a line is
   moved to a share, its modifiers move in the same proportion (split one of
   three proseccos with three extra shots and the share gets one shot), with
   the same penny-remainder rule. Zero-priced modifiers carry no money, so the
   proportion only matters for display on the printed check.
5. **"A date we set in the back office" is a membership term, not a calendar
   date.** The back office gains a membership term in months and a membership
   fee. Renewal sets the new expiry to *today + term* (or *current expiry +
   term* when renewing early), computed by the server on its own clock. A
   single fixed calendar date would renew every customer to the same day,
   which is clearly not what a membership scheme wants.
6. **The membership fee is taken as a sale line.** Renewing at the till adds a
   priced line "Membership renewal" to the open bill, so the fee appears in
   takings and on the receipt like anything else sold. The renewal is posted
   to the server only when the bill finalises; a voided bill renews nobody.
7. **An expired card prompts rather than hard-refusing.** Scanning an expired
   customer's card offers "renew for £X?" If the operator declines, no customer
   is attached — the card genuinely cannot be used — but the default path is a
   sale, not a dead end.
8. **Only the programmed bar's Pay key changes.** The built-in action bar
   (`action_bar.dart`) already draws the amount beside the label at a readable
   size; the venue uses the programmable bar (`programmed_bar.dart`), which
   draws it underneath at 12 pt. The built-in bar is left alone.
9. **Creating staff with a terminal token is new, and stays gated.** Today
   staff can only be created with a back-office login. The new till route is
   protected by the terminal token server-side and by the existing manager
   approval flow till-side. A staff member may be created without a PIN only
   when a card is about to be assigned — never both absent.

## Ambiguities the plan has had to read plainly

- **The client believes Mix & Match currently works "using PLU numbers".** It
  does not. Nothing in the back office writes `bo_mix_match_products` at all;
  the rows on live were entered by hand. The searchable picker (T5, T12) is
  built regardless, and gives them what they think they are asking to replace.
- **"Tiles" in the green request** is read as the dashboard charts and the
  stat-card accent stripes — the measured lilac/magenta surfaces — not a
  wholesale reskin of every accent in the back office.
- **"A few other items" with capital letters** is resolved by audit to the
  thirteen sentence-case labels listed in T8. If the venue spots another one
  afterwards, it is a one-line change of the same kind.
- **"Mass edit of customers"** is scoped to the stated purpose — setting
  expiry dates. Other customer fields are not bulk-editable in this pass.
- **"Role"** for a new staff member means the permission group
  (`permission_group_id` → `epos_permission_groups`), because that is what
  actually controls what they may do.
- **The English pass (T17)** covers interface copy a human reads. It does not
  touch keys, URLs, `data-view` values, API field names, or permission keys,
  however tempting the spelling.

---

## Phase 1 — schema and server routes

*Finishing this phase requires a **server deploy**. No Store build. Everything
here is inert until a UI calls it, so this phase is safe to deploy on its own.*

### T1 — Schema migration: `epos_customers.photo_url`

- **Ask:** (no direct quote — this is the enabler for "Ability to upload a
  photo of a customer…", delivered by T3/T14/T18/T21).
- **Files:**
  - New file `vesopa_server/schema/schema_customer_photo.sql` (name follows the
    existing `schema_*.sql` convention; files apply in filename order).
  - Pattern to copy: `vesopa_server/schema/schema_order_cols.sql` and
    `vesopa_server/schema/schema_permissions.sql` (the guarded
    `vesopa_add_column` / `vesopa_add_index` stored procedures).
  - Reference for the table: `vesopa_server/schema/schema_customers.sql`.
- **Behaviour:**
  - Add `photo_url VARCHAR(500) NULL` (length to match neighbouring URL
    columns) to `epos_customers`, via `vesopa_add_column` only.
  - **Re-runnable rule:** the deploy applies *every* file in `schema/` on
    *every* deploy. A bare `ALTER TABLE ... ADD COLUMN` fails on the second
    run, and because MySQL applies a multi-clause ALTER as one statement, a
    duplicate-column error rolls back the clauses that had already succeeded.
    No bare `ALTER`, no bare `CREATE INDEX` — guards for everything.
  - No other columns are needed in this release: the two new loyalty settings
    (T2) are key/value rows in `epos_loyalty_settings` merged over
    `LOYALTY_DEFAULTS`, not new columns. Confirm that while editing
    `src/commerce.js`; if the table turns out to be wide rather than
    key/value, the two settings join this file through `vesopa_add_column`.
- **Test:** apply the file **three times** against a scratch database and
  expect silence (no errors, no rolled-back clauses). Then
  `cd vesopa_server && npm test` exits 0.
- **Done:** three consecutive applications produce no error;
  `DESCRIBE epos_customers` shows `photo_url`; the file contains no unguarded
  `ALTER` or index statement.

### T2 — Loyalty settings: membership term, membership fee, renewal route

- **Ask:** "We should be allowed to renew and take their membership fee at the
  till and setting a expiry date. … say they expired and then paid £10
  membership at the till, the till should then renew to a date we set in the
  back office."
- **Files:**
  - `vesopa_server/src/commerce.js` — `LOYALTY_DEFAULTS` (line 555),
    `readLoyalty()`, `PUT /loyalty`, `GET /loyalty/public`, and the loyalty
    route block (lines ~630–760) where the new route lives.
- **Behaviour:**
  - Add two settings with defaults: `membership_term_months` (default `12`)
    and `membership_fee_minor` (default `1000` — the client's own £10 example).
    They merge through `readLoyalty()` like every other setting.
  - `PUT /loyalty` accepts both, validated: term an integer 1–60; fee a
    non-negative integer of minor units.
  - `GET /loyalty/public` serves both to the till (the till needs the fee to
    price the renewal line and the term to describe the offer).
  - New route `POST /loyalty/renew`, guarded by the same terminal-token
    middleware as the other till-facing loyalty routes. Body:
    `{ customerId }`. Behaviour:
    - 404 for an unknown customer.
    - Base date = today (server clock), or the current `membership_expiry` if
      that is still in the future (early renewal extends, it does not
      shorten).
    - New expiry = base + `membership_term_months` months.
    - Updates `epos_customers`, then returns the customer row in the same
      shape the `/loyalty/*` lookups return, so the till can refresh its
      local copy from one response.
- **Test:** new file `vesopa_server/test/loyalty_renew.test.js` (create,
  following the naming of the existing files in `vesopa_server/test/`):
  defaults present in `readLoyalty()`; `PUT /loyalty` round-trips both
  settings and rejects a non-integer term; `POST /loyalty/renew` sets
  today + term for an expired customer, extends from the current date for a
  current customer, 404s on an unknown id. `npm test` exits 0.
- **Done:** the two settings are readable and writable through the existing
  settings API, are served publicly, and the renewal route moves the expiry
  exactly as specified with tests to prove each branch.

### T3 — Customer photo upload and loyalty lookups

- **Ask:** "Ability to upload a photo of a customer that would display on the
  till when scanned to confirm it's the right person."
- **Files:**
  - `vesopa_server/src/backoffice.js` — multer config (lines 17–30) and the
    existing upload routes `POST /api/branding/logo` and
    `POST /api/product-image` (lines 930–950) to copy.
  - The customers update route in `src/backoffice.js` (find it via the edit
    form at `public/app.js` line 4753) must accept `photo_url`, including
    `null` to clear.
  - `vesopa_server/src/commerce.js` — the three lookups
    `/loyalty/customer`, `/loyalty/search`, `/loyalty/card` (lines ~630–760):
    add `photo_url` to each `SELECT`.
- **Behaviour:**
  - New `POST /api/customer-photo`, a sibling of `/api/product-image`: same
    multer limits (4 MB; png/jpeg/webp/gif only; random UUID filename; written
    to `public/uploads`); returns `{ url: '/uploads/<file>' }`.
  - `public/uploads` is **excluded from deploys** — images live only on the
    server. Nothing about this feature may depend on a file being in the
    repository, and no deploy step may delete or overwrite `uploads`.
  - The three loyalty lookups return `photo_url` alongside the existing
    `membership_expiry`, so the till receives it on the same payload it
    already consumes.
- **Test:** new `vesopa_server/test/customer_photo.test.js` (create): the
  update route persists and clears `photo_url`; all three lookups include the
  column. Upload itself checked by hand with `curl -F` against a local server
  (reject a `.txt`, accept a `.png`, confirm the returned URL shape).
  `npm test` exits 0.
- **Done:** a photo uploaded for a customer is stored, survives a redeploy
  (because `uploads` is untouched by it), and comes back from all three
  loyalty lookups.

### T4 — Customers bulk-update route

- **Ask:** "Customers / Loyalty please allow a mass edit of customers so we
  can set expiry dates easier."
- **Files:**
  - `vesopa_server/src/backoffice.js` — find `POST /products/bulk` (grep
    `products/bulk` across `src/`) and put `POST /customers/bulk` beside it,
    following its shape.
- **Behaviour:**
  - Body: `{ ids: number[], set: { membership_expiry: 'YYYY-MM-DD' | null } }`.
  - Validates: non-empty `ids`; the date is a valid calendar date or explicit
    `null` (which clears the expiry). 400 with a readable message otherwise.
  - Updates exactly the listed ids — no `WHERE` clause that could widen.
    Returns `{ updated: n }`.
  - Scope is deliberately expiry-only; the modal in T13 sends nothing else.
- **Test:** new `vesopa_server/test/customers_bulk.test.js` (create): sets a
  date across several ids; clears with `null`; rejects an empty id list and a
  malformed date; leaves unlisted customers untouched. `npm test` exits 0.
- **Done:** the route behaves as specified under test, and cannot touch a
  customer whose id was not in the request.

### T5 — Mix & Match deal-product routes

- **Ask:** "Mix & Match instead of using PLU numbers can this be set to select
  products from a drop down list with a search function."
- **Files:**
  - `vesopa_server/src/programming.js` — beside the generic
    `crud('mix-match', 'bo_mix_match', [...])` at line 254.
  - Reference: `vesopa_server/schema/schema_layout.sql` lines 87–93 for
    `bo_mix_match_products (mix_match_id, plu_id)`; `vesopa_server/src/server.js`
    lines 551–563 for the till sync that already reads it.
- **Behaviour:**
  - `GET /mix-match/:id/products` → the deal's products as
    `[{ plu_id, name, price } ]` (join for display fields the picker needs).
  - `PUT /mix-match/:id/products` with body `{ pluIds: number[] }` → replace
    the deal's rows in a transaction (delete-then-insert within one
    transaction, not a bare delete then a separate insert). 404 for an
    unknown deal; 400 for a non-array body.
  - Nothing else about the generic CRUD changes.
  - Note for the engineer: the client thinks deals currently work "using PLU
    numbers". In fact nothing in the back office writes this table today — the
    live rows were entered by hand. These routes are the first write path.
- **Test:** new `vesopa_server/test/mix_match_products.test.js` (create):
  empty list for a new deal; PUT stores and GET returns; a second PUT
  replaces rather than appends; unknown deal 404s. `npm test` exits 0.
- **Done:** a deal's product list can be read and replaced through the API,
  and the existing till sync (`server.js` 551–563) returns exactly what was
  written.

### T6 — Till routes: create staff, list permission groups

- **Ask:** "Ability to add staff members from the function screen. This should
  ask for their name, role and either pin or to swipe a new staff card."
- **Files:**
  - `vesopa_server/src/server.js` — beside `GET /till/staff` (line 612).
  - Reference for the rules to mirror: `vesopa_server/src/backoffice.js`
    lines 963–1180 (`GET/POST/PUT/DELETE /staff`, aliased `/clerks`; the table
    is `bo_clarks` — the name predates the apps, do not "fix" it).
  - `vesopa_server/src/cards.js` — `POST /till/cards/assign` already exists
    and already refuses a card belonging to somebody else; the new route does
    **not** duplicate card logic.
- **Behaviour:**
  - `POST /till/staff`, terminal token required. Body:
    `{ name, permissionGroupId, pin? }`.
    - `name` non-empty; `permissionGroupId` must exist in
      `epos_permission_groups` (400/404 otherwise).
    - `pin` optional, but if present it is **exactly four digits** — the till
      pad submits on the fourth key, so a five-digit PIN creates someone who
      can never sign on. Anything else is a 400.
    - A PIN already in use is a **409 naming the person who holds it**, the
      same response shape the back-office route gives.
    - Allocate `pluid` the same way `POST /staff` does.
    - Respond with the new staff member shaped exactly like a `GET /till/staff`
      entry (id, pluid, name, pin, `swipe_card`, group switches), so the till
      can cache it from one response.
    - A PIN-less creation is allowed **only** as the first half of "swipe a
      new card"; the till (T24) then calls `POST /till/cards/assign` and is
      responsible for never finishing with neither PIN nor card.
  - `GET /till/permission-groups`, terminal token required →
    `[{ id, name }]` so the till can offer roles.
- **Test:** new `vesopa_server/test/till_staff.test.js` (create): happy path
  with PIN; 3-digit and 5-digit PINs are 400; duplicate PIN is a 409 naming
  the holder; unknown group rejected; no token rejected; groups endpoint
  lists the seeded groups. `npm test` exits 0.
- **Done:** a terminal can create a staff member and list roles without a
  back-office login, and every rule the back office enforces (four digits,
  unique PIN, named 409) is enforced identically here.

---

## Phase 2 — back office

*Finishing this phase requires a **server deploy** (the back office is served
from `vesopa_server/public`). No Store build. The venue sees this phase as soon
as it deploys.*

### T7 — "Financial Summary" becomes "Reports"; "Report" becomes "Sales Overview"

> **Corrected while executing — see correction 1.** The plan first said to
> rename the one item to "Overview" and leave everything else. That was wrong
> about what the two pages are.

- **Ask:** "Backoffice – rename the navigation from Financial Report to
  Reports." and "Change Reports to something else? It's more of an overview so
  I let you decide on that one."
- **Files:**
  - `vesopa_server/public/index.html` — the nav rail (lines 236–300): the item
    `data-view="run_report"` labelled "Financial Summary", and the item
    `data-view="report"` labelled "Report"; also the page heading for
    `view-report`.
  - `vesopa_server/src/permissions.js` — the labels on
    `reports.financial_summary` and `reports.report`. **Neither key changes.
    Only the labels**, and they have to move because that list is deliberately
    shaped like the navigation.
  - `vesopa_server/public/app.js` — `document.title`, which was built from the
    view *key* (`run_report`, `dinein_qr`) and so leaked variable names into
    the browser tab. It reads the rail's own label now.
- **Behaviour:**
  - `run_report` is labelled **Reports**. It is not one report: it is the page
    that runs five of them from a dropdown, and its own heading already said
    "Reports" before being replaced by whichever report was chosen. The venue
    calling it "Financial Report" is the nav promising a single report the
    page has not been for some time.
  - `report` is labelled **Sales Overview**. Its heading describes it exactly —
    "your biggest sellers across every closed bill, by group, department, staff
    member and product" — which is the "more of an overview" the client is
    pointing at, and the name it needs now that Reports is taken.
  - The group heading "Reports" stays. Nothing machine-facing moves:
    `data-view="run_report"`, `data-view="report"`, the permission keys, the
    report registry key `financial_summary` (schedules store it), and the
    report's own printed name "Financial Summary", which is the heading on a
    document handed to an accountant and should stay the accountant's words.
- **Test:** `npm test` exits 0. `grep -rn "Financial Summary"` finds it only
  in `src/reports.js` (the printed report) and in comments; `grep -rn
  "financial_summary" vesopa_server/src` still finds the key where it was.
- **Done:** the rail reads Reports and Sales Overview, the permission screen
  agrees with the rail, the browser tab names the page rather than the view
  key, and no key, route or `data-view` has moved.

### T8 — Navigation title case

- **Ask:** "Scheduled reports please put a capital R on reports. This is a
  same for a few other items on the back office Navigation."
- **Files:**
  - `vesopa_server/public/index.html` — nav rail (lines 236–300) and each
    matching page heading.
  - `vesopa_server/public/app.js` — any `document.title` strings for these
    views.
- **Behaviour:** change exactly these thirteen labels, nowhere else:

  ```
  Scheduled reports   → Scheduled Reports
  Screen programming  → Screen Programming
  Printer categories  → Printer Categories
  Your menu page      → Your Menu Page
  Table codes         → Table Codes
  Online orders       → Online Orders
  Receipt designer    → Receipt Designer
  Gift cards          → Gift Cards
  Wallet passes       → Wallet Passes
  Tender & gratuity   → Tender & Gratuity
  Automation rules    → Automation Rules
  Till & printers     → Till & Printers
  Kitchen screens     → Kitchen Screens
  ```

  Each nav item's page heading (and `document.title`, where one exists for the
  view) changes with it — the three surfaces must not drift apart. Labels
  already in title case (`Dashboard`, `Mix & Match`, `Back Office Users`,
  `Sales Explorer`, …) are untouched.
- **Test:** eyeball the rail and each affected page;
  `grep -n "Scheduled reports" vesopa_server/public/index.html` and the
  equivalents return nothing; `npm test` exits 0.
- **Done:** the thirteen labels read as above in the nav, on their page
  headings, and in the browser tab.

### T9 — Collapse the navigation by default

- **Ask:** "Can we default the back office navigation so all the sub pages are
  hidden and only displaying the header until clicked to show submenu."
- **Files:**
  - `vesopa_server/public/app.js` — `navItemsFor()`, `applyGroupState()`,
    `toggleGroup()`, `initNavGroups()` (around lines 428–475), including
    `const defaultCollapsed = ['programming', 'people', 'administration'];`
    and the `localStorage` key `vesopa_nav_open`.
- **Behaviour:**
  - Every group is collapsed by default — only headings show on a fresh
    browser. Implement by listing every group id in `defaultCollapsed` (or by
    inverting the default), not by hiding items another way.
  - The group containing the **current view** still opens itself — that logic
    already exists; keep it working.
  - Bump the storage key to `vesopa_nav_open_v2` so operators with a saved
    preference get the new default once (decision 2). From then on their
    toggles persist under the new key. The old key is no longer read; do not
    migrate it.
  - Out of scope here: the "Hide menu" footer overlap — that is T16.
- **Test:** manual, against a local server: fresh profile (or cleared site
  data) → headings only; click a heading → group opens; reload → still open;
  navigate directly to a view inside a collapsed group → its group opens. An
  old `vesopa_nav_open` value in storage has no effect.
- **Done:** all of the manual checks pass, and a first-time operator sees
  exactly one heading row per group until they ask for more.

### T10 — Green dashboard palette

- **Ask:** "Please Change the tiles to our Green from the light lilac/purple."
- **Files:**
  - `vesopa_server/public/charts.js` — `PALETTE` and the three default
    colours (lines 35–36): `line()` defaults to `#b5179e` (the Takings area
    chart and the payment-breakdown donut), `bar()` to `#4361ee`, `ranked()`
    to `#7209b7`.
  - `vesopa_server/public/style.css` — `.stat-card` accent stripes
    (lines 1495–1503, currently `#4361ee`, `#f77f00`, `#06d6a0`, `#ef476f`);
    brand tokens `--brand: #a5c715`, `--brand-deep`, `--on-brand` already
    exist; dark theme is `:root[data-theme="dark"]` plus a
    `prefers-color-scheme` block.
- **Behaviour:**
  - Re-cut the palette around the brand green. The Takings area, the donut's
    first slice and the ranked bars lead with the green; the remaining
    categorical colours are chosen to sit with it — **no magenta, no purple
    leads**. Ten categories still need to be distinguishable from each other.
  - Re-cut the four stat-card stripes to a coordinated sequence rather than
    the current random rainbow.
  - Verify in **both** themes — the venue works in dark mode. On light
    surfaces the green may need `--brand-deep` for line contrast; on dark the
    full `--brand` reads well. Hard-coded hex is fine (the charts already
    are), but every value must be checked against both backgrounds.
- **Test:** visual: open the dashboard in light and dark, at a desktop width,
  and check legibility of every series, stripe and donut slice. Take a
  screenshot of each theme for the release record.
  `grep -n "b5179e\|7209b7" vesopa_server/public/charts.js` returns nothing.
- **Done:** the dashboard reads green-led in both themes, nothing lilac or
  purple survives in `charts.js`, and the stat-card stripes look deliberate.

### T11 — Fix the overlapping select arrows (dark mode)

- **Ask:** "Fix the arrows overlapping the departments and sub departments in
  the product view page."
- **Files:**
  - `vesopa_server/public/style.css` — the base `select` rule (around
    lines 5659–5707: `appearance: none; padding-right: 38px;
    background-image: url("data:image/svg+xml,…chevron…");
    background-position: right 12px center; background-size: 17px;`);
    `.cell-edit` (line 2715: `background: transparent; padding: 3px 6px;`);
    the dark rules `:root[data-theme="dark"] select { background-image: … }`
    and the matching `@media (prefers-color-scheme: dark)
    :root:not([data-theme="light"]) select { … }`.
  - The rendering side, for reference only: `cellSelect()` in
    `vesopa_server/public/app.js` line 2064.
  - "Before" evidence:
    `C:\Users\Administrator\Documents\Vesopa-Claude-Images\2026-09-08-backoffice-1680\before-dark-products.png`.
- **Behaviour:** the cause, established by measuring, is a specificity and
  shorthand interaction: `.cell-edit`'s `background:` shorthand clears the
  chevron's image/position/size in light mode (so no arrow at all), while the
  dark rules set *only* `background-image` at a specificity that beats the
  class — so in dark mode the image returns with default position `0% 0%` and
  repeats across the cell, on top of the department name. The fix:
  - Stop relying on shorthand/longhand luck. `.cell-edit` sets
    `background-color`, `background-image`, `background-position`,
    `background-repeat`, `background-size` **explicitly**, with
    `padding-right` making room, in both themes — so the chevron sits once, at
    the right edge, clear of the text, in light *and* dark.
  - The chevron must remain theme-appropriate (dark chevron on light, light
    chevron on dark — the two SVG data-URIs already exist per theme).
  - Deliberate visible change: light mode **gains** the chevron on these
    cells. A cell that looks like plain text but is a dropdown is its own
    complaint; the affordance stays.
  - Audit the rest of the stylesheet: `grep -n "background" style.css` over
    every rule that targets a `select` (or a class applied to one) and fix
    any other place overriding `background` on a select the same way.
- **Test:** manual, measured: Products page, dark theme, at 1440 / 1180 /
  1024 / 900 / 700 / 560 px — one chevron per Department and Sub Department
  cell, right-aligned, never over text; same in light theme (chevron now
  present). Take an "after" screenshot next to the "before" one.
  `npm test` exits 0.
- **Done:** at every measured width, in both themes, each cell shows exactly
  one chevron that does not overlap the text, and no other `select` rule in
  the stylesheet can recreate the bug.

### T12 — Mix & Match product picker

- **Ask:** "Mix & Match instead of using PLU numbers can this be set to select
  products from a drop down list with a search function."
- **Files:**
  - `vesopa_server/public/app.js` — the generic-CRUD registration at line 568
    (`'mix-match': { path: 'mix-match', title: 'deal', sortable: true,
    fields: [...] }`); the custom-control pattern `imagePicker()` /
    `wireImagePickers()` (lines ~690–780) to copy for a bespoke control inside
    the generic modal; the products list fetch used by the Products page
    (reuse it rather than inventing a second one).
  - Server side: T5's routes.
- **Behaviour:**
  - The deal form gains a "Products" control: a search box filtering a
    checklist of products (match on name or PLU), with the chosen products
    shown as removable chips and a count.
  - Editing a deal loads its current products from `GET /mix-match/:id/products`.
  - Saving: for an existing deal, save the CRUD fields then `PUT` the product
    list; for a **new** deal, create it first, then `PUT` with the new id —
    in that order, because the list is keyed by deal id.
  - The generic CRUD (sortable, existing fields) keeps working unchanged.
- **Test:** manual against a local server (then once against live as
  `manager@vesopa.co.uk` with a deal created and deleted for the purpose):
  create a deal, search and add three products by name, save, reload — the
  three persist; remove one, save, reload — gone; confirm the till sync
  output (`src/server.js` lines 551–563) returns the chosen products for that
  deal. `npm test` exits 0.
- **Done:** a deal's products can be found by search and saved entirely from
  the deal form, and the sync endpoint serves exactly what was chosen.

### T13 — Customers bulk-edit UI

- **Ask:** "Customers / Loyalty please allow a mass edit of customers so we
  can set expiry dates easier."
- **Files:**
  - `vesopa_server/public/app.js` — the pattern to copy is the Products page:
    `productPicks` (a `Set` of ids held across re-renders, line 1661),
    `renderBulkBar()` (line 1951), `bulkEditProducts()` (line 1972), the
    per-row `.pick-col` checkbox (line 2127) and the header select-all. The
    customers table and its expiry badge are around line 2462.
  - Server side: T4's route.
- **Behaviour:**
  - The customers table gains the same machinery: a checkbox column, a header
    select-all over the visible (filtered) rows, a picks `Set` that survives
    re-renders, and a bulk bar showing "N selected" with **Set expiry date…**
    and **Clear expiry** actions.
  - The modal sets one date (or confirms clearing) and posts to
    `POST /customers/bulk`; on success the table refreshes and the expiry
    badges (line ~2462) reflect the change immediately.
  - Scope: expiry only, in this pass (see the ambiguities section).
- **Test:** manual: filter the list, select three customers with the boxes and
  the select-all, set a date — all three badges update; clear expiry on two —
  badges clear; an unselected customer is untouched. Live spot-check once with
  a customer created and deleted for the purpose. `npm test` exits 0.
- **Done:** an operator can put the same expiry date on any visible selection
  of customers in one action, and nothing outside the selection changes.

### T14 — Customer photo picker

- **Ask:** "Ability to upload a photo of a customer that would display on the
  till when scanned to confirm it's the right person."
- **Files:**
  - `vesopa_server/public/app.js` — the customer edit form (line ~4753, which
    already has the `membership_expiry` date field); the
    `imagePicker()` / `wireImagePickers()` control (lines ~690–780) with its
    square/circle crop option — use the circle crop for people.
  - Server side: T3's `POST /api/customer-photo` and the update route that
    persists `photo_url`.
- **Behaviour:**
  - The customer form shows the current photo (or initials placeholder), an
    upload control using the existing picker, and a **Remove photo** action
    that saves `photo_url: null`.
  - Upload posts to `/api/customer-photo`, then the returned `/uploads/<file>`
    URL is saved with the customer. Oversized or wrong-type files are refused
    by the server (4 MB; png/jpeg/webp/gif) — surface the error in the modal
    rather than failing silently.
- **Test:** manual: upload a photo, save, reload the form — photo shows;
  remove it — placeholder returns; confirm `GET /loyalty/customer` for that
  customer now returns `photo_url` (curl or browser). `npm test` exits 0.
- **Done:** a customer's photo round-trips through the form and is exposed to
  the till through the loyalty lookups.

### T15 — Shift-click range select on Products

- **Ask:** "Allow use to select multiple products for mass edit using the
  shift key to select the first and last product and everything in between."
- **Files:**
  - `vesopa_server/public/app.js` — `productPicks` (line 1661), the per-row
    checkbox `<input type="checkbox" data-pick="${p.id}">` (line 2127),
    `visibleProducts()`, `renderBulkBar()` (line 1951), `bulkEditProducts()`
    (line 1972).
- **Behaviour:**
  - Remember the **anchor**: the id of the last row whose checkbox was
    clicked without Shift.
  - A Shift+click toggles its row, then sets every row from the anchor to the
    clicked row **inclusive** to the clicked row's new state — computed over
    `visibleProducts()`, i.e. the visible, sorted, filtered order. Ranging
    over the underlying array would select rows a search has hidden.
  - If the anchor is not in the current visible list (after a search or
    re-sort), treat the Shift+click as a plain click and re-anchor.
  - The header select-all and the bulk bar behave exactly as today.
- **Test:** manual script: sort by name, click row 2, Shift+click row 7 —
  rows 2–7 selected, bar reads "6 selected"; Shift+click a selected row —
  the range deselects; search to narrow the list, then Shift+click across the
  filtered view — only visible rows are picked; sort differently mid-selection
  and confirm the picks `Set` (ids) is unaffected. `npm test` exits 0.
- **Done:** every step of the script behaves as described, with the range
  always following what the operator can see.

### T16 — Back-office polish list

- **Ask:** "Any other tweaks you can think of for the back office to make it
  look sexier."
- **Files:** various, per item.
- **Behaviour:** a short, concrete list — each item says what it fixes. Four
  items; two are cross-references so their work is not doubled.
  1. **Sort arrow hard against the header word** (Products table,
     `public/style.css` table-header rules): add a small margin between the
     header label and the sort indicator. Fixes cramped headers on every
     sortable table, not just Products.
  2. **Nav rail scrolls its last group under the "Hide menu" footer**
     (`public/style.css` nav rules): give the rail bottom padding (or take the
     footer out of the scrolling flow) so the final group is fully reachable.
     Fixes unreachable menu items at the bottom of the rail.
  3. **Stale department name in live data:** a product on live shows its
     department as "Beers (no longer listed)" because the department was
     renamed under it. On the live back office, move the affected products to
     the correct department and rename or remove the stale one. Fixes
     nonsense department names on the till and in reports. This is a live
     data change: back the database up first, use the normal Departments UI,
     and confirm the target department with the venue if "Beers" is not
     obvious.
  4. **Dark-mode chevrons and rainbow accents** — already fixed properly in
     T11 and T10; mention them in the release notes as part of the tidy-up
     rather than duplicating work here.
- **Test:** visual for 1 and 2 (both themes for the nav); for 3, the product
  list on live no longer shows the stale department, and the Departments page
  reflects the tidy-up. `npm test` exits 0.
- **Done:** the four items are each visibly fixed (or verified fixed by their
  own tasks), and nothing else has been "improved" beyond this list.

### T17 — British English pass

- **Ask:** "Can we use AI to tweak your instructions / saying so it's in
  perfect English. Please make sure it's English UK not American."
- **Files:**
  - `vesopa_server/public/index.html` — headings, hints.
  - `vesopa_server/public/app.js` — labels, empty states, confirmations,
    error messages.
  - `vesopa_server/src/permissions.js` — permission **labels only** (keys and
    labels are different fields; only the label may ever move).
  - `vesopa_server/src/*.js` — server error strings that surface to a human.
- **Behaviour:**
  - British spellings throughout: -ise endings, colour, centre, licence as a
    noun, practise as a verb, cheque, catalogue.
  - No Americanisms: gotten, "off of", "different than", US date order in
    prose.
  - Consistent casing: sentence case in body copy, title case in navigation
    (T8 did the nav).
  - Straight apostrophes everywhere (`'`, not `’`) — pick one and be
    consistent.
  - Venue words over jargon where a venue word exists.
  - **Hard rule:** never touch a string that is a key, a URL, a `data-view`
    value, an API field name, a permission key, or anything compared against
    elsewhere. Only words a human reads. When in doubt, leave it.
- **Test:** three parts, all required.
  1. Read the entire diff by eye — every changed string is display copy, none
     is a key.
  2. `cd vesopa_server && npm test` exits 0 (permission and route tests pin
     machine-facing strings).
  3. Mechanical sweep: `grep -rni "gotten\|off of\|different than\|color\|
     center\|organize\|finalize\|licensee"` over the four areas and confirm
     every hit (if any) is justified; then click through the back office and
     read the pages touched.
- **Done:** the diff is clean under all three checks, and an operator reading
  the back office meets correct, consistent British English.

---

## Phase 3 — the till (`vesopa_epos`)

*Finishing this phase requires a **Store build** of `vesopa_epos` (folded into
Phase 4) and **Phase 1 must be deployed** before the end-to-end checks. The
kitchen and customer-display apps are not changed in this phase. Run
`flutter test` after every task; expect only the three known failures listed in
"Scale honesty".*

### T18 — Drift: customer `photoUrl` column and migration

- **Ask:** (enabler for the photo request; see T14/T21 for the quoted ask).
- **Files:**
  - `vesopa_epos/lib/data/local/database.dart` — the customers table (line 249
    holds `DateTimeColumn get membershipExpiry`); bump `schemaVersion` and add
    a migration step.
  - `vesopa_epos/lib/data/local/database.g.dart` — regenerated, committed.
  - The mapper that turns a `/loyalty/*` payload into a Drift companion —
    find it by grepping `membershipExpiry` across `vesopa_epos/lib`.
- **Behaviour:**
  - Add `TextColumn get photoUrl => nullable()`.
  - Migration: on upgrade from the previous schema version, add the column.
  - The mapper stores `photo_url` from the loyalty payloads (T3) alongside
    `membershipExpiry`.
  - Regenerate with `dart run build_runner build` and commit the result.
- **Test:** `flutter test` — the existing database tests plus, if the house
  pattern includes migration tests, one that opens a database at the old
  version and upgrades. Only the three known failures remain.
- **Done:** an upgraded local database has the column, and a synced customer
  with a photo has its URL stored locally.

### T19 — Till: refuse expired memberships

- **Ask:** "Please allow a function on the till that is the customer have
  expired they card can't be used."
- **Files:**
  - The customer-attach paths in `vesopa_epos/lib` — locate them by following
    what consumes `/loyalty/card` (the scan path, via `swipe_listener.dart`)
    and `/loyalty/search`. The expiry value is already stored locally (T18's
    neighbour, `membershipExpiry`); nothing reads it yet — this task is the
    reader.
- **Behaviour:**
  - When a customer is attached by scan or search: if `membershipExpiry` is
    non-null and **before today** (till-local date; the expiry date itself is
    still valid through its day), the customer is **not** attached. Instead,
    show "Membership expired on \<date\>" with **Renew (£X)** and **Not now**.
    - **Renew** runs T20's flow. **Not now** leaves no customer attached —
      the card genuinely cannot be used.
  - `membershipExpiry` null (plain loyalty customers) is unaffected.
  - The check is local — it must work with the broadband off, which is why the
    expiry is synced to the till at all.
- **Test:** new `vesopa_epos/test/customer_expiry_test.dart` (create): the
  attach decision with expiry yesterday (refused + prompt), today (allowed),
  tomorrow (allowed), and null (allowed). This is decision logic — no IO, so
  the `dart:io` stubbing in widget tests is irrelevant here.
- **Done:** an expired card cannot attach a customer; the only onward paths
  are renewal or walking away.

### T20 — Till: take the membership fee and renew

- **Ask:** "We should be allowed to renew and take their membership fee at the
  till and setting a expiry date. … say they expired and then paid £10
  membership at the till, the till should then renew to a date we set in the
  back office."
- **Files:**
  - The renewal prompt from T19; the bill/finalise path (start from
    `vesopa_epos/lib/data/tender_engine.dart` and wherever finalise hooks
    live); the loyalty settings sync that consumes `GET /loyalty/public`
    (T2 added the fee and term to it).
  - Server side: T2's `POST /loyalty/renew`.
- **Behaviour:**
  - **Renew** adds a sale line "Membership renewal" priced at the configured
    fee (`membership_fee_minor` from synced loyalty settings) to the open
    bill, tied to that customer. One renewal line per customer per bill —
    tapping Renew twice does not double it.
  - On finalise, the till POSTs to `/loyalty/renew` with the customer id. The
    server computes the new expiry (today + term, or current expiry + term
    when early) and returns the customer; the till updates its local copy.
  - A bill voided before finalise renews nobody — the POST happens only on
    finalise.
  - If the POST fails (offline, server error): do **not** pretend the renewal
    happened. Queue it, warn the operator ("payment taken — renewal will
    complete when the connection returns"), and retry when connectivity
    returns.
- **Test:**
  - New `vesopa_epos/test/membership_renewal_test.dart` (create) with a fake
    API: renewal line added once and priced from settings; finalise triggers
    exactly one POST; void triggers none; a failed POST queues and a later
    success clears the queue.
  - End-to-end: new `vesopa_epos/integration_test/membership_renewal_live_test.dart`,
    run with `flutter test integration_test/membership_renewal_live_test.dart
    -d windows` against `https://backoffice.vesopaepos.com` as
    `manager@vesopa.co.uk`. It creates its own test customer, expires it,
    renews through the real routes, asserts the new expiry in the back
    office, then deletes **only** that customer.
- **Done:** an expired customer renewed at the till shows an expiry of
  today + term in the back office, the £10 (or configured fee) appears in
  takings on the receipt, and a lost connection never loses the renewal.

### T21 — Till: show the customer photo on attach

- **Ask:** "Ability to upload a photo of a customer that would display on the
  till when scanned to confirm it's the right person."
- **Files:**
  - The customer-attach UI in `vesopa_epos/lib/ui` (the panel or dialog shown
    when a customer is attached — find it from the attach paths in T19);
    `photoUrl` from T18.
- **Behaviour:**
  - When a customer with a `photoUrl` is attached, show the photo large enough
    to recognise a face, fetched from
    `https://backoffice.vesopaepos.com` + `photoUrl`, and cache it locally so
    repeat scans do not refetch.
  - No photo, or photo unreachable (offline): show an initials placeholder.
    The photo never blocks a sale — it is a confirmation, not a gate.
- **Test:** widget test with the house `dart:io` stubbing in mind (image HTTP
  answers 400 in widget tests): assert the placeholder path renders and the
  correct URL is requested — not real pixels. Then a manual check on a real
  till against a live customer who has a photo.
- **Done:** scanning a photographed customer shows their photo on the till;
  everyone else gets a clean placeholder; the sale proceeds offline.

### T22 — Pay key: amount beside the label

- **Ask:** "Pay button can the amount be on the side of the button not
  underneath so it's bigger and easier to read."
- **Files:**
  - `vesopa_epos/lib/ui/widgets/programmed_bar.dart` — `_resolved` (line 636)
    returns `note: money(live.totalMinor)` for the `pay` function key; the key
    body (lines 754–800) draws icon, label, then the note **underneath** in a
    Column at `fontSize 12`. **This** is the bar the venue uses.
  - `vesopa_epos/lib/ui/widgets/action_bar.dart` — `_PrimaryKey` (lines
    267–336) already lays label and amount in a Row at 19 pt / 22 pt w800.
    Leave it alone (decision 8), but reuse its sizes for consistency.
  - `vesopa_epos/lib/ui/widgets/programmed_grid.dart` — same label/note Column
    at lines ~433–455. Determine whether `pay` is a placeable grid key
    (screen programming / finalise keys); if it is, apply the same treatment
    there, and record the answer in the commit message either way.
- **Behaviour:**
  - For the `pay` function key only: label and amount side by side in a Row —
    amount at 22 pt w800, label at 19 pt, matching the built-in bar's
    hierarchy.
  - Keys can be narrow: shrink gracefully. The amount keeps priority; the
    label ellipsises; the icon drops before anything overflows. No overflow
    at any width the bar allows.
  - Every other use of `note` keeps the existing Column treatment: "Not in
    the catalogue", "Screen removed", a product price when `showPrices` is
    on.
- **Test:** existing golden tests over these widgets will move. Inspect the
  rendered diff image by eye before accepting any regenerated golden — never
  regenerate to make a test green without looking at the picture.
  `programmed_grid_golden_test.dart` already fails by 0.43% on a clean tree:
  confirm with `git stash push -u` that any failure you see is yours or that
  known one before touching goldens.
- **Done:** on the venue's real bar layout, the Pay key shows the amount
  beside the word at a size worth reading; narrow keys degrade without
  overflow; every other note usage is pixel-for-pixel as before.

### T23 — Split bill: divide a quantity line

- **Ask:** "There's also a bug on split bill. If there is 3 x Prosecco you
  can't split them off, someone must pay for the 3 glasses if you get what i
  mean."
- **Files:**
  - `vesopa_epos/lib/ui/split_bill_sheet.dart` (768 lines) — the
    pool-and-shares screen: `_lines` (`List<PricedLine>` in reading order),
    `_shares` (`List<Set<String>>`), `_picked` (`Set<String>`), `_pool`.
  - `vesopa_epos/lib/data/tender_engine.dart` — `TenderState.splitByItems(
    List<List<String>> groups)` (line 238) and `_apportion()`.
  - `vesopa_epos/lib/data/pricing_engine.dart` — `PricedLine` (line 4):
    `quantity` (a `double`), `unitPriceMinor`, `discountMinor`, `grossMinor`,
    `netMinor`, `parentLineId`.
  - The print path: `onPrintShare(Set<String> lineIds, String title, int
    totalMinor)` and its callers.
- **Behaviour:**
  - Division is a lens over the sale line, never a rewrite of it. The sale keeps
    its `3 x Prosecco` row for the full bill, kitchen dockets and any later
    reprint; dividing only changes how the engine and the sheet apportion it.
  - New on `TenderState`: `divideLine(String lineId) → List<String>`. Offered
    only when the line is top-level (`parentLineId == null`), `quantity > 1`
    and `quantity` is a whole number. It mints one synthetic `PricedLine` per
    unit, id `${lineId}#${i}` for i in 1..n, each `quantity: 1`, held in a
    `_portions` map keyed by those ids. The engine hands the ids out and
    resolves them; the sheet and the print path both ask the engine, so the
    three can never disagree about what an id means.
  - The money. Portion gross is `unitPriceMinor` — a portion is one unit, so
    gross always divides exactly. `netMinor` is apportioned base-plus-remainder:
    `base = netMinor ~/ n`, and the first `netMinor % n` portions carry
    `base + 1`. Each portion's discount is what remains, `gross − net`, so the
    discounts sum to `discountMinor` exactly as well. Portions therefore add up
    to the parent to the penny however they are grouped, the shares sum to the
    outstanding, and `_apportion()` needs no rounding changes. The odd penny,
    when a line won't divide evenly, is paid by portion 1 — deterministic, and
    always the same glass however the operator drags them.
  - Modifiers divide through their parent, never on their own — `divideLine`
    refuses a child id. A child whose quantity tracks the parent's (the normal
    case: `3 x Peppercorn` on `3 x Steak`) is divided the same way, and
    portion i of the parent owns portion i of the child — `${childId}#${i}`
    with `parentLineId: ${parentId}#${i}`, money apportioned identically. A
    flat child whose quantity doesn't match (a one-off charge) rides whole on
    portion 1. Parent portions plus child portions still sum exactly to the
    original lines.
  - In the sheet: a pool row with a divisible quantity shows a divide
    affordance on its quantity chip, and long-press on the row does the same —
    the gesture the venue's old system used. The only division offered is into
    singles; any coarser grouping is built by dragging singles. Confirming
    replaces the row in `_lines` with the portion rows at the same position,
    and from then on portions pick and drag exactly like any other line,
    because `_shares`, `_picked` and `_pool` already hold ids and a portion id
    is just an id. When every portion of a parent is back in the pool
    unassigned, the sheet re-merges them — the engine drops the portions and
    the pool shows `3 x Prosecco` again. Merge is never offered while any
    portion sits in a share.
  - `splitByItems` resolves every id (sale line or portion) and validates
    coverage: a divided line is covered exactly when all of its portions are
    present; the parent's own id in a group is an error once it has been
    divided; a missing portion fails the way a missing line does today.
  - Print: `onPrintShare` resolves portion ids to the portion lines, so a share
    never prints `3 x Prosecco` unless it genuinely holds all three. Portions
    of one parent inside a single share coalesce on the receipt — two glasses
    on share 2 print as `2 x Prosecco £9.10`, one glass on share 1 as
    `1 x Prosecco £4.55`. The full-bill reprint is untouched and still shows
    the original line.
  - Fractional quantities (a 1.5 kg weigh-line) and quantity-1 lines are not
    offered the gesture at all — there is no sensible unit to tear them into;
    the venue re-weighs or re-rings if it truly needs to part one.
- **Test:**
  - `vesopa_epos/test/data/tender_engine_test.dart`: divide 3 x £3.50 carrying
    a £1.00 line discount → portions net 317p, 317p, 316p, summing to 950p,
    the line's `netMinor`; 3 x £4.55 with no discount → 455p each;
    `splitByItems([[p1], [p2, p3]])` sums to the outstanding to the penny;
    parent id mixed with its own portion → throws; one portion missing →
    throws; `divideLine` on quantity 1, on 1.5, and on a modifier id → throws;
    3 x Steak + 3 x Peppercorn → the share holding `steak#2` also holds
    `peppercorn#2` at 150p; a flat £2.00 child lands whole on portion 1.
  - `vesopa_epos/test/ui/split_bill_sheet_test.dart` (widget): long-press
    `3 x Prosecco` → three pool rows in the same place; one dragged to share 1,
    two to share 2, share totals adding to the bill total; all portions
    returned to the pool re-merge to `3 x Prosecco`; no affordance on a `1 x`
    row or a `1.5 kg` row.
  - Print: a one-portion share prints `1 x Prosecco £4.55` and never `3 x`;
    a two-portion share prints `2 x Prosecco £9.10`; the full bill reprint
    still shows `3 x Prosecco`.
- **Done:** the table with 3 x Prosecco can put one glass on its own share and
  two on another; every share total is exact and the shares add to the bill to
  the penny; each receipt reads what that person is actually paying for; and
  nothing about the sale itself, the kitchen docket or the full-bill reprint
  has changed.

### T24 — Till: add staff / replace a card from the Functions screen

- **Ask:** the client wants a new starter put on the till from the shop floor,
  not by driving to the back office — and, their words, "the ability for
  existing staff to assign a new card if their one have broke, lost etc."
- **Files:**
  - `vesopa_epos/lib/ui/functions_page.dart` — the `Shift` group (listed only
    when `tillSettingsProvider.idleRequirePin && canSignOnProvider`) gains two
    `_Function`s.
  - `vesopa_epos/lib/ui/manager_approval.dart` — the gate both flows sit
    behind.
  - `vesopa_epos/lib/ui/staff_pin_pad.dart` — the four-key-submit pad, reused
    for PIN entry and confirmation.
  - `vesopa_epos/lib/hardware/swipe_listener.dart` — reading the new card.
  - `vesopa_epos/lib/ui/cards_page.dart` — the card-UI patterns to mirror.
  - `vesopa_server/src/server.js` — `GET /till/staff` (line 612), the read
    side, terminal-token signed; plus the two routes T6 adds — create a staff
    member (`POST /till/staff`) and list the venue's permission groups
    (`GET /till/permission-groups`) — also on a terminal token.
  - `vesopa_server/src/cards.js` — `POST /till/cards/assign` and
    `POST /till/cards/issue`, which already refuse a card registered to
    somebody else, and name them.
  - `bo_clarks` (staff rows) and `epos_permission_groups` — "role" in the
    client's words is `permission_group_id`.
- **Behaviour:**
  - The `Shift` group gains **Add staff** and **Replace card**, under exactly
    the same visibility rule as the rest of the group. Both open behind
    manager approval — a manager's PIN or card authorises the flow before
    anything else shows.
  - Add staff: name → PIN pad reused from sign-on, so it submits on the fourth
    digit and a fifth cannot be typed → confirm PIN → role picker listing the
    venue's permission groups by name → optional card swipe → the T6 create
    route. The form itself also refuses anything but exactly four digits
    before the POST, and the route validates `^\d{4}$` and answers 400
    otherwise, because a five-digit PIN sitting in `bo_clarks` is a person who
    can never sign on.
  - A PIN already in use comes back 409 naming its holder: show "That PIN is
    already used by {name}" and drop back to the pad. The PIN is never echoed
    after submit and never logged.
  - On success the till refreshes its cached staff list from `GET /till/staff`,
    so the new starter — permission-group switches and all — can sign on at
    that till within the minute.
  - Replace card: manager approval → pick the staff member from the
    `GET /till/staff` list (searchable; some venues have dozens) → swipe the
    new card → confirm, naming the person. A card the system already knows
    goes through `assign`; one it has never seen goes through `issue`. Either
    route refuses a card registered to somebody else and names them — surface
    that verbatim and let the manager pick another card. The moment the row's
    `swipe_card` changes the old card is dead: sign-on matches cards against
    the row, so there is nothing to revoke and no window where both work.
  - Offline: neither flow can work without the server and neither pretends to.
    PIN uniqueness is venue-wide, the permission groups live on the server,
    and a locally-invented person could sign on at one till and not another —
    so there is no queue-and-sync. With no connection the two entries stay
    listed but greyed, description set to "Needs a connection", and tapping
    one says the same in words. The rest of the Shift group is unaffected:
    sign-on keeps working from the last synced staff list, and manager
    approval for everything else still works offline.
- **Test:**
  - `vesopa_server` (npm): create happy path returns the row; 3- and 5-digit
    PINs → 400; duplicate PIN → 409 naming the holder; both T6 routes reject a
    missing or bogus terminal token; permission-groups returns only the
    calling venue's groups; replace a member's card via `assign` → the old
    card no longer signs on, the new one does; assign a card held by someone
    else → refusal naming them.
  - `vesopa_epos` (widget): the two functions appear under the same provider
    condition as the rest of the Shift group and not otherwise; both demand
    manager approval first; the pad will not submit three digits and will not
    wait for a fifth; a confirm-mismatch scolds and restarts; the role picker
    renders the groups the T6 route returned; with connectivity stubbed off,
    both entries are greyed with the reason and sign-on still works.
- **Done:** a manager can stand at the till and put a new starter on — name,
  four-digit PIN, role, card if they have one — and the starter signs on
  straight away; a broken or lost card is replaced at the till and the old one
  is instantly useless; and none of it is offered when the broadband is down,
  with the till saying why.

## Phase 4 — The release

### T25 — Versions

- **Files:**
  - `vesopa_epos/pubspec.yaml`
  - `vesopa_epos_kitchen/pubspec.yaml`
  - `vesopa_epos_display/pubspec.yaml`
- **Behaviour:** all three go to 1.6.8.0 with build numbers incremented:
  `vesopa_epos` to `version: 1.6.8+29` with `msix_config.msix_version:
  1.6.8.0`; the kitchen to `1.6.8+9`; the display to `1.6.8+8`. Both fields in
  each file — the pubspec `version` and the four-part msix version are read by
  different tooling and drift apart silently if you let them.
- **Test:** grep each pubspec for both fields and confirm they agree;
  `flutter pub get` clean in all three; no build file in the tree still says
  1.6.7.
- **Done:** three pubspecs agree on 1.6.8.0.

### T26 — The full test sweep

- **Files:** `vesopa_server` (npm), the three Flutter apps, and the live back
  office.
- **Behaviour:**
  - `cd vesopa_server && npm test` — exits 0.
  - `flutter test` in `vesopa_epos` and `vesopa_epos_kitchen`. In
    `vesopa_epos` the three known failures are expected and are not chased in
    this release:
    - `test/goldens/receipt_golden_test.dart` — the goldens were captured on
      the old dev box; font rasterisation differs by pixels on this one.
      Cosmetic, failing since 1.6.5.
    - `test/data/fiscal_day_test.dart` — assumes the machine is on
      Europe/London; fails under any other timezone.
    - `test/hardware/cash_drawer_kick_test.dart` — needs a drawer on the
      serial port; always fails on a machine without one.

    Anything red beyond these three is a regression and stops the release.
  - `vesopa_epos_display` has no test suite: `flutter analyze` there, zero
    issues.
  - Then the live end-to-end pass against
    `https://backoffice.vesopaepos.com`, signed in as `manager@vesopa.co.uk`
    and nothing else — the Vesopa demo venue, never a customer's. Everything
    created in this pass is destroyed again before sign-off:
    - The nav: the renamed section reads correctly and every destination
      loads.
    - Night mode on: each nav group's chevron collapses and restores its
      section, and the folds survive a reload.
    - The Mix & Match picker: create a `T26 TEST` offer, pick products through
      the picker, save, verify it at the till, delete it.
    - A bulk expiry edit: select the test members, extend expiry in one edit,
      check the dates, put them back.
    - A customer photo: attach to the test customer, confirm it renders,
      remove it.
    - An expired card refused at the till: the test member whose card has
      expired is refused, with the renewal offered.
    - A renewal taken: renew that member at the till, then void the tender so
      the demo books stay clean.
    - The Pay key: a mixed basket shows the exact amount beside the label.
    - A three-glass split: 3 x Prosecco, one glass moved to its own share,
      both shares paid, receipts reading `1 x` and `2 x`, totals to the penny;
      the sale voided after.
    - A staff member added at the till: add `T26 Temp` with a PIN and a role,
      sign on as them, sign off, delete the row.
- **Test:** the checklist above, every line initialled; the suites green apart
  from the three named failures; analyze clean.
- **Done:** npm exits 0; the Flutter suites are green bar the three known
  failures; the ten live checks pass on the production URL and the demo venue
  is left exactly as it was found.

### T27 — Server deploy

- **Files:** `vesopa_server/src/`, `vesopa_server/schema/`,
  `vesopa_server/public/` (minus `uploads`),
  `.claude/skills/vesopa-ops/scripts/vesopa_ssh.py`, `@app/backup/`.
- **Behaviour:** in order —
  1. Dump first, before anything changes:
     `vesopa_ssh.py run 'mysqldump --single-transaction --routines
     vesopa_eposdb > @app/backup/vesopa_eposdb-1.6.8.0.sql'`.
  2. `python .claude/skills/vesopa-ops/scripts/vesopa_ssh.py put src
     "@app/src"`.
  3. The same `put` for `schema`.
  4. The same for `public` **with `--exclude uploads`**. Venue logos and
     product images exist only on the server; syncing over that folder deletes
     every venue's branding.
  5. The schema loop — every migration in `@app/schema` applied in filename
     order.
  6. `pm2 restart vesopa_backoffice` and nothing else. The box also runs
     `pasificbackend` and `royalbackend` for two other customers; touching
     them takes their venues down with ours.
  7. `GET /health` — 200 before this task is called done.
  - Remote paths are always the `@app` shorthand, never a literal POSIX path:
    Git Bash rewrites `/…` on its way to a native Windows program, and the
    file lands somewhere surprising or nowhere.
- **Test:** `/health` answers 200; sign in as the demo manager and load the
  staff list; `pm2 list` shows all three services online with only
  `vesopa_backoffice`'s restart time moved.
- **Done:** the live server runs 1.6.8.0, the dump is on disk in
  `@app/backup/`, and the other two customers never noticed.

### T28 — Three msix builds

- **Files:** outputs at `vesopa_epos/build/store/`,
  `vesopa_epos_display/build/store/`, and — the kitchen has no `output_path`
  in its msix config — `vesopa_epos_kitchen/build/windows/x64/runner/Release/`.
- **Behaviour:** `dart run msix:create --store` in each app. Every package
  file name carries the version — `…1.6.8.0….msix`. A submission that
  replaces a package lists the old one `PendingDelete` and the new one
  `PendingUpload`, and two files with the same name are read by the Store as
  a submission with no package in it: same name, no release.
- **Test:** each package's manifest identity reads 1.6.8.0 (open the msix as a
  zip and read `AppxManifest.xml`); each file name differs from the 1.6.7.0
  packages currently live; file sizes are in the same parish as last release's.
- **Done:** three versioned packages on disk at the three paths, ready to
  stage.

### T29 — Store release notes, upload, publish

- **Files:** `ms-store-submission-client/` and the three notes files, one per
  app.
- **Behaviour:**
  - Three sets of release notes in the fixed shape: first line literally
    `Version 1.6.8.0 - Short title` with a real short title per app, a blank
    line, then paragraphs with **each paragraph on one single line however
    long it is**. Partner Center renders every newline as a line break, so
    hard-wrapped prose arrives on the public Store page broken mid-sentence on
    every line. Under 1,500 characters each — count them (`wc -m`), don't
    guess. The kitchen and display notes are short, and short is fine; the
    shape is not negotiable.
  - `cd ms-store-submission-client`; stage each package against its app —
    `vesopa-epos`, `vesopa-kitchen`, `vesopa-display` — with its notes.
  - Verify every upload by reading the blob back: HEAD it and compare the byte
    count with the local file. "The PUT did not throw" is not "the file is
    there".
  - Commit each submission — and be clear about what committing is: there is
    no validated-but-unsubmitted state through the API, and
    `targetPublishMode` is `Immediate`, so a submission that passes
    certification goes live to every venue with no second gate. Commit only
    when T26 and T27 are green and the notes are final.
  - Never edit an API-created submission in Partner Center afterwards; the
    portal and the API client fork each other's state, and the next submission
    inherits the mess.
- **Test:** all three HEADs return byte counts equal to the local files; each
  submission shows certification in progress.
- **Done:** three submissions committed, certification under way, and Partner
  Center never touched by hand.

### T30 — git

- **Files:** the repo.
- **Behaviour:** one commit per phase, made along the way — this task lands
  the last of them and pushes `main` from a clean tree. Build outputs stay out
  of the tree (`build/` is ignored; check before committing, not after).
- **Test:** `git status --porcelain` empty; `git log --oneline` shows one
  commit per phase; after the push, `git log --oneline origin/main..HEAD` is
  empty.
- **Done:** `origin/main` contains the whole 1.6.8.0 release and the working
  tree is clean.

## Decisions taken for the client

- **The navigation rename.** "Clerks" becomes "Staff" throughout the back
  office nav — that is the word every venue actually uses, and T24 leans on it
  at the till. The table keeps its name (`bo_clarks`); renaming columns buys
  nothing and costs a migration. The alternative was keeping "Clerks" to match
  the printed training manual — the manual is easier to fix than every new
  manager's first question.
- **An operator's saved fold preference survives the rename.** Fold state is
  keyed by the section's stable id, not its label, so renaming a section does
  not flatten anyone's layout on upgrade morning. The alternative — keying by
  label, the simpler code — would have reset every operator's folds at once,
  and the people who fold the nav every day are exactly the people who ring up
  about it.
- **The odd penny on a divided line is paid by the first portion.** Net is
  apportioned base-plus-remainder with the remainder on the earliest portions,
  so the portions always sum to the line exactly, and if anyone pays an extra
  penny it is always the same glass. The alternative was letting whichever
  share settled last absorb the rounding — rejected: the bill total would
  appear to change depending on the order people paid in, which is precisely
  the sort of thing that ends a venue's trust in the split screen.
- **A modifier divides with its parent.** A child priced per unit (its
  quantity tracks the parent's) is divided identically, and each portion owns
  its share of the child; a flat one-off charge rides whole on the first
  portion. The alternative was refusing to divide any line with modifiers —
  the competitor's answer — which just moves the Prosecco bug to anything
  with an option on it.
- **Staff creation with no network is refused, not faked.** The entries stay
  visible but greyed with the reason, sign-on carries on from the last synced
  staff list, and nothing is queued for later. The alternative — queue the
  new person locally and sync when the broadband returns — was rejected: PIN
  uniqueness is venue-wide and the role switches live on the server, so a
  queued person could sign on at the bar till and not the back one, which is
  worse than being told to wait.
- **The default membership term is twelve rolling months.** A new membership
  runs twelve months from the day it is bought, and a renewal adds twelve
  months to the later of today or the current expiry, so renewing early never
  costs the member time they have paid for. The alternative was a fixed season
  ending on a calendar date, like the old paper book — rejected: anyone
  joining in November pays full price for two months and, fairly, complains.
