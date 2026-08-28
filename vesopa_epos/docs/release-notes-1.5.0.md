# Vesopa EPOS 1.5.0 — release notes

Store submission: `msix_version: 1.5.0.0` (previous build here was 1.4.7.0).
Flutter `version: 1.5.0+20`.

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it, so the numbering walks the
third part and never the fourth.

**Minor, not patch.** 1.4.x was a run of fixes and one feature at a time. This
one adds a capability the till did not have — a venue's terminals can see each
other — and it carries a local database migration. That is what a minor version
is for.

**Vesopa Kitchen moves too, to 1.5.0.0** (from 1.4.5.0). It gains a night
theme and nothing else; a venue that is happy with the board it has does not
need this update, and nothing in the till requires it.

---

## Server: changes required, and already applied to live

Deployed with `.\deploy.ps1 -Schema` on 28/08/2026. Two new migration files,
both guarded and safe to re-run:

* `schema_terminals.sql` — five tables behind terminals that know about each
  other: `epos_open_bills`, `epos_open_bill_revs`,
  `epos_open_bill_tombstones`, `epos_clerk_sessions`, `epos_time_clock`.
* `schema_screens_button_modifier.sql` — `modifier_group_id` on
  `epos_screen_buttons`, for a key that asks a question.

Verified on live afterwards rather than inferred from a clean deploy log — the
lesson of 1.4.6. `information_schema` answers:

```
epos_clerk_sessions          7 columns
epos_open_bills             16 columns
epos_open_bill_revs          2 columns
epos_open_bill_tombstones    5 columns
epos_time_clock             11 columns

modifier_group_id   int(11)   YES   NULL
```

**Order matters, and the server is already ahead.** Saving a layout INSERTs
`modifier_group_id`, so an un-migrated server would answer every save with
`Unknown column` and a venue could not programme anything. The server has the
column; this is a note for a rebuild rather than an instruction.

**A till on 1.4.7 is safe against this server.** The new column is null on
everything that exists, the new tables are only read by routes a 1.4.7 till
never calls, and `kind` has always been a string precisely so an older till
meets a newer key and draws it inert rather than failing to parse the screen.

**A 1.5.0 till against an un-migrated server** loses shared tables and the time
clock — both endpoints 404 and both are written to fail quietly — and keeps
selling exactly as it did. That is the whole design rule of the new code: none
of it is on the path that takes money.

### The deploy script itself

`deploy.ps1 -Schema` aborted half way through the migrations, with the code
extracted and pm2 not yet restarted. MariaDB prints `mysql: Deprecated program
name` on **stderr** and exits 0 — a warning — and PowerShell 5.1 turns any
stderr from a native executable into a terminating error under
`$ErrorActionPreference = 'Stop'`. The script now prefers `mariadb` where it
exists and filters that one line. Worth knowing about because it will happen
again to anything else on this box that shells out to `mysql`.

---

## What is in it

### Terminals that know about each other

This is the release's reason for existing, and it is three things that are
really one: **a bill, a clerk and a shift belong to the venue, not to the
machine that happens to be nearest.**

Everything before this treated a till as an island. It kept its open bills in
its own file and told the server about a sale only once the money was taken —
exactly right for the thing that must keep working with the broadband down, and
exactly wrong for a dining room with two terminals in it.

**Table 6 saved at the bar is recalled at the station by the door.** Open bills
are pushed to the back office as they change and pulled back by every other
terminal in the venue, so the table plan, the table picker and the open-bills
strip all draw the whole room rather than one till's corner of it.

The implementation is a *mirror*, not a second list: another terminal's bills
are written into this terminal's own tables, marked with which machine is
holding them. Nothing downstream had to be taught about a second source of
bills — the alternative, merging a parallel list in three places, is three
chances for a table to appear on the plan and not in the picker.

* **Exactly one terminal owns a bill at a time.** A table another till is
  holding is drawn, and says which till, and has to be *taken over* before it
  can be rung up on or settled. That is not tidiness: two terminals settling
  one check is money taken twice.
* **A plan that has gone stale says so.** An "All tills" chip on the Tables page
  turns to **Not in step** when this terminal stops hearing from the others,
  because a plan that has quietly stopped updating looks exactly like a quiet
  night — and a clerk who reads it as one seats a party on an occupied table.
* **The kitchen is not re-fired.** A bill carries which of its lines have
  already been sent to a printer, so a course recalled on the second terminal
  is not cooked twice. A kitchen that learns to ignore duplicate tickets is a
  kitchen that will eventually ignore a real one.

**A clerk can only be signed on to one terminal at a time, and their items
follow them.** Signing on somewhere does not add a session, it *moves* the one
that exists — the database has one row per member of staff and nowhere to
record a second. The reason is not tidiness either: a PIN live on two machines
means two baskets, and the second one they walk away from is a round of drinks
nobody is charged for.

The half that makes moving it better than refusing it: if they were part-way
through a bill on the other terminal, this one **offers to bring it with them**,
names the terminal it came from and says what is on it. It is an offer and not
an automatic action — somebody who walked to the second till to start something
new should not find a half-rung round already on the screen.

