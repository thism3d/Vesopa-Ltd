# Vesopa EPOS 1.4.6 — release notes

Store submission: `msix_version: 1.4.6.0` (previous build here was 1.4.5.0).
Flutter `version: 1.4.6+18`.

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it, so the numbering walks the
third part and never the fourth. 1.4.6.0 is the correct successor to 1.4.5.0;
1.4.5.1 is not a version this Store will take.

**Vesopa Kitchen does not move.** Nothing in this release touches it — it stays
at 1.4.5.0, and a venue running kitchen screens needs no kitchen update
alongside this one.

**Server: changes required, and already applied to live.** Deployed with
`.\deploy.ps1 -Schema` on 26/08/2026. Three new migration files, all guarded
and safe to re-run:

* `schema_fonts.sql` — `epos_fonts`, the typefaces a venue has uploaded for its
  own tills.
* `schema_screens_fonts.sql` — `font_family` and `font_size` on
  `epos_screen_buttons`.
* `schema_till_fonts.sql` — `font_family` on `epos_till_settings`, the one every
  key without a font of its own inherits.

Verified on live afterwards rather than inferred from a clean deploy log:
`epos_screen_buttons.font_family` (varchar 64) and `.font_size` (tinyint
unsigned), `epos_till_settings.font_family` (varchar 64), and the `epos_fonts`
table are all present. `GET /api/till/fonts?office=…` answers with the sixteen
built-ins, refuses a request with no office, and
`/assets/fonts/inter/inter-400.ttf` serves 324,820 bytes as `font/ttf`.

**This one is order-independent, unlike 1.4.5.** Every new field is null on
everything that exists, and null means what it has always meant: the till
decides. An older till meets the new server and ignores three fields it has
never heard of; a 1.4.6 till meets an un-migrated server, reads no font list,
and letters everything exactly as it does today. Neither combination loses a
sale. The server should still go first, because there is no reason for it not
to.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version. 1,396 of the 1,500 characters Partner Center allows — count it again if
you edit it.

```
Version 1.4.6.0 – Make It Yours

Your own typeface on the till, and a screen editor you can work in.

Your Brand On Every Key: Choose from sixteen built-in typefaces, or upload your own from the Back Office or straight from a till. Pick one for the whole venue and every screen follows; give a single key its own font and size when it needs to stand out. Fonts are downloaded once and kept on the terminal, so the lettering is right whether or not the broadband is.

Any Colour, Not Just Ours: A colour wheel beside the swatches, for the fill and the lettering both. Paste a hex from your brand book with or without the hash.

Double-Click A Key To Search: Double-click any button in the screen editor and search everything you can put on it — products, pages, till functions — by name. It was there before and could not be reached; now it works with a mouse, a pen or a finger.

Drag The Corner To Resize: Every selected key gets a handle. Drag it and the key grows across the grid, snapping to the cells. It stops at its neighbours rather than swallowing them.

A Window That Fits: Open the editor in its own window and the whole grid fits, at the shape of a real till, with no scrolling up and down to see what you just changed.

Simpler Product Screen: Button position and emoji have gone from the product form. Both belong to the screen editor, which is where you can see what you are doing.
```

---

## What changed, in full

### Fonts

A venue can letter its tills in its own typeface. Sixteen families ship —
Inter, Roboto, Open Sans, Lato, Montserrat, Poppins, Nunito, Source Sans 3,
Work Sans, Rubik, Manrope, Raleway, Fira Sans, Oswald, Bebas Neue and Playfair
Display — regular and bold, all OFL 1.1 or Apache 2.0, with the licences beside
them in `public/assets/fonts/LICENSES.md`.

**The files are served by the back office, not by Google, and that is the whole
design.** The obvious build is a stylesheet link to `fonts.googleapis.com`. It
is wrong for a till twice over: a till takes money through a broadband outage,
which is most of the reason it exists, and a button whose lettering arrives over
the internet changes shape when the line drops. And Flutter's `FontLoader` reads
ttf and otf, while Google serves woff2 to anything modern — the till would have
to lie about its user agent to get a file it could use.

So a font is fetched once from the venue's own back office, written to the
terminal's application-support directory (not a cache directory, which an
operating system may empty — a till that loses its lettering offline mid-service
is not fixable at a counter), and registered from disk on every start after
that. First run needs the network. Nothing after it does.

A till downloads **only the fonts in use** — the venue's, plus any named by a
key — not all sixteen. And the resolution is a lookup, not a string: a font the
venue has deleted, or one this terminal has not fetched yet, comes out as the
app's own lettering rather than as whatever the platform substitutes. A key that
silently changes shape and then changes back is harder to explain than one that
has not changed at all.

A `.woff2` upload is refused, loudly, with an error naming the formats that
work. It would render perfectly in the browser the manager is looking at it in
and do nothing at all on the terminal it was for.

