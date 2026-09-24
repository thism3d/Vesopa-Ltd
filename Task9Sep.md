# Task 9 Sep — Vesopa EPOS 1.6.9.0

Release 1.6.9.0 answers twelve requests from The Bridge, Llangennech (ex-Newbridge). Much of what they ask for is half-built in 1.6.8.0; this release closes the gaps rather than rebuilding. The work falls into four phases: schema, back office, till/display, and sign-in. All testing uses `manager@vesopa.co.uk` on the test venue only — every other account is a real person.

## The decisions that shape this release

1. **Membership renewal becomes product-flag based with an optional fixed season date.** Any product can carry "Renews membership"; a nullable `membership_renewal_date` on loyalty settings wins when set and in the future, otherwise we keep today's rolling `membership_term_months`. The old single-PLU setting is migrated, not deleted — no venue already on 1.6.8.0 loses behaviour. This knowingly overrides the decision recorded in `tasks.md` (single named PLU + rolling term); the client has asked, twice, for a club season.
2. **The payment screen falls back to the sale bars, but keeps its own bar columns.** The `pay_top_bar_screen_id` / `pay_bottom_bar_screen_id` split shipped in `schema_till_pay_bars.sql` and stays; when unset, the payment screen now shows the sale screen's bars, which is what The Bridge actually wants. Void and Cancel leave the payment header and live on the bars.
3. **Login with Vesopa becomes the only visible sign-in everywhere — but an offline device unlock survives on the till and kitchen.** OIDC needs a network; a venue with dead broadband at 7am still has to open the till. The honest design is SSO-first with a cached-credential fallback, not SSO-only.
4. **Everything additive stays compatible in both directions.** Old tills against the new server, new displays against old `basket.json`, idempotent schema files, tenant-scoped queries. The customer QR page (`dinein_pages.js`) is not touched by any task in this release.

---

## Phase 1 — Schema

Each file below must define `vesopa_add_column` itself (the previous file drops it on its last line), guard every change through `information_schema`, survive being run twice, and drop the procedure on its own last line. Before committing each file, run `ls vesopa_server/schema/ | sort` and confirm it lands after the file that creates the table it alters — there are no numeric prefixes to save us.

### T1 — Membership renewal v2 columns

**Files:** new `vesopa_server/schema/schema_products_membership.sql` (verify the name: `grep -l "epos_products" vesopa_server/schema/*.sql` to find the file that creates `epos_products` — expected `schema_products.sql`, in which case this name sorts immediately after it and after `schema_membership.sql` / `schema_membership_product.sql`; if the creator is named differently, rename so the sort order holds).

**Behaviour:** Adds `epos_products.renews_membership TINYINT(1) NOT NULL DEFAULT 0` and `epos_loyalty_settings.membership_renewal_date DATE NULL`. Then a one-time, idempotent backfill: for every office whose `epos_loyalty_settings.membership_plu` is set, set `renews_membership = 1` on that office's matching product (join on office — this platform grew out of one venue's database, so scope the UPDATE explicitly). The old columns `membership_plu` and `membership_term_months` are left in place and readable; nothing is nulled. Running the file a second time is a no-op.

**Test:** Restore a production dump to a scratch database, apply the file twice with `mysql`, and confirm: both columns exist; on the test venue (which has `membership_plu` set) exactly that product is flagged; a venue with no `membership_plu` has no flagged products; row counts in other offices are unchanged between runs.

**Done:** Columns present, backfill correct per office, file re-runnable with zero errors and zero deltas on second apply.

### T2 — Customer display greeting column

**Files:** new `vesopa_server/schema/schema_till_customer_display.sql` (read the header of `schema_till_bars.sql` first — it documents which file creates `epos_till_settings` and why these files were split out; name accordingly so this sorts after the creator).

**Behaviour:** Adds `epos_till_settings.customer_display_greeting VARCHAR(120) NULL`. NULL or empty means the display falls back to "Welcome" at render time — we do not store the default, so the venue can clear the field and get the default back.

**Test:** Apply twice against the scratch restore; column exists; existing settings rows untouched.

**Done:** Column present, idempotent.

### T3 — Error reasons: seed `no_sale` and `cancel`

**Files:** new `vesopa_server/schema/schema_reasons_no_sale_cancel.sql` (sorts after `schema_layout.sql`, which owns `bo_error_reasons`).

**Behaviour:** Data-only migration, but it keeps the full file skeleton (define `vesopa_add_column`, drop it last line) so the convention never depends on file contents. For each office: (a) if the office has no `applies_to = 'no_sale'` rows, insert two defaults — "Opened in error" and "Customer needed change"; (b) copy the office's existing `void` reasons to `applies_to = 'cancel'` where an equivalent cancel row does not already exist — this is the "split them off" the client asked for, giving cancel its own editable list from day one rather than an empty one. All inserts are `INSERT ... SELECT ... WHERE NOT EXISTS`, scoped by office, safe to re-run. Existing `void` / `refund` / `discount` rows are untouched.

**Test:** Apply twice to the scratch restore. After run one: every office has ≥1 `no_sale` reason and its `cancel` list mirrors its `void` list. After run two: identical counts. Spot-check with `SELECT office, applies_to, COUNT(*) FROM bo_error_reasons GROUP BY 1,2`.

**Done:** Seeds present per office, second run changes nothing.

### T4 — Dine-in auto-accept setting