**Offline, all of this does nothing and the till still works.** A terminal that
cannot reach the back office signs staff on, rings up, prints and settles
exactly as it did before, on the bills it is holding itself. What it loses is
sight of the others', and it says so.

### Clock in, clock out

A shift is one row that opens when somebody arrives and closes when they leave,
and it is what a wage is paid against. Deliberately **not** the same thing as
signing on, which says "I am about to ring something up on this machine",
happens twenty times a service, and ends every time a clerk walks away.

* One key and one list: everybody who could be on, with the ones already in
  marked as in and their hours so far beside them. Clocking in and clocking out
  are the same key, and the server's own state decides which — so a double tap
  cannot open two shifts or close one twice.
* **A PIN is asked for either way.** A time clock anybody can punch on a
  colleague's behalf proves nothing, which is the entire reason a venue asks for
  one rather than a sheet of paper by the door.
* Both ends record which terminal they happened at, because "clocked in at the
  bar, out at the door" is a question a manager does ask.
* The back office reads them at **Reports › Timesheets**, with the minutes
  worked computed in SQL so an export and the screen cannot disagree, and with
  an open shift counted to now — a manager looking at lunchtime wants what the
  person on the floor has done so far, not a blank. A shift somebody forgot to
  close can be corrected, and a corrected row is visibly a corrected row.

### A Sign On key

The till has always had Sign Off, which locks the screen and puts the idle
picture up for the next person to type into. That is right at the end of a shift
and wrong in the middle of one: the common case is a colleague stepping in for a
single sale while the first clerk is still standing there, and making them lock
the till, wait for the screensaver and then type into it is three steps for
something that should be one.

**Sign On** names who is on now, lists everybody who could take over, and asks
the new person for their PIN. The bill on screen is left exactly as it is — a
handover is a change of who is responsible, not a change of what the customer
ordered. It is on the Functions page and is a key a venue can place on a screen
or on either bar, beside a new **Clock in / out** key.

### A key that asks a question

Until now a modifier could only be reached by ringing up a product that carried
one. That covers "which mixer with that gin?" and misses what a bar actually
wants: a **MIXERS** key on the screen, pressed against a round that has already
been rung — because the customer has changed their mind, or because the question
belongs to the line rather than to the product.

So a button has a fifth kind, **Ask a modifier question**, on sale screens and
on both bars. It costs almost nothing to carry: a modifier group already owns a
screen of answers, so the till opens the prompt it already knows how to open,
and the editor's "Edit its answers →" goes straight there.

Which line it asks about: the one the clerk has picked, or the last item on the
bill if they have picked nothing — because "gin, then mixers" is the order
somebody actually presses the two keys in.

A key whose group has since been deleted draws as **Unavailable / Question
removed** and refuses the press, and deleting a group in the back office clears
the keys that pointed at it. A key that says nothing is a key a clerk presses
twice before asking anybody about it.

### The pound sign, on paper

"Fix the symbol on the Z and X reports to show £" — and the interesting part is
that the till was already right. It encodes Latin-1 and selects CP1252, which is
correct and works on most hardware. It does not work on all of it: plenty of
cheap thermal printers ignore `ESC t` outright and draw whatever their DIP
switches say, and on the factory default (CP437) the byte behind "£" is "ú". A Z
report reading "ú1,204.40" is not a cosmetic fault; it is a document a manager
hands to an accountant.

* **The character set is a per-printer setting now**, defaulting to CP1252 —
  which is what every printer already set up is being sent, so nothing changes
  for a venue whose printing is fine.
* **A last resort for the printer that will not be told.** `ESC R 3` selects the
  UK international character set, in which the printer draws the plain ASCII
  byte `#` as "£". Every printer ever made supports it; it is the oldest command
  in the standard. The cost is that a real "#" cannot be printed, so it comes
  out as "No." — stated in the setting rather than discovered on a receipt.
* **The test slip is now the instruction.** It prints the character set in use
  beside a sample amount and says, in as many words, that if the amount does not
  show a £ you change this setting and print another one.

And a fault found alongside it: **a Z report went to the receipt printer's
layout even when the venue sent it somewhere else.** A report printer on a 58mm
roll was being handed an 80mm layout, which prints the money off the edge of the
paper. Every document is now built for the printer it is actually going to.

### Screen programming

**Rows and Columns are asked once.** They were on the New screen form *and* on
the toolbar, they disagreed the moment either was touched, and a manager had no
way to tell which had won. They are on the toolbar, where the grid they change
is on screen beside them and a wrong answer is one drag to fix.

**Width and Height are gone from the inspector.** A key had one size and two
places to set it, and the typed one had to re-implement every rule the drag
already enforced — clamping to the grid, refusing to swallow a neighbour,
holding a reservation on an empty cell. The corner handle is the answer, it
works on empty cells as well as programmed ones, and arrow keys still nudge.

