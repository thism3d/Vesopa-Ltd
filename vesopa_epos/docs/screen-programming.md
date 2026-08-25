# Screen programming

Letting a venue lay out its own sale screen from the back office, instead of
taking whatever the catalogue's order happens to produce.

This document is the design, and it doubles as the notes from
`VesopaScreenProgrammingDemo.MP4` — the recording of a competitor's back office
that the work was specified against. Neither the video nor its stills are
committed (see `.gitignore`), for the reason `vesopa_epos_kitchen/docs/
reference-kitchen-demo.md` gives about the kitchen demo: several megabytes of
phone footage in every clone is a poor way to carry a handful of decisions. This
is the handful.

---

## 1. What the reference actually does

Newbridge's console, under **Till Programming → Screen Programming**.

### Creating a page

A form with four fields and a button:

| Field | What it does |
| --- | --- |
| New Page Name | Free text |
| Copy Page | Start from an existing page, or from nothing |
| Page Type | `Full Page` or `Extended Page` |
| Copy Functions / Copy Everything | Two toggles governing how much of the copied page comes across |

### Editing a page

The whole till screen, drawn as it will appear, and directly editable:

```
 ┌──────────────────────────────────────────────────────┬──────────────┐
 │ Save Table │ Table Plan │ Split │ Transfer │ Qty │ … │              │
 ├───────────────┬───────────┬───────────┬──────────────┤ Quick Actions│
 │ Carling       │ Coors     │ Madri     │ DRAUGHTS     │ Products     │
 │ Worthington   │ Guinness  │           │ BOTTLES      │ Style        │
 │ Dark Fruits   │ Thatchers │ Aspall    │ SPIRITS      │ Copy         │
 │ Blood Orange  │ Dark Berry│ Cloudy Lem│ WINE         │              │
 │ Staropramen   │ PRFC Pint │ 1/2 PINTS │ FOOD         │              │
 │               │           │    >>>    │    >>>       │              │
 ├───────────────┴───────────┴───────────┴──────────────┤              │
 │ Pay │ Void │ Main Menu │ Functions │ Print Bill │ …  │              │
 └──────────────────────────────────────────────────────┴──────────────┘
```

Worth taking from it:

- **Every button is the same kind of thing.** A product, a jump to another page
  (`DRAUGHTS`, `1/2 PINTS >>>`) and a function (`Split`, `Print Bill`) all live
  in the same grid and are edited the same way. The column down the right is not
  a special "category rail" — those are page links that happen to be stacked.
- **Selection is the interaction.** Drag a box round several buttons, or click
  them one at a time, then apply a colour or a product set to all of them at
  once. The instructions panel says: *click and drag to select multiple, single
  click to toggle one, double click to edit, click blank to clear.*
- **Style is reusable.** A right-hand panel offers "most recent" and "popular"
  styles as swatches, applied to the current selection.
- **Bulk product fill.** A Products tab lets a department's worth of products be
  dropped onto the selected buttons in one go — "60 selected", by department.
- **Copy between pages.** Select buttons, tick which pages to copy them to.

Worth *not* taking from it:

- **Buttons are resized by dragging a pixel handle.** Every button in the
  screenshots carries a resize grip. That is why their layouts do not survive a
  change of screen size: the sizes are absolute. Ours are grid cells with spans.
- **Two page types with an unexplained distinction.** `Full Page` versus
  `Extended Page` is a modelling artefact, not something a venue thinks about.
  A page is a page; whether it is reached from the home screen or from another
  page is a property of the button that points at it.
- **The chrome is programmable too.** Their Pay key, Sign On and the function
  strip are all buttons on the page, which is powerful and is also how a till
  ends up with no Pay key. See §4.
- **`Select Action` behind a dropdown.** Rename, delete and duplicate hidden
  behind a generic blue bar, one page at a time.

---

## 2. What we are building

**The sale page only.** Decided deliberately; see §4.

A **screen** is a named page of buttons belonging to a venue. A venue may have
as many as it likes, and they are pushed to every till in that venue.

A **button** occupies a cell in that screen's grid and is one of:

| Kind | Does what | Carries |
| --- | --- | --- |
| `product` | Rings the product up | `plu_id` |
| `page` | Switches the grid to another screen | `target_screen_id` |
| `function` | A till action — Qty, Price Check, Discount | a function key |
| `blank` | Nothing. Holds a gap open | — |

