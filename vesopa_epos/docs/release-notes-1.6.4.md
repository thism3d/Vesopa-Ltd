# Vesopa EPOS 1.6.4 — release notes

Store submission: `msix_version: 1.6.4.0` (previous build here was 1.6.3.0).
Flutter `version: 1.6.4+25`.

**Vesopa Customer Display goes to 1.6.4.0 with it**, and this time they really
do ship together: the child lock is a setting the till writes and the display
reads, so a 1.6.4 till talking to a 1.6.3 screen can turn the lock on and
nothing will happen. Flutter `version: 1.6.4+5`.

**Vesopa Kitchen does not move.** Nothing in it changed. It stays on 1.5.0.0.

**Minor, not patch.** Dine-in is a new way for money to arrive at a venue.

**Server: schema changes.** `schema_menu_dinein.sql` adds the dine-in tables
and gives every existing table a public address. Guarded and safe to re-run —
verified by applying it three times in a row to a clean database. **Already
applied to the live server**, along with the DNS, SSL and nginx work below.

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

### The address

**`menu.vesopaepos.com/your-venue`** — the venue's own name at the root of the
path, because that host serves nothing but menus and there is nothing else there
for a venue name to collide with. Each table's own code is
`menu.vesopaepos.com/t/<code>`.

Its own host, on purpose. A printed card is the longest-lived thing this system
produces — it is screwed to a table and read by somebody holding a phone in a
dark room — so it wants the shortest address that can still be typed by hand
when the camera will not focus, and it wants to sit somewhere the marketing site
cannot be reorganised out from under it.

The Vesopa Kitchen is live at
**https://menu.vesopaepos.com/vesopakitchen**

### Setting it up (back office → Dine-in & QR)

Four pages, in the order they are done, because each is useless without the one
above it.

1. **Your menu page.** Choose the web address. Availability is checked as you
   type — against every other venue on the platform and against the handful of
   words the host keeps for itself — and what you type is tidied into something
   that can live in a URL before it is saved, so a venue typing "The Vesopa
   Kitchen" gets `vesopakitchen` rather than a rejection. Then the name, the
   strapline, the phone number, the map link, a logo and a banner. Two switches
   control everything: *Menu is live* makes it readable, *Taking orders* lets a
   customer send one to the till. They are separate because a venue usually
   wants its menu readable weeks before it is ready to have tickets arriving.
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
3. **Table codes.** Every table has its own permanent web address, and a card
   designer to print them from — see below.
4. **Online orders.** Everything that has come in over the last 24 hours and
   what the till did with it.

### What a customer sees

The venue's own photograph across the full width of the screen with the venue's
name on it, fading and drifting away as they scroll so that it hands the page
over to the food rather than being scrolled past. Section tabs that scroll
sideways and follow the page down. Dish photographs, descriptions, and the price
sitting with the button that orders it. A basket that does not exist until
something is in it.

The page carries the venue's name, its own words, its accent colour and its
banner into the browser tab, the search result and the share card — so a venue
pasting their own link into a WhatsApp group gets their venue, not a grey
rectangle with "Menu" written on it. **The venue's name leads and Vesopa
follows**, in that order, everywhere the two appear together. A venue that has
uploaded nothing still gets a page with its own name on it, with the Vesopa mark
standing in for the logo it has not sent yet.

### At the till

**Orders announce themselves.** A notification slides in from the side of the
screen carrying what was ordered, from which table, how long they have waited,
any note they left, and the two buttons that answer it. They stack — a Friday
brings three at once — and past three the rest collapse into one line that
opens the full list. They do not time out: a notification about an email can
afford to disappear on its own, and one about food somebody is waiting for
cannot. One that has been waiting five minutes turns red.

- **Accept** rings the lines onto that table's bill exactly as if a clerk had
  keyed them. If there is already a bill on the table it goes onto that one.
- **Cannot take it** asks why in one tap — the kitchen has closed, run out, too
  busy, order at the bar — or type your own on the on-screen keyboard, because
  the reason is going to somebody's phone and "no" on its own is worse than
  nothing. That sentence is what they read.
- **Ready** and **Served** move it along, and the customer's phone follows.

**A sound when one arrives**, using the alert Windows already uses for
everything else, so its volume is whatever the venue set years ago. Once per
order, and never on the first read after a restart — a till started at nine
with four orders waiting should not open with four chimes, none of which just
happened.

