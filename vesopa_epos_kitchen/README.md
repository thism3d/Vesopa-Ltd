# Vesopa Kitchen

A Windows touch-screen application that hangs in a kitchen and shows what has
been ordered. It replaces — or sits alongside — the thermal printer a station
would otherwise be routed to.

```
 ☰            [ 3 Open ] [ Counts ] [ 35 Completed ]            🖨  ⚙  💬  ⏻
┌────────────────────────────┐ ┌────────────────────────────┐
│ Table #4      Order 60292:4│ │ Table #3      Order 60287:4│
│ Lounge               sophie│ │ Lounge                steff│
│ 19:38        Elapsed: 00:41│ │ 13:45        Elapsed: 06:52│
├────────────────────────────┤ ├────────────────────────────┤
│  1  The Front Row          │ │  1  Crispy Chicken Burger  │
│     Extra Sausage          │ │     no tomato, no garlic   │
│     No Toast               │ │  1  Kids Breakfast         │
├────────────────────────────┤ ├────────────────────────────┤
│   Details    │    ✓ Done   │ │   Details    │    ✓ Done   │
└────────────────────────────┘ └────────────────────────────┘
```

## The one idea

The till already decides, per product, which **stations** (`KP 1`…`KP 6`) a line
belongs to. That routing is set in the back office and it does not change. All
this adds is a second **delivery mode** for it:

| Mode | What happens when a line routed to KP 3 fires |
| --- | --- |
| `printer` | A ticket prints at KP 3. **The default, and what every venue does today.** |
| `screen` | It appears on every kitchen screen watching KP 3. No paper. |
| `both` | Both. |

A venue that upgrades and never opens the kitchen app prints exactly as it did
yesterday.

## Getting a venue running

1. **Back office → Kitchen screens.**
   - Create a **kitchen login** (a short username and a password — this gets
     typed on glass with a finger, so keep it short).
   - Optionally define **screens**: named boards, each watching some stations.
     A kitchen with one screen needs none of this.
   - Set the **delivery** for each station to Screen or Both.
2. **On the kitchen machine**, run the app and sign in with the venue's office
   email and the kitchen login. Pick which screen this machine is.
3. **Ring something up** on a till. It appears on the board.

Delivery can also be set from a till, under **Settings › Printing › Kitchen
screens** — which is usually where the person plugging the screen in is
standing.

## Running it

```bash
flutter pub get
flutter run -d windows                                   # against the live server
flutter run -d windows --dart-define=USE_LIVE_SERVER=false   # against localhost:5060
flutter build windows --release
```

`--dart-define=API_HOST=192.168.1.42` points a machine on the LAN at a dev
server; `API_BASE` and `WS_URL` override the pair completely, for staging.

The app runs full screen with the close and minimise buttons disabled — a
kitchen screen that gets minimised keeps *looking* like a working computer, and
the orders behind it are only discovered when a customer asks where their food
is. The way out is **Sign out**, which asks first.

## The screens

| Tab | What it is for |
| --- | --- |
| **Open** | The board. Oldest first; anything rushed first of all. |
| **Counts** | Everything outstanding, added up by item — *7 × Crispy Chicken Burger*. Prep rather than orders, and the one view a printer can never give you. |
| **Completed** | The recall window. Green cards, newest first, each with **Recall Order**. |

On a card: **Details** opens the whole ticket, including the lines that went to
other stations. **Done** bumps it. A **long press on the header** rushes an
order to the front of the board.

Off the header: **print** the board (for when the screen has to be abandoned
mid-service), **settings** for this machine, **info** for support, **sign out**.

## Ageing

| Age | Header |
| --- | --- |
| Fresh | Slate |
| Past the warn threshold (8 min) | Amber |
| Past the late threshold (15 min) | Red, pulsing |
| Completed | Green |
| Rushed | Indigo, sorted to the front |

Both thresholds are per screen, set in the back office.

## When the network goes

It will, so:

- The last board is cached and re-drawn on launch — a screen that boots offline
  shows what it knew, not a spinner.
- A persistent bar says so. Not a toast: a toast that a chef missed is worse
  than no warning at all.
- Bumps made offline are applied immediately and re-sent when the link returns.
  Every action is idempotent, so a double-send costs nothing.
- On the till side, a ticket that cannot be delivered is queued for ten minutes
  and then dropped. A kitchen ticket delivered forty minutes late is worse than
  one never delivered, because somebody will cook it.

## Tests

```bash
cd vesopa_epos_kitchen && flutter test   # the board, against real server JSON
cd vesopa_server       && npm test       # the routes, no database needed
```

The Flutter fixtures in `test/fixtures/` are captured from a running server by
`vesopa_server/test/capture-fixtures.js`, not hand-written — the seam between the
server's JSON and these models is the one most likely to be wrong, and a
hand-written fixture would agree with whatever the models already did.

There is an end-to-end suite against a real MySQL too; see
`docs/architecture.md` §11.

## Where things are

| | |
| --- | --- |
| `docs/architecture.md` | **Start here.** Why a ticket is one row per fire, how bumping works across stations, what is authorised how. |
| `docs/reference-kitchen-demo.md` | Notes from the competitor recording the brief points at. |
| `docs/original-brief.md` | What was asked for, unedited. |
| `docs/microsoft-store.md` | The Store identity, how to build the MSIX, and the pre-submission checklist. |
| `lib/data/` | Models, the API client, the socket, the board. |
| `lib/ui/` | The board, the tabs, the chrome, the on-screen keyboard. |

Server side: `vesopa_server/src/kitchen.js`, `schema_kitchen.sql` and
`schema_till_kitchen.sql`. Till side: `vesopa_epos/lib/data/kitchen_screens.dart`
and `kitchen_printing.dart`.

The reference recording (`VesopaKitchenDemo.MP4`) is deliberately not committed
— eleven megabytes of shaky phone footage in every clone is a poor way to carry
a handful of design decisions. `docs/reference-kitchen-demo.md` is what it says.
