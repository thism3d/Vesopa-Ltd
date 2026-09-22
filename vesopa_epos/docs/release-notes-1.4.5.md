# Vesopa EPOS 1.4.5 — release notes

Store submission: `msix_version: 1.4.5.0` (previous submission was 1.4.2.0).
Flutter `version: 1.4.5+17`.

**The fourth part of a Store version must be 0.** Microsoft reserves the
revision field and rejects a package that sets it — which is why the numbering
here walks the third part and never the fourth. Both pubspecs have said so in a
comment beside `msix_version` all along.

`1.4.3.0`, `1.4.3.1` and `1.4.4.0` were built on this machine and never
submitted. `1.4.3.1` should never have existed: it was built to carry the
Windows icon rebuild and set the revision field to do it, which the Store would
have refused. Nothing went to Partner Center, so no version is spent — this is
simply the first one that is correct.

**Server: changes required, and already applied to live.** Deployed with
`.\deploy.ps1 -Schema` on 26/08/2026. Two new migration files:

* `schema_screens_modifiers.sql` — `epos_modifier_groups` and
  `epos_product_modifiers`, the questions a product asks and the order it asks
  them in.
* `schema_screens_modifiers_lines.sql` — `is_modifier` and `line_no` on
  `epos_order_lines`, `is_modifier` on `epos_kitchen_ticket_lines`, and
  `room_id` on `epos_orders`.

Both are guarded and safe to re-run. Verified on live: all four columns and both
tables are present.

**This one is not order-independent.** The till writes `is_modifier`, `line_no`
and `room_id` on every sale it pushes, so the server must be migrated *before*
tills are updated, or order sync fails on the new columns. It has been.

An older till meets the new server harmlessly — it sends none of those fields
and every one of them defaults to what was true before it existed: a line is an
item in its own right, and a bill is on no particular floor.

Vesopa Kitchen moves to 1.4.5.0 with this release and must be updated alongside
it if the venue runs kitchen screens; see its own notes.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version. 1,350 of the 1,500 characters Partner Center allows — count it again if
you edit it; there is about a line and a half of room.

```
Version 1.4.5.0 – Ask The Right Question

Modifiers, a Z report you can act on, and the till asking before it rings.

Modifiers: A product can now ask a question before it goes on the bill — which mixer with that gin, how the steak is cooked, single or double. Set the questions up in the Back Office, lay the answers out on a grid exactly like a sale screen, and the till asks them in the order you chose. A priced answer is charged, appears under its item on the bill and the receipt, and goes to the kitchen under the dish it belongs to.

A Z Report Worth Reading: Every line now carries a count beside the amount, so you can see what an average has done and not just what the total was. Covers, average spend, discounts, refunds and gratuity each have their own section, and voids sit next to no-sales — with counts — because that is the pair worth checking.

Your Cash Drawer On Cash Sales: The drawer opened on No Sale but not when a sale was paid in cash. It now opens as the sale settles, before the change is shown.

Two Tables Numbered One: A Table 1 upstairs and a Table 1 on the terrace shared a single bill. Each keeps its own.

Pictures On Programmed Keys: A picture set on a screen button now actually appears on the till.

More Room On The Check: The venue name, address and clock are gone from the check, leaving the items the space.
```

---

## What changed, in full

### Modifiers

A product carries an ordered list of modifier groups. Each group is one prompt
on the till, and the answers hang off the sale line underneath the product they
belong to.

A group **owns a screen**. `epos_screens.surface` had carried the comment
"always 'sale' today" since the first migration, left open for exactly this, so
a grid of answers is laid out by the screen editor that already exists —
colours, spans, pictures and all — and reaches the till in the same fetch as
every other screen. There is no second editor and no second sync path.

An answer is a real order line with `parentLineId` set, not text on its parent.
That is what makes a 50p mixer price itself, carry its own VAT, void with its
drink, and land in the Z report as what was actually sold. Nesting is left as a
display concern, done once and used by the check, both receipts, the paper
kitchen ticket and the kitchen board.

