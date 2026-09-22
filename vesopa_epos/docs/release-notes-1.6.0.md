# Vesopa EPOS 1.6.0 — release notes

Store submission: `msix_version: 1.6.0.0` (previous build here was 1.5.0.0).
Flutter `version: 1.6.0+21`.

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it, so the numbering walks the
third part and never the fourth.

**Minor, not patch.** This adds reporting and a scheduled-report engine to the
back office, a catalogue import, and an entirely new application — the customer
display. It also changes a default that affects every printer in the field. That
is more than a run of fixes.

**Vesopa Kitchen does not move.** Nothing in it changed and nothing in this
release requires it. It stays on 1.5.0.0.

**Vesopa Customer Display is new, at 1.6.0.0.** It tracks the till's release
line rather than starting at 1.0.0, for the same reason the kitchen screen does:
a display and a till on different major versions is a support question nobody
can answer over the phone.

---

## Server: changes required

One new migration file, guarded and safe to re-run:

* `schema_reports.sql` — `bo_report_schedules` and `bo_report_runs`, behind
  scheduled reports.

**Two new npm dependencies**, installed by the deploy script's own
`npm install --omit=dev`:

* `exceljs` — reads the uploaded catalogue workbook and writes the template and
  the XLS export.
* `pdfkit` — the PDF export, and the PDF that a scheduled report attaches.

**Scheduled reports need SMTP.** The back office already had `SMTP_HOST` and
`SMTP_PASSWORD` for password resets, and the scheduler uses the same transport.
On a server where they are unset, a schedule still runs and still builds its
report — it is recorded as `no_mail` rather than as a failure, and the schedules
page says so at the top rather than letting a venue find out when the first
report does not arrive.

**An un-migrated server** loses only the schedules page: every other report runs,
because running one is a query over tables that already existed. The two new
tables are read by nothing else.

---

## The eight things that were asked for

### 1. Screen programming: font colours

**Already built, never deployed.** The lettering control has been in the editor
since 26 August — light, dark, or a custom colour with a wheel and a hex box,
per key, and the till has been rendering it. What was missing was a deploy. It
is live now.

### 2. Mass-applying buttons: pick individual products

Filling a screen from a department or a sub department used to drop in
*everything* on the shelf, so laying out eight of fourteen lagers meant filling
all fourteen and deleting six keys.

There is now a tick list under the department and sub department pickers, with a
search box and All / None. It defaults to everything ticked, so the one-press
fill is exactly as fast as it was; untick what you do not want and only the
ticked products go in, in product-list order.

The count under it says what will actually happen — "8 of 14 in Lagers ticked" —
before the press rather than after it.

> **Note.** The video referred to ("see video from yesterday") was not in
> `instruction-assets` — only the reports one was. This is built from the written
> description. If the video shows something different, say so and it is a small
> change.

### 3. Reports: Financial Summary, and scheduling

**Reports › Financial Summary.** Pick a period and run it:

* Today, Yesterday, Last 7 Days, Last 30 Days, This Week, Last Week, This Month,
  Last Month, This Year, Last Year, or a custom range.
* Seven sections, matching the reference PDF: Department Sales, Sub Department
  Sales, General, Other Discounts, Expenses, Spend Per Head, Payment Methods.
* Export as PDF, CSV or XLS — all three built from the same figures that are on
  screen, so they cannot disagree with it.

**The report reconciles.** Department sales, sub department sales and payments
are three views of one set of rows, grouped once rather than queried three times.
There is a test that fails if they ever stop adding up to each other.

**VAT is the tax inside the price, not a percentage on top of it** — and it is
taken after a line discount, not before. Charging tax on money the customer was
never asked for is the error that would have been invisible until an accountant
found it.

**Reports › Scheduled reports.** A report that runs on a clock and emails itself:

* Daily, Weekly, Monthly, Quarterly or Yearly, at a time of day.
* The period it covers is set separately from how often it runs — "every Monday,
  covering last week" and "every Monday, covering yesterday" are both things
  venues ask for.
* Any number of recipients.
* **Results** shows every attempt: when it ran, whether it was sent, which
  addresses, and what window it covered. That is the answer to "the Monday
  report didn't arrive", which is unanswerable without it.
* **Send now** uses the same path the clock takes, so a test send proves
  something about the schedule.

A missed window is run late, not skipped: if the server was down at 08:30 the
report still goes out, and it still covers the day it was meant to.

