# Vesopa EPOS 1.6.5 — release notes

Store submission: `msix_version: 1.6.5.0` (previous build here was 1.6.4.0).
Flutter `version: 1.6.5+26`.

**Vesopa Customer Display does not move.** Nothing in it changed. It stays on
1.6.4.0.

**Vesopa Kitchen does not move.** It stays on 1.5.0.0.

**Patch, not minor.** Nothing here is a new way for money to arrive. It is the
floor plan becoming something a venue can draw and arrange for itself, on the
device that is already standing in the room.

**Server: one schema change, already applied.** `schema_floor_designer.sql` adds
three nullable colour columns. Guarded by `vesopa_add_column` and verified by
applying it three times in a row against the live database. Null means "the
theme's own colour", so a venue that never opens a colour picker sees exactly
what it saw before.

---

## Lay out the room from the till

Arranging a dining room in a browser means doing it on a laptop in an office,
from memory, about a room you are not standing in. Everybody who has done it has
then walked out to the floor and found the plan wrong — the two-top by the
window is on the wrong side, the booth is a table further along.

The till is already standing in the room. **Tables → the map icon in the top
right** opens the same editor the back office has.

### The furniture

A room is not made of "tables". It is two-tops along the window, four-tops in
the middle, a long six for the party, a couple of stools at the bar. So there is
a strip of nine presets — Two, Round 2, Four, Round 4, Six, Round 6, Eight,
Booth, Stool — each drawn in the proportions of the real thing, so a six reads
as long and a round four reads as round before the word underneath it is read at
all.

Tap one and it lands in the middle of the plan; drag it where it belongs.

Adding a table saves immediately, because the code printed on the card that sits
on it is minted by the server and there is nothing sensible to hold locally.
Moving is held until **Save layout**, because a manager rearranging a room
touches a dozen tables and a write per drag would be a dozen chances for half of
them to land.

### Drawing the room

Real rooms are not boxes. An L wrapping a corner is the commonest floor in the
trade and a bar cutting across the front is the second.

**Draw the room** turns the plan into something you walk round: tap each corner,
and tap the first one again to close it. Once three corners are down, the first
one grows into a target and the wall back to it is drawn dashed, so the shape
you are about to get is the shape on the screen. **Undo corner** takes the last
one back; **Cancel** leaves the room as it was; **Done** with nothing drawn puts
the room back to a plain rectangle, which is the only way back from a shape
somebody drew wrongly.

What it writes is the same list of corners the back office writes, so a room
drawn on a till can be adjusted in the office tomorrow and the other way round.

### Who can do it

The editor is behind the **manager** key that already exists, and behind the
terminal being commissioned. A till that has not been signed in is told so
rather than being offered an editor that will fail at the moment somebody
presses Save.

It is deliberately a separate screen and not a mode the Tables page slips into.
A clerk crossing that page at eight on a Friday is parking bills and recalling
them, and a plan that a stray finger could rearrange is a plan that will be
rearranged by one.

### What a till can and cannot reach

The three new endpoints take the venue from inside the terminal's own signed
token and never from anything sent with the request, and every row they touch is
matched on the office as well as on the id. A till can only ever rearrange its
own venue's floor. Both of those were checked by removing them and watching the
tests fail, and again against the live server: another venue's room refuses with
404, and a table cannot be added into another venue's room.

---

## The room a venue drew now appears everywhere

Until this release the shape was drawn in exactly one place — the back office
designer — and nowhere else.

* **The till** draws it, under the tables, in the venue's own floor and wall
  colours if it has chosen any.
* **The customer's table picker** draws it too, so a diner choosing where they
  are sitting sees the room rather than a grey box with tables floating in it.

### The bug behind this

The till had been taught to draw walls in 1.6.4's development, and could never
have drawn them: `/till/floor` selects a hand-written column list, and that list
had never been told about `outline`. A venue that drew an L saw it in the
designer and on a customer's phone, and every till in the building went on
showing a rectangle.

Nothing complained, because nothing was watching. There is now a test on that
column list specifically, since a column added in one file and forgotten in
another is exactly how this happened.

---

## Colours

Three nullable columns, and all three mean "use the theme's own" when unset:

* the room's **floor** and **walls**, set in the back office under
  Table Designer → Size & colours;
* a **table's own colour**, for the ones worth picking out — the window seats,
  the booths.

On the till a table wears its colour **only while it is free**. The moment a
bill is open on it, it goes back to the brand lime whatever the venue painted
it. That colour is the till's single most important signal, read across a room
at a glance while carrying something, and a venue that painted its window seats
a similar green would have quietly turned it off. The custom colour says which
table this is; the lime says what is happening on it, and the second must never
be lost to the first.

Text on a table already takes its contrast from the tile colour, so a pale
custom colour gets dark ink without anything further being set.

---

## How this was tested

**Unit and widget:** 14 new checks on the till's floor code and the editor's
repository, plus 15 on the room shape surviving the wire, the cache and the
painter. The two that matter most were proved to bite by reintroducing the
bug — dropping the JSON-text branch fails the parsing tests, and a painter that
fills its bounding box instead of the polygon fails "the notch was filled in",
which on a till is a member of staff sent to a table on the other side of a
wall.

**On the server:** 17 checks against the live back office with a terminal token
obtained by commissioning the way the app commissions — nothing forged. That run
covers the cross-venue refusals, and it creates and deletes its own room so no
venue's real plan is touched.

**On a real machine:** `integration_test/floor_editor_test.dart` runs the actual
widgets on Windows against the live server: it taps a preset and asks the server
what it stored, drags a table and checks it moved, and draws a room corner by
corner and reads the corners back. The two bugs this feature has already had
were both invisible to unit tests and both would have been caught here, which is
why it exists.

`flutter build windows --release` succeeds.

---

## One thing to watch

`schema_floor_designer.sql` sorts after `schema_layout.sql`, which creates the
tables it alters. The deploy loop applies every schema file every time and
swallows failures with "(skipped: already applied or not needed)", so a file
that sorts before the tables it depends on simply never applies and nothing says
so. Do not rename it.