Uploads work from the Back Office and from a till. The till's upload is on a
terminal token rather than the office query every other till route uses — those
are reads, and a write that puts a file on our disk is not the same trade.
Picking a font from a counter is deliberate: the question a typeface has to
answer is whether a clerk can read it across a bar at half past ten, and that
cannot be answered from a desk.

A size is a wish rather than a promise. The same layout is drawn on a 15-inch
counter panel and on a handheld, so the key caps a size against its own height
before using it. A key with no size of its own is drawn exactly as it was
before this release — checked by a golden test, because a new control that
quietly re-letters every screen a venue has already programmed is not a new
control.

### The screen editor

**Double-click to search never worked.** There was a `dblclick` listener on the
grid and it had never fired once: the editor calls `preventDefault()` on
pointerdown — it must, or the browser starts selecting text the moment you drag
across the grid — and that suppresses the entire compatibility mouse sequence
behind it, `dblclick` included. Written, shipped, and unreachable with a mouse,
a pen or a finger. Presses are counted in the pointer stream now, which works
the same for all three.

Acting on that second *press* then broke every move in the editor, because
moving a key is "click it, then drag it" — two presses on the same key, well
inside any double-click window. The search opens only if the second press turns
out not to have travelled.

**A corner handle** on the selected key, snapped to the grid. It refuses to
swallow its neighbours: the tidy pass drops a button whose own cell has been
covered, which is right for a drop on top of something and wrong for a corner
drag, where the pointer overshoots by a cell routinely — and a gesture that
silently deletes the key next to it costs a venue a layout. The typed Width and
Height boxes *did* swallow, with nothing on screen to say what had gone; they
are clamped to the same room now, and the box snapping back is the editor
saying why.

**A colour wheel** beside the twelve swatches, for the fill and the lettering
both, paired with a hex box so a brand colour can be read back and pasted in.
Both commit when you finish rather than while you drag: a colour input fires on
every pixel the pointer crosses, and each of those would have been an undo step.

**The pop-out fits.** It existed and it scrolled. In the page the grid is
width-driven — it takes its column and its 16:9 shape decides its height — which
in a window sized for it is backwards: a wide window makes a tall grid, the
bottom row goes under the fold, and the manager is scrolling in the window that
existed to stop them scrolling. In the pop-out the grid is height-driven and
capped at the column's width. Same 16:9 shape either way, which is the point —
what is arranged is the shape a clerk meets.

**"Edit that screen →"** on a page key, for walking down a venue's own menu
without reading the name off a dropdown and finding it again in the picker.

### The product form

Button position and emoji are gone. Both belong to the screen editor, which is
where the layout, the colour, the size, the lettering and the face of every key
are set — and "button position" was a number a manager had to hold in their head
to arrange a grid they could not see.

**The columns are not cleared, and that mattered.** A save that does not mention
a field now leaves it alone, the same guard button colour already had.
`button_position` orders the built-in Default sale screen for every venue that
has not programmed one of its own, so nulling it on edit would have reshuffled
their grid silently, one product at a time, as prices were updated. A product's
emoji is still the face a key falls back to.

### One found by its own test

`spShape()` is the string the editor compares to answer "is there unsaved work"
and "did that change anything". The two new fields were not in it, so lettering
a key was not a change: no undo step, no warning before leaving the page, and
the edit thrown away without a word by the next screen switch. Fixed, with a
note beside it saying to add fields there in the same breath.

---

## Known, and not from this release

Two till tests fail at 1.4.5.0 and still fail here. Neither is reached by
anything in this release and neither affects a terminal in service:

* `programmed_bar_test.dart`, "a key's own face survives it too" — a key's
  `imageUrl` is resolved to an absolute address on the way in, so a
  `toJson`/`fromJson` round trip is not idempotent and the test compares the
  bare path.
* `functions_page_layout_test.dart` desktop golden — 0.47% of pixels differ.

The two Dojo *live* tests also fail without credentials in the environment,
which is expected.

---

## Before submitting

1. `dart run tool/make_windows_icon.dart` if `flutter_launcher_icons` has been
   re-run since the last build — it overwrites the multi-frame icon with a
   single frame.
2. Build with the Dojo key defined if this build is to take live card payments;
   it is never in source:
   `flutter build windows --dart-define=DOJO_LIVE_API_KEY=…`
   **The package built for 1.4.6.0 was built without it**, so it carries the
   bundled sandbox key — the same caveat 1.4.5.0 carried. Rebuild before
   submitting if live card payments are wanted from the Store build.
3. `dart run msix:create --store`
4. Check the finished manifest, not the pubspec: the rejection comes from the
   package. `Version=` must read `1.4.6.0`, with the fourth part 0.
5. `msix_version` can never be reused, and its fourth part must stay 0. A
   resubmission after a failed certification bumps the *third* part: 1.4.7.0,
   never 1.4.6.1.