> **Two differences from the video, both deliberate.**
>
> * **One form, not five tabs.** Eight fields fit on one screen, and a wizard
>   over eight fields costs four presses to check what you typed on the first
>   page. Say the word and it becomes tabs.
> * **No Terminal filter.** `epos_orders` does not record which terminal took a
>   sale, so there is nothing to filter on. Adding it means a column on the sales
>   table and a change to what the till pushes — happy to do it, but it is its
>   own piece of work and it only applies to sales taken *after* it ships.
>
> **Cashback, Cash Rounding and Expenses are printed as zero rows.** The till
> does not take cashback, does not round cash, and has no expenses feature. They
> are on the report so its shape matches what a manager is used to reading, and
> so the line is already in the right place the day any of them is added.

### 4. Void and Cancel: "other reason" now lets you press Void

**Found and fixed.** The earlier fix only ever worked with a hardware keyboard,
which is why it looked fixed and was not.

`TextField.onChanged` reports characters that arrive through the platform's input
connection. The till's on-screen keyboard does not use one — it writes to the
text controller directly — and a programmatic write to a controller does not fire
`onChanged`. So on a touchscreen till, which is every till, the reason appeared
in the box and the button that would accept it stayed grey.

The dialog now listens to the controller itself, which sees both routes. There
are four tests, and they type by pressing the drawn keys rather than by
simulating a keyboard — the same fault would have walked straight past a test
that typed the easy way.

### 5. Importing products, sub departments and departments from Excel

**Programming › Import.**

1. **Download the template.** It is generated, not a checked-in file, so the
   column headings it carries are by construction the ones the parser reads. It
   has a sheet explaining every column and example rows showing the format.
2. **Upload your file** and press **Check**. Nothing is written. It reports what
   would be created, what would be updated, and every problem with its
   spreadsheet row number.
3. **Import.**

Behaviour worth knowing:

* **Nothing is ever deleted.** A row you leave out is left alone. A missing row
  is far more likely a filter left on than a product somebody wants gone.
* **A blank cell means "leave this alone", not "clear it".** Correcting one
  department's colour does not blank the other twelve's accounting codes.
* **All or nothing.** A file with any error in it writes nothing at all. Half an
  imported catalogue is the state nobody can reason about.
* **"drink" and "Drink" are one department.** Matching is case-insensitive
  throughout, because creating the second one splits a venue's sales report in
  half.
* Leave PLU blank and the next free number is allocated. Give one and it is the
  key, so a corrected price sheet updates rather than duplicating.
* Prices are read the way people type them: `£4.60`, `1,250.00`. A decimal comma
  is **refused** rather than guessed at — reading "4,60" as four pounds sixty is
  how a £4.60 pint becomes £460.

### 6. Customer display — a separate application

**New: Vesopa Customer Display.** Its own application, its own package, its own
process. The till's entire involvement is writing a small file; it has no socket
to the display, no plugin, and no shared code. A display doing video work cannot
slow the till down, and a display that falls over takes nothing with it — the
till carries on selling and the only thing lost is the picture facing the
customer. That was the requirement and it is the whole design.

* **Split screen** while a sale is happening: the bill on one half, adverts on
  the other. Side by side on a landscape screen, stacked on a portrait one, so a
  pole display mounted upright works.
* **Full-screen adverts** when the till has been quiet. The timer is on
  *changes*, not on whether a bill exists — a bill left on screen because a clerk
  walked away goes to adverts after the set time and comes straight back the
  moment anything is rung up.
* **Adjustable**, in the display's own settings: 0 to 300 seconds, where 0 means
  never. A till with nothing rung up on it always shows adverts full screen,
  whatever that is set to.
* **Adverts are a folder on the machine.** Drop pictures or clips in and they
  appear — nothing needs restarting. PNG, JPG, GIF, WEBP, MP4 and MOV; they play
  in file-name order, so name them `01-`, `02-` to set the order. Video plays to
  its end and is always muted.
* **Change is shown.** When a sale is paid for, the customer can check their
  change against the screen without asking.

**Setting one up:** install it on the same PC as the till, open Settings from the
faint cog in the corner. The path to the till's basket file is already filled in;
choose an advert folder and set the idle time. It reports whether the till's file
is actually there and how many adverts it found, so a wrong path is visible
immediately rather than at service.

> **Before the first Store submission** the display's `identity_name` in
> `pubspec.yaml` must be replaced with the one Partner Center issues. It is a
> placeholder, and a name that merely looks right is not one the Store has heard
> of.

### 7. Sign on: straight to a pin pad

The Sign On key now opens onto a PIN pad. No list, no names, no scrolling.

