# Vesopa Kitchen 1.4.0 — release notes

Store submission: `msix_version: 1.4.0.0` (previous submission was 1.3.8.0).
Flutter `version: 1.4.0+2`.

One feature, asked for by a working kitchen after using 1.3.8 in service: let a
chef cross an item off once it has been cooked, and finish the ticket when the
last one goes.

**Server: changes required.** Deploy `vesopa_server` and run the schema
migrations (`deploy.sh --schema`). `schema_kitchen_lines_made.sql` adds the two
columns that hold per-item progress; without it the new endpoint returns an
error and the board falls back to bumping whole tickets as before.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version. 1,262 of the 1,500 characters Partner Center allows — check the count
again if you edit it.

```
Version 1.4.0.0 – Cross Items Off As You Cook

One change, asked for by a working kitchen.

Tap An Item To Cross It Off: Touch any item on a ticket once it has been cooked. It rules through, fades back and gets a tick, so a long order shows at a glance what is plated and what is still to do — no more holding it in your head to the end of the ticket.

Tapped The Wrong One: Tap it again to bring it back. Wet hands on a busy pass are exactly why this is not a one-way action.

The Ticket Finishes Itself: When the last item is crossed off, the ticket moves to Completed on its own. Nobody has to remember the tick at the end.

Your Progress Follows You: Crossed-off items are kept with the order, not on the screen in front of you. The board refreshes without losing your ticks, a second screen watching the same station sees them, and a screen that reboots mid-service comes back where it was.

Kitchens With More Than One Screen: Each screen answers for its own items. The grill crossing off everything it can see finishes the grill's part and leaves the fryer alone, exactly as pressing the tick always did.

Recall Still Means Start Again: Recalling a completed ticket clears its ticks as well as putting it back on the board.
```

---

## What changed, and why

### The unit of progress was wrong for the person doing the work

A ticket already tracked progress per **station** — the grill is done, the fryer
is not. That is the right unit for deciding which tab a card sits in, and the
wrong unit for a chef working down a ten-item order: there was no way to say
"the eggs are plated, the toast is not", so the state of a long ticket lived in
somebody's head until every item was ready.

Per-item state is that missing unit. Station progress is untouched and still
decides which tab a card sits in; crossing off the last outstanding item simply
lets the screen bump the stations it watches, exactly as pressing the tick has
always done.

### Why it is held on the server and not on the screen

The board re-fetches on a timer. A tick kept only in the app would vanish under
the chef mid-service, which looks exactly like the screen losing the order —
the one thing a kitchen board must never do. Persisting it also means two
screens watching the same station agree about what has been made, and a screen
that reboots during service comes back where it was.

Like bumping, it is a state assignment rather than a counter, so a double tap on
a steamed-up screen is one tap and a request retried over a flaky link cannot
half-finish a line.

### Completion is scoped to the board, not to the ticket

This distinction is not decoration; getting it wrong loses orders. On a kitchen
with two screens the grill finishing its own items must close the grill and
leave the fryer alone. So "all items made" is asked of the lines *this board
watches*, mirroring how bumping already works — and a board with no lines at all
on a ticket answers false, or a screen would auto-complete a card carrying none
of its own work the instant it appeared.

### Recall clears the ticks

Both on the server and locally. A ticket that returns to the board with every
line already struck through tells the kitchen there is nothing to cook, which is
the opposite of what recalling it meant.

### What it looks like

The reference the venue sent is the standard: the item name rules through and
fades back, a tick appears on the right, and the modifier under it rules through
with its line — a struck item whose "no bacon" still reads at full strength
looks like an instruction that has been missed rather than one that has been
followed. The tick sits in a fixed-width slot whether or not it is showing, so
crossing a line off does not shuffle the text under a finger that is still
moving down the ticket.

The whole row is the target, not just the words: a chef aiming at "Chips" with
the side of a thumb should not have to hit the glyphs.