**Where alerts appear is chosen per terminal**, under Settings → Orders from
tables: notifications, a count on the bar, both, or nothing at all. A till
facing customers all evening and a till by the pass want different answers, and
they are different machines.

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

## The table card designer

Height, width and position in numbered boxes is not how anybody lays out a card.

Lay it out on the canvas instead: drag a thing to move it, pull its corner to
resize it, and edit whatever is selected in the panel beside it. Layers, with
bring-forward and send-back, because a card is a background with things on top
of it. Undo. Four themes so that a new card is never a blank page, a library of
pictures to start from, your own uploads, fonts, colours and panels.

Positions are held as percentages of the page rather than in millimetres, so one
layout prints correctly on an A4 sheet, an A5 card, a table tent and a 60mm
sticker. Print one table or the whole set; the print dialog will save it as a
PDF if that is what the printers want.

The code itself is pinned square whatever is done to it, because a QR code that
has been dragged into a rectangle does not scan.

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

## Fixes the venue reported

**Two doubled backgrounds on the till's bar.** Both real, and both the same
fault — two surfaces painted where one was meant.

- **The page selector at the left** sat on the till's chrome colour while the
  venue's programmed bar painted its own canvas across everything beside it, so
  the left of the bar was a visibly lighter rectangle that stopped dead where
  the keys began. The bar is now one surface, and the selector is styled as one
  of its keys.
- **The clock key and the two badges** each paint their own rounded surface, and
  the bar was drawing its own slab behind all three. The clock key now fills its
  cell, so it lines up with Sign On beside it.

**Buttons on the bar were different heights.** The page selector sized itself to
its own text, so on a venue's own bar it was a 42px pill standing beside 58px
keys. Every key on the bar is now the height of the bar.

**A key with no colour on it was invisible.** An uncoloured widget key fell back
to a fill four values away from the canvas it sat on, so a section-name key a
venue had not coloured drew as a word floating in a gap rather than as a button.

**"Customer display connected" was unreadable in Night.** A pale green card
carrying the theme's own ink is near-white on near-white. The card was there and
every word in it was not. Both the card and its text now come from the theme, so
they move together.

**Settings contradicted itself for two seconds.** The status card was read on
load and the paired list only on a timer, so the page opened saying "connected ·
1 screen attached" at the top and "no customer display is asking to be
connected" underneath it.

---

## Microsoft Store — "What's new in this version"

Paste into Partner Center → Store listings → What's new in this version.
**The field holds 1500 characters**; this is 1491, and it is worth counting again
after any edit because Partner Center truncates rather than complains.

(`tool/check-store-listing.py` checks `store-listing.md`, not this block — it
looks for `<!-- FIELD -->` markers and silently passes a file without them.)

