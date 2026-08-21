# Vesopa Kitchen — how it is put together

A Windows touch-screen application that hangs in a kitchen and shows what has
been ordered. It replaces — or sits alongside — the thermal printer that a
station would otherwise be routed to.

This document is the design. Read `reference-kitchen-demo.md` first for what the
board looks like, and `../README.md` for how to run it.

---

## 1. The one idea

The till already decides, per product, which **stations** a line belongs to:
`kp1`…`kp6` plus the receipt printer. That routing is set in the back office,
stored on `bo_products.printer_routes`, and read on every fire by
`KitchenPrinting` in the till. It is the existing, working answer to "who cooks
this?".

The kitchen screen does not introduce a second answer. It introduces a second
**delivery mode** for the answer that already exists:

| Mode | What happens when a line routed to KP 3 fires |
| --- | --- |
| `printer` | A ticket prints on whatever this terminal has plugged into KP 3. *This is the default and the existing behaviour.* |
| `screen` | The ticket appears on every kitchen screen watching KP 3. Nothing prints. |
| `both` | Both. |

The mode is per station, venue-wide, and owned by the back office — the same
place, and for the same reason, as the station *names*. "KP 3 is the fryer, and
the fryer has a screen" is a fact about the venue, not about a till.

The brief asks for exactly this: *"From the back office let the user setup the
printer and kitchen software or both."*

Defaulting every station to `printer` is deliberate. A venue that upgrades and
never opens the new screen keeps printing precisely as it did yesterday.

---

## 2. The ticket

### One ticket per fire, not per station

A printer gets one ticket per station because paper cannot be filtered. A screen
can. So the till sends **one ticket per fire**, carrying every line that went
anywhere, and each line carries the stations it is routed to. Each screen then
draws only the lines for the stations it watches.

This is what makes the board match the reference: one card per order, not one
card per station-of-order. A single screen in a small kitchen watching all six
stations shows one card with everything on it, which is what that kitchen wants.
A grill screen and a fryer screen in a large kitchen show the same order twice,
each with only their own lines, which is what *that* kitchen wants. Same data,
no configuration.

### A ticket is complete when every station is done

`epos_kitchen_ticket_stations` holds one row per (ticket, station) with a status.
Bumping on the grill screen closes the grill's row. The ticket leaves the Open
tab when the last station closes — so on a two-screen kitchen the pass can see
that the fryer is still working, and on a one-screen kitchen the distinction
never surfaces at all.

Recall re-opens every station, which is the only sane reading of "that went out
wrong".

### Identity and idempotency

The till mints the ticket id (a UUID) and the server does `INSERT IGNORE`, the
same contract `/till/orders` already uses. A till that retries after a dropped
connection re-sends the same id and the kitchen does not get the order twice.

### Tickets expire; sales do not

A sale that fails to reach the server is queued in the till's Drift outbox
forever, because unrecorded money is a problem that stays a problem. A kitchen
ticket is the opposite: a ticket delivered forty minutes late is worse than one
never delivered, because somebody will cook it.

So the till's kitchen-ticket queue is a small, prefs-backed list with a **ten
minute time-to-live**, not a row in the outbox. It survives a restart and a
flaky minute of network; it does not survive a service. See
`vesopa_epos/lib/data/kitchen_screens.dart`.

---

## 3. Who talks to whom

```
   Vesopa EPOS (till)                vesopa_server                Vesopa Kitchen     
   ─────────────────                 ─────────────                ───────────────────
   KitchenPrinting.fire
     ├─ printer mode ──► ESC/POS to the station's printer
     └─ screen mode  ──► POST /till/kitchen/tickets ──► epos_kitchen_tickets
                                                          │
                                                          ├─ broadcast kitchen.ticket ──► WS ──► board updates
                                                          │
                                          GET /api/kitchen/board ◄── poll (30s backstop)
                                          POST /api/kitchen/tickets/:id/bump
                                          POST /api/kitchen/tickets/:id/recall
```

The socket is the fast path and the poll is the truth. A kitchen screen that
misses a push because nginx culled an idle connection must not miss the order —
so the board is re-fetched on every reconnect, and on a timer regardless. The
same belt-and-braces the till already uses for its catalogue.

Delivery is **at-least-once and idempotent** in both directions: a re-sent ticket
is ignored by id, and a bump is a state assignment rather than an increment, so
pressing it twice is pressing it once.

---

## 4. Who is allowed

Three credentials already exist in this platform, and the kitchen adds a fourth
rather than reusing one:

| Credential | Scope | Why not this one for the kitchen |
| --- | --- | --- |
| Back-office session | Everything for one office | A screen on a kitchen wall is not a manager's laptop. |
| Terminal token | Read a venue's staff list | Long-lived and till-specific; issued at commissioning. |
| Staff PIN | Attribution on a till | Four digits, shared, and not a login. |
| **Kitchen login** | Read the board for one office; bump and recall | — |

`epos_kitchen_users` is a username and a bcrypt hash per office, created by the
back office — the brief's *"Let back office user create Kitchen software users
credentials"*. Signing in returns a JWT with `scope: 'kitchen'` and the office.
`requireKitchen` refuses a session token, and `requireAuth` refuses anything
carrying a `scope` at all — see *The auth fix* in §10, which is where this
mutual exclusion stopped being a list of names and became a rule.

A kitchen token is deliberately long-lived (90 days). A screen bolted to a wall
above a fryer, signed out at 7pm on a Friday because a token expired, is a
kitchen that cannot see its orders during the busiest service of the week.

---

## 5. Screen profiles

A **screen** is a named board defined in the back office: which stations it
watches, how many columns, when a ticket turns amber and then red, how long
completed orders stay recallable. The back office owns it for the same reason it
owns station names — so "the grill screen" means one thing in the venue, and a
manager can change it without climbing onto a stool with a keyboard.

What stays on the device is which profile *this* machine is: picked once at
sign-in, stored in `SharedPreferences`, changeable from the drawer. Exactly the
split the till already draws between printer names (venue) and printer hardware
(terminal).

A venue that never defines a screen gets a built-in **All stations** profile, so
the app works before anybody configures anything.

---

## 6. Ageing

The reference board never shows an old ticket, so it does not say whether one
looks different. Ours does:

| Age | Header |
| --- | --- |
| Fresh | Slate — quiet, so the board is calm when it is calm |
| Past the warn threshold | Amber |
| Past the late threshold | Red, and the card pulses once a second |
| Completed | Green, as the reference |
| Rushed | Indigo, and sorted to the front regardless of age |

Both thresholds are per screen profile and default to 8 and 15 minutes.

A board where a two-minute ticket and a twenty-minute ticket look identical
makes the person at the pass do the sorting, and they are the one person in the
building with no spare attention.

---

## 7. The screens

| Tab | What it is for |
| --- | --- |
| **Open** | The board. Cards, oldest first, rushed tickets first of all. |
| **Counts** | Every outstanding line added up by item — *"7 × Crispy Chicken Burger"* — so a chef can batch. This is prep, not orders, and it is the one view a printer can never give you. |
| **Completed** | The recall window. Green cards, newest first, each with `↺ Recall Order`. |

Off the header: **print** (put the visible board or one ticket on paper, for when
the screen has to be abandoned), **settings** (this device: profile, columns,
sound, connection), **info** (what this screen is, what it is connected to, and
who to ring), **sign out**.

Off the hamburger: station filters, density, sound, a manual refresh, and the
about box.

### On-screen keyboard

Required by the brief, and required by the situation: a kitchen screen has no
keyboard, and the app asks for text in exactly two places — signing in, and
searching the completed list. A `VirtualKeyboard` widget is mounted by the two
fields that need it rather than being a global input method, because a keyboard
that can appear over the board is a keyboard that will appear over the board
mid-service.

---

## 8. Failure

Everything here is built on the assumption that the network will go away, because
in a kitchen it will.

- **The board is cached.** The last board drawn is written to
  `SharedPreferences` and re-drawn on launch, so a screen that boots with no
  network shows what it knew instead of a spinner.
- **The connection is visible.** A persistent bar, not a toast: a toast that a
  chef missed is worse than no warning at all.
- **Bumps queue.** A bump made while offline is applied locally and re-sent when
  the link returns. Idempotent, so a double-send is free.
- **Nothing blocks the board.** Printing, settings, sound — every one of them can
  fail without taking the tickets off the screen.

And, on the till side: `KitchenPrinting` still returns a description of what
happened rather than throwing. A kitchen screen that is switched off must never
be able to stop a sale.

---

## 9. Layout

