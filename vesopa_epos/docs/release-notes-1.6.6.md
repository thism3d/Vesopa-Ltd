# Vesopa EPOS 1.6.6 — release notes

Store submission: `msix_version: 1.6.6.0` (previous build here was 1.6.5.0).
Flutter `version: 1.6.6+27`.

**Vesopa Customer Display moves too**, to 1.6.5.0 — see
`vesopa_epos_display`. It holds the finished sale for twenty seconds instead of
the idle time.

**Vesopa Kitchen does not move.** Nothing in it changed. It stays on 1.5.0.0,
and the modifier work below needed nothing from it — a modifier line is one
with a parent, which the kitchen board already draws indented.

**Minor, not patch.** There are new ways for money to move: a bill can be
divided and each share paid on its own, a price can be overridden, and money
can be given back.

**Server: three schema changes, all applied and verified.**
`schema_till_pay_bars.sql`, `schema_product_modifier_flag.sql` and
`schema_till_consolidate.sql`. Each is guarded and was applied three times in a
row against the live database. Every default is what the till does today, so a
venue that opens none of these settings sees no change at all.

---

## Split a bill the way a table actually asks for it

The bill starts as a pool. Pick a few items, press once, and they leave the pool
and become a share of their own. Then the next few. The pool drains to zero in
front of you, which is the whole check that nothing has been forgotten.

Each share is a card with its own total, its own **Bill** to print and its own
**Pay now**. Three people wanting three slips before anybody pays is the
ordinary case in a restaurant, and until now the till could not produce them.

What is left in the pool is a share too — two people paying and the rest
settling together is a normal way to split a bill.

**By round** is the part no other till does. A table two people served an hour
apart is already divided, and the till knows it: one press fills the cards from
the rounds rather than making anybody rebuild it by hand.

An offer on the bill is shared out in proportion. £6.05 off a £60.50 table used
to go entirely to whoever paid first; two people splitting it down the middle
paid £24.20 and £30.25 for the same half each, with nothing on screen to say
why.

**Split** is now a key a venue can put on a bar, so it can sit on the sale
screen where a table asks for it rather than on the payment board.

## Refund

Off a receipt first: find the sale, tick what is coming back, and the screen
says how it was paid so it goes back the same way. Without a receipt is there
too, under a manager's key and a required reason — it is the one thing on the
till that takes money out of the drawer with no document behind it.

Card refunds are still raised on the card machine. This records that it
happened, and by whom.

## Barcodes

Scan a product and it rings up. Scan one the till has never seen and it offers
to add it — name, price, tax rate, department, sub department — and sends it to
the back office, so every till in the building gets it and the next catalogue
sync does not wipe it.

## Counting the drawer

**Float** at the start of the shift. It has printed on the Z since the first
release and there has never been a way to enter it, so "cash expected" was
always the takings rather than what should actually be in the drawer.

**Cash declaration** at the end, if the venue wants one: a quick total or a
full count on the denomination grid. The Z then prints BALANCED, OVER or SHORT.
Nothing is printed when nobody was asked — "not counted" and "counted, and it
was empty" are different facts.

## Six more keys a venue can place

**Table Plan** opens the floor, always — unlike Save Table, which saves
silently when the bill already has one. **Price Check** answers "how much is
the Malbec?" and adds nothing to the bill, whatever is tapped. **Product
Search** finds an item in a catalogue of five hundred and rings it. **Price
Override** charges something else for a line, under permission, and records it
as a price rather than a discount so it does not sit in the discount column all
week. **Refund** and **Split**, above.

## Reprint a Z

Seven days back, rebuilt from the sales rather than a stored copy, so the
figures come out identical to the paper. The printer having no paper at eleven
at night is not a reason to lose the day's Z.

## Smaller things

* **The customer is on the bill.** A card at the top of the check: who they
  are, their discount, their points where the till has a live figure, their
  contact details. A way to change them or take them off. Nothing at all when
  no customer is attached.
* **"Is a Modifier"** on a product. Tick it and the product can only be sold
  attached to another — "No ice", "Extra shot". Pick the item on the bill, tap
  it, and it goes underneath.
* **The check view fits a square till.** It was a fixed 420px: a fifth of a
  widescreen and two fifths of a 1024×768 panel. It is now a share of the
  width, and its type sizes from the width as well as the height so nothing
  truncates.
* **The payment screen wears the venue's bars**, its own pair rather than the
  sale screen's — a bar carrying Void and Save Table means nothing once the
  bill is being settled.
* **The payment screen's check is quieter**: the venue name, address, staff
  name and time have gone. Round headings stay, but only on a bill that has
  more than one round.
* **Turn consolidation off** and the bill lists `Carling, Carling, Carling`
  instead of `3 × Carling`. Some venues read the bill back to the table that
  way, and a line each is a line each to void.