```
Version 1.6.4.0 - Order From The Table

QR Menus And Dine-In: Print a code for every table. A customer scans it, reads your menu on their own phone and sends an order straight to the till - no app, no account. Accept it and it rings onto that table's bill like any other sale, prints in the kitchen. Refuse it in one tap and their phone says why.

Orders That Announce Themselves: A notification slides in with the table, the order and the two buttons that answer it. They stack, they chime, and they stay until you deal with them. Refusing asks why, with preset reasons and an on-screen keyboard. Set per till whether you want notifications, a count on the bar, both or neither.

Build Your Own Menu Page: Your own web address, checked as you type, with your logo, banner, phone number and map link. Choose which products appear and in which sections. Prices always come from your catalogue, so there is never a second list.

Design And Print Your Table Cards: Drag things around a canvas, pick a theme, add your own pictures and text, and print the set. A table's code never changes, even when you rename or renumber it.

Rooms That Are Not Boxes: The floor designer now draws L-shaped, T-shaped and U-shaped rooms as well as rectangles.

Lock The Customer Screen: Turn the customer display's controls off from the till, so a counter with children at it stays showing the bill.

Tidier Till Bar: Every key is now the same height, and the menu and clock keys no longer draw two backgrounds.
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

- **35 dine-in checks against a real MariaDB**, not a mock. The things that can
  actually go wrong here are joins, transactions and races, and a recording pool
  cannot have an opinion about any of them. `test/dinein.test.js` stands up the
  schema, seeds two venues and drives the real routers: that a price is read
  from the catalogue rather than believed from the phone, that one venue cannot
  see another's tables or orders, that accepting twice does not make two kitchen
  tickets, that a table keeps its printed address across a rename, that the
  table number follows the table rather than the order, and that the till's
  credential and a back office session are not interchangeable.
- **11 checks drive the card designer in a real browser** against the live
  panel: drag, resize, undo, layers, themes, add, delete, and that the code
  stays square so that it still scans. A canvas editor is exactly the kind of
  thing that passes every unit test and does nothing at all when a hand is on
  it.
- **The whole back office suite is green**, exit 0.
- **The till and display suites pass**, with the exceptions stated plainly
  below.
- **The whole path was walked on the live system more than once**: a card
  printed with its address on it, scanned with a phone, ordered from, picked up
  by the till, accepted onto the table's bill, and followed on the customer's
  own page as far as "accepted".

### Bugs found before the venue could find them

- **No commissioned till could have reached the dine-in routes.** They were
  behind `requireAuth`, which deliberately refuses a terminal token — the two
  credentials are not interchangeable on purpose. The test was signing in as a
  manager, so it passed against routes a real till would have been refused by.
  It now uses the credential a till actually carries, plus two checks that the
  two cannot be swapped.
- **Then the same class of thing again**: those routes were mounted under `/api`
  when every other till route is at the root. Found by running the till, not by
  the suite, because the test mounted the router the way that made the test
  pass. Both facts are pinned by a check now.
- **The table backfill produced guessable codes.** MySQL's `UUID()` is version
  1: a timestamp and the server's MAC address. Four tables filled in together
  came out sharing a suffix and differing in one byte, so anybody holding one
  printed card could have read off the codes of the tables either side of them
  and ordered onto either. It now uses `RANDOM_BYTES` where the server has it,
  which the live server does, and falls back to a hash on anything older.
- **The notification badge would have been invisible to every existing venue.**
  It was drawn only in the till's built-in bar, which a venue's own programmed
  bar replaces entirely — so every venue that had ever laid out a bar would
  have upgraded, turned ordering on, and seen absolutely nothing when an order
  arrived. It is drawn on every bar now, unless the venue has placed the key
  itself.

### Known, and not fixed here

- `programmed_grid_golden_test` fails by 0.43%. It was failing before any of
  this work — verified by reverting the one line this release touches in that
  file and watching it fail identically — and it is left alone rather than
  regenerated, because regenerating a golden is how you hide whatever moved it.
- Two Dojo *live* tests fail without network credentials, as they always have.
- The till suite is flaky under load on an 8GB machine: a different handful of
  widget tests report "did not complete" on each full run, and every one of them
  passes when run on its own. It is the machine, not the code.
- **There is no server-side PDF and no saved library of printed cards.**
  Printing goes through the browser's own print dialog, which will save a PDF,
  and a design is saved as JSON against the venue so that it can be reopened and
  reprinted. A rendered-on-the-server PDF archive is not built, and is not
  claimed.

### Serving it from menu.vesopaepos.com

The pages live in the back office application and are served from
**menu.vesopaepos.com**, which proxies to the same Node process on port 5060.
`PUBLIC_BASE_URL=https://menu.vesopaepos.com` in the back office `.env` is what
makes every generated link and every printed card agree with each other.

Only the public paths answer on that host — the venue page, a table's page, an
order's page, and `/api/public/dinein/`. The signed-in back office API, the
login route, the dashboard and the till's own endpoints are all 404 there, and
that was checked by asking for each of them rather than by reading the config.

The nginx for it is in `vesopa_server/deploy/`, with a README explaining why it
lives in HestiaCP's per-domain custom slot rather than in `nodejs-app.conf` —
the panel rewrites that file whenever the Node app is reconfigured, and rules
kept there would take every printed code in the venue down with them.

### One thing to watch on a fresh install

`schema_menu_dinein.sql` is named to sort **after** `schema_layout.sql`, which
creates the tables it alters. Named `schema_dinein.sql` it sorted between
`schema_devices` and `schema_dojo` — before those tables existed on a fresh
install — and the deploy loop swallows a failure with "(skipped: already applied
or not needed)", so the columns would simply never have appeared and nothing
would have said so. Do not rename it.
