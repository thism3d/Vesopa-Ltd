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
that changing our minds is additive — a screen has a `surface` column, set to
`sale` on every row, and nothing about a second surface would need a migration.

The function strip along the bottom of the sale page is the same argument at
smaller scale, and gets the same answer for now: Void, Save Table and Pay are
not layout.

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
| Drag a programmed key | Moves it. Hold Alt to copy it instead |
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