That is the whole vocabulary. The reference proves it is enough: everything on
its screen is one of those four.

### The grid, not pixels

A screen declares `rows` and `cols`, and a button occupies a cell plus an
optional span. This is the one place we deliberately depart from the reference,
and it is the difference between a layout that travels and one that does not: a
venue with a 1920×1080 counter till and a 1280×800 handheld should see the same
screen, laid out for the space each has. Absolute pixel sizes cannot do that.

### The Default screen

**There is always a screen called Default, and it is not a row in this table.**
It is synthesised from the catalogue exactly as the till draws it today —
departments down the rail, products in the grid, sorted by `button_position`.

Two reasons it is built rather than stored:

1. **A venue can never end up with no working screen.** Delete every screen you
   have programmed and the till falls back to Default, which is derived from the
   products that must exist for the till to be worth using at all.
2. **It keeps working while a venue grows.** A new product appears on Default
   the moment it is created. A *programmed* screen deliberately does not — a
   layout somebody arranged should not rearrange itself overnight — and that is
   exactly why the fallback has to be the other kind.

Default is offered as a starting point for a copy, which is how the reference's
"Copy Page" is meant to be used and how a venue gets going in one click.

---

## 3. Where a till gets its screen

```
epos_till_settings.home_screen_id  ──►  the venue's home screen, or NULL
                                          │
                                          ├─ NULL  → the built-in Default
                                          └─ id    → that screen
```

Venue-wide, like the station names and the kitchen delivery modes, and for the
same reason: "the sale screen" should mean one thing across a site. A per-till
override is deliberately not in the first cut — it is a column on the terminal
row whenever somebody actually asks for it, and until then it is a way to have
four tills that disagree.

Pushed on change, over the existing `till-settings` broadcast the tills already
listen to.

---

## 4. Why the pay page is not programmable

The sale page is a **menu**: what it contains is the venue's own vocabulary, it
differs at every site, and getting it wrong costs a clerk a few seconds.

The pay page is a **workflow**: tender, split, discount, change. What it
contains is decided by which tender types the venue has enabled, and getting it
wrong means a till that cannot take cash. Handing that to a drag-and-drop editor
buys a venue nothing it wants and offers it a failure it cannot recover from at
a counter.

So the pay page's keys stay driven by configuration. The schema is shaped so
that changing our minds is additive — a screen has a `surface` column, and
nothing about a second surface would need a migration.

> **The strip along the bottom used to be in this list, and is not any more.**
>
> It said: "the function strip along the bottom of the sale page is the same
> argument at smaller scale, and gets the same answer for now: Void, Save Table
> and Pay are not layout."
>
> That was wrong, and the way it was wrong is worth keeping. The pay page is a
> workflow because *the order of its steps is load-bearing* — you cannot tender
> before you have chosen how. The bottom bar has no order at all. It is ten
> unrelated keys, and which ten, in what order, at what size, is exactly the
> kind of thing that differs at every site: a table-service restaurant wants
> Covers and Save Table where a takeaway counter wants neither and would rather
> have Print and No Sale twice the size.
>
> The test "is this a menu or a workflow" was the right test. The strip was
> filed on the wrong side of it. See §9.

---

## 5. Layout

```
vesopa_server/
├── schema_screens.sql          the two tables
├── src/screens.js              CRUD, scoped to an office
└── test/screens.test.js        who may write what, and what a grid may hold

vesopa_server/public/           back office: the editor
vesopa_epos/lib/                till: rendering a screen, falling back to Default
```

---

## 6. The editor's gestures

Written down because they are the part a manager learns by trying, and because
two of them were wrong for long enough to be reported as "the editor is buggy
on Windows".

| Gesture | What it does |
| --- | --- |
| Click a key | Selects it |
| Drag across the grid | Selects the box — with a mouse, a pen **or a finger** |
| Shift+drag / Shift+click | Extends the box from the last press |
| Ctrl+click | Adds or removes one key |
| Drag a key that is selected | Moves it. Hold Alt to copy it instead |
| Arrow keys | Walk the grid. Shift extends, **Alt nudges what is selected** |
| Ctrl+Z / Ctrl+Y | Undo, redo — sixty steps, held in the browser |
| Ctrl+C / V / X / D | Copy, paste, cut, duplicate the selection |
| Ctrl+A, Backspace, Esc | Select everything, clear, deselect |
| Ctrl+S | Save the layout |

