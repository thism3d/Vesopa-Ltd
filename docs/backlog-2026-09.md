# Till backlog — September 2026

Eighteen items from the client, in the order they were sent. Recorded here
because a list this long does not survive in a chat window, and because half of
them turn out to be smaller than they read: Vesopa already has the machinery,
and what is missing is a key, a flag or a column.

Each item says **what exists today**, so nobody rebuilds something that is
already there. Line references were checked on 2026-09-07.

---

## 1. Customer display: hold the sale, then say thank you

Show the finished transaction and a Thank You for a set time — 20 seconds by
default, adjustable — and drop it immediately if the till starts a new sale.
Settable both from the till and in the display app's own settings.

**Exists:** the thank-you message itself, all the way through. The till pushes
it (`vesopa_epos/lib/data/customer_display_control.dart`, `thank_you`), the
display stores its own (`vesopa_epos_display/lib/data/settings.dart`,
`display.thank_you`) and `_Totals` in `bill_panel.dart` draws it whenever the
basket is `paid`.

**Missing:** the clock. Nothing decides how long `paid` stays on screen or what
replaces it. Needs a hold duration on `epos_till_settings`, pushed through the
existing control channel, plus the same field in the display's settings page,
and a timer in `display_page.dart` that a new basket cancels.

## 2. "Is a Modifier" on a product

A tick box on the product. Ticked, the product cannot be sold on its own — it
attaches to a line already on the bill. Select Vodka & Coke on the check, tap
No Ice, and it hangs underneath.

**Exists:** more than expected. `epos_order_lines.is_modifier` and `line_no`
(`schema_screens_modifiers_lines.sql`), the till's `parentLineId`, the same
flag on `epos_kitchen_ticket_lines`, and indenting already implemented in the
receipt builder, the kitchen board and the customer display's `_Line`.

**Missing:** the flag on the product itself (`bo_products.is_modifier`), the
back-office tick box, and the till rule — refuse to ring one with no line
selected, attach it to the selected line otherwise.

**Note:** this is *not* the existing modifier-group feature
(`epos_modifier_groups`), which is a question a product asks when rung. This is
a product that is only ever an answer. Both should exist; see the questions.

## 3. Itemised split bill

Default to splitting a bill by item, keeping the current methods for venues
that prefer them.

**Exists:** more than it looks. `TenderState.splitByItems(groups)` is built
and unit-tested (`tender_engine_test.dart`), `SplitShare.lineIds` records which
lines a share covers, and `_SplitDialog` in `redemption_dialogs.dart` already
offers "By item" beside "Equally". Also `allow_split_bill` in commerce settings
and `orders.split_from_order_id` in the till database.

**Missing:** three things, none of them the engine.

1. **It opens on Equally.** `_byItem` starts false, so the method the client
   wants by default is the one behind the second tab.
2. **The screen is a cramped `AlertDialog`** — a 440px box of `ListTile`s, each
   with a row of numbered chips to assign a share. Twenty items on a table is
   twenty rows of chip-tapping. This is the part the Newbridge video is for.
3. **Offers land on share 1.** `splitByItems` puts everything it cannot
   attach to a line onto the first share. Client has chosen pro-rata instead.

**Correction:** an earlier draft of this file said the itemised method did not
exist. It does. It was found by grepping for callers of `splitByItems` rather
than for the words "split bill", which is the only reason the mistake surfaced
before the work started.

## 4. The check view is too big on a 4:3 till

**Exists:** `PosLayoutX` in `vesopa_epos/lib/ui/layout.dart` decides everything
from width alone — under 600 phone, under 1100 tablet, otherwise desktop.

**Missing:** any notion of shape. A 1024×768 square till is "tablet" at a width
that is nearly desktop, and the check view takes a desktop share of a screen
that has none to spare. Needs the aspect ratio in the decision, and a narrower
check on a square screen.

## 5. Payment screen: drop the venue name, address, staff name and time

From the check view *on the payment screen only* — the sale screen keeps them.

## 6. Payment screen: top and bottom bars

Scale the payment keys down slightly so both bars fit. The top bar goes after
`Payment |`, leaving the back button and the title alone; the bottom bar sits
where the sale screen's does. Both programmable from the back office. Only the
bars — not the whole payment screen.

**Exists:** the entire bar system. `epos_screens.surface` already takes
`topbar` and `bottombar`, `BAR_KEYS` in `vesopa_server/src/screens.js` lists 30
keys, `ProgrammedBar` draws one, and `epos_till_settings` carries the venue's
defaults (`schema_till_bars.sql`).

**Missing:** two more columns for the payment screen's own bars, the till
reading them in `payment_page.dart`, and room made for them.

