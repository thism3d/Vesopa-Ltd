# Vesopa EPOS 1.4.2 — release notes

Store submission: `msix_version: 1.4.2.0` (previous submission was 1.4.1.0).
Flutter `version: 1.4.2+13`.

**Server: changes required, and already applied to live.** Deploy
`vesopa_server` with schema migrations (`.\deploy.ps1 -Schema`).
`schema_screens_bars.sql` adds `emoji` / `image_url` to screen buttons and the
per-screen bar columns; `schema_till_bars.sql` adds `top_bar_screen_id` and
`bottom_bar_screen_id` to the till-settings row. Both are guarded and safe to
re-run.

An older till meets the new rows harmlessly: it does not ask for a bar, and a
`surface` it has never heard of parses as unknown and is skipped rather than
failing the venue's whole layout. So the two can be rolled out in either order.

Vesopa Kitchen is unaffected and stays at 1.4.0.0.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version. 1,495 of the 1,500 characters Partner Center allows — count it again if
you edit it, there is almost no room left.

```
Version 1.4.2.0 – Your Screen, Top To Bottom

Lay out the whole till from the Back Office, and a terminal that repairs itself.

Your Own Top And Bottom Bars: The strip of open tables across the top, and the keys along the bottom — Void, Cancel, Save Table, Pay — are now laid out in the Back Office like any other screen. Move them, resize them, recolour them, or leave them exactly as they are.

Your Tables Stay Where You Want Them: The open-tables strip is a key you place, so it can sit beside a clock, the bill total, who is signed on, and your venue's name.

Pictures And Emoji On Any Key: A key that jumps to another page can now carry your own photo or an emoji instead of just a word. Product keys still show the product's own picture unless you give them a different one.

Choose What Your Tills Open With: One place in the Back Office names your sale screen, your top bar and your bottom bar, with a drawing of a till beside it.

A Terminal That Will Not Start Now Repairs Itself: A till interrupted mid-update could come back stuck on a loading spinner for good, and the only cure was deleting a folder by hand — which threw away sales not yet sent. It now repairs its own storage on start-up, keeps every sale, and offers a recovery screen if anything is still wrong.

Layouts Reach The Counter: A screen saved in the Back Office now appears on every till in the venue straight away.

On A Handheld: A crowded bar scrolls sideways rather than shrinking its keys past being hittable.
```

---

## What is in it

### The bars are layouts too

A bar is a screen. The open-bills strip along the top and the action bar along
the bottom are one or two rows of the same buttons the sale grid is made of,
told apart by `epos_screens.surface` — a column that has been on that table
since the first screen-programming migration saying *"Always 'sale' today"*.

So the editor, the undo stack, the drag-select, the whole-grid save, the socket
push and the tenancy scoping all worked on bars the day they existed, because
none of them ever asked what kind of screen they were holding.

Null everywhere still means the built-in bar. That is the venue's answer, not an
absence of one, and it is what a venue gets back the moment it deletes the bar
it made.

**The trap this could have been.** The top bar *is* the open-bills strip. A
venue that programmed its own and could not put the tables back would silently
lose the ability to run two bills at once — and would find that out at a counter
on a Friday, not in an office on a Tuesday. So `open_bills` is a key you place,
widen and colour, drawn by the same widget the built-in bar uses; and the editor
reports a top bar with no tables key, or a bottom bar with no Pay key, under
**Needs attention**. Neither is broken. Both are a layout somebody will save,
walk away from, and meet in service.

Alongside it: `clock`, `order_total`, `staff_name`, `venue_name`, `sync_status`,
`screen_name` and `spacer`, plus every key the built-in bar has and the nav rail
as `go_*` keys — which a venue that hides the rail to buy back 208px of bill
needs somewhere to put.

See `docs/screen-programming.md` §9.

### A key can have a face

Buttons gained `emoji` and `image_url`, falling back to the product's own.

Until now the only way a key could carry a picture was to *be* a product that
had one, so the venue that photographed its menu could not put its own picture
on the FOOD key that leads to it. The fallback is what stops the feature quietly
un-decorating every screen already programmed; the editor draws a borrowed face
faded and disables **Remove** on it, so "has a picture" and "was given a
picture" stay distinguishable.

Pictures are on-site only — `/uploads/…` or `/assets/…`. A till on a venue
network with no route to the open internet must not be able to draw a broken
frame across its sale screen, weeks after the layout was arranged, in front of
customers.

### "How do I choose the screen my tills open on?"

Asked by people looking straight at the tick box that does it. A tick box on the
screen you happen to be editing answers *is this one the default*; it never
answers *which one is*.

The page now opens with three named choices — sale screen, top bar, bottom bar —
and a small drawing of a till beside them, each part labelled with the layout it
is wearing and clickable as the way in to editing that part.

### A press that landed on the wrong key

Found while adding the card above, and worth more than the feature that found
it. `grid.focus()` ran *before* the editor measured the grid, so on any page
tall enough to scroll, the focus scroll moved the grid between the pointer's
coordinates being taken and the grid's box being read. The first press after
landing on the page selected a key one or two rows from the one under the
finger; every press after it was right, because nothing scrolled the second
time.

Intermittent, only on a short window, and impossible to reproduce on the machine
of whoever it is reported to — which is precisely the shape of "the editor is
buggy on my Windows 11 laptop". Geometry first now, and
`focus({ preventScroll: true })` second.

### A bar on a narrow terminal

A bar is laid out in an office against a counter terminal and met on whatever
the venue is holding. Sixteen keys across a handheld is 25px each. Below 72px a
key stops shrinking and the bar scrolls sideways instead — the same figure
`PosActionBar._minKeyWidth` uses, and the trade that leaves the venue's layout
intact rather than silently rearranging it.

---

## Carried in from the same work, not previously packaged

1.4.1.0 was built before these landed, so they reach the Store here.

### The till that would not start

Three faults wore one spinner, and clearing AppData cured all three — at the
cost of any sale in the outbox that had never reached the back office.

The third is the real one: drift writes the schema version *after* the migration
steps finish, so a terminal killed in between comes back with the columns
present and the version behind. The migration re-runs, SQLite refuses with
`duplicate column name`, the open fails, the version is never written — so it
happens again on every launch, for ever, on a database `PRAGMA quick_check`
calls perfectly sound.

Every column migration is idempotent now, storage is checked and repaired before
any provider reads it, and anything still stuck meets a recovery screen after
twelve seconds instead of a spinner. The rule throughout: preferences may be
thrown away, sales may not.

### A layout saved in the office reached no till

The terminal never sent the `subscribe` frame for its own venue, and nothing
invalidated the screens once they had been fetched at sign-on. A manager could
lay out a page, watch the back office confirm the save, and find every till in
the building still showing the old one until somebody restarted the app.

### Programmed keys lost their pictures

A venue that photographed its menu lost every picture the moment it programmed a
screen, with nothing to say why. Programmed keys draw the product's picture,
emoji and running offer, exactly as the catalogue grid always has.

---

## Known issues, unchanged by this release

`widget_test` (a pending-timers assertion), `functions_page_layout_test` (a
golden generated on macOS) and the two `dojo_*_live_test` suites (need a live
account) were failing before this work and still are. Each was confirmed
unrelated by re-running it against the previous code.
