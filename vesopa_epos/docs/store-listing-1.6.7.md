# Partner Center — what to paste, 1.6.7.0

Three submissions this time. All three apps changed, and all three are at
**1.6.7.0** — the kitchen app jumps from 1.5.0.0 to join the till's line,
which is the point of the number: a venue on the phone to support should be
able to say one version for the whole building.

Paste each block into Partner Center → Submission → **Release notes**. The
character counts are the text inside the fence, and the Store's limit is
1,500.

---

## Vesopa EPOS 1.6.7.0

1,202 characters.

```
Orders from the QR menu arrive with everything the customer chose. Add-ons
appear under the dish they belong to, priced; anything they typed about that
one dish — "no mayo" — sits under it; and if they said what to do when
something is off, the card says so instead of somebody having to ring and ask.

Allergens. Declare them once against a product in the back office and they
follow it: onto the QR menu, onto the kitchen ticket, and onto the customer's
own screen. A product nobody has filled in shows nothing at all, so no screen
ever claims a dish is free of something that was never checked.

Windows notifications. An order from a table now also raises a notification
from Windows, so it reaches whoever is at this till even with the window
minimised behind a stock count. It follows the two settings this till already
has — set it to be told Nothing and you get none, turn the sound off and it is
silent — and the back office can switch notifications off for every terminal
in the building at once.

The kitchen screen can now accept a QR order too, for venues where the kitchen
is the room watching. Whichever room presses first wins; the other is told
rather than the order being taken twice.
```

---

## Vesopa Kitchen 1.6.7.0

1,212 characters.

```
Accept an order from the kitchen. Orders customers send from the code on their
table now appear in a strip across the top of the board, with what was ordered,
anything they asked for, and Accept and Turn down on buttons big enough for a
hand that has been holding a pan. Until now only the till could take one, which
is a walk in a venue where the kitchen is the room watching.

Whichever room presses first wins. The other is told, rather than the order
being cooked twice.

Add-ons chosen on a phone are drawn under the dish they belong to, exactly as
a modifier from the till already is.

Allergens on the board. What a venue has declared against a product appears
under the item, in the words the law uses, in amber so it never competes with
the red that means "read this, it changes what you cook". It is taken when the
ticket is fired, so it keeps saying the same thing if a product is edited
mid-service or the screen loses its network.

Windows notifications when an order arrives, with the sound and the pop-up as
separate switches — a kitchen that cannot hear over an extractor and a bar with
music on want opposite answers.

And the password box no longer opens the keyboard on top of half the screen.
```

---

## Vesopa Customer Display 1.6.7.0

707 characters.

```
Allergens on the bill. What the venue has declared against a product now
appears under the item on the customer's own screen, in the words the law uses.
It is the one screen in the building a customer can read for themselves, and
asking across a counter is exactly what somebody with an allergy would rather
not have to do.

A product nobody has filled in shows nothing at all. This screen never claims a
dish is free of something that was never checked.

New, and off unless you turn it on: a Windows notification when the till stops
sending. It is off by default because a pop-up over somebody's bill is aimed at
nobody — it is there for a screen mounted in a back office, where there is
somebody to tell.
```

---

## Order of submission

The till first, then the kitchen, then the display. Nothing breaks if a venue
updates them in a different order — every change is backwards compatible with
the release before it — but a till on 1.6.7.0 is what puts allergens into the
file the display reads and the PLU on the ticket the kitchen board takes its
allergen snapshot from, so it is the one worth landing first.

## What is NOT in these notes, on purpose

The server side went live before any of this: the allergen columns, the
notification settings, the add-on and per-line fields on a QR order, and every
change to the customer menu page itself. None of it needs an app update and
none of it belongs in a Store release note, which is read by somebody deciding
whether to click Update.