```
vesopa_epos_kitchen/
├── docs/
│   ├── architecture.md              this file
│   ├── original-brief.md            what was asked for, unedited
│   └── reference-kitchen-demo.md    notes from the competitor recording
└── lib/
    ├── config/constants.dart        server endpoints, brand, defaults
    ├── data/
    │   ├── kitchen_api.dart         REST client
    │   ├── kitchen_session.dart     sign-in, token, this device's identity
    │   ├── live_link.dart           socket, reconnection, poll backstop
    │   ├── screen_profile.dart      which stations this board watches
    │   ├── ticket.dart              the models
    │   └── ticket_board.dart        board state, bump/recall, offline queue
    ├── printing/kitchen_print.dart  a ticket on paper, from the screen
    └── ui/
        ├── theme.dart               the palette, shared with the till
        ├── sign_in_page.dart
        ├── kitchen_shell.dart       header, tabs, drawer
        ├── open_board.dart
        ├── counts_board.dart
        ├── completed_board.dart
        ├── ticket_detail_sheet.dart
        ├── settings_page.dart
        ├── info_page.dart
        └── widgets/
            ├── ticket_card.dart
            └── on_screen_keyboard.dart
```

## 10. What changed elsewhere

| Repository | Change |
| --- | --- |
| `vesopa_server` | `schema_kitchen.sql` (the kitchen's own tables), `schema_till_kitchen.sql` (the six delivery modes on the till-settings row), `src/kitchen.js`, three routers mounted in `server.js` |
| `vesopa_server` | `broadcast()` gained office scoping, and the socket a `subscribe` frame — a kitchen ticket names what a venue is cooking and must not reach another venue's wall |
| `vesopa_server` | **`requireAuth` now refuses *any* scoped token**, not just `terminal` — see below |
| `vesopa_server` | `schema_printer_names.sql` renamed to `schema_till_printer_names.sql` — see below |
| `vesopa_server` | `test/kitchen.test.js` (`npm test`, no database), `test/kitchen.integration.js` (end to end against MySQL), `test/capture-fixtures.js` |
| `vesopa_epos_kitchen` | `test/board_test.dart`, run against JSON captured from the real server |
| `vesopa_server/public` | Back office: **Kitchen screens** — logins, screens, per-station delivery, and a live board |
| `vesopa_epos` | `data/kitchen_screens.dart`; `KitchenPrinting` splits a fire between paper and screens; `TillSettings` carries the modes; `SyncService` re-sends queued tickets on reconnect; Settings › Printing gains a Kitchen screens card |

### The auth fix

`requireAuth` used to name the credential it refused:

```js
if (claims.scope === 'terminal') return res.status(401)…
```

A session token carries no `scope`; every credential issued to a *device* does.
Naming them one at a time was a bug waiting for the next one to be added, and
adding `scope: 'kitchen'` duly triggered it — a kitchen token passed
`requireAuth` and opened the whole back office to a shared login on a wall in a
room full of people. It now refuses anything scoped at all, so the next device
credential is safe the day it is minted.

Found by `test/kitchen.test.js` on its first run, which is the entire argument
for that file existing.

### The migration rename

`deploy.sh` applies these files in `sort` order. `schema_printer_names.sql`
alters `epos_till_settings`, which `schema_staff_idle.sql` creates — and `p`
sorts before `s`, so on a **fresh** database every one of its `ADD COLUMN` calls
failed with "table doesn't exist" and the venue silently had no printer names at
all. It was invisible because an existing server already had the columns, so the
errors read as "already applied".

It stopped being merely untidy when the kitchen screens arrived: `stationNames()`
selects those columns to label a station, so a missing one took the whole board
down rather than falling back to "KP 3". Renamed to `schema_till_printer_names.sql`,
matching the three other migrations that extend the same row. The migration is
idempotent and `deploy.sh` rsyncs with `--delete`, so the rename is a no-op on a
server that already has the columns.

Found by applying every migration to an empty database, which is the only way
this class of bug ever shows up.

---

## 11. Running the tests

```bash
# Server, no database needed — who may call what, and what gets written.
cd vesopa_server && npm test

# The kitchen screen's models, against JSON captured from the real server.
cd vesopa_epos_kitchen && flutter test
```

End to end against a real MySQL, which is what catches collations, the board
query's `GROUP BY` under `ONLY_FULL_GROUP_BY`, and the retention sweep:

```bash
mysql -u root -e "CREATE DATABASE vesopa_kds_test
                  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
mysql -u root vesopa_kds_test < vesopa_server/backup/Backup_v1.0.0.sql
cd vesopa_server
for f in schema.sql $(ls schema_*.sql | sort); do mysql -u root vesopa_kds_test < "$f"; done

KDS_DB_USER=… KDS_DB_PASSWORD=… node test/kitchen.integration.js
```

It refuses to run against a database whose name does not contain "test", creates
two offices of its own, and deletes them on the way in and the way out.

`node test/capture-fixtures.js` re-captures the Flutter fixtures from the same
database. Re-run it when the board's JSON shape changes — `board_test.dart` will
then fail loudly if the two halves have drifted, which is the point of it.