Three faults were found while building it, each worse than the feature:

* **A modifier was routed by its own product**, and nobody routes "Rare" to the
  grill. The steak printed and its temperature did not — silently, on a ticket
  that looked complete. Routing is now resolved per line, a modifier following
  the dish it belongs to.
* **Receipt lines came back from the server in random order.** The table's
  primary key is a UUID and the reads had no `ORDER BY`, so rows arrived
  clustered by it. Unnoticed because a shuffled receipt still adds up; fatal for
  a modifier, which means nothing three lines below its drink. Lines now carry
  their position and are read back in it.
* **A cleared checkbox in the Back Office submits the string `"0"`**, which is
  truthy in JavaScript, so every `!!value` read as ticked. The harmless end was
  "creating a new page still copies the page". The dangerous end was "Replace the
  existing catalogue first" on the starter-template dialog, which wiped a venue's
  catalogue whether or not anybody asked it to.

### The Z report

Was a total per tender and a total per department. Now every line is a count and
an amount, because the money alone does not answer the question being asked:
"Drink 204.40" says the bar took two hundred pounds; "Drink [55] 204.40" says it
did so across fifty-five items.

Added: covers, average spend, average cover, discounts, refunds, and gratuity
held apart as money owed to staff rather than takings. Voids sit beside no-sales,
both with counts.

**Voids could not be counted at all before.** They were written to the outbox,
and the outbox row is deleted the moment the server acknowledges it — so a till
that was online reported no voids whatsoever. The one condition under which the
figure matters least was the only one that worked. Voids and no-sales now go to
a till-local log that nothing deletes.

Kept, against the reference report this was matched to: the float and what
should be in the drawer. Counting cash against a figure the till worked out is
the entire reason a Z is taken at a counter.

### Fixes

* **Cash drawer on cash sales.** `openCashDrawer` was only ever called from the
  No Sale key. It now fires as a sale settles — before the change box, since the
  clerk's next move is to take notes out of a drawer that has to be open — for
  any bill with cash in it, splits included.
* **Two tables numbered 1.** The floor plan has allowed a Table 1 per room since
  the unique key moved to (room, number), but an order knew only a number, so
  both tables shared one bill and a Terrace ticket printed "Main Floor". An
  order now records its room; bills parked before this still resolve.
* **A picture on a programmed key never appeared.** The Back Office stores
  on-site paths and the till handed one straight to `Image.network`, which
  cannot load a bare path and failed into an error builder that draws nothing.
* **The till's own top bar** stands down on the Sale screen where a programmed
  top bar is drawing, so there are no longer two. It stays everywhere else,
  where nothing would replace it, and the one thing it carried that a bar could
  not — whether the kitchen ticket landed — is now a key you can place.
* **The check** drops the venue name, address and clock, leaving the item list
  the height. The printed receipt still carries all three.
* **The Windows icon** was regenerated from the 1024px master into all ten
  frames the shell asks for. The till's was already correct; Vesopa Kitchen's
  was not — see its notes, and the shared reason in
  `tool/make_windows_icon.dart`.

---

## Before submitting

1. `dart run tool/make_windows_icon.dart` if `flutter_launcher_icons` has been
   re-run since the last build — it overwrites the multi-frame icon.
2. Build with the Dojo key defined if this build is to take live card payments;
   it is never in source:
   `flutter build windows --dart-define=DOJO_LIVE_API_KEY=…`
   **The package built for 1.4.5.0 was built without it**, so it carries the
   bundled sandbox key. Rebuild before submitting if live card payments are
   wanted from the Store build.
3. `dart run msix:create --store`
4. `msix_version` can never be reused, and its fourth part must stay 0 — the
   Store reserves the revision field and rejects a package that sets it. So a
   resubmission after a failed certification bumps the *third* part: 1.4.6.0,
   never 1.4.5.1.
