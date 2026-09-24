# Vesopa Express — tasks

> **Where this plan came from.** Generated in one pass by **Kimi K3** (Moonshot, `kimi-k3`, 2026-09-10, 25.5k tokens) from the owner's brief, a summary of the reference kiosk video, and a written survey of this repository. The owner's brief itself is kept only on the build machine (`vesopa_expresss/newapp.md`, gitignored) because it carries the Dojo sandbox secret key; nothing secret appears here. Kimi's plan is reproduced below as written. Where the build deliberately departs from it, the departure is in the table directly underneath, with the reason, so nobody has to diff the two.

## The brief, restated without secrets

Vesopa Express is a self-service ordering kiosk: Windows first (later Android and iOS from the same code, which is why it is Flutter). Same kind of features as the McDonald's kiosk in the reference video, but more modern. Payment by **Dojo**. Portrait first, adapting automatically to landscape and to any screen. Always full screen like Vesopa EPOS; leaving it is through Settings and needs a passcode. **Off by default** per venue in the back office; once on, a kiosk is set up with **Continue with Vesopa**. Venues choose where notifications go: till, kitchen, or a display. Own logo and brand, consistent with Vesopa. Build and test it; **do not upload to the Microsoft Store yet**. Environment variables go to the server's `.env` (never GitHub); everything else is pushed to `main`.

## As built — where the build departs from the plan below

| Kimi's plan | As built | Why |
|---|---|---|
| `src/express.js`, `src/menucore.js`, `src/expressdojo.js` | `src/express_kiosk.js`, `src/menu_core.js`, `src/dojo_client.js`; board page in `src/express_board.js` | `express` is already the name of the web framework everywhere in `server.js`; a module called `./express` next to `require('express')` is a trap. Names follow the repo's snake_case. |
| Device token stored as a SHA-256 hash | A signed JWT with `scope: 'express'` (like the till's and the kitchen's), plus **revocation checked on every request** against `epos_express_kiosks.revoked_at` | Same shape as the two device tokens already in production, so `requireAuth` and `requireTerminal` already refuse it. Revocation is immediate, not "within 60 s". |
| Passcode stored bcrypt; kiosk caches "the hash" | **PBKDF2-SHA256, 120k iterations**, salt + hash returned to the kiosk | A bcrypt hash cannot be checked by the kiosk offline without shipping bcrypt; PBKDF2 is in Dart's `crypto` primitives. A kiosk that can only be exited online is a kiosk nobody can leave on the day the line fails. If a venue has no passcode yet, the manager sets one at commissioning (first time only). |
| `epos_express_order_lines` table | Lines kept as a JSON snapshot on `epos_express_orders`; the **sale's** lines go to `epos_order_lines` through `recordSale` | Every report already reads sale lines from one place. A second lines table would be a second set of takings. |
| `epos_express_numbers` | `epos_express_counters` (same atomic `LAST_INSERT_ID` trick, verified against MariaDB) | — |
| Notification columns added to `epos_till_settings` | `notify_till`, `notify_kitchen`, `board_enabled` on `epos_express_settings` | One page, one Save, one table for the whole feature; the till/kitchen apps still apply `notify_master` AND their local toggle on top. |
| Kitchen ticket always raised | Raised for stations that have a **screen** (mode `screen`/`both`), exactly as a till's fire; add-ons with no station follow their dish | A printer-only station is printed by a till, which a kiosk is not. Printing kiosk tickets on a kitchen printer needs the till to do it — listed below as a follow-up. |
| — | **Pay at the counter** (off by default): the order goes into the dine-in queue unpaid | The till already accepts dine-in orders, rings them onto a bill and fires the kitchen, so this works with **no till release**. |
| — | **Sweep**: unpaid orders a kiosk stopped asking about are checked with Dojo when the board or back office is looked at; money-in is finished, 30-minute-old baskets are closed | Covers a kiosk switched off between "card presented" and "approved" even if the webhook is not configured. |
| — | Venue's own Dojo key, pasted in the back office, sealed with AES-256-GCM (`EXPRESS_SECRET_KEY`); platform sandbox key as fallback | Live venues each have their own Dojo account; the key never leaves the server. |
| Store submission parked | msix config prepared, **nothing submitted** | Owner's instruction. |

## Status — 11 September 2026

**Built, deployed and proven live.** The server half is live on backoffice.vesopaepos.com (deployed 2026-09-10 23:37, after a database backup `backup/pre_express_20260910-233756.sql`). The kiosk is built for Windows (`build\windows\x64\runner\Release\vesopa_express.exe`). **Nothing has been submitted to the Microsoft Store.**

| Check | Result |
|---|---|
| `vesopa_server/test/express.test.js` — real MariaDB, pretend Dojo | 45 / 45 |
| `vesopa_server/tool/verify-express-live.js` — production, test venue only, Dojo sandbox card machine VCMVESOSIP0 | 12 / 12: a card order ran `present_card → processing → paid` and became one sale linked to its Dojo intent; board, pay at counter, cancel, demo, switch-off and removal all behaved; everything it made was removed; no new server error-log lines |
| The real app against production — `integration_test/live_kiosk_test.dart` at 540 × 960 | passed: attract → take away → menu → dish → basket → name → card → **paid on the sandbox machine** → number; the test kiosk and its sale were removed afterwards |
| Kiosk unit and widget tests | 16 pass |
| Screen gallery — 50 screens at 1080×1920, 1920×1080, 540×960, 960×540 and a tablet, plus Welsh, high contrast and reach mode | 50 / 50, no overflow |
| The back-office page, drawn by the live shell (`tool/bo_express_preview.py`) | in the rail; on and off states drawn |