Three things about the implementation are load-bearing rather than incidental:

**The grid captures the pointer and works the cell out from its own geometry.**
Selection used to be `pointerover` on each cell plus a full re-render of the
grid on every event. A touch or pen pointer is implicitly captured by the
element it went down on, so those events never arrived and drag-select did
nothing at all under a finger — on a Windows 11 laptop, which is very often a
touchscreen. Re-rendering mid-drag also destroyed the node the pointer was over
and rebuilt every product in the venue into a `<select>` on each pixel of the
drag. Nothing is rebuilt during a drag now; only a class is toggled.

**Nothing throws the layout away without asking.** The whole screen is held in
the browser, so a resize, a screen change, a socket push from another machine,
leaving the view and closing the tab all check `spDirty()` first. Changing the
row count used to `PUT` and reload, taking every unsaved button with it.

**A drag is always a box; a move is picking up what is already selected.**
Treating a drag that begins on a programmed key as a move seems natural until
you meet a finished layout, which has no empty cells left in it — and then a box
can never be drawn, and every bulk edit in the panel is unreachable on exactly
the screens somebody has worked hardest on. Select, then drag.

**A press inside a 2x2 belongs to the 2x2.** Cells swallowed by a span are not
cells you can programme; selecting one used to create a button underneath the
span — invisible in the editor, saved to the server, drawn by nothing.

`vesopa_server/test/backoffice-screens-browser.test.js` drives all of this in a
real Chromium, including the touch drag, and skips itself where there is none.

---

## 7. How a change reaches the counter

```
back office saves  ──►  broadcast({type:'screens'}, {office})
                             │
                             ▼
                     the till's socket ── subscribed to that office ──►
                        screensProvider invalidates ──► GET /api/till/screens
```

**Every arrow in that diagram is required, and two of them were missing.** The
server deliberately sends nothing office-scoped to a socket that has never said
which office it is — the default is silence, because the other default puts one
venue's orders on another venue's screen — and the till never sent the
`subscribe` frame. Even had it arrived, `screensProvider` had no listener for
it. So a layout saved in an office reached no till until somebody restarted the
app, which reads as "screen programming does not work" rather than as two
missing lines.

Guarded by `vesopa_epos/test/screen_push_test.dart`.

---

## 8. A till that will not start

Not screen programming, but found while testing it, and it is the failure an
operator meets first — so it is written down where somebody will look.

A terminal loses power mid-write. That is not an edge case; it is what a till at
a counter does, nightly, for years. Two files in
`%APPDATA%\Vesopa EPOS Limited\Vesopa EPOS` can be left unreadable by it, and
each produced a different endless spinner:

| File | What it looked like | What it actually was |
| --- | --- | --- |
| `shared_preferences.json` | A lime spinner on black, for ever | Every read threw, so the session never resolved — and `AsyncError` fell into the same branch as `AsyncLoading`, which drew a spinner |
| `vesopa_epos.sqlite` | Chrome at the top, "Online", a spinner where the buttons go | Preferences were fine, so it got past sign-on; the first query into the till never answered |
| `vesopa_epos.sqlite`, **sound** | The same screen, on a perfectly good file | The migration below — not corruption at all |

In a window the till deliberately will not let anybody close. The only cure was
somebody who knew to delete a folder in AppData by hand.

Both are now checked before `runApp`, in `data/startup_repair.dart`, and both
repair themselves. What is left is a rule that is not negotiable:

**Preferences may be thrown away. Sales may not.** Preferences are a cache of
things the back office can send again, and losing them costs a sign-in. The
sales file holds the outbox — sales rung up but not yet pushed — and for those
it is the only copy of the money.

The one exception proves it rather than weakening it: a database SQLite
**cannot open** holds no sale the till could ever have sent, so those are
already gone before the check runs. It is moved aside rather than deleted,
because a corrupt database is often still partly salvageable and those rows are
a venue's takings — and the till says so, on screen, with the path, rather than
starting empty and quiet.

Anything that still hangs meets `ui/recovery_page.dart` after twelve seconds
instead of a spinner: one silent repair attempt, then a screen that offers a
repair which keeps every sale, and — behind a confirmation that says what it
costs — a full reset that does not.

### The one that was not corruption