The list was what made the key slow, and it got slower the better the venue did —
a pub with twenty staff put a scroll between a clerk and their own till,
mid-queue, to collect a fact the PIN was about to establish anyway. The back
office refuses to issue two people the same PIN, which is what makes "who typed
this" a lookup rather than a guess.

A wrong PIN **keeps the pad up** and says so. Backspace corrects one digit; any
digit starts a fresh attempt. Closing the dialog on a mistyped digit is how four
digits turns into a re-press and four more.

### 8. X and Z reports: the pound sign

**Fixed, and the cause is worth writing down.**

The pound was being sent as byte `0xA3` with a code page selected by `ESC t`.
That is correct and works on most hardware. It does not work on printers whose
code-page table is shifted from the Epson one this till assumes: `ESC t 16` means
CP1252 on an Epson and **CP866** on a good number of clones — and `0xA3` in CP866
is `г`, which is exactly the "r" that was reported.

**The pound now goes through the UK international character set** (`ESC R 3`),
in which the printer draws the ASCII byte `0x23` as `£` whatever code page it is
on. `ESC R` is the oldest command in the standard and does not depend on the code
page at all. A real code page is still selected underneath it, so accented names
on a receipt are unaffected.

The cost is one character: a genuine `#` cannot be drawn and prints as `No.`. A
venue that would rather have the `#` than a guaranteed `£` can pick a code page
in Settings › Printers; the default is the safe one.

**A separate bug found beside it, and fixed.** The character-set menu offered
`ISO_8859-1`, which is not in the printer capability profile at all. Choosing it
threw inside the generator — and because the failure was recorded on the
generator, **every subsequent document failed too**. That is a printer that
produces no paper at all, offered as a fix for a wrong glyph. It is off the menu,
and an unresolvable setting now falls back instead of throwing.

**The test slip now prints the pound under every setting at once**, labelled. The
old slip printed one and said "if this is wrong, change the setting and print
another" — a loop a venue runs four times, over the phone, mid-service. Now
whichever line shows a `£` names the setting to pick.

### 9. The taskbar icon

The Store package's icons were all generated by scaling the brand master to fill
the canvas, so on the taskbar Vesopa was a solid green square filling its whole
cell while every app beside it drew a glyph with a margin. That is the "should
match width height with others".

The `Square44x44Logo` family — and only that family — is now re-rendered with the
mark at 78% of the canvas, centred, on transparency. The tiles are untouched:
they are full bleed on purpose, because `msix` writes
`BackgroundColor="transparent"` with no way to configure it, and a padded tile
would put a floating green square on the user's accent colour.

Built with `tool\build-store-msix.ps1`, which runs the normal package build and
then unpacks, re-renders those icons and repacks. Repacking is safe precisely
because a Store package is unsigned — Microsoft signs it on ingestion — and it is
what regenerates `AppxBlockMap.xml`, which is why the files cannot simply be
swapped inside the zip.

---

## One more thing, not asked for

`test/widget_test.dart` had been failing for some time and taking **ten minutes**
of every test run to do it — it was timing out on a pending timer, not on
anything it was testing. `flutter_test` unmounts whatever is left at the end of a
test *body* and checks for pending timers there, before any tear-down runs, so a
tear-down that unmounts the tree is already too late. It also needs a pump that
*advances the clock*: cancelling a drift stream schedules its cleanup with
`Timer.run`, and a zero-duration `pump()` does not run it.

The full till suite is 493 tests and now takes 50 seconds.

---

## Test counts

| Suite | Tests |
| --- | --- |
| Till (`flutter test --exclude-tags "live \|\| golden"`) | 493 |
| Back office (`npm test`) | 22 + 19 + 12 + 9 + 46 + 18 + 22 + 7 + 52 + 52 + 9 + 11 + 10 + 18 + **29 import** + **50 reports** + 23 |
| Customer display (`flutter test`) | 19 |

New suites in this release:

* `vesopa_epos/test/void_reason_keyboard_test.dart` — 4
* `vesopa_epos/test/sign_on_pad_test.dart` — 4
* `vesopa_epos/test/customer_display_test.dart` — 9
* `vesopa_server/test/imports.test.js` — 29
* `vesopa_server/test/reports.test.js` — 50
* `vesopa_epos_display/test/display_test.dart` — 19

`printer_code_page_test.dart` was rewritten around the new default and now
asserts against the **X and Z report itself** rather than the test slip that
happened to be convenient — the report was the document that was reported wrong.