## 7–10. Four functions that can go on a bar

* **Table Plan** — opens the floor plan. Its own key, because Save Table
  opening the plan confuses people who have used other tills.
* **Price Check** — look a price up without ringing it.
* **Product Search** — find a product by name.
* **Price Override** — change a line's price, under permission.

**Exists:** the key mechanism. Each is a new entry in `BAR_KEYS`, the back
office offers it in the button editor, and the till handles it. `tables_page`
and `table_picker` already exist for the first.

## 11. Refund mode

**Exists:** `TillPermission.refund` (`can_refund`) and a `refund` event kind in
the till's log, counted by the Z report (`session_repository.dart`).

**Missing:** the mode itself. See the questions — recalling a receipt and
refunding lines from it is a different build from ringing a negative sale.

## 12. Reprint Z reports

From the Functions page, for the last few days.

## 13. Barcodes

A barcode against a product in the back office; and on the till, scanning an
unknown barcode offers to create the product then and there — name, price, tax
rate, sub department, department.

**Missing:** all of it. `barcode` in the codebase today is wallet passes and
receipt printing, nothing to do with products.

## 14. Float button

Staff type in the float.

**Exists:** `openingFloatMinor` on the till's session table, already printed on
the Z report as "Opening float".

**Missing:** any way to enter it.

## 15. Cash declaration

A setting. When on, the till asks what is in the drawer before a Z report, and
the Z prints whether the till is up or down.

**Exists:** `schema_cash_denominations.sql`, `cash_tally.dart` and
`cash_notes_panel.dart` — a venue's denominations and a grid to count them.

## 16. Turn consolidation off

Some venues want `Carling, Carling, Carling`, not `3 x Carling`.

**Exists:** the merge, in `order_repository.dart:57` — ringing the same product
bumps the existing line's quantity. A product carrying modifiers is already
exempt.

**Missing:** a venue setting to skip the merge.

## 17. The Functions page as a bar key

So it can be reached from the top or bottom bar.

**Exists:** `go_functions` is already in `BAR_KEYS`. Worth confirming on a till
before building anything.

## 18. Pay one staff member's round, or both

*(Screenshot: Table 1, "Nicky · 19:08" and "Muzahid Islam · 15:21".)*

One table, two rounds rung by two people for two different customers. Each must
be payable on its own by selecting it, with the option to select both and pay
together.

**Exists:** the grouping is already on screen — `live_receipt.dart:268` draws a
run of items under a staff heading, and suppresses the heading when the whole
bill is one block.

**Missing:** selecting a group, and paying only what is selected. This is the
same machinery as item 3, arriving from the other direction: item 3 selects
items, this selects a round. Build them together.

**Open:** a bill-wide offer. Table 1 carries −£6.05 across £60.50; splitting it
means deciding whose discount that is.

## 19. The customer, visible on the bill

Once a customer is attached, show who they are on the check, with a way to
change them. No customer attached, the check looks exactly as it does now.

**Exists:** the whole record, on the order already —
`orders.customerId`, `customerName`, `customerDiscountType` and
`customerDiscountValue` (`database.dart:289-321`), plus `customer_picker.dart`
for choosing one.

**Missing:** drawing any of it. The check view has never shown the customer.

---

# Decisions

Taken with the client on 2026-09-07, so nobody has to re-litigate them.

**Order of work.** Payment and split first — items 3, 4, 5, 6 and 18. Item 18
arrived as a live complaint from a real till, and it is the same machinery as
item 3 approached from the other end, so they are one piece of work.

**Refund mode (11).** Both, receipt first. Recalling the sale is the default
path and refunds go back to the tender they came from; ringing a blank refund
is the override, and it wants a manager permission on it.

**Splitting an offer (3, 18).** Pro-rata by share value. Every share carries
its portion of the offer in proportion to what it is worth, so the split always
adds back to the bill total and nobody is asked to make a judgement with a
table waiting.

**Cash declaration (15).** The venue chooses: a quick total, or a full count on
the denomination grid that already exists.

**Customer card (19).** The clerk's check shows the full record — name,
discount, balance, phone, email. The customer-facing display shows **none of
it**, and that pairing is the point: full detail is safe precisely because only
staff can see it. The display faces a queue.

**Staff headings on the payment screen (5 vs 18).** These two requests
contradict each other — item 5 says strip the staff name, item 18 needs it to
pick a round. Resolution: headings appear only when the bill has more than one
round. A single-round bill gets the clean stripped check that item 5 asked for;
a table with two rounds keeps the headings, because there they are doing a job
rather than adding clutter. Venue name, address and time go in both cases.