The terminal this was found on had a database `PRAGMA quick_check` calls
perfectly sound, holding sales that had never reached the back office — and
it would not open, on every launch, for ever.

Drift decides which migration steps to run from the stored `user_version`,
and writes the new number *after* the steps finish. A till killed between the
two — a power cut, a Windows update, somebody switching a kiosk machine off
at the wall — comes back with the new columns already in the table and the
version still on the old number. The migration runs again, SQLite refuses
with `duplicate column name`, the open fails, the version is never written,
and so it happens again on the next launch. And the next.

What the operator saw was a spinner where the sale buttons go. What fixed it
was deleting the file — which threw those unsent sales away.

Every column step in `AppDatabase.migration` now asks the table what it
already has (`_addColumnIfMissing`), which makes them all safe to re-run. The
terminal's sales are untouched and nothing needs clearing. `tool/inspect_db.dart`
is what told the two apart in the first place.

Guarded by `test/startup_repair_test.dart` and `test/migration_rerun_test.dart`.

---

## 9. The bars

The two strips of chrome around the sale grid are laid out by the venue too:

* the **top bar** — the strip of open bills, `Current · Table 6 · Table 8 …`;
* the **bottom bar** — `Void · Cancel · Save Table · … · Pay`.

### A bar is a screen

Not a new table, a new editor, or a new renderer. A bar is one or two rows of
the same buttons the sale grid is made of, told apart by `epos_screens.surface`:

```
surface = 'sale'       a page of products              up to 10 x 12
surface = 'topbar'     the strip along the top         up to  2 x 16
surface = 'bottombar'  the strip along the bottom      up to  2 x 16
```

`surface` has been on that table since the first migration, waiting for exactly
this. So the drag-select, the undo stack, the bulk colour, the whole-grid PUT,
the socket push and the tenancy scoping all worked on bars on the day they
existed, because none of them ever asked what kind of screen they were holding.

Two rows rather than one, because `PosActionBar` already spills onto a second
when the keys will not fit across one — a venue rebuilding its bar has to be
able to express the bar it is replacing. Not three: past two the bar starts
eating the grid, which is the screen a clerk actually works in.

Sixteen columns rather than twelve, because a bar's cells are narrow by nature
and the stock bottom bar is already ten keys plus a wide Pay. Twelve would have
made "rebuild what you have, then change one thing" impossible on the first try.

### Which bar a till wears

```
epos_till_settings.top_bar_screen_id       the venue's, or NULL
epos_till_settings.bottom_bar_screen_id
epos_screens.top_bar_id                    this one page's, or NULL
epos_screens.bottom_bar_id
```

Resolved by `ScreenSet.barFor`: the screen's own, then the venue's, then none.
**None means the built-in bar** — the same weight `home_screen_id` carries in
§3. It is the venue's answer, not an absence of one, and it is what a venue gets
back the moment it deletes the bar it made.

The per-page override exists for a real request: a Drinks page whose bottom bar
offers a round and a tab, where the food page offers Covers and Save Table. It
costs two nullable columns and a dropdown, and it is null on nearly every row.

No foreign keys, deliberately — same reasoning as `home_screen_id`. A bar
deleted in the back office leaves these pointing at nothing and the till falling
back to the built-in, rather than the delete being refused or a venue's home
screen being cascaded away as a side effect of tidying up.

`barFor` also checks the *surface* of what it finds, not just that it exists. A
sale page worn as a bottom bar would draw a page of lagers squashed into the
bottom two inches of a till. The back office refuses to set that — but a till
reads rows it did not write, out of its own cache, put there by an older
release, so it is checked at both ends.

### The keys a bar may carry

`BAR_KEYS` in `vesopa_server/src/screens.js`, in three groups:

| group | keys |
| --- | --- |
| the bill | `pay` `void` `cancel` `save_table` `new_bill` `qty` `note` `covers` `customer` |
| paper and cash | `print_bill` `last_bill` `open_drawer` |
| go to | `go_sale` `go_tables` `go_receipts` `go_reports` `go_products` `go_functions` `go_settings` `sign_off` |
| live displays | `open_bills` `order_total` `clock` `venue_name` `staff_name` `sync_status` `screen_name` `spacer` |

The whitelist is per surface. `pay`, `void` and `cancel` are refused on a sale
grid — a Pay key in the middle of a page of lagers, one row above Cancel, is a
mis-press that costs a venue a bill — and the live displays are refused there
too, because nothing on the grid draws them.