**Fill from a sub department.** The department fill is the one thing that turns
laying out a screen from an afternoon into a minute, and it was all-or-nothing:
a venue with 90 drinks could fill 90 keys or type them one at a time. A second
picker narrows it to one shelf — lagers, not the whole bar — and says how many
products that is *before* the press, because that is the number that decides how
big a selection to drag. Two departments can both have a "Bottles"; the shelf is
only ever read against the department showing.

**The editor opens in a window of its own.** It is the one page in the back
office that wants the whole screen, and every manager who used it pressed "Own
window" as their first act. It now does that for them, and "Edit answers" on a
modifier group goes straight into that window rather than into the tab and then
out to it. The tab it left behind says where the editor went and carries both
ways back, and *"Edit in this tab instead"* is remembered.

Only ever off a press. `window.open` outside a user gesture is what every
browser's pop-up blocker exists to stop, so a deep link, a refresh or the back
button leave the editor in the tab, drawn as it always was.

### Day and Night

The senior developer's note about the admin console — that it looks smart and
the back office might follow it — turned into the same question everywhere: a
venue's office and its bar are not the same room.

* **The back office** was light only and now has Night, with a Day / Night /
  Auto switch at the foot of the rail. Everything goes through colour tokens, so
  this is a list of colours rather than a second stylesheet. Two things do not
  invert: the receipt designer's paper, which is a picture of something printed
  in black on white, and the near-black rail, which was already dark and is what
  keeps the two themes reading as one application.
* **The admin console** was dark only and now has Day, the same three-way
  switch, in the sidebar footer. Applied before the first paint from a small
  inline script, because a manager who has chosen Day must not be shown a black
  page flashing on the way to it.
* **Vesopa Kitchen** was light only — deliberately, and the argument was a good
  one: a kitchen is a bright room and a dark board loses contrast to the glare.
  It turns out not to be the only room the thing gets mounted in. A pass in a
  dim service corridor and a late shift with the main lights off both want the
  other answer, and a wall panel at full white in a dark room is a light
  fitting. **Every colour that means something stays exactly as it is** —
  fresh, warn, late, done, rush and the modifier red are the board's whole
  vocabulary, and a chef who has learned that red means "read this bit" must not
  have to learn it twice.
* **The till already had one** and is untouched.

Both themes default to following the machine, and a choice is remembered on the
machine that made it — a screen over the pass and a screen by the door are two
different rooms.

### This till has a name

A venue with two terminals has to be able to tell them apart — on a receipt, on
the bill a terminal is holding, and against the shifts clocked in at it. Until
now the till had no name because there was nothing to tell apart. It defaults to
the computer's own host name, which is already different on the two machines and
already means something to whoever set them up, and it is renamed in Settings ›
This terminal. "Bar", "Door", "Kitchen pass".

---

## Checks

Back office: **221 checks** across `npm test`, including 52 in the
headless-Chrome editor suite. New: the modifier kind and its parity with the
server's list, the sub-department fill (including the shelf name shared between
two departments), and that there is now exactly one way to size a key.

Till: **467 passing** under `flutter test`, with three new files —
`bill_sync_test.dart` (14 checks on the mirror, the loop guard, and the
deletion that must never happen), `printer_code_page_test.dart` (10 on the
pound sign down both paths), and `modifier_key_test.dart` (7). Kitchen: **94
passing**, including a new `theme_skin_test.dart` that holds the two skins to
contrast ratios rather than to taste.

Two things fixed that were failing before this work:

* `programmed_bar_test`'s wire round trip, named as a real bug in the 1.4.7
  notes and left there. A key's `imageUrl` came back **absolute** from
  `toJson`, and the server's `cleanImage` refuses an absolute URL — so a layout
  that went out and came back would have arrived with its pictures stripped. In
  memory it stays absolute, because that is what `Image.network` needs; on the
  wire it is relative, because that is what the server stores. The test asserted
  only the first half, which is how it went unnoticed.
* The editor's "typed width" test, which guarded the number boxes this release
  removes. Replaced with the check that they are gone.

**Four still fail, and all four failed before this work**: two Dojo live tests
that need a network, a Functions-page golden, and a `widget_test` that creates
a real `HttpClient` and times out. That is one fewer than 1.4.7 reported,
because the fifth was the `programmed_bar_test` bug above.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version.

```
Your tills now work together.

  Save a table at the bar and recall it at the till by the door. Every
  terminal in the venue shows the same tables, with the same totals, and
  says which till is holding each one.

  Staff are signed on to one till at a time. Sign on at another and the
  bill you were part-way through comes with you, if you want it.

  Clock in and clock out. Your shift is not the same thing as signing on to
  the till, and managers read the hours in the back office.

A Sign On key hands the till to a colleague in one press, without locking the
screen or losing the bill in front of you.

Put a modifier question on a screen or a bar. A MIXERS key can be pressed
against a round that has already been rung up, not just as the drink goes on.

End of day prints a proper pound sign. If your printer draws it wrong, there
is now a setting per printer to fix it, and the test slip tells you what to
change.

Screen programming: fill a screen from one sub department rather than a whole
department, size keys by dragging the corner, and the editor opens in a window
of its own.

Dark and light themes in the back office and the admin console. The till
already had them.
```