**Files:** new `vesopa_server/schema/schema_dinein_auto_accept.sql` (first `grep` `dinein.js` for where venue settings are read and find that table's creator in `schema/`; if settings turn out to be key/value rows rather than columns, this file inserts a default key per office instead of DDL — same skeleton, same idempotency).

**Behaviour:** Adds `auto_accept_orders TINYINT(1) NOT NULL DEFAULT 0` to the dine-in venue settings table. Default off: no venue's behaviour changes on deploy. Acceptance happens server-side (T10), so this must live somewhere the server reads without a till being on.

**Test:** Apply twice; default is 0 on the test venue.

**Done:** Setting stored, default off, idempotent.

### T5 — Vesopa identity link on back-office users

**Files:** new `vesopa_server/schema/schema_users_vesopa_sub.sql` (verify the users table name/creator with `grep -l "CREATE TABLE" vesopa_server/schema/*.sql | xargs grep -l users`).

**Behaviour:** Adds `vesopa_sub VARCHAR(255) NULL` plus a `UNIQUE` index (MariaDB permits multiple NULLs, so unlinked users are unaffected). This is the link written the first time an existing account signs in via Vesopa (T23).

**Test:** Apply twice; manually set the same `vesopa_sub` on two rows in scratch and confirm the unique index rejects it.

**Done:** Column + unique index present, idempotent.

---

## Phase 2 — Back office (server + SPA)

### T6 — Membership renewal v2: API and back-office UI

**Files:** `vesopa_server/src/commerce.js` (loyalty settings, renewal endpoint, earn/redeem), `vesopa_server/src/backoffice.js` (product CRUD — confirm where product update actually lives; `programming.js` if products are served by the generic CRUD), `vesopa_server/public/app.js` (product form, loyalty settings page).

**Behaviour:** Product create/update accepts and persists `renews_membership`, office-scoped. Loyalty settings accept `membership_renewal_date` (`YYYY-MM-DD` or null). The product form gains a checkbox "Renews membership"; the loyalty settings page gains a date field labelled "Membership renewals run to" with help text using the client's own example ("e.g. 31/08/2027 — an expired card renewed today runs to this date"). If the saved date is in the past, show an inline warning ("this date has passed — renewals will use the N-month term until it is moved forward") but still save; season-end dates are legitimately entered ahead of time and a past date is the venue's mistake to fix, not ours to forbid. Renewal endpoint: when a renewal posts, the server — never the till — computes the new expiry: `membership_renewal_date` if set and ≥ today's server date, otherwise today + `membership_term_months`. Expiry is inclusive: the card works *on* the expiry date and expires the day after. Loyalty earn and redeem endpoints refuse expired members with `409 {code: 'membership_expired', membership_expiry}` — every door closed server-side — except the renewal-posting endpoint itself, which must obviously accept expired members. Old tills keep working: the backfilled flag means a 1.6.8.0 venue's named PLU still renews.

**Test:** As `manager@vesopa.co.uk`: flag the test product, set the date to 31/08/2027, then `curl` a renewal post for the expired test customer — expiry lands on 2027-08-31. Set the date to yesterday, renew again — expiry is today + term. `curl` an earn for the expired customer — 409 with the code. `curl` a product update with another office's id — 403.

**Done:** All four curls behave; UI saves and warns as specified; legacy PLU venue renews exactly as before the flag existed.

### T7 — Error reasons: endpoint per action + UI

**Files:** `vesopa_server/src/server.js` (`GET /till/void-reasons` at ~519), `vesopa_server/src/backoffice.js` (reasons CRUD validation), `vesopa_server/public/app.js` (~766, the `applies_to` form).

**Behaviour:** New `GET /till/error-reasons?applies_to=<action>` accepting `void`, `refund`, `discount`, `no_sale`, `cancel`, rejecting anything else, office-scoped from the till's credential, with an index check on `(office, applies_to)`. The existing `/till/void-reasons` stays and delegates with `applies_to='void'`, byte-identical response shape, so un-updated tills are unaffected. The back-office form's dropdown gains `no_sale` and `cancel`; the list page gets a filter so a venue can see each action's list separately. Seed content came from T3; the client mentioned Newbridge's back office for ideas — the two `no_sale` defaults and void-mirrored cancel list cover it without copying anything blind.

**Test:** `curl` both endpoints as the till does; the legacy route returns only void reasons. In the UI, add a reason to each of the five actions and confirm each lands under the right one.

**Done:** New endpoint serves all five lists; legacy endpoint unchanged; UI offers and filters five actions.

### T8 — Price level names: editor and label sweep (back office)

**Files:** `vesopa_server/public/app.js` (till settings editor near 1888/1916/1953, then the sweep: product form price rows, price-level column headings, reports), `vesopa_server/src/backoffice.js` (694/873 — verify validation only).

**Behaviour:** The data and parsing already exist (`price_level_names` JSON, `PriceLevelNames` on the till); what is missing is the editor. Add six fields to the till settings page, levels 2–6 editable and level 1 shown fixed as "Price 1" (the till parser hardcodes level 1 — see Decisions). Trimmed-empty means "fall back to Price N"; cap at 40 chars. Then sweep every back-office surface that prints a level label — product form, column headings, reports — and route them all through the venue's names with the fallback.

**Test:** Set level 2 to "Happy Hour", reload the product form, a price report and the screen programming preview — all read "Happy Hour". Clear it — all read "Price 2".

**Done:** Names editable; every label in the back office honours them with fallback.

### T9 — Copy buttons to many pages

**Files:** `vesopa_server/src/screens.js` (new endpoint beside `PUT /screens/:id/buttons` at ~1015), `vesopa_server/public/screens.js` (designer).

**Behaviour:** In the designer, the page being edited gets a "Copy to pages…" action: select buttons on the grid, then a dialog listing every other screen in the venue (grids and bars, source screen excluded) with a checkbox each and a Select all. One API call regardless of target count: `POST /screens/:id/buttons/copy` with `{button_ids, target_screen_ids}`. Server-side: verify the source screen and *every* target belong to the requester's office (403 otherwise); then per target, in its own transaction so one bad target cannot block the rest: validate each key against the target surface (`functionKeysFor`, `FUNCTION_KEYS` vs `BAR_KEYS`, `isBar()`), and place each copied button by this rule — **same row/col if that cell exists within the target's grid and is free; otherwise the first free cell scanning row-major from the top-left; never overwrite; skip with a recorded reason when a key is invalid for the surface or no free cell remains** (respecting `MAX_ROWS=10`, `MAX_COLS=12`). If the target already holds a button with the same key, skip it as "already present" — re-running a copy must not stack duplicates. Occupancy is determined by existing button rows, not grid bounds, so legacy buttons sitting outside current bounds still block their cells. Respond `{results: [{screen_id, copied: [...], skipped: [{key, reason}]}]}`; the dialog renders that summary per page so nothing fails silently.

**Test:** On the test venue designer: page A with six buttons including a grid-only function key; copy to B (empty grid), C (same size, one occupied cell), D (a bar). B gets all six in place; C places the colliding button in the first free cell and overwrites nothing; D skips the grid-only key and the summary says why. Dev tools Network tab shows exactly one POST. Re-run the copy — everything reports "already present", no duplicates in `epos_screen_buttons`.

**Done:** One call, correct placements, explicit skip report, no overwrites, no duplicates, tenant check proven.

### T10 — Auto-accept menu orders

**Files:** `vesopa_server/src/dinein.js` (order placement; the accept transition at ~2352, `accepted: ['placed']`; the gap comment at ~1292), `vesopa_server/public/app.js` (dine-in settings page), `vesopa_server/src/backoffice.js` (settings pass-through if needed).

**Behaviour:** A venue toggle "Automatically accept menu orders" (off by default), with help text that states the trade: "orders go straight to accepted and print to the kitchen; you lose the chance to refuse before acceptance". Acceptance happens **on the server at placement time** — the only place that works when no till is on. Extract the existing accept logic (the same function the manual accept endpoint runs) and call it immediately after the order is inserted at `placed`, with `accepted_by = 'auto'`. Because the transition table only allows `placed → accepted`, a later manual accept is a harmless no-op, and kitchen print dispatch — which lives in the accept path — runs exactly once. The till poll (`/till/dinein/orders?status=placed,accepted,ready`) already includes `accepted`, so auto-accepted orders appear on tills and the kitchen app unchanged. The reject path is untouched for venues with the setting off. If kitchen printing fails, the order stays accepted and the existing print-retry mechanism owns recovery — auto-accept must not roll the order back. This also closes the timing gap noted at `dinein.js:1292`: food is on the right ticket from the start. Do not touch `dinein_pages.js`.

**Test:** Setting on: place a real order from a phone on the test venue's QR menu; within seconds it reads `accepted` in the till's poll, the kitchen screen shows exactly one ticket, nobody touched anything, and `accepted_by` reads `auto` in the database. Attempt a manual accept — refused as a no-op. Setting off: the next order waits at `placed` until a clerk accepts it.

**Done:** Auto-accepted orders print once, appear everywhere, and the toggle round-trips; manual flow unchanged when off.

### T11 — Bar keys: `transfer`, plus Void/Cancel on bars

**Files:** `vesopa_server/src/screens.js` (`BAR_KEYS`; confirm `void` and `cancel` are already accepted on bars and add them if not), `vesopa_server/public/screens.js` (the labels list — the comment in `src/screens.js` says the two lists must agree; make them agree).

**Behaviour:** `transfer` becomes a programmable key on `topbar`/`bottombar` surfaces, labelled "Transfer". Void and Cancel must be programmable on bars too, since T17 removes them from the payment header. No schema — keys are validated strings. Before deploy, check how a 1.6.8.0 till renders an unknown bar key: if it refuses politely, ship together with the server; if it hard-fails, hold the designer change until the Store rollout (see Release).

**Test:** In the designer, put Transfer on the test venue's bottom bar and Void on a pay bar; save, reload, confirm both persisted and render in the designer preview.

**Done:** Keys programmable and persisted on both lists.

---

## Phase 3 — Till and customer display

### T12 — Till sync foundation: photos, expiry, renewal flag

**Files:** `vesopa_epos/lib/data/` — the Drift database (schema version bump with migration), the customer/product/settings sync parsers, `vesopa_epos/lib/ui/customer_picker.dart`, `vesopa_epos/lib/ui/membership_prompt.dart` (`MemberFace` fed from local data).

**Behaviour:** Drift schema version bumps with an in-place migration adding `photo_url` and `membership_expiry` to the local customers table and `renews_membership` to the local products table; loyalty settings sync also carries `membership_renewal_date`. The picker shows faces and an "expired" badge from local data; photo files are cached on first fetch with initials fallback when uncached or offline (existing `MemberFace` behaviour). This is what makes the expiry gate (T13) and renewal logic (T14) work with the network down, and it answers "photos don't show when a card is scanned" for every path that reads local customers.

**Test:** Sync the counter till, then airplane mode: open the Customer key — photos and expired badges render; kill and relaunch the app still offline — unchanged; swipe a known card — the member UI shows the cached face.

**Done:** All three fields sync, migrate cleanly from the 1.6.8.0 local DB, and render offline.

### T13 — Expiry gate on every attach path (requests 1 and 3)

**Files:** `vesopa_epos/lib/data/order_repository.dart` (`OrderRepository.attachCustomer` — verify the filename), `vesopa_epos/lib/ui/sale_page.dart` (`_promptCustomer`, ~1444), `vesopa_epos/lib/ui/payment_page.dart` (`_attachCustomer`, ~1813), `vesopa_epos/lib/ui/card_actions.dart` (`_loyaltyCard` and the enrol path at ~428), `vesopa_epos/lib/ui/barcode_actions.dart`, `vesopa_epos/lib/ui/membership_prompt.dart`.

**Behaviour:** The expiry check moves into `OrderRepository.attachCustomer` itself, so callers cannot forget it: attaching an expired customer returns a typed expired result instead of attaching, and every caller — magstripe swipe (`_loyaltyCard`, already correct), **barcode scan** (`barcode_actions.dart` — this is the "scan" the venue means, and it currently bypasses the whole member UI, which is also why no photo shows), the Customer function key picker, and the payment-screen attach — routes that result through `showExpiredMembership()`: a popup stating the customer's membership has expired, offering Renew / Not now. Decline attaches nobody. The enrol-a-new-member path is untouched (a new member is not expired). Fix the date comparison while here: parse the server's `DATE` as a plain local calendar date (never `DateTime.parse` onto a UTC midnight, which shifts a day behind in UK winter time), and "expired" means today is *after* the expiry date — the card works on its last day. Null expiry is legacy/no-programme: attach allowed, no "Member until" line. As backstop, the server's 409 from T6 surfaces the same popup if an expired earn ever slips through (e.g. stale local copy).

**Test:** Set the test customer's expiry to yesterday in the back office, sync, then at the counter: (a) swipe, (b) scan the card's barcode, (c) pick via the Customer key, (d) attach at payment — all four show the popup, and declining attaches nobody; accepting Renew attaches and (per T14) queues renewal. Set expiry to today — all four attach and show the face. Repeat (c) offline.

**Done:** All four doors gated by the single repository check; `grep` shows no caller of `attachCustomer` handling expiry itself; scan path shows the photo.

### T14 — Renewal at the till: flagged products and the season date (request 2)

**Files:** `vesopa_epos/lib/data/membership.dart` (`billRenewsMembership()`, `membershipProduct()`), `vesopa_epos/lib/ui/card_actions.dart`, `vesopa_epos/lib/ui/payment_page.dart` (settle path ~1219), `vesopa_epos/lib/ui/membership_prompt.dart`.

**Behaviour:** `billRenewsMembership()` now keys off the synced `renews_membership` flag on any bill line — the legacy `membershipRenewalPlu` (-1) fee line and the backfilled old `membership_plu` product both qualify, so existing venues behave identically. Two flows: (1) **flagged product already on the bill** (the client's exact wording — "if this product is on the check view and expired card is swiped"): the expired swipe attaches immediately with no Renew dialog and marks renewal pending; (2) expired swipe with nothing renewing on the bill: the existing Renew/Not-now dialog rings the renewal as today. The dialog and the bill line state the target: "renews to 31/08/2027" from synced settings, falling back to "renews for 12 months" when no date is set. Renewal still posts only once the bill settles; voiding the flagged line before settle cancels the pending renewal; multiple flagged lines on one bill still post exactly one renewal (guard on customer + bill). The server computes the authoritative date (T6) — the till's shown date is a preview, which matters because till clocks drift. Offline settle: the renewal rides the existing queued sync and posts on reconnect.

**Test:** At the counter: (1) ring the flagged "Annual Membership" line, then swipe the expired card — attaches with no dialog, bill shows "renews to 31/08/2027", settle, back office shows expiry 2027-08-31; (2) swipe first with an empty bill — dialog flow, same result; (3) on a second test venue still using legacy `membership_plu` and no date — renewal yields today + 12 months; (4) void the flagged line before paying — no renewal posts; (5) settle offline, reconnect — renewal posts once.

**Done:** Both entry flows renew to the fixed date; legacy behaviour preserved; exactly one renewal per bill.

### T15 — Customer name, points and greeting on the customer display (request 4)

**Files:** `vesopa_epos/lib/data/customer_display.dart` (basket.json writer), the till's `settings.json` writer for the shared folder, `vesopa_epos_display/lib/data/basket_feed.dart`, `vesopa_epos_display/lib/ui/bill_panel.dart`, `vesopa_server/public/app.js` (greeting input on the till settings page).

**Behaviour:** `basket.json` gains an optional `customer: {name, points}` object, written on attach/detach and refreshed at settle; points are the last-synced loyalty balance (say so — no real-time guarantee). The `format` field does **not** change: additive optional keys only, because an old display may hard-check the version, and we cannot update displays before tills. The greeting travels by the existing mechanism — `customer_display_greeting` in `epos_till_settings` (T2) → pushed to `settings.json` in the shared folder → read by the display. `bill_panel.dart` renders the greeting (default "Welcome" when unset) with the customer's name and points beneath it when a customer is attached, and hides the block entirely when the keys are absent — that is the old-till case. Verify the display's JSON parsing ignores unknown keys — that is the new-till/old-display direction; if any `fromJson` asserts on unknown fields, relax it.

**Test:** At the counter with the display attached: attach the test customer — display shows "Welcome … — 1,240 pts"; detach — it clears. Edit the greeting in the back office to "Welcome to The Bridge" — it appears after settings sync. Sideload the previous Store display build against the new till — no crash, no block; run the old till against the new display — no block.

**Done:** Both compatibility directions proven on hardware; greeting editable end to end.

### T16 — "Gift Card" casing (request 5)

**Files:** `vesopa_epos/lib/data/commerce.dart:26`, `vesopa_epos/lib/ui/widgets/tender_panel.dart:439`, `vesopa_epos/lib/ui/confirm_tender_dialog.dart:80`, `vesopa_epos/lib/ui/card_actions.dart:519,522`, `vesopa_epos/lib/ui/redemption_dialogs.dart:112`.

**Behaviour:** "Gift Card" everywhere, not only the payment screen — these are display strings derived from `TenderKind.label`, so half-fixing it would put both spellings on one screen. Enum names and stored values do not change.

**Test:** `grep -ri "Gift card" vesopa_epos/lib` returns nothing; walk the five surfaces on the till and read them.

**Done:** Grep clean; all five surfaces read "Gift Card".

### T17 — Payment screen bars (request 6)

**Files:** `vesopa_epos/lib/ui/payment_page.dart` (`_PayHeader`, `_PayBar`, `_board`, ~1574), the widget providing `VenueTopBarBody.paymentBars(ref)`.

**Behaviour:** `paymentBars` now falls back: configured `pay_top_bar_screen_id` / `pay_bottom_bar_screen_id` if set, otherwise the sale screen's `top_bar_screen_id` / `bottom_bar_screen_id`. The columns stay (see Decisions) — a venue that wants tender-only bars configures them; a venue that wants the sale bars does nothing, which is The Bridge's ask. Void and Cancel come off `_PayHeader`; the header slims to title/context. `_PayBar` now *accepts* `void` and `cancel` (they must work from the bars since the header lost them) and continues to refuse ring/page/modifier keys politely, and also refuses `transfer` — "finish or cancel the payment first" (merging tables mid-tender is not safe). `_board()` already sits in an `Expanded`; tighten key padding/margins a notch so the tender grid fits with bars present, and verify at the till's native resolution.

**Test:** With no pay bars configured: open payment — the sale top/bottom bars render, no header Void/Cancel; Void from the bar voids a line; Cancel from the bar returns to the sale screen. Configure a pay-only bar — it wins over the fallback. Check for overflow at 1920×1080.

**Done:** Fallback works, header slimmed, bar keys behave, layout clean at native resolution.

### T18 — Price level names on the till (request 7, till half)

**Files:** `vesopa_epos/lib/ui/price_level_sheet.dart`, `vesopa_epos/lib/ui/functions_page.dart`, `vesopa_epos/lib/data/price_levels.dart` (reuse `PriceLevelNames`), plus `grep -rn "Price [0-9]" vesopa_epos/lib` for stragglers.

**Behaviour:** Every till surface that labels a level — the price-level sheet, function buttons, anywhere the grep finds — renders the venue's name via `PriceLevelNames` with "Price N" fallback. Level 1 stays "Price 1" (existing parser behaviour; matched in the T8 editor).

**Test:** With level 2 named "Happy Hour" (T8), sync the till: the sheet and the function button both read "Happy Hour". Clear the name, sync: both read "Price 2".

**Done:** No surface shows a bare "Price N" when a name is set.

### T19 — Reasons on the till: No Sale, Refund, Void, Cancel (request 9, till half)

**Files:** `vesopa_epos/lib/ui/void_dialog.dart` (generalise), `vesopa_epos/lib/ui/refund_page.dart`, the cancel path (`_cancelCheck`), the No Sale handler (find it via the function-key dispatch, `_runScreenFunction`), the data API client.

**Behaviour:** Each action fetches its own list from `/till/error-reasons?applies_to=…` (T7). Today only voids capture a reason; this adds capture for Refund (`refund_page.dart`), Cancel (its own `cancel` list, seeded from void in T3 — no longer sharing void's), and No Sale (drawer open with no sale), each recorded on the audit row that action already writes — if No Sale writes no audit row today, it starts. Degradation: against a pre-T7 server (404), void falls back to `/till/void-reasons` and the other actions proceed without a reason rather than blocking; with the network down, every action proceeds reason-less and queues its audit — trading must never stop for a reason list.

**Test:** At the counter: No Sale → dialog with the no_sale list; Refund → refund list; Void → void list; Cancel from payment → cancel list. Confirm each reason lands in back-office reporting under the right action. Repeat No Sale in airplane mode — drawer opens, audit queues, nothing blocks.

**Done:** Four actions, four lists, reasons visible per action in the back office; legacy and offline paths proven.

### T20 — Transfer on the bars, with merge (request 11)

**Files:** `vesopa_epos/lib/ui/sale_page.dart` (`_runScreenFunction`), `vesopa_epos/lib/ui/tables_page.dart` (~212, the existing bottom-sheet transfer), `vesopa_epos/lib/data/table_repository.dart`, the `ProgrammedBar` function dispatch, `vesopa_epos/lib/ui/payment_page.dart` (`_PayBar` refusal — T17), and `vesopa_server/src/server.js` if order-line sync needs to accept re-homed lines.

**Behaviour:** The `transfer` bar key (T11) with a bill open runs the same table picker the floor plan uses. First, confirm what `tables.transfer()` actually throws on an occupied target and replace the bare `StateError` with a typed `TableOccupiedError`; the UI catches it and shows "Merge table? Yes / No". No changes nothing. Yes merges into the destination order by these rules: destination order survives; source lines are appended in their original order with new line ids, modifiers and line-level discounts intact; covers are summed; the destination's bill-level discount is kept and the source's is dropped with an audit note (a merge cannot honour two bill discounts — see Decisions); the destination's attached customer is kept, or the source's moves over if the destination has none. The source order closes with a `merged_into <id>` event and the destination gains `merged_from <id>`, so both audit trails survive intact. Transfer with no bill open, or from the payment screen's bar, refuses politely. Tables are local-first Drift, so this works offline and syncs; if order lines sync by id, make sure re-homed lines and the closed source order sync without resurrection.

**Test:** Table 1 holds two pints, a food line with a modifier, and an attached customer; Table 2 holds a coffee and a bill discount. From the bar: Transfer → pick Table 2 → prompt → Yes: Table 2 shows all lines with the modifier intact, Table 1 frees, both orders carry the merge events in their audit. Repeat and answer No — nothing changes. Transfer to an empty table — clean move, no prompt. Repeat the whole sequence from the floor-plan sheet to prove one shared code path.

**Done:** Merge prompt on occupied targets from both surfaces; merge content and audit verified; decline is a no-op.

---

## Phase 4 — Login with Vesopa

### T21 — Auth service registrations and the Vesopa mark

**Files:** `vesopa_auth/` — an idempotent seed script against `applications`, `application_redirect_uris` and the per-app sign-in method tables; a hosted `vesopa-mark` asset served from `auth.vesopa.com`.

**Behaviour:** Register two new clients: `vesopa-backoffice` (authorization code + PKCE public client; redirect `https://backoffice.vesopaepos.com/auth/vesopa/callback`) and `vesopa-kitchen` (PKCE with loopback redirect on an ephemeral port, mirroring the till's RFC 8252 pattern, plus a `vesopa-kitchen://` hand-off row if the kitchen uses the device scheme the way the till uses `vesopa-epos://`). Verify the existing `vesopa-epos` client rows rather than assuming them. Host the icon so app buttons can bundle it and web pages can link it. Inserts are `WHERE NOT EXISTS` — re-runnable.

**Test:** For each client_id, build the authorize URL and confirm the login page renders; fetch `/.well-known/openid-configuration`; the icon URL returns 200.

**Done:** Both clients can start an OIDC flow against `auth.vesopa.com`.

### T22 — Consolidate `dinein_auth.js` onto `vesopa_oidc.js`

**Files:** `vesopa_server/src/dinein_auth.js`, `vesopa_server/src/vesopa_oidc.js`, `vesopa_server/src/dinein.js` (imports).

**Behaviour:** The duplicate OIDC machinery in `dinein_auth.js` carries a header saying to move it "the next time somebody has a reason to open it" — this release is that reason. Replace its internals with the shared client; dine-in keeps issuing its own tokens/sessions exactly as today (`vesopa_oidc.js` deliberately creates none). Do not touch `dinein_pages.js`.

**Test:** Run the dine-in sign-in flow end to end on the test venue; load the QR menu page and view-source it to confirm the template literal is untouched.

**Done:** No duplicated OIDC code remains; dine-in auth behaves identically.

### T23 — Back office: Login with Vesopa

**Files:** the file owning today's login route (identify it — likely `vesopa_server/src/backoffice.js`), `vesopa_server/src/vesopa_oidc.js`, `vesopa_server/public/index.html`, `vesopa_server/public/app.js` (login section).

**Behaviour:** `GET /auth/vesopa/start` begins the code flow; `GET /auth/vesopa/callback` verifies via `vesopa_oidc.js` and then the back office issues its own session exactly as it does today — the shared client stays session-free by design. First-time linking: match the Vesopa identity's verified email to an existing user and write `vesopa_sub` (T5); no match → refuse with "ask your manager to add you" — there is no self-registration anywhere in this release, and any existing registration UI comes out. The login page shows only the branded "Login with Vesopa" button (icon from T21). The password endpoint survives server-side behind a support-only flag for one release as break-glass, then is removed in the next; it is not shown. `manager@vesopa.co.uk` must be linked before this ships — it is the only test account.

**Test:** Full round trip as `manager@vesopa.co.uk`; `vesopa_sub` written on first login; second login uses the link. An unlinked email gets the refusal. The password form is absent from the page; the session works across back-office pages.

**Done:** SSO is the only visible sign-in; linking proven; break-glass flag documented.

### T24 — Kitchen app: Login with Vesopa

**Files:** `vesopa_epos_kitchen/lib/ui/sign_in_page.dart`, plus a kitchen mirror of `vesopa_epos/lib/data/vesopa_sso.dart` and the server endpoint that issues the kitchen's own token.

**Behaviour:** Same pattern as the till: PKCE, system browser, loopback redirect on port 0, `prompt=login`; on callback the server issues the kitchen's own token (each product keeps its own). Email/password fields are removed. Kitchens sit on the venue LAN and must keep working when the internet drops mid-service, so the same offline unlock as the till survives: after one successful SSO sign-in, a cached-credential device unlock opens the screen offline.

**Test:** Sign in on the kitchen screen online; orders flow. Pull the WAN cable; relaunch — offline unlock opens the kitchen screen; tickets still arrive over LAN.

**Done:** SSO-only visible sign-in; offline unlock proven.

### T25 — Till sign-in page: SSO only, offline unlock kept

**Files:** `vesopa_epos/lib/ui/sign_in_page.dart`, `vesopa_epos/lib/data/session_controller.dart` (~195), `vesopa_epos/lib/data/vesopa_sso.dart`, the app's asset bundle (Vesopa mark).

**Behaviour:** The email/password fields beside the existing SSO button are removed; the page shows one "Login with Vesopa" button with the mark, keeping `prompt=login` so the shared device never silently reuses the last person's browser session. Under it, a line of copy: "Staff are added by your manager in the back office" — replacing anything resembling registration. The honest constraint, stated plainly: OIDC cannot mint a session offline, so when the browser launch fails or the device is known-offline, the page offers the device unlock (last signed-in account plus local credential) — without it a venue with dead broadband cannot open the till in the morning, and we will not ship that.

**Test:** Online: fresh sign-in round trip; no password field anywhere on the page. Sign out, enable airplane mode, relaunch: the offline unlock opens the till. Reconnect: normal SSO again.

**Done:** SSO is the only visible sign-in; offline open proven; no registration affordance remains.

---

## Decisions taken for the client

1. **Fixed season date beside rolling months, not instead of them.** `membership_renewal_date` wins when set and in the future; otherwise renewals fall back to today + `membership_term_months`. This overrides the decision recorded in `tasks.md` (single named PLU + rolling term) because the client explicitly asked for a club season ("the card would expire on 31/08/2027… changeable") and for any product to renew, not one named PLU. Rejected: replacing the term with a mandatory date — the first time a venue forgot to roll the date forward, every renewal would issue an already-expired membership, and every existing `membership_plu` venue would break on upgrade. Also rejected: computing the date on the till — till clocks drift, so the server computes the authoritative expiry at settle and the till shows a preview. The old PLU is migrated to the new product checkbox by backfill, so no venue loses behaviour.
2. **The payment screen keeps its own bar columns, with a fallback.** `schema_till_pay_bars.sql` shipped separate `pay_top_bar_screen_id` / `pay_bottom_bar_screen_id`, and its header argues tender screens deserve their own programming — that argument still stands for venues that want it. The client is overruling it as the *default*: when no pay bars are configured, the payment screen now shows the sale screen's bars. Rejected: dropping the columns (deletes a shipped feature and forces one layout on everyone) and keeping pay-bars-only (ignores the request). Void and Cancel leave the payment header and become bar keys, as asked.
3. **Button-copy placement: same cell if free, else first free cell, never overwrite.** Preserve each button's row/col when the target grid has that cell free; otherwise place it in the first free cell scanning row-major; skip with a reported reason when a key is invalid for the target surface or no cell is free. Rejected refuse-on-collision: one occupied cell would fail an otherwise fine copy, and the common case is cloning a page onto near-identical pages. Rejected overwrite: silently destroying existing programming is unrecoverable. Copies of already-present keys are skipped, so re-running a copy cannot stack duplicates.
4. **Email/password leaves every visible UI; an offline device unlock survives.** The client asked to remove every other login and registration feature, and we have — no password forms, no self-registration anywhere; staff are created by managers and linked on first SSO login by verified email. The honest exception: OIDC needs a network, so the till and kitchen keep a device unlock (cached credential after one successful sign-in) for the morning the broadband is down; removing it would ship a till that cannot open offline, which we will not do. The back office is always online, so it is SSO-only, with the password endpoint retained one release behind a support-only flag as break-glass.
5. **Auto-accept costs the venue its refusal window.** With the setting on, every menu order goes straight to `accepted` and prints to the kitchen; there is no chance to reject before food fires, and mistakes become cancels/refunds after the fact. We accepted that cost because the alternative — till-side auto-accept — fails when no till is on and risks two tills double-printing. Mitigations: default off, help text that states the trade in plain words, `accepted_by = 'auto'` on the order, and exactly one kitchen print guaranteed by running the same accept transition as the manual path.
6. **Expiry is inclusive and timezone-safe.** The card works on its expiry date and expires the day after, compared as local calendar dates — a `DATE` parsed as UTC midnight would expire UK customers a day early.
7. **`basket.json` stays additive with no version bump.** Old displays may hard-check `format`; new fields are optional keys both sides tolerate.
8. **Merge rules for Transfer.** Destination bill survives; source lines re-id and append with modifiers and line discounts; covers sum; the source's bill-level discount is dropped with an audit note (two bill discounts cannot both apply); customer follows the destination, else moves from the source; both orders keep their audit trail via `merged_from` / `merged_into` events.
9. **Level 1 stays "Price 1".** The till parser hardcodes it; levels 2–6 are renamable. Renaming level 1 too was rejected as churn with no ask behind it.
10. **"Gift Card" is fixed everywhere**, not only the payment screen — one spelling, driven from `TenderKind.label`, no stored values touched.
11. **`dinein_auth.js` is consolidated now** — its own header scheduled the move for the next reason to open it, and request 12 is that reason.

---

## Release and deployment

**Store apps.** All three changed, so all three bump to 1.6.9.0: `vesopa_epos` (T12–T20, T25), `vesopa_epos_display` (T15), `vesopa_epos_kitchen` (T24). Bump each pubspec only because that app changed. If kitchen SSO slips, the kitchen app does not ship and does not bump.

**Schema deploy order.** Files apply in filename sort order on the server deploy; the new files apply in this order: `schema_dinein_auto_accept.sql`, `schema_products_membership.sql`, `schema_reasons_no_sale_cancel.sql`, `schema_till_customer_display.sql`, `schema_users_vesopa_sub.sql`. Before committing each one, `ls vesopa_server/schema/ | sort` and confirm it lands after its table's creator — the `schema_till_bars.sql` / `schema_till_pay_bars.sql` split exists because a venue lost printer names to exactly this mistake.

**Server and auth first.** (1) Run the T21 registrations against `auth.vesopa.com`. (2) Deploy `vesopa_server` to `backoffice.vesopaepos.com` — schema applies on deploy — then restart the Node service. (3) Smoke the running system: `GET /till/void-reasons` (legacy shape intact), `GET /till/error-reasons?applies_to=no_sale`, a screens fetch, and a back-office SSO login as `manager@vesopa.co.uk`. The new server is safe for old tills: legacy endpoints unchanged, renewal falls back to term months, error-reasons has the legacy route.

**Then the Store rollout.** New tills depend on T6/T7 endpoints, so the server must be live before the till build reaches venues. One sequencing note: the designer's "Transfer" key (T11) appears with the server deploy; if the T11 check shows 1.6.8.0 tills hard-fail on unknown bar keys, hold that one designer change until tills are updated.

**The Bridge onboarding, after their till updates:** set "Membership renewals run to" to 31/08/2027 and flag their membership product (the backfill will already have flagged their old PLU); set the customer-display greeting; rename their price level; program Transfer onto a bar and confirm Void/Cancel sit on the payment bars; decide on auto-accept with the trade explained; and have each sign-in go through Login with Vesopa once to link accounts.
---

## Verified against the running system before starting

The plan above was written from a description of the code. Everything in it was
then checked against the live back office (`backoffice.vesopaepos.com`), the
live identity provider (`auth.vesopa.com`) and the Microsoft Store API. Seven
things were wrong or already done, and the tasks below are amended accordingly.

1. **Table names.** Products are `bo_products`, not `epos_products`; the
   dine-in venue settings are columns on `dinein_venue`, not key/value rows.
   `schema_commerce.sql` creates both `bo_products` and
   `epos_loyalty_settings`, so the membership file is
   `schema_membership_renewal.sql` (sorts after `schema_membership_product.sql`);
   `schema_menu_dinein.sql` creates `dinein_venue`, so the dine-in file is
   `schema_menu_dinein_auto_accept.sql`; `epos_till_settings` is created by
   `schema_staff_idle.sql`, so the display file is
   `schema_till_customer_display.sql`.

2. **T5 is already done.** `schema_backoffice_vesopa_auth.sql` added
   `backoffice_users.vesopa_sub` and `vesopa_linked_at` with the unique index,
   and both columns are on live. No new file.

3. **T23 is already done and already live.** `src/backoffice_auth.js` carries
   the whole flow, `public/index.html` already draws "Continue with Vesopa"
   with the Vesopa mark, and the live `.env` has
   `VESOPA_AUTH_BACKOFFICE_ENABLED=on` **and**
   `VESOPA_AUTH_BACKOFFICE_ONLY=on` — `/api/public/backoffice/sign-in-options`
   answers `{"vesopa":true,"only":true}` today. One user is already linked.
   What is left in the back office is the wording on the button ("Login with
   Vesopa") and confirming no registration affordance remains.

4. **`vesopa-backoffice` is already registered** in the identity provider
   (application id 13), as are `vesopa-epos`, `vesopa-menu` and `vesopa-cloud`.
   T21 therefore registers **`vesopa-kitchen` only**.

5. **The till's SSO is already live too** —
   `/api/terminal/vesopa/enabled` answers enabled with a real client id, and
   `session_controller.dart` completes the round trip. T25 is a sign-in *page*
   change plus an `only` flag the server does not yet publish for the till.

6. **T10's design is wrong and is replaced.** The plan has the server accept a
   dine-in order at placement time. It cannot: accepting is what *creates the
   sale*, and that happens on the till (`ui/dinein_actions.dart`
   `acceptDineInOrder` rings every line onto a bill and only then posts
   `accepted` with the sale id). A server-side accept would mark the order
   accepted with `order_id` NULL, no till would ever ring it up, and the venue
   would serve food that never reached a bill. Auto-accept therefore runs **on
   the till**, driven by the venue setting, through the same
   `acceptDineInOrder` path a clerk's tap uses. Exactly-once is already
   guaranteed by the server: the transition updates
   `WHERE status IN ('placed')`, so a second till gets `affectedRows = 0` and
   is told another till got there first. The cost is stated honestly in the
   help text: auto-accept needs a till switched on, which a venue taking table
   orders has anyway.

7. **The photo and expiry features exist and are published.** 1.6.8.0 shipped
   them and is the live Store build; the live database has `photo_url`,
   `membership_expiry`, `membership_term_months`, `membership_fee_minor`,
   `membership_plu`, `price_level_names` and all four bar columns. An uploaded
   photograph is reachable
   (`/uploads/…png` returns 200, `image/png`). So requests 1 and 3 are not
   "build it" but "close the doors that bypass it" — and the door is
   `/till/customers`, which returns `id, name, phone, email, card_number,
   discount_type, discount_value` and **neither `membership_expiry` nor
   `photo_url`**. The Customer key on the till reads that endpoint, which is
   why an expired member attaches silently and shows no face.

8. **Price level renaming is entirely built except the editor.** The column,
   the server validation (`backoffice.js` 694/873), the till parser
   (`PriceLevelNames`) and the product form's labels all exist; there is no
   input anywhere in `public/index.html` bound to `price_level_names`. T8 is
   an editor plus a sweep, not a feature.

9. **No Store submission is pending** for any of the three apps, so all three
   are free to stage 1.6.9.0.

**Baseline before any change:** `flutter test --concurrency=2` in `vesopa_epos`
is `+821 -4` with the known failures (two Dojo live tests, the programmed-grid
golden, and the three `clock_punch_test.dart` "did not complete" phantoms that
do not reproduce when the file runs alone).

---

## What actually shipped, and what did not

Written after the work, against the running system rather than the plan.

### Done and deployed

Every one of the twelve requests is answered, the back office is live on
`backoffice.vesopaepos.com`, and all three apps are staged and committed to the
Microsoft Store as 1.6.9.0.

Proved on the live server after deploying, not only locally:

* `/till/void-reasons` answers exactly what it answered before, for the tills
  still on 1.6.8.0.
* `/till/error-reasons` answers a separate list for void, cancel, refund and
  no_sale, and refuses an action it does not know with a 400.
* `/till/customers` now carries `membership_expiry`, `photo_url` and
  `points_balance` — five expired members and one photograph on the test venue.
* A renewal posted for the expired test member with the season set to the
  client's own example returned `2027-08-31`, `renewed_by: season`. The test
  member's expiry was put back afterwards.
* The migration seeded 56 cancel reasons and 16 no-sale reasons across eight
  offices — seven and two each, exactly once.

### The one thing deliberately left switched off

`VESOPA_AUTH_TILL_ONLY` is **not** set on the live server, so the till still
offers email and password beside Login with Vesopa.

The reason is a number: of the eight venues on the platform, **one** has a
back-office user linked to a Vesopa account, and it is the test venue. The
back office has been Vesopa-only for some time, so those venues are already
living with that; adding the same constraint to till commissioning today would
mean a venue that needs to set a terminal up cannot, and would find out at the
counter.

Turning it on is one line in `@app/.env` and a `pm2 restart` — no deploy, no
Store release — and it should be turned on once venues have signed in through
Vesopa at least once. The button, the mark and the wording are already there;
the flag only decides whether the password fields sit beside it.

### The design the plan got wrong

Auto-accept. The plan had the server accept an order at placement time. It
cannot: accepting is what *creates the sale*, on the till, so a server-side
accept marks an order accepted with no bill behind it and the venue cooks food
that reaches no Z report. It runs on the till instead — and, unlike the manual
path, it claims the order **before** ringing it up, because auto-accept runs on
every terminal at once and three tills ringing the same food onto three local
bills is a table charged twice.

### Not attempted

`dinein_auth.js` still carries its own copy of the OIDC machinery. Its header
schedules the move for "the next time somebody has a reason to open it", and
this release never needed to open it — consolidating a working live migration
purely for tidiness is the kind of change that breaks a thing nobody asked to
have broken. It is still worth doing, on a day when it is the only thing being
done.