`sign_off` ends the shift. It is deliberately **not** the rail's Logout, which
de-commissions the terminal and needs a password: that on a bar, where it can be
leaned on, is a different feature with a far worse failure.

### Why the live displays exist

This is the group that makes the feature safe rather than a trap.

The top bar today *is* the strip of open bills. Without `open_bills` as a
placeable key, a venue that programmed its own top bar would silently lose the
ability to run two bills at once, and would find out at a counter on a Friday
rather than in an office on a Tuesday. So the strip is a key you place, widen
and colour — `OpenBillsStrip`, the same widget the built-in bar draws, inside
one cell. It scrolls sideways rather than wrapping, so nine open tables in a
narrow key is a strip you push along, not nine chips too small to read.

The editor will not let that go quietly either: a top bar with no `open_bills`,
or a bottom bar with no `pay`, is reported in **Needs attention** as a warning
rather than an error. Neither is broken. Both are a layout somebody will save,
walk away from, and discover in service.

### A bar on a narrow terminal

A bar is laid out in an office against a counter terminal and then met on
whatever the venue happens to be holding. Sixteen keys across a handheld is
25px each — a bar a clerk cannot use and cannot fix from behind a counter.

So below 72px a key stops shrinking and the bar scrolls sideways instead: the
same figure `PosActionBar._minKeyWidth` uses, for the same reason, and the same
trade the open-bills strip makes. The venue's layout survives intact rather than
being silently rearranged into something it did not arrange.

### The face on a key

Buttons gained `emoji` and `image_url`. The chain is: the key's own, then — on a
product key only — the product's own.

Two things follow from that order, and both were asked for:

* a **page** key can carry a picture at all. Until now the only way a key had a
  face was to be a product that had one, so the venue that photographed its menu
  could not put its own picture on the FOOD key that leads to it;
* a **product** key can be given a different face on one screen without changing
  the product everywhere else.

And the fallback is what stops the feature quietly un-decorating every screen a
venue had already programmed before it existed. The editor draws a borrowed face
faded, and disables **Remove** on it, so "this key has a picture" and "this key
was given a picture" stay distinguishable — otherwise clearing a key's own emoji
looks like it did nothing.

Pictures are on-site only, `/uploads/…` or `/assets/…`. A till on a venue
network with no route to the open internet must not be able to draw a broken
frame across its sale screen, weeks after the layout was arranged, in front of
customers. The server drops anything else rather than storing it.

### Finding it in the back office

"How do I choose the screen my tills open on?" was being asked by people looking
straight at the tick box that does it. A tick box on the screen you happen to be
editing answers *is this one the default*; it never answers *which one is*.

So the page now opens with **What your tills open with**: three named choices —
sale screen, top bar, bottom bar — with a small drawing of a till beside them,
each part labelled with the layout it is wearing and clickable as the way in to
editing that part. The tick box stays, because it is the quick way once you know
where you are.

### Where it lives

```
vesopa_server/
  schema_screens_bars.sql        emoji, image_url, top_bar_id, bottom_bar_id
  schema_till_bars.sql           top_bar_screen_id, bottom_bar_screen_id
  src/screens.js                 SURFACES, BAR_KEYS, PUT /screens/defaults
  public/screens.js              surface tabs, the defaults card, the key face
vesopa_epos/
  lib/data/screens.dart          ScreenSurface, barFor, surfaceById
  lib/ui/widgets/programmed_bar.dart    a bar, drawn
  lib/ui/widgets/open_bills_strip.dart  the table strip, drawn by both bars
```

Guarded by `test/programmed_bar_test.dart`, `vesopa_server/test/screens.test.js`
and `vesopa_server/test/backoffice-screens-ui.test.js`.

**The two schema files are two on purpose.** `deploy.sh` applies `schema_*.sql`
in `sort` order, and `epos_till_settings` is created in `schema_staff_idle.sql` —
which sorts *after* `schema_screens_bars.sql`. A column added to that row from
the screens file would fail on a fresh database and succeed on every server that
already had one: green in testing, discovered by the first new venue. That is
the failure in `vesopa_epos_kitchen/docs/architecture.md` under "The migration
rename", which cost a venue its printer names, and this is the second time this
feature has had to be split in two to avoid it. Adding another column to that
row? Put it in a file named `schema_till_*.sql` and it is safe by construction.
