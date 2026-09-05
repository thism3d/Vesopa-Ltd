# Vesopa EPOS 1.6.4 — release notes

Store submission: `msix_version: 1.6.4.0` (previous build here was 1.6.3.0).
Flutter `version: 1.6.4+25`.

**Vesopa Customer Display goes to 1.6.4.0 with it**, and this time they really
do ship together: the child lock is a setting the till writes and the display
reads, so a 1.6.4 till talking to a 1.6.3 screen can turn the lock on and
nothing will happen. Flutter `version: 1.6.4+5`.

**Vesopa Kitchen does not move.** Nothing in it changed. It stays on 1.5.0.0.

**Minor, not patch.** Dine-in is a new way for money to arrive at a venue.

**Server: schema changes.** `deploy.sh --schema` is required.
`schema_menu_dinein.sql` adds the dine-in tables and gives every existing table
a public address. It is guarded and safe to re-run — verified by applying it
three times in a row to a clean database.

---

## Dine-in: a menu on the table

A customer sits down, points their phone at the code on the table, reads the
menu, and orders. The till is told over the connection it already holds open, a
clerk presses Accept, and from that moment it is an ordinary sale against that
table — it prints in the kitchen, it shows on the customer display, it counts
towards the day, and it is settled at the counter like everything else.

There is no app to install and no account to make. A name and a phone number are
one optional line at the end.

**No payment is taken, by design.** Taking money for food nobody has accepted is
the one way this could cost a venue rather than cost them a plate. The room for
it is left in the design and nothing collects.

### Setting it up (back office → Dine-in & QR)

Four pages, in the order they are done, because each is useless without the one
above it.

1. **Your menu page.** Choose the web address — the menu answers at
   `vesopaepos.com/m/your-venue`, and each table's own code at
   `vesopaepos.com/t/<code>` — then fill in the name, the strapline, the phone
   number, the map link, a logo and a banner. Two switches control everything: *Menu is live* makes it
   readable, *Taking orders* lets a customer send one to the till. They are
   separate because a venue usually wants its menu readable weeks before it is
   ready to have tickets arriving.
2. **Menu.** Sections — Starters, Mains, Drinks — and the products in each,
   picked off the catalogue several at a time. This is deliberately not the
   whole catalogue: bar tabs, deposits, corkage and a PLU called MISC all live
   in there, and a customer's phone is the one place none of them belong. Give
   each dish the wording and the picture it deserves rather than the twelve
   characters that fit on a till key. **Prices are never copied** — they are
   read from the catalogue every time the menu is opened, so there is never a
   second price list to keep in step.
   Tick a dish off with one tap when the kitchen runs out; tick it back in the
   morning.
3. **Table codes.** Every table has its own permanent web address. Lay the card
   out once — page size, background, the code, the venue name, the table name,
   your own text and pictures — and print the set. Positions are held as
   percentages, so the same design prints correctly on an A4 sheet and on a
   60mm sticker.
4. **Online orders.** Everything that has come in over the last 24 hours and
   what the till did with it.

### At the till

A badge appears on the bar the moment an order arrives, and draws nothing at all
when there is nothing waiting. Press it (or Functions → Table Orders) for the
list: what was ordered, which table, how long they have been waiting, and any
note they left.

- **Accept** rings the lines onto that table's bill exactly as if a clerk had
  keyed them. If there is already a bill on the table it goes onto that one.
- **Cannot take it** asks why in one tap — kitchen closed, run out, too busy,
  order at the bar — and the customer's phone says so.
- **Ready** and **Served** move it along, and the customer's phone follows.

Orders arrive two ways on purpose: instantly over the live connection, and by a
check every thirty seconds regardless. A till that was offline when an order was
placed still picks it up.

### The rule that makes printed cards safe

**Names change and ids do not.** A table's printed code is 32 random characters
minted once and never derived from its number. Rename table 5 to "Window",
renumber it to 12, move it to another room — the card already screwed to it
keeps working, and orders placed on it stay attached to it.