Evidence (every screenshot looked at): `Documents\Vesopa-Claude-Images\2026-09-10-vesopa-express\`.

**Done from the plan below:** P0.4 (mark, icon, tiles), P0.7 (the sandbox, verified live rather than in a spike), P1.1–P1.10, P2.1–P2.5, P3.1–P3.8 (P3.4 as a string table rather than ARB files), P4.1–P4.5, P4.7–P4.9, P5.1–P5.4, P5.6, P6.1, P6.4–P6.5, P7.1–P7.5, P8.1 (configuration only), P8.3.

**Not done — deliberately, or next:**

* **Microsoft Store** — not submitted, as instructed. The identity values in `msix_config` are placeholders until Partner Center reserves the name.
* **The till's notification (P6.2)** — the server already broadcasts `express.order` to the venue; the till does not show it yet. That is a till change and a till release. Kitchen screens already get the ticket.
* **Kitchen printers** — a kiosk ticket reaches stations set to *Screen* or *Both*. A printer-only station is printed by a till, so it needs the till to do it.
* **A receipt from the kiosk (P5.5)** — the number is on screen; printing needs the kiosk's printer chosen and the till's Windows printing path brought across.
* **A step-by-step meal builder (P4.6)** — the dish sheet already asks the venue's own modifier questions ("choose up to 3"). "Make it a meal" at a meal price needs meal pricing the catalogue does not model yet.
* **Welsh** — drafted by the developer; a Welsh speaker must check it before a venue shows it (P0.6).
* **Loyalty, refunds and offline ordering at the kiosk** — non-goals for v1, below.

### Verified so far

* `schema_till_express.sql` applied **three times** to an empty database and — with every other schema file, as a deploy does — to a local copy of the **live database's structure** (79 files + 3 replays): silent, no leftover procedures, every `office` column `utf8mb4_general_ci`.
* The number counter, driven for real: 1, 2, 3, wraps to 1.
* Refactor regression: kitchen, dojo, dine-in (hours, offers, stylesheet, OTP, floor), tenancy, gym, routing and till-floor suites unchanged. `dinein.test.js` against a real database is **20 passed / 15 failed both before and after** this change (its scratch schema predates later dine-in migrations) and `backoffice-products.test.js` fails on a clean tree — neither is caused by Express.

---

# Kimi K3's plan, as generated

**Product:** Vesopa Express — self-service ordering kiosk for Vesopa EPOS
**Platform target:** Windows kiosk first (portrait-first, adaptive); Android/iOS later from the same Flutter codebase
**Server:** `vesopa_server` module `src/express.js` + migration `schema/schema_till_express.sql`
**App:** `vesopa_expresss/` (package `vesopa_express`) in the `Vesopa-Ltd` monorepo
**Status:** Plan v1.0 — for owner sign-off (Phase 0 exit gate)

---

## 1. Product summary

Vesopa Express is a full-screen, self-service ordering kiosk in the spirit of the McDonald's self-order kiosk — attract screen, eat-in/take-away, browsable menu with imagery and allergen data, meal builder, upsell, card payment at a Dojo terminal, big collection number, and a "Preparing / Ready for collection" board for an overhead screen — modernised and integrated natively with the Vesopa estate: the venue's existing curated menu, the existing kitchen display, the existing till, and the existing "Continue with Vesopa" commissioning door. The server prices everything, holds the Dojo secret key, and only turns a paid payment into a real sale + kitchen ticket.

### Goals

- Portrait-first kiosk that adapts automatically to landscape and arbitrary screen sizes, always full screen, exit only via a passcode-gated Settings.
- Per-venue enablement, **off by default**, controlled from the back office; commissioning refused while off; a commissioned kiosk shows a calm "switched off" screen if the venue disables it.
- One shared pricing function for the QR dine-in menu and the kiosk (refactored out of `src/dinein.js`).
- Card payment via Dojo terminal sessions, driven entirely server-side; kiosk only polls progress; retries reuse the same payment intent.
- Paid orders land as ordinary Vesopa sales (card, reference = payment intent id) and ordinary kitchen tickets (station routing from products), plus venue broadcasts.
- Notification routing per venue: till (toast + in-app card), kitchen (ticket + toast), and a web collection board at `/express/board/<secret>`.
- Accessibility: large targets, allergen info everywhere, high-contrast mode, "reach" mode for wheelchair users, English + Cymraeg, idle timeout with countdown.
- Sandbox and demo modes for testing and venue demos; demo never records money.
- msix packaging prepared and built locally; **not** submitted to the Microsoft Store.

### Non-goals (v1)

- Loyalty/points, vouchers and rewards redemption (the reference kiosk has these; we have no loyalty backend — the UI leaves a slot, hidden in v1).
- Cash payments, refunds, or order amendments at the kiosk (refunds remain a till/back-office matter — see Open questions).
- Table delivery / table numbers (counter collection only).
- Android/iOS builds, Microsoft Store submission, self-registration of any kind.
- Offline ordering (pricing is server-side by design; an offline kiosk cannot sell — see Risks).

---

## 2. Architecture overview

### 2.1 Components

| Component | Location | Role |
|---|---|---|
| Kiosk app | `vesopa_expresss/` (Flutter 3.47 / Dart 3.13, Riverpod 3, window_manager, http, web_socket_channel, local_notifier, url_launcher, crypto, shared_preferences) | UI, basket, payment progress polling, passcode gate, kiosk lock. Holds **no** secrets and **no** prices of record. |
| Express server module | `vesopa_server/src/express.js` (mounted in `server.js`) | Settings, kiosks, commissioning, config, menu, orders, payment orchestration, finalisation, board state. |
| Shared menu core | `vesopa_server/src/menucore.js` (extracted from `src/dinein.js`) | Loads curated menu (sections/items/images/allergens/add-ons) and `priceBasket(office, lines)` — the **single** pricing function, priced live from `bo_products` by PLU, add-ons from `epos_product_modifiers` → `epos_modifier_groups` → `epos_screen_buttons`. |
| Shared sale recorder | `vesopa_server/src/sales.js` (extracted from the `POST /till/orders` handler) | `recordSale(...)` used by the till upload route and by Express finalisation. |
| Dojo service | `vesopa_server/src/expressdojo.js` | Server-side Dojo client (intents, terminal sessions, terminal availability, cancel, signature). Env-driven live/sandbox/demo. |
| Dojo webhooks | existing `src/dojo.js` | HMAC-verified, idempotent; extended to hand captured intents to the Express finaliser. |
| Back office | `public/app.js`, `public/index.html`, `public/style.css` | Always-visible "Express" rail section: settings, passcode, kiosks, terminal assignment, board URL, notification destinations, orders viewer. |
| Till | `vesopa_epos/` | Receives `express.order` broadcast → Windows toast + in-app card per notify rule. |
| Kitchen | `vesopa_epos_kitchen/` | Receives the kitchen ticket through the existing ticket feed; toast per notify rule; marking ready feeds the collection board. |
| Collection board | `public/express-board/` static page at `/express/board/<secret>` | Any TV/browser; polls board-state JSON; shows "Preparing" / "Ready for collection". |

### 2.2 Data flow — one order, attract screen to collection board

1. **Browse.** Kiosk builds a basket locally (PLUs, quantities, modifier ids only — never prices of record; client-side prices are display-only previews from `GET /api/express/menu`).
2. **Submit.** Pay tapped → `POST /api/express/orders` with a client-generated idempotency key (UUID per basket, persisted in `shared_preferences`). Server prices the basket via `menucore.priceBasket`, allocates the next collection number atomically (`epos_express_numbers`, per venue per day), writes `epos_express_orders` (`awaiting_payment`) + `epos_express_order_lines`, returns `{orderId, number, totalMinor}`.
3. **Pay.** `POST /api/express/orders/:id/pay`. Server resolves payment mode (`live` if a live key + terminal assigned, `sandbox` if key is `sk_sandbox_...`, `demo` if no terminal assigned), creates the Dojo payment intent — **or reuses the intent id already stored on the order** (Dojo ignores `Idempotency-Key`, so the intent id is the idempotency mechanism) — checks `GET /terminals?statuses=Available`, then starts a terminal session on the kiosk's assigned terminal. Intent id and terminal-session id are stored on the order row.
4. **Progress.** Kiosk polls `GET /api/express/orders/:id` every 2 s. The server maps the Dojo terminal-session status (same mapping as `vesopa_epos/lib/payments/payment_provider.dart`, with a ~1.5 s fetch cache to respect Dojo rate limits) to the kiosk vocabulary: `present_card` / `processing` / `signature` / `approved` / `declined` / `cancelled` / `unavailable`. The kiosk may cancel only before `present_card` (server issues `PUT .../cancel`).
5. **Capture → finalise (idempotent).** Whichever sees capture first — the server's poll or the `src/dojo.js` webhook — calls `finaliseOrder(orderId)`. The finaliser: transitions the order to `paid` inside a guarded `UPDATE ... WHERE status='awaiting_payment'`; records the sale through `sales.recordSale` (card payment, `epos_payments.reference` = payment intent id — unique, so duplicates fail safe); raises the kitchen ticket with deterministic id `express-<orderId>` (natural idempotency key) carrying station routing from the products; broadcasts `kitchen.ticket` (existing) and `express.order` (new, scoped `{office}`); marks fulfilment `preparing`. Duplicate webhook / racing poll → exactly one sale, one ticket.
6. **Confirm.** Kiosk shows "No. 042", prints the receipt (same Windows printing path as the till), auto-returns to attract after 10 s.
7. **Fulfil.** Kitchen ticket appears on the board (badged "Express"). Kitchen marks ready via the existing ready action, extended to report ticket source → server sets fulfilment `ready` → board moves the number to "Ready for collection". When the kitchen ticket is cleared (or after a 10-minute safety expiry) the number leaves the board.

### 2.3 Payment state machine

```
                 submit                 pay (create/reuse intent,
 basket ──────────────────▶ AWAITING_PAYMENT ──────────────────────┐
                            │        │                              ▼
              cancel/expire │        │ terminal            INTENT_CREATED ──▶ SESSION_STARTED
                            ▼        │ unavailable                 │
                        CANCELLED /  ▼                              ▼
                          EXPIRED  UNAVAILABLE ──retry──▶ PRESENT_CARD ──▶ PROCESSING ──▶ SIGNATURE? ──▶ APPROVED/CAPTURED
                                                              │                                   │
                                                              └── decline ──▶ DECLINED ──retry──────┘   ▼
                                                                 (new terminal session,           FINALISED
                                                                  SAME intent id)                 (sale + ticket
                                                                                                   + broadcasts)
```

Rules:

- `AWAITING_PAYMENT → CANCELLED` (user cancel, venue-disabled mid-flow abort, or idle expiry) is only possible **before** `PRESENT_CARD`. After a card is presented the UI offers no cancel; the session runs to a Dojo outcome.
- `DECLINED` never discards the order: retry starts a **new terminal session against the same intent**; the basket/order/number are unchanged.
- `UNAVAILABLE` (terminal busy/offline: `GET /terminals?statuses=Available` empty, or `POST /terminal-sessions` rejected) leaves the order `awaiting_payment`; the kiosk shows "card machine unavailable — please ask a member of staff" with Retry.
- `FINALISED` is terminal and idempotent (status-guarded update + unique sale reference + deterministic ticket id).

### 2.4 Failure handling

| Scenario | Detection | Server behaviour | Kiosk behaviour |
|---|---|---|---|
| Network loss mid-payment | Poll times out | Webhook may still capture and finalise; order row is source of truth | Blocking "Checking your payment…" overlay (no cancel), exponential backoff, resume polling on reconnect; if order is `paid` jump straight to confirmation |
| Kiosk restart / crash mid-payment | Boot finds persisted `active_order_id` | Order + intent + session ids all on the order row | Re-query order: `paid` → confirmation + number; in-flight → reattach payment-progress screen; stale/`awaiting_payment` with dead session → offer resume or cancel |
| Duplicate webhook (or webhook racing poll) | `src/dojo.js` idempotency + finaliser guards | Single finalisation; second call is a no-op (status guard, unique `epos_payments.reference`, deterministic ticket id) | n/a |
| Declined card | Terminal-session status | Order stays `awaiting_payment`, intent retained | Friendly decline screen: "Try again" (new session, same intent) or "Cancel order" |
| Terminal busy / offline | Availability check / session start failure | No session created; order stays `awaiting_payment` | "Card machine unavailable" + staff hint + Retry |
| Venue switched off mid-session | `enabled=0` on next config poll / order create refused `403 venue_disabled` | New orders and commissioning refused; notifications suppressed; **an in-flight payment is allowed to reach a Dojo outcome and finalise** (money in motion is never stranded) | Idle → calm "Vesopa Express is switched off for this venue" screen within 60 s; mid-payment → finish, show confirmation, then the off-screen |
| Dojo API outage | HTTP failures/timeouts | Pay returns `unavailable`; webhook backlog reconciles later | "Card machine unavailable" state; order retained for retry |
| Double-tap Pay / retry storm | Idempotency key on order; intent id reuse | One order, one intent | Pay button debounced + disabled while in flight |

---

## 3. Data model and server API

### 3.1 New tables — `schema/schema_till_express.sql`

Re-runnable per house rules: `vesopa_add_column` / `vesopa_add_index` guard procedures defined at the top and dropped on the last line; `CREATE TABLE IF NOT EXISTS`; `office` columns `VARCHAR(190) ... utf8mb4_general_ci`, always bound as parameters (never joined to legacy tables).

**`epos_express_settings`** — one row per venue (the gym.js pattern):
`office` PK · `enabled TINYINT NOT NULL DEFAULT 0` · `passcode_hash VARCHAR(255) NULL` · `passcode_updated_at` · `idle_timeout_seconds INT DEFAULT 90` · `languages VARCHAR(32) DEFAULT 'en,cy'` · `default_language VARCHAR(2) DEFAULT 'en'` · `board_enabled TINYINT DEFAULT 1` · `board_secret CHAR(32)` (128-bit hex) · `demo_banner_ack TINYINT DEFAULT 0` · `created_at` / `updated_at`.

**`epos_express_kiosks`** — `id CHAR(26)` PK (ULID) · `office` · `name` · `dojo_terminal_id VARCHAR(64) NULL` · `device_token_hash CHAR(64)` (SHA-256; raw token shown once at commissioning) · `commissioned_by` · `commissioned_at` · `last_seen_at` · `revoked TINYINT DEFAULT 0` · index `(office)`.

**`epos_express_orders`** — `id CHAR(26)` PK · `office` · `kiosk_id` · `collection_number INT` · `collection_day DATE` · `status ENUM('awaiting_payment','paid','cancelled','expired')` · `fulfilment ENUM('preparing','ready','collected') NULL` · `payment_mode ENUM('live','sandbox','demo')` · `eat_in TINYINT` · `lang CHAR(2)` · `total_minor INT` · `currency CHAR(3) DEFAULT 'GBP'` · `dojo_payment_intent_id VARCHAR(64) NULL UNIQUE` · `dojo_terminal_session_id VARCHAR(64) NULL` · `idempotency_key VARCHAR(64)` · `created_at` / `paid_at` / `cancelled_at` · unique `(office, idempotency_key)` · index `(office, collection_day)`.

**`epos_express_order_lines`** — `id` AI PK · `order_id` · `plu` · `name` · `qty` · `unit_price_minor` · `line_total_minor` · `modifiers JSON` · `stations JSON` · index `(order_id)`.

**`epos_express_numbers`** — `office` · `day DATE` · `next_number INT DEFAULT 1` · PK `(office, day)`; allocated via `INSERT ... ON DUPLICATE KEY UPDATE next_number = LAST_INSERT_ID(next_number + 1)` (atomic under concurrent kiosks; wraps at 999).

**Guarded ALTERs on existing tables** (same file, via `vesopa_add_column`):
- `epos_till_settings` += `notify_till_express_new TINYINT DEFAULT 1`, `notify_kitchen_express_new TINYINT DEFAULT 1`, `notify_express_sound VARCHAR(64) DEFAULT 'default'` (mirrors the existing `notify_till_dinein_new` / `notify_kitchen_dinein_new` pattern; effective = `notify_master` AND event column AND device-local toggle).
- `epos_kitchen_tickets` += `source VARCHAR(16) DEFAULT 'till'` (values `till` | `express`) so the kitchen's ready action can route fulfilment updates back to Express.

### 3.2 Server API

Back-office auth = existing back-office session (office-scoped). Device auth = `Authorization: Bearer <express device token>` via a `requireExpressKiosk` middleware (resolves office, checks `revoked`, updates `last_seen_at`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/express/settings` | Back office | Read venue settings (always reachable, even when disabled — gym.js lesson) |
| PUT | `/api/express/settings` | Back office | Update enabled, passcode (hashed server-side), idle timeout, languages, board enabled, notification destinations |
| GET | `/api/express/kiosks` | Back office | List kiosks (name, terminal, last seen, revoked) |
| PUT | `/api/express/kiosks/:id` | Back office | Rename; assign Dojo terminal |
| POST | `/api/express/kiosks/:id/revoke` | Back office | Revoke device token |
| GET | `/api/express/dojo/terminals` | Back office | Proxy `GET /terminals?statuses=Available` to populate the assignment dropdown |
| POST | `/api/express/board/rotate` | Back office | Rotate `board_secret` (old URL dies immediately) |
| GET | `/api/express/orders?day=` | Back office | Today's/historic Express orders for the venue |
| POST | `/api/express/commission` | Vesopa ID token | Exchange "Continue with Vesopa" ID token (verified exactly as `src/terminal_vesopa.js`: signature/issuer/audience/10-min freshness/single-use jti/`linkAndFind` by verified email, venue membership required) for a long-lived Express device token; **403 `venue_disabled`** when off |
| GET | `/api/express/config` | Express device | Venue name, kiosk name, enabled flag, notify snapshot, passcode hash (offline verify), payment mode, feature flags, idle timeout, languages |
| GET | `/api/express/menu` | Express device | Curated menu via `menucore` (sections, items, images, allergens, diet tags, add-ons, live prices); **does not require the QR menu to be published** |
| POST | `/api/express/orders` | Express device | Price basket, allocate collection number, create `awaiting_payment` order (idempotent by key) |
| GET | `/api/express/orders/:id` | Express device | Order + mapped payment status (poll target) |
| POST | `/api/express/orders/:id/pay` | Express device | Create/reuse intent, start terminal session; returns mode + status |
| POST | `/api/express/orders/:id/cancel` | Express device | Cancel before `present_card` (cancels terminal session, voids intent, marks order) |
| POST | `/api/express/passcode/verify` | Express device | Verify passcode (bcrypt compare, rate-limited 5/min/kiosk) |
| POST | `/api/express/heartbeat` | Express device | Last-seen ping; response carries `enabled` for the 60 s off-check |
| GET | `/express/board/:secret` | Public secret | Collection board page (static, brand-styled) |
| GET | `/api/express/board/:secret/state` | Public secret | `{preparing:[...], ready:[...]}` numbers only; polled every 5 s |
| POST | `/api/webhooks/dojo/:environment` | Dojo HMAC | Existing; extended to call `finaliseByIntent(intentId)` |

Kitchen readiness flows through the existing kitchen endpoints (`src/kitchen.js`), extended so completing a ticket with `source='express'` updates fulfilment and board state.

---

## 4. Kiosk screens, navigation and adaptive layout

### 4.1 Screen list (routes)

| # | Route | Screen | Notes |
|---|---|---|---|
| 1 | `/attract` | Attract | Full-bleed promo carousel (from featured menu items), "Touch to start", persistent EN/CY toggle, reach-mode & contrast toggles |
| 2 | `/start/place` | Eating place | "Where will you be eating today?" — Eat In / Take Away cards + language buttons (English / Cymraeg) |
| 3 | `/menu` | Menu home | Left category rail (Home, Popular, Allergens, then curated sections), category tiles, promo banner, "Popular choices", sticky bag bar (icon, count, running total, Review) |
| 4 | `/menu/:section` | Category | Filter pills (All + diet tags), product cards: photo, name, price, kcal when present, allergen badge |
| 5 | `/item/:plu` | Item detail | Large image, description, allergen panel, add-on groups (min/max enforced), qty stepper, live price preview |
| 6 | `/meal/:plu` | Meal builder | "Would you like a side and a drink?" size choice, then step-by-step pickers with left progress rail, then assembled-meal review, "Add to bag" (driven by a combo-flagged modifier group; falls back to screen 5 when absent) |
| 7 | `/bag/added` | Added confirmation | "Item added to bag", updated total, Continue / Review bag |
| 8 | `/bag/upsell` | Upsell | "May we suggest…" popular items, "Not today" exit |
| 9 | `/bag` | Order review | Line steppers, remove, allergen recap, total, Pay |
| 10 | `/pay` | Payment | "Follow the instructions on the card reader": present-card / processing / signature / approved / declined / cancelled / terminal-unavailable states; Cancel only pre-card |
| 11 | `/done` | Confirmation | "No. 042" (Orbitron), "Please collect at the counter", receipt prints, auto-return 10 s; demo watermark in demo mode |
| 12 | `/off` | Venue disabled | Calm "Vesopa Express is switched off for this venue" |
| 13 | `/offline` | Offline | Calm "no connection" interstitial, auto-retry; menu/ordering unavailable (server-side pricing) |
| 14 | `/settings` | Settings | Passcode-gated: venue/kiosk/terminal/version/connectivity status, **Exit application**, **Sign out** (decommission) |
| — | overlay | Idle countdown | 10 s warning, any touch cancels; expiry clears basket → attract; suppressed during active payment |
| — | overlay | Passcode pad | Server verify, offline hash fallback, 5 failures → 60 s lockout |

**Navigation:** Riverpod flow controller (finite-state flow `attract → place → menu ⇄ (item|meal) → added → upsell? → bag → pay → done → attract`); the hidden gesture (long-press bottom-left corner 3 s) is armed on **every** screen and leads to the passcode pad → Settings.

### 4.2 Adaptive layout rules

- **Breakpoints by logical width:** compact `<600`, medium `600–1024`, expanded `>1024`. Orientation read per-frame (`LayoutBuilder`), never assumed.
- **Portrait (primary):** vertical category rail left (96 dp), grid 2–3 columns, sticky bottom bag bar full width; meal-builder progress rail on the left.
- **Landscape:** rail becomes slimmer (72 dp) or icon-only, grid 4–5 columns, item detail becomes two-pane (image left / options right), bag bar keeps bottom; confirmation number scales down to fit height.
- **All screens:** touch targets ≥64 dp; body text ≥18 sp; grids use `maxCrossAxisExtent` so cards never stretch ugly on odd sizes; safe-area and text-scale (up to 1.3×) respected; every screen must be screenshot-verified at 1080×1920, 1920×1080 and 1280×800.
- **Reach mode:** persistent toggle; interactive content compresses into the lower ~55% of the display (hero/scrim above), including payment status and confirmation number.
- **High-contrast mode:** ink `#10130A` background, soft `#EFF6D8` text, lime actions; AA contrast for all text pairs.

---

## 5. Brand & design system — Vesopa Express

- **Logo concept.** Derived from the Vesopa "V", distinct from the till and the kitchen's inverted mark: a rounded-square tile in Vesopa lime `#A5C715` carrying the ink `#10130A` V whose right arm extends into two forward speed-cuts (a chevron "express" gesture) — readable at 24 px, unmistakable next to the kitchen mark on one taskbar. Wordmark: "VESOPA" in Michroma caps, "Express" in Montserrat SemiBold, lime on ink or ink on lime only. Exports: SVG master, PNGs (16→512), `.ico`, msix tile assets. Source in `brand_assets/Express/`.
- **Palette.** Primary lime `#A5C715`; on-lime ink `#10130A`; deep `#6E8A0E` (success/affirmation); soft `#EFF6D8` (panels); chrome `#111111` (rails, footer bars). Semantic tokens added for kiosk use: `error` (warm red, AA on soft), `warning`, `info` — defined in `tokens.json`, never ad-hoc hex in code.
- **Typography.** Order numbers and payment amounts: **Orbitron** (the "No. 042" moment). Headings: **Montserrat** SemiBold/Bold. Body/UI: **Blinker**; dense fallbacks and any missing Welsh glyphs (ŵ ŷ): OpenSans. Scale (sp): Display 96/72, H1 40, H2 32, Title 26, Body 22, Small 18 (floor). Michroma reserved for the wordmark.
- **Motion.** 250 ms ease-out standard; 350 ms emphasised for sheet opens; add-to-bag item "flies" to the bag icon; attract promos slow ken-burns; all motion disabled when `MediaQuery.disableAnimations` is set.
- **Iconography.** Rounded line icons, 2.5 px stroke, lime accents on ink; card corner radius 16, buttons 14, full-width primary CTAs.
- **Tone of voice.** Short, warm, imperative, bilingual parity (Welsh is a first-class path, not an afterthought): "Touch to start" / "Cyffwrdd i ddechrau"; "Eat in" / "Bwyta yma"; "Take away" / "I fynd"; "Follow the instructions on the card reader". Error copy blames the machine, never the customer. All strings keyed in a copy deck; Welsh professionally reviewed before any venue demo.

---

## 6. Security

- **No secrets in the app or repo.** The Dojo secret key, `software-house-id` and `reseller-id` live only in the server's `.env` (never committed; `.env.example` documents names only). The kiosk never talks to `api.dojo.tech`. Repo is public — CI grep for `sk_`, `sk_sandbox_`, `.env` in the final review task.
- **Token scopes.** The Express device token is office-bound, role-scoped to `/api/express/*` only, stored server-side as a SHA-256 hash, revocable per kiosk (effective within 60 s via config/heartbeat, immediately on next request). It cannot create payment intents directly, cannot reach dine-in, kitchen, till or back-office endpoints, and cannot read another venue's data.
- **Commissioning.** Only via the exact **"Continue with Vesopa"** button (Vesopa mark, exact label), OAuth authorization-code + PKCE against `https://auth.vesopa.com` with loopback redirect, public client, no secret; ID token verified server-side per `src/terminal_vesopa.js`; venue membership required; refused when the feature is off. No self-registration anywhere.
- **Passcode.** Set in the back office; stored bcrypt (server) — never plaintext anywhere; kiosk caches only the hash (from config) for offline verification; server-side verify is rate-limited; the pad locks 60 s after 5 failures. The passcode unlocks Settings/Exit only — it grants no money-moving powers.
- **Money trust boundary.** Baskets carry PLUs/quantities/modifier ids only; all pricing, intents and terminal sessions are server-side; capture is believed only from Dojo (poll or HMAC webhook). Demo mode records no sale and no payment rows.
- **Collection board.** Secret is 128-bit, rotatable, read-only, exposes collection numbers only — no customer, order-value or venue data beyond the numbers.
- **A stolen kiosk can:** display the menu, place unpaid baskets, and complete a card payment on its paired terminal. **It cannot:** access the back office, other venues, refunds, settings (without the passcode), card data (terminal is Dojo's, P2PE), or any secret — and it can be bricked instantly via Revoke.

---

## 7. Phased task list

### Phase 0 — Plan, audits, brand

- [ ] **P0.1 — Plan sign-off.** Owner approves this document's scope and non-goals. _AC: written approval recorded._ Files: `tasks.md`.
- [ ] **P0.2 — App-side audit.** Document reusable code in the till (Dojo status mapping in `lib/payments/payment_provider.dart`, receipt-printing path, toast helper, window_manager kiosk-lock setup). _AC: `docs/express/audit-apps.md` lists exact classes/functions with paths._ Files: `docs/express/audit-apps.md`.
- [ ] **P0.3 — Server-side audit.** Document the `POST /till/orders` ingest path, exact sales/payments/ticket tables and columns (verified read-only against live schema), and the webhook reconcile flow. _AC: `docs/express/audit-server.md` names every table/column the finaliser will write._ Files: `docs/express/audit-server.md`.
- [ ] **P0.4 — Express brand mark.** Design logo + wordmark per §5; export SVG/PNG/ICO/msix tiles. _AC: assets committed; legible at 24 px; visually distinct from till/kitchen/display marks._ Files: `brand_assets/Express/*`.
- [ ] **P0.5 — Design tokens & component spec.** `tokens.json` (colour, type scale, spacing, radii, motion) + component spec; AA contrast verified for every text/background pair incl. high-contrast theme. _AC: tokens file is the single source for Phase 3 theme._ Files: `brand_assets/Express/tokens.json`, `docs/express/design-system.md`.
- [ ] **P0.6 — Bilingual copy deck.** Every UI string keyed, en + cy drafted, flagged for Welsh review. _AC: zero un-keyed strings; deck covers all §4 screens._ Files: `docs/express/copy-deck.md`.
- [ ] **P0.7 — Dojo sandbox spike.** Throwaway script (env-read keys, nothing hard-coded) creating an intent + terminal session against sandbox (`softwareHouse1`/`reseller1`). _AC: approve path observed end-to-end; sandbox quirks (signature flow, decline simulation, session expiry) documented._ Files: `scripts/dojo-sandbox-spike.mjs`, `docs/express/dojo-sandbox.md`.

### Phase 1 — Server & schema

- [ ] **P1.1 — Migration.** Write `schema_till_express.sql` per §3.1 (guard procedures top, dropped bottom; `CREATE TABLE IF NOT EXISTS`; office columns `utf8mb4_general_ci`). _AC: applied three times consecutively on a restored live backup → zero errors, identical schema._ Files: `vesopa_server/schema/schema_till_express.sql`.
- [ ] **P1.2 — Extract `menucore`.** Move curated-menu load + pricing out of `dinein.js` into `src/menucore.js`; dine-in re-imports it. _AC: QR menu prices byte-identical before/after on the test venue; existing dine-in regression passes._ Files: `vesopa_server/src/menucore.js`, `vesopa_server/src/dinein.js`.
- [ ] **P1.3 — Extract `sales`.** Move sale-recording out of the `/till/orders` handler into `src/sales.js`. _AC: till sales upload regression unchanged; function callable from express.js._ Files: `vesopa_server/src/sales.js`, `vesopa_server/src/kitchen.js`.
- [ ] **P1.4 — Settings & kiosk admin API.** §3.2 back-office endpoints incl. terminals proxy and board rotate. _AC: cross-venue access returns 404/403 in tests; passcode only ever stored hashed._ Files: `vesopa_server/src/express.js`.
- [ ] **P1.5 — Commissioning.** Reuse the `terminal_vesopa` door; issue hashed Express device tokens; refuse when disabled. _AC: enabled venue commissions; disabled returns 403 `venue_disabled`; token stored as hash only._ Files: `vesopa_server/src/express.js`, `vesopa_server/src/terminal_vesopa.js`.
- [ ] **P1.6 — Config & menu endpoints.** Device-scoped config (incl. passcode hash, payment mode, enabled) and menu via `menucore`. _AC: menu returns fully priced without QR publish; revoked token gets 401._ Files: `vesopa_server/src/express.js`.
- [ ] **P1.7 — Orders API.** Create (price, atomic number, idempotency), status, cancel, passcode verify (rate-limited), heartbeat. _AC: duplicate submit returns the same order/number; concurrent allocation test yields unique numbers._ Files: `vesopa_server/src/express.js`.
- [ ] **P1.8 — Dojo service.** `src/expressdojo.js`: mode resolution (live/sandbox/demo), intent create/**reuse**, availability check, session start/poll/cancel/signature; mirrors the till's mapping. _AC: sandbox session completes; retries never create a second intent (verified in Dojo dashboard)._ Files: `vesopa_server/src/expressdojo.js`, `vesopa_server/.env.example`.
- [ ] **P1.9 — Finaliser + webhook hook.** Idempotent `finaliseOrder` (status guard, unique payment reference, deterministic ticket id `express-<orderId>`, stations from products, broadcasts `kitchen.ticket` + `express.order`); wire into `src/dojo.js`. _AC: webhook replayed twice + racing poll → exactly one sale row and one ticket._ Files: `vesopa_server/src/express.js`, `vesopa_server/src/dojo.js`.
- [ ] **P1.10 — Mount & boot.** Register routes in `server.js`; document env names in `.env.example`. _AC: server boots under pm2; route smoke list passes; repo grep finds no secrets._ Files: `vesopa_server/server.js`, `vesopa_server/.env.example`.

### Phase 2 — Back office

- [ ] **P2.1 — Rail entry.** "Express" section **always visible** in the left rail + `ROUTES`; when disabled the page says so in one sentence and still renders the controls. _AC: entry present with feature off (the gym.js regression must not recur)._ Files: `public/app.js`, `public/index.html`, `public/style.css`.
- [ ] **P2.2 — Settings form.** Enable toggle, passcode set/change (with confirmation field), idle timeout, languages/default, demo acknowledgement, notification destinations (till / kitchen / board) bound to the notify columns. _AC: PUT round-trips; DB shows only a passcode hash._ Files: `public/app.js`, `public/index.html`, `public/style.css`.
- [ ] **P2.3 — Kiosk management.** List (name, assigned terminal, last seen, status), rename, assign terminal from the live Available dropdown, revoke. _AC: revoked kiosk loses access within 60 s._ Files: `public/app.js`, `public/index.html`.
- [ ] **P2.4 — Collection board panel.** Show board URL, copy button, QR code, rotate-with-confirm, open-in-new-tab. _AC: old secret 404s immediately after rotation._ Files: `public/app.js`, `public/index.html`.
- [ ] **P2.5 — Orders viewer.** Today's Express orders: number, total, status, fulfilment, mode (demo rows visually flagged). _AC: matches DB exactly; office-scoped._ Files: `public/app.js`, `public/index.html`.
- [ ] **P2.6 — Deploy back office.** Paramiko upload of `public/` + server, pm2 restart, verify running asset hashes. _AC: live back office shows Express section; hash check logged in runbook._ Files: `deploy/upload_backoffice.py`, `docs/express/runbook.md`.

### Phase 3 — Kiosk app shell, commissioning, kiosk lock

- [ ] **P3.1 — Scaffold.** Create `vesopa_expresss/` (package `vesopa_express`), pinned Flutter 3.47/Dart 3.13, Riverpod 3, declared deps, `analysis_options.yaml`. _AC: `flutter build windows` and `flutter analyze` clean._ Files: `vesopa_expresss/pubspec.yaml`, `vesopa_expresss/lib/main.dart`, `vesopa_expresss/analysis_options.yaml`.
- [ ] **P3.2 — Kiosk lock.** window_manager full screen, not closable/minimisable, matching the till's setup; platform abstraction interface for later Android/iOS. _AC: close/Alt+F4/minimise do not exit; only Settings→Exit quits._ Files: `vesopa_expresss/lib/platform/kiosk_lock.dart`, `vesopa_expresss/lib/main.dart`.
- [ ] **P3.3 — Theme.** Tokens + fonts (Montserrat/Blinker/Orbitron/Michroma, OpenSans fallback), high-contrast variant, text-scale clamps. _AC: golden tests pass; ŵ/ŷ render correctly in every font used for body copy._ Files: `vesopa_expresss/lib/theme/*`, `vesopa_expresss/pubspec.yaml`.
- [ ] **P3.4 — Localisation.** en/cy scaffolding wired to the copy deck; lint forbids hard-coded strings. _AC: language toggle re-renders every screen; lint clean._ Files: `vesopa_expresss/lib/l10n/*`.
- [ ] **P3.5 — Commissioning screen.** Exact **"Continue with Vesopa"** button + mark; PKCE loopback OAuth against `https://auth.vesopa.com`; token exchange; secure local storage; disabled-venue refusal screen. _AC: test venue commissions on Windows; token never written to logs._ Files: `vesopa_expresss/lib/commissioning/*`.
- [ ] **P3.6 — Bootstrap & health.** Config fetch → route to attract / off / offline; 60 s config+heartbeat poll; connectivity watcher. _AC: disabling the venue flips the kiosk to the off-screen ≤60 s; aeroplane mode shows the offline screen._ Files: `vesopa_expresss/lib/bootstrap/*`, `vesopa_expresss/lib/api/express_api.dart`.
- [ ] **P3.7 — Hidden gesture & Settings.** Long-press corner 3 s (armed globally) → passcode pad (server verify, offline hash fallback, 5-strike lockout) → Settings with status, Exit application, Sign out. _AC: exit possible only via this path; lockout verified._ Files: `vesopa_expresss/lib/settings/*`, `vesopa_expresss/lib/security/passcode.dart`.
- [ ] **P3.8 — Adaptive layout kit.** Breakpoints, orientation handling, reach-mode container, min-target enforcement widgets per §4.2. _AC: demo screen renders correctly at 1080×1920, 1920×1080, 1280×800._ Files: `vesopa_expresss/lib/layout/*`.

### Phase 4 — Menu & ordering UX

- [ ] **P4.1 — Attract.** Promo carousel from featured items, "Touch to start", EN/CY + reach + contrast toggles. _AC: matches design; idle-from-anywhere returns here (via countdown)._ Files: `vesopa_expresss/lib/screens/attract.dart`.
- [ ] **P4.2 — Eating place.** Eat In / Take Away cards + language buttons. _AC: choice + language land on the order row._ Files: `vesopa_expresss/lib/screens/eating_place.dart`.
- [ ] **P4.3 — Menu home.** Category rail, tiles, promo banner, popular choices, sticky bag bar. _AC: 3-col portrait / 4–5-col landscape; bag bar always visible._ Files: `vesopa_expresss/lib/screens/menu_home.dart`.
- [ ] **P4.4 — Category & cards.** Filter pills by diet tag; product cards with image/price/kcal-when-present/allergen badge. _AC: allergen detail reachable from every item in one tap._ Files: `vesopa_expresss/lib/screens/category.dart`.
- [ ] **P4.5 — Item detail & modifiers.** Add-on groups with min/max, qty stepper, live price preview. _AC: preview total equals server `priceBasket` for identical baskets (test)._ Files: `vesopa_expresss/lib/screens/item_detail.dart`.
- [ ] **P4.6 — Meal builder.** Size choice → step pickers with progress rail → meal review → Add to bag; graceful fallback when no combo group. _AC: assembled meal prices correctly end-to-end; fallback path covered by test._ Files: `vesopa_expresss/lib/screens/meal_builder.dart`.
- [ ] **P4.7 — Bag flow.** Added confirmation, upsell sheet with "Not today", review with steppers/remove, hidden loyalty slot. _AC: Pay is disabled until a server price-check succeeds._ Files: `vesopa_expresss/lib/screens/bag.dart`, `vesopa_expresss/lib/screens/upsell.dart`.
- [ ] **P4.8 — Reach & high-contrast modes.** Persistent per-device toggles applied to every ordering screen. _AC: all flows completable in the lower 55%; AA contrast verified._ Files: `vesopa_expresss/lib/layout/reach_mode.dart`, `vesopa_expresss/lib/theme/*`.
- [ ] **P4.9 — Idle timeout.** Countdown overlay (10 s), any touch cancels, expiry clears basket → attract; suppressed during payment. _AC: timeout seconds come from venue settings; payment screens exempt._ Files: `vesopa_expresss/lib/widgets/idle_timeout.dart`.

### Phase 5 — Dojo payments

- [ ] **P5.1 — Payment orchestrator.** Riverpod state machine mirroring §2.3; 2 s polling; cancel gated pre-`present_card`. _AC: unit tests cover every transition incl. decline-retry with intent reuse._ Files: `vesopa_expresss/lib/payments/payment_controller.dart`.
- [ ] **P5.2 — Payment screens.** All §4 states with large iconography, bilingual copy, reach-mode support. _AC: screenshots en+cy, both orientations, archived._ Files: `vesopa_expresss/lib/screens/payment.dart`.
- [ ] **P5.3 — Submit + pay wiring.** Idempotency key per basket persisted; debounced Pay. _AC: double-tap/kill-retry yields exactly one order and one intent._ Files: `vesopa_expresss/lib/api/express_api.dart`, `vesopa_expresss/lib/basket/basket_controller.dart`.
- [ ] **P5.4 — Demo mode.** "DEMO — no payment will be taken" banner, simulated approval, watermark on confirmation/receipt, zero sales/payment rows. _AC: DB shows no sale/payment rows for demo orders; banner unmissable._ Files: `vesopa_expresss/lib/payments/demo_payment.dart`, `vesopa_expresss/lib/screens/payment.dart`.
- [ ] **P5.5 — Confirmation & receipt.** Big number, collect-at-counter, 10 s auto-return; receipt via the till's Windows printing path. _AC: receipt prints on the test kiosk hardware; number matches DB and board._ Files: `vesopa_expresss/lib/screens/confirmation.dart`, `vesopa_expresss/lib/printing/receipt_printer.dart`.
- [ ] **P5.6 — Resilience.** Persist `active_order_id`; boot-resume logic; network-loss overlay; venue-disabled mid-flow completion rule per §2.4. _AC: forced kill mid-payment resumes to the correct end state in drills._ Files: `vesopa_expresss/lib/bootstrap/resume.dart`.

### Phase 6 — Notifications & collection board

- [ ] **P6.1 — Broadcast.** `express.order` (number, total, eat-in, mode) scoped `{office}` on finalisation; suppressed when the venue is disabled. _AC: till and kitchen ws clients receive it; disabled venue emits nothing._ Files: `vesopa_server/src/express.js`.
- [ ] **P6.2 — Till handling.** On `express.order`: Windows toast + in-app card, governed by `notify_master` AND `notify_till_express_new` AND device-local toggle; add the local toggle to till settings. _AC: full 8-combination toggle matrix tested._ Files: `vesopa_epos/lib/notifications/*`, `vesopa_epos/lib/settings/*`.
- [ ] **P6.3 — Kitchen handling.** Express ticket on the board with an "Express" source badge; toast per `notify_master` AND `notify_kitchen_express_new` AND local; ready action reports source to the server. _AC: ready reflects on the collection board ≤5 s._ Files: `vesopa_epos_kitchen/lib/*`, `vesopa_server/src/kitchen.js`.
- [ ] **P6.4 — Board page.** Static brand-styled page (huge Orbitron numbers, Preparing / Ready for collection columns, 5 s polling, optional ready chime). _AC: runs on a bare smart-TV browser; secret-only access; no other data exposed._ Files: `public/express-board/index.html`, `public/express-board/board.js`, `public/express-board/board.css`.
- [ ] **P6.5 — Board state & lifecycle.** State endpoint; `paid→preparing`, kitchen-ready→`ready`, ticket-cleared (or 10-min expiry)→removed. _AC: state matches DB through the full lifecycle; expired numbers disappear._ Files: `vesopa_server/src/express.js`.

### Phase 7 — Testing (see §8 for the full plan)

- [ ] **P7.1 — Server unit tests.** Pricing parity, number allocation, state machine, passcode crypto, idempotency guards. _AC: suite green in CI._ Files: `vesopa_server/test/express*.test.js`.
- [ ] **P7.2 — Flutter widget/golden tests.** Every screen × {portrait, landscape} × {default, high-contrast, reach}. _AC: goldens committed; CI diff gate._ Files: `vesopa_expresss/test/*`.
- [ ] **P7.3 — Integration tests.** Demo-mode full journey, passcode/exit flow, idle timeout, resume-after-kill; run with `flutter test integration_test/ -d windows`. _AC: all green on the dev kiosk._ Files: `vesopa_expresss/integration_test/*`.
- [ ] **P7.4 — Migration re-runnability.** Apply `schema_till_express.sql` **three times** on a restored live backup. _AC: zero errors; schema diff identical after runs 2 and 3._ Files: `docs/express/test-evidence/migration.md`.
- [ ] **P7.5 — Live E2E.** Scripted run against the real server using **only `manager@vesopa.co.uk`** and its dedicated test venue: enable → commission → menu → demo order → sandbox card order → verify sale rows, kitchen ticket, board, till toast → disable → off-screen → revoke → delete all created data. _AC: checklist executed with evidence archived._ Files: `docs/express/e2e-checklist.md`, `docs/express/test-evidence/*`.
- [ ] **P7.6 — Failure drills (live).** Kill kiosk mid-payment, replay webhook (curl), unplug terminal, disable venue mid-session, revoke mid-session. _AC: each drill lands in the §2.4 end state; evidence captured._ Files: `docs/express/test-evidence/failure-drills.md`.
- [ ] **P7.7 — Screenshot archive.** Every screen × portrait/landscape (en + cy on key flows). _AC: archive complete and referenced from the README._ Files: `docs/express/screenshots/*`.

### Phase 8 — Packaging, deploy, docs

- [ ] **P8.1 — msix packaging.** msix config + brand tiles; local build validated; **nothing submitted to the Microsoft Store / Partner Center.** _AC: `.msix` installs and runs on a clean Windows machine; submission checklist parked._ Files: `vesopa_expresss/pubspec.yaml` (msix section), `docs/express/store-submission.md`.
- [ ] **P8.2 — Server deploy runbook.** Paramiko script covering the new module + `public/` assets + pm2 restart + asset-hash verification + **live DB backup before migration**. _AC: rehearsed end-to-end; runbook signed off._ Files: `deploy/upload_backoffice.py`, `docs/express/runbook.md`.
- [ ] **P8.3 — Operator docs.** README + runbook: enable a venue, commission a kiosk, assign a terminal, rotate the board URL, revoke a kiosk, demo mode, troubleshooting. _AC: a non-author can commission a kiosk from the docs alone._ Files: `vesopa_expresss/README.md`, `docs/express/runbook.md`.
- [ ] **P8.4 — Secrets inventory.** `.env.example` complete; inventory of every secret, its location and rotation procedure. _AC: inventory matches the live `.env` keys (names only)._ Files: `vesopa_server/.env.example`, `docs/express/secrets.md`.
- [ ] **P8.5 — Final review.** Repo-wide secret grep, dependency licence check, brand sign-off, owner demo on the test venue. _AC: owner sign-off recorded; repo pushed to GitHub `main`._ Files: `docs/express/sign-off.md`.

---

## 8. Test plan

**Principle (learned the hard way):** unit tests have passed while features were broken — twice. No task in Phase 7 is "done" on unit tests alone; every feature also has a live check against the real server.

- **Unit (server):** `menucore.priceBasket` parity with dine-in for a fixed basket corpus; atomic number allocation under concurrency; payment state-machine transitions; bcrypt passcode flow; finaliser idempotency (double invocation, out-of-order webhook/poll); tenancy isolation.
- **Unit (app):** basket arithmetic (display only), payment controller transitions, idempotency-key persistence, passcode offline-hash verify, layout breakpoints.
- **Widget/golden:** every screen × {1080×1920, 1920×1080} × {default, high-contrast, reach mode}; goldens gated in CI.
- **Integration (`flutter test integration_test/ -d windows`):** demo-mode order end-to-end; hidden-gesture → passcode → exit; idle timeout clears basket; kill-and-resume mid-(demo)-payment; language switch mid-flow.
- **Migration:** `schema_till_express.sql` applied **three times consecutively** on a restored live backup → no errors, no schema drift; guard procedures dropped after each run.
- **Live E2E (the only permitted account: `manager@vesopa.co.uk`, dedicated test venue; creates and deletes only its own data):** enable → commission → menu fetch → demo order (assert no money rows) → sandbox card order (assert sale row with reference = intent id, kitchen ticket with stations, `express.order` broadcast, till toast, board number) → kitchen ready (assert board moves to Ready) → disable venue (assert off-screen ≤60 s, notifications cease) → revoke kiosk → cleanup. Live DB backed up before any migration deploy.
- **Failure drills (live):** per §2.4 table — process kill mid-payment, duplicated webhook via curl, terminal unplugged, venue disabled mid-payment, kiosk revoked mid-session.
- **Evidence:** screenshots of every screen (portrait + landscape; en + cy on the primary flow), E2E checklist, drill notes and DB assertions archived under `docs/express/test-evidence/` and `docs/express/screenshots/`.
- **Exit criteria:** all Phase 7 tasks checked, owner demo completed, zero open defects labelled blocker.

---

## 9. Risks & open questions (non-blocking)

1. **Folder name.** `vesopa_expresss/` (triple "s") is used throughout as specified — if it is a typo, rename **before** P3.1; cheap now, painful after packaging.
2. **Meal-deal modelling.** The catalogue has modifier groups, not combo pricing; the meal builder assumes a combo-flagged group. Confirm how venues should price meals; fallback is the simple item+modifiers flow (P4.6).
3. **kJ/kcal data.** `dinein_items` may not carry calories; cards show kcal only when present. Decide whether to add a guarded column or drop the requirement.
4. **Kitchen notification interpretation.** The kitchen **ticket** is always raised for paid orders (operational necessity — food must be made); the venue toggles govern the **toast/alerts** per destination. Flagging for owner confirmation.
5. **Dojo sandbox terminal behaviour.** Auto-approve, signature and decline simulation are unverified until the P0.7 spike; sandbox session-expiry timing affects the kiosk's stale-order sweep.
6. **Receipt printing.** Assumes the till's Windows printing path transfers to kiosk hardware (P0.2 audit); if drivers differ, the on-screen number is the fallback and receipt becomes a venue option.
7. **Offline ordering.** Impossible by design (server-side pricing). The calm offline screen is the agreed behaviour — confirm the owner accepts no degraded offline mode.
8. **Refunds at kiosk.** Out of scope v1; define whether refund of an Express sale is a till function or back-office-only.
9. **Dojo polling rate limits.** Server caches terminal-session fetches (~1.5 s); if venues run many kiosks, revisit with a per-terminal poller.
10. **Android/iOS later.** window_manager is desktop-only; the kiosk-lock abstraction (P3.2) keeps the door open, but Android kiosk-mode and iOS Guided Access need their own spikes when those platforms are scheduled.
11. **Welsh copy.** Drafted in P0.6 but requires professional translation sign-off before any public venue demo.
12. **Collection-number wrap.** Numbers wrap at 999 per venue per day; confirm no venue exceeds ~999 Express orders/day.