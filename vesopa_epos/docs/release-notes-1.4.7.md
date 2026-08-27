# Vesopa EPOS 1.4.7 — release notes

Store submission: `msix_version: 1.4.7.0` (previous build here was 1.4.6.0).
Flutter `version: 1.4.7+19`.

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it, so the numbering walks the
third part and never the fourth. 1.4.7.0 is the correct successor to 1.4.6.0.

**Vesopa Kitchen does not move.** Nothing in this release touches it — it stays
at 1.4.5.0, and a venue running kitchen screens needs no kitchen update
alongside this one.

---

## Server: changes required, and already applied to live

Deployed with `.\deploy.ps1 -Schema` on 27/08/2026. One new migration file,
guarded by the usual `vesopa_add_column` procedure and safe to re-run:

* `schema_screens_key_images.sql` — `image_fit`, `image_scale`, `image_x`,
  `image_y` and `show_label` on `epos_screen_buttons`. How a picture sits on a
  programmed key, and whether the key's name is drawn over it.

Verified on live afterwards rather than inferred from a clean deploy log — the
lesson of 1.4.6. `SHOW COLUMNS FROM epos_screen_buttons` answers:

```
image_fit     varchar(12)           YES   NULL
image_scale   smallint(5) unsigned  YES   NULL
image_x       smallint(6)           YES   NULL
image_y       smallint(6)           YES   NULL
show_label    tinyint(1)            NO    0
```

**This one is order-dependent, and the server has to go first.** Unlike 1.4.6,
the back office does not degrade quietly without its migration: saving a layout
INSERTs all five columns, so an un-migrated server answers every save with
`Unknown column 'image_fit'` and a venue cannot programme anything at all. The
server is already migrated, so this is a note for a rebuild rather than an
instruction — but it is why the order matters here and did not last time.

**A till is safe either way.** Every new field is null on everything that
exists, and null means the plain answer: fill the key, no zoom, centred. A 1.4.6
till meets the new server and ignores five fields it has never heard of; a 1.4.7
till meets an un-migrated server, reads nulls, and draws exactly what it drew
before. Neither combination loses a sale.

---

## What is in it

### The Z report comes off the printer

**It was never printed.** Not misconfigured, not routed wrong — nothing in the
till ever called the code that prints it. `ReceiptBuilder.tillReport()` had been
building the document for months, `PrintTarget.tillReport` had a printer
assignment and a fallback to the receipt printer, and
`PrintService.printTillReport()` was written and correct. Running a Z closed the
period, reset the totals, showed a toast, and printed nothing — and the manager
who had just set a printer up had no way to tell which of those four things had
failed.

* **A Z prints as soon as it has run.** The confirmation dialog says so before
  it runs.
* **The last Z can be printed again.** A Z closes the period, so the moment it
  runs the screen goes back to an empty X and the document a manager actually
  needs on paper is no longer anywhere they can reach it. There is now a
  **Reprint Z #n** key beside the totals, for the printer that was switched off.
  Held in memory, not on disk: a Z from last Tuesday is a back-office question.
* **A print that fails leads with "the period is closed anyway".** A manager who
  reads only "could not print" runs the Z again looking for paper, and the
  second one totals nothing.
* **Print X**, which needs none of that — nothing is closed, so a failure costs
  one more press of the same key.

The printer is resolved through the target's fallback chain, so an unset
"X / Z report" uses the receipt printer, which is what a till with one printer
has always meant. With no printer at either end the message names
Settings › Printers › X / Z report rather than saying it could not print.

### Screen programming: shapes first, products second

**Empty keys resize.** The corner handle used to appear only on a key that
already had something on it — so a venue that lays a screen out by arranging the
shapes first and saying what each one does afterwards could not, because there
was nothing to resize until after the decision the sizing was meant to come
before. Dragging the handle on an empty cell now sets a **space aside** at that
size: it survives being saved, it keeps its size when a product is dropped into
it later, and dragging it back to one cell makes it stop existing. One drag is
one press of undo.

**Changing page works again.** The unsaved-work guard used `confirm()`, and
Chrome offers "prevent this page from creating additional dialogs" on the second
native dialog in a row — after which every `confirm()` on the page returns
*false* without drawing anything. The guard read that as "stay put", re-rendered
the picker back to the screen already open, and the editor silently refused to
change page. That is the whole of "swapping to another page doesn't change to
the page, it just shows the page I am currently on". It is a drawn modal now,
with three answers rather than two: **Stay here**, **Discard changes**, and
**Save and carry on** — because a manager who has arranged twenty minutes of
keys and reaches for the next page does not want to be asked whether to leave
them behind, they want them kept.

### A picture is the key

**A key with a picture no longer letters its name over it.** A photograph of a
burger is a better burger key than the word BURGER over a sliver of one. The
price goes with the name — "just the image" means just the image — and both come
back per key on a **Show the name as well** tick, which letters them over the
picture on a scrim so they stay readable whatever the photograph happens to be.
A key with no picture always says its name.