A table's name must be unique across the whole venue, not merely within its
room. Two tables answering to "Window" in one building is a plate going to the
wrong people.

---

## Rooms that are not boxes

The floor designer would only draw rectangles. An L wrapping a corner is the
commonest floor plan in the trade, and a venue forced to draw it as a rectangle
either lost the corner or gained a quarter of the room that is actually the
kitchen.

**Table Designer → Room shape** now offers L (either way round), T and U as
well, sized by the room and by the cut, with a live preview. Anything genuinely
odd — a bay window, a curved bar — can be given its corners directly.

Tables also gained a **customer-facing name**, which is what appears on the
phone that scans them.

---

## Locking the customer screen

A customer display sits at hand height on a counter, and the people nearest it
are queueing children, somebody leaning on it while they find their card, and a
cloth at the end of the night. Any of those brought its controls up.

**Lock it from the till** — a switch in Settings → Customer display, or a key a
venue can put on a bar or on the sale grid. Locked, the screen carries on
showing the bill and the adverts and simply ignores being touched. The till
shows what the screen reports rather than what it was last told, so a manager
who pressed the switch and walked off can come back and see that it took.

It is set from the till and only from the till. A lock the locked screen can
undo is not a lock.

---

## The customer display

- **The controls moved to the top right, the connection to the bottom.** One tap
  anywhere brings both bars up together and they leave on their own after the
  chosen delay. Volume is on the top bar, where it is reachable without walking
  into a settings page — it is the one thing on that screen anybody changes
  twice a day.
- **"The till is not running" is gone.** It was reported by a screen that was at
  that moment drawing that till's bill, and it appeared during every quiet spell
  in a working service. The bar reports the pairing, which is the honest answer
  to what a screen is connected to. Connected means connected.
- **The settings header is visible.** It was there all along and painted in
  exactly the same colour as the page behind it, so the title and the way back
  were invisible. It now has its own colour, a line under it, and a Back button
  with the word on it.
- **Five settings are saved that never were.** Advert volume, which side the
  bill sits on, how much of the screen it takes, whether pictures fill the
  screen, and the standing message were all applied for the session and gone by
  morning.
- Each connected screen now reports the size it is actually running at, so a
  venue with two can tell them apart from behind the till.

---

## Two doubled backgrounds on the till's bar

Both reported by the venue, both real, and both the same fault — two surfaces
painted where one was meant.

- **The page selector at the left** sat on the till's chrome colour while the
  venue's programmed bar painted its own canvas across everything beside it, so
  the left of the bar was a visibly lighter rectangle that stopped dead where
  the keys began. The bar is now one surface, and the selector is styled as one
  of its keys.
- **The clock key and the two badges** each paint their own rounded surface, and
  the bar was drawing its own slab behind all three. The clock key now fills its
  cell, so it lines up with Sign On beside it.

---

## Microsoft Store — "What's new in this version"

Paste into Partner Center → Store listings → What's new in this version.
Re-check the length with
`python tool/check-store-listing.py vesopa_epos/docs/store-listing.md`.

```
Version 1.6.4.0 - Order From The Table

QR Menus And Dine-In: Print a code for every table. A customer scans it, reads your menu on their own phone and sends an order straight to the till - no app to install and no account to make. Accept it and it rings onto that table's bill like any other sale, prints in the kitchen and settles at the counter. Refuse it in one tap and their phone says why. Mark it Ready and Served and they can follow it.

Build Your Own Menu Page: Give your venue its own web address, add your logo, banner, phone number and map link, and choose which products appear, in which sections, with the wording and pictures a phone deserves. Prices always come from your catalogue, so there is never a second list to keep up to date. Tick a dish off when the kitchen runs out.

Design And Print Your Table Cards: Lay the card out once - page size, background, the code, the table name, your own text and pictures - and print the set. A table's code never changes, even when you rename or renumber it.

Rooms That Are Not Boxes: The floor designer now draws L-shaped, T-shaped and U-shaped rooms as well as rectangles, with a live preview.

Lock The Customer Screen: Turn the customer display's controls off from the till, so a counter with children at it stays showing the bill. One switch, or a key you can put on your own bar.

A Clearer Customer Display: Controls in the top corner and the connection along the bottom, both hidden until the screen is tapped. It no longer reports a working till as missing.

Tidier Till Bar: The menu key and the clock key no longer draw two backgrounds.
```

The Customer Display's own block is in
`vesopa_epos_display/docs/release-notes-1.6.4.md`.

---

## Store submission

| | Vesopa EPOS | Vesopa Customer Display |
| --- | --- | --- |
| `version:` | 1.6.4+25 | 1.6.4+5 |
| `msix_version:` | 1.6.4.0 | 1.6.4.0 |
| Identity | `MeirionDavies.Vesopa` | `MeirionDavies.VesopaDisplay` |
| Package | `build\store\vesopa-epos-store.msix` | `build\store\vesopa-display-store.msix` |

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it.

Build both with `powershell tool/build-store-msix.ps1` in each project. Verify
by reading `AppxManifest.xml` out of the .msix rather than trusting the
filename, which never carries the version.

---

## What was tested

- **34 dine-in checks against a real MariaDB**, not a mock. The things that can
  actually go wrong here are joins, transactions and races, and a recording pool
  cannot have an opinion about any of them. `test/dinein.test.js` stands up the
  schema, seeds two venues and drives the real routers: that a price is read
  from the catalogue rather than believed from the phone, that one venue cannot
  see another's tables or orders, that accepting twice does not make two kitchen
  tickets, that a table keeps its printed address across a rename, and that the
  table number follows the table rather than the order.
- **The whole back office suite is green.**
- **The till and display suites pass**, with two exceptions stated plainly
  below.

### Two bugs the tests found before the venue did

- **No commissioned till could have reached the dine-in routes.** They were
  behind `requireAuth`, which deliberately refuses a terminal token — the two
  credentials are not interchangeable on purpose. The test was signing in as a
  manager, so it passed against routes a real till would have been refused by.
  It now uses the credential a till actually carries, plus two checks that the
  two cannot be swapped.
- **The table backfill produced guessable codes.** MySQL's `UUID()` is version
  1: a timestamp and the server's MAC address. Four tables filled in together
  came out sharing a suffix and differing in one byte, so anybody holding one
  printed card could have read off the codes of the tables either side of them
  and ordered onto either. It now uses `RANDOM_BYTES` where the server has it,
  which the live server does, and falls back to a hash on anything older.

### Known, and not fixed here

- `programmed_grid_golden_test` fails by 0.43%. It was failing before any of
  this work — verified by reverting the one line this release touches in that
  file and watching it fail identically — and it is left alone rather than
  regenerated, because regenerating a golden is how you hide whatever moved it.
- The till suite is flaky under load on an 8GB machine: a different handful of
  widget tests report "did not complete" on each full run, and every one of them
  passes when run on its own. It is the machine, not the code.

### Serving it from the apex domain

The pages are in the back office application but are served from
**vesopaepos.com**, because that is what goes on a printed card. Four paths
cross from the marketing site's vhost — `/t/`, `/m/`, `/o/` and
`/api/public/dinein/` — and nothing else does; the signed-in back office API is
not reachable there. `PUBLIC_BASE_URL=https://vesopaepos.com` in the back
office `.env` is what makes every generated link and printed card agree.

The nginx for it is in `vesopa_server/deploy/`, with a README explaining why it
lives in HestiaCP's per-domain custom slot rather than in `nodejs-app.conf` —
the panel rewrites that file, and rules kept there would take every printed code
in the venue down with them.

### One thing to watch on a fresh install

`schema_menu_dinein.sql` is named to sort **after** `schema_layout.sql`, which
creates the tables it alters. Named `schema_dinein.sql` it sorted between
`schema_devices` and `schema_dojo` — before those tables existed on a fresh
install — and the deploy loop swallows a failure with "(skipped: already applied
or not needed)", so the columns would simply never have appeared and nothing
would have said so. Do not rename it.
