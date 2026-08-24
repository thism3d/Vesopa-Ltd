# Vesopa EPOS 1.4.1 — release notes

Store submission: `msix_version: 1.4.1.0` (previous *submission* was 1.3.9.0).
Flutter `version: 1.4.1+12`.

**1.4.0.0 was built but never submitted.** A defect was found after that package
was produced — an expired card payment was being reported as a decline — so the
package was superseded rather than shipped. This release therefore carries
everything that was in 1.4.0.0 *plus* that fix, and the Store text below is
written cumulatively for a venue coming from 1.3.9.0.

**Server: changes required.** Deploy `vesopa_server` and run the schema
migrations (`deploy.sh --schema`). `schema_dojo.sql` adds the webhook ledger and
the card-state columns.

Vesopa Kitchen is unaffected and stays at 1.4.0.0 — no kitchen code changed
after that package was built.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version. 1,478 of the 1,500 characters Partner Center allows — check the count
again if you edit it, there is very little room left.

```
Version 1.4.1.0 – Refunds At The Counter

Card refunds, safer handling of an unclear result, and a sign-on screen you can read.

An Unclear Result Is No Longer Shown As A Decline: If the card machine stops answering, the payment may still have gone through. The till now says the result could not be confirmed and asks you to check the machine, rather than reporting a decline — which is what invites charging the same customer twice.

Refund A Card From The Till: Functions > Card machine refunds to a customer's card on a Dojo reader. Enter the amount, confirm it, and hand the reader over — the till follows the machine and shows what it asks for at each step, including a signature check.

Every Card Sale Is Traceable: The card system's own reference is stored against the sale. That is what lets a refund find the original payment, and lets the Back Office answer a question about a charge weeks later.

Messages You Can Act On: A rejected key now says so and points at the setting to check, instead of reporting a failed payment. A busy reader, an offline one, and a payment too late to cancel each say what happened and what to do.

The Bill On The Card Machine: Items and their options, including discounts, are sent with the payment, so the reader can show an itemised bill rather than a total.

A Readable Sign-On Screen: With a venue picture as your background, the PIN keypad now sits on its own panel. The digits stay clear whatever picture you choose.
```

---

## What changed since 1.4.0.0 was built

### An expired card payment was being shown as a decline

Found by running the Dojo accreditation checklist through the till's *own*
payment code rather than a script beside it, which is the whole reason that
suite exists: the API-level run passed this scenario — the terminal session did
reach `Expired` — while the till's handling of it was wrong.

`Declined`, `Canceled` and `Expired` were treated as one outcome. The first two
are verdicts: the money did not move and the reader knows it. `Expired` means
the reader stopped answering, and the card may have been approved with the
result lost on the way back. Showing that as a decline invites the clerk to take
the payment again, which is how a customer gets charged twice — and it is the
one outcome Dojo's checklist names explicitly, requiring the till to say the
result cannot be confirmed and offer to record it manually or retry.

An expired session now returns `PaymentUncertainty.checkTerminal` and says so in
words. The poll-timeout path had the same defect in a quieter form: its comment
read *"this is unknown, never a decline"* but it never set the flag, so the
message said one thing and the till booked the other.

A `live`-tagged suite now covers the checklist through the shipped classes — the
real polling loop, the real signature callback, the real error mapping — against
the sandbox account's own virtual terminals, one per outcome. Seventeen
scenarios, all passing.

---

## Everything carried over from 1.4.0.0

### The card integration could take money and nothing else

Dojo will not accredit an integration until at least one refund route works, and
there was none: no refund call, no capture, and no way to reach either from the
till. The till gained the calls the checklist tests — refund to card, matched and
unlinked refund sessions, capture, cancel intent, amount, tips, cashback, item
lines with modifiers, and card-holder-not-present — and a screen an operator can
actually refund from.

That screen already existed but was gated to the older card platform, and told
everyone else to use a web portal. It now serves both, and hides only the two
things that genuinely are platform-specific: the reader's own end-of-day and
balance reports.

Three request shapes are not guessable from the rest of the API and each was a
`400` before it was right, so all three are pinned by tests:

- `captures` and `refunds` take `amount` as a bare integer, while every other
  endpoint takes `{value, currencyCode}`.
- `refunds` requires an `idempotencyKey` header that nothing else does.
- A pre-authorisation expiry is a .NET `TimeSpan` (`d.hh:mm:ss`), rejected
  outside 30 seconds to 7 days.

### A card sale could not be tied back to the acquirer

`epos_payments.reference` has existed since `schema_commerce.sql` and nothing
ever wrote it. The consequence was invisible until a refund was needed: no
matched refund, no way for an acquirer webhook to find the sale it was talking
about, and nothing to quote on a chargeback. The payment intent id now travels
till → server → column.

### "Payment failed" was the wrong thing to say

A wrong API key reported a failed payment, which sends somebody hunting a card
fault instead of opening Settings. Every acquirer error now carries its status
code and resolves to a sentence an operator can act on; the acquirer's own
`traceId` is kept for support.

### The PIN pad lost to a background picture

Transparent keys were tried twice and lost twice. The second failure is the
instructive one: over a venue backdrop with a gold wordmark across the middle of
the screen, a 35% scrim and a blur still left the digits fighting the letters
underneath — "5" and "0" were close to unreadable. Alpha cannot win that,
because the thing behind is not a texture a blur can flatten; it is type with
the same tonal weight as the digits.

So the picture now stops at the pad rather than being dimmed everywhere. The
keypad sits on its own opaque console, which is the only setting that holds
against *any* image a venue might choose, and it covers a small enough area that
the backdrop is still plainly theirs around it — which is what the venue asked
for when they rejected the 85% full-screen scrim in the first place.

The per-key blur went with it. Each key used to carry its own `BackdropFilter`
because each key was a window onto the picture; over an opaque console that is
twelve shader passes over a flat colour, on the one screen a tired clerk taps
fastest.

### Known issues, unchanged by this release

`widget_test` (a pending-timers assertion), `functions_page_layout_test` (a
golden generated on macOS) and `dojo_terminal_live_test` (needs a live account)
were all failing before this work and still are. Each was confirmed unrelated by
re-running it against the previous code.