**And the picture can be framed.** A venue arranges keys in whatever sizes suit
them, and one photograph has to look right in all of them; before this a picture
was drawn one way only, so a tall bottle shot on a wide key was a label of glass
with the bottle cropped out of frame and there was nothing anybody could do
about it from the back office.

Four numbers now say how to *look* at the file — fit, zoom, and a shift in each
direction. Nothing is uploaded and nothing is cropped, so **the same photograph
frames one way on the FOOD key and another on the burger it leads to**, without
a second copy of it and without the product catalogue changing under either.

The control is a **framing stage** in the inspector, drawn at the selected key's
own proportions — a 2x2 stage is square, a 1x3 is a strip — because "does this
picture work *here*" is a question only the real shape answers. Drag it to pan,
scroll or pinch to zoom, **Fill the key** / **Whole picture** for the two
answers worth one press each, **Reset** to put it back. The zoom floor is 20%,
not 100%: a floor at "exactly the fit" means a picture can only ever be cropped
and never pulled back to show more of itself, which is the fault the product
cropper had to be fixed for.

**Note for venues that already have product photographs.** Picture-only is the
default, including for keys that exist today, so a product key wearing its
catalogue picture will stop showing its name until the tick is turned on for it.
That is the behaviour that was asked for, and it is the one change in this
release that alters screens nobody has touched.

### One bar, everywhere

The till used to wear a fixed strip above everything — a gear, the section name,
the shift chip and the online badge — and then, on the sale screen, the venue's
programmed top bar underneath it. Two bars, one above the other, both saying who
was signed on and whether the till was online. **The top one is gone.**

It could only ever go on the sale screen before, because that was the only place
a programmed bar drew; everywhere else it was the only chrome there was. So the
programmed bar is now the till's only bar and it is drawn on **every** section —
Sale, Tables, Receipts, Reports, Products, Functions, Settings.

* **A fixed page selector is pinned at the left of every top bar**, and no layout
  can remove it. That is deliberate: a venue that programmed a top bar without a
  `go_settings` key on it, on a terminal with the side rail tucked away, would
  have arranged a till nobody can navigate — and would find out at a counter. It
  takes width from the bar rather than one of its columns, so **a bar laid out
  before this release still has every key it had**; they are drawn a little
  narrower. The editor shows it beside the grid whenever a top bar is being laid
  out, so a manager arranges against the width it takes.
* **The shift chip and the badges are drawn only until a venue lays a top bar
  out.** After that they have said what goes on their bar, and `staff_name`,
  `sign_off`, `sync_status` and `print_status` are all keys they can place.
* **Off the sale screen, keys that act on a bill are drawn and dimmed** rather
  than hidden. There is no bill in front of the clerk on Reports, so Pay, Void,
  Save Table and every product key do nothing there — visibly. A key that
  vanishes on one section and returns on another is a bar that appears to be
  broken; one that still fired would take a payment from a screen the clerk
  cannot see the bill on. Navigation, Sign off and every live display stay
  working, the open-bills strip included — so a clerk can see a table waiting
  from the Reports page and be taken to it.

---

## Checks

Back office: 210 checks across `npm test`, including 52 in the headless-Chrome
editor suite — the empty-cell reservation, the framing stage, and the fixed key
beside a top bar. Till: `flutter test` at 435 passing, with a new
`test/programmed_key_face_test.dart` that checks the two image transforms are
composed in the same order in Dart as they are in CSS. Get that order backwards
and the editor's preview shows a manager something a clerk will never see.

Five tests fail and all five failed before this work: two Dojo live tests that
need a network, a Functions-page golden, a `widget_test` that creates a real
`HttpClient` and times out, and `programmed_bar_test`'s wire round-trip — that
last one is a real bug (a key's `imageUrl` comes back absolute from `toJson`,
which the server's `cleanImage` would refuse) and is not fixed here.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version.

```
End of day now prints. Running a Z report sends it straight to the printer,
and the last Z can be printed again from the same screen if the printer was
switched off — so a closed period always has paper behind it. There is a
Print X key too, for reading the takings without closing anything.

Screen programming, three ways:

  Lay out the shapes first. Drag the corner of an empty key to set a space
  aside at the size you want, and give it a product later.

  Put a picture on a key and frame it. Zoom, pan and fit the photograph
  inside the key, at that key's real shape, without re-uploading it — so one
  picture can sit differently on a large key and a small one. A key with a
  picture shows the picture; turn its name back on whenever you want it.

  Changing page in the editor works again, and it now offers to save your
  work rather than only offering to throw it away.

One top bar. The till's fixed strip is gone and the bar you programme is the
only one, on every screen, with a page selector pinned at its left that staff
use to move between Sale, Tables, Reports and the rest.
```
