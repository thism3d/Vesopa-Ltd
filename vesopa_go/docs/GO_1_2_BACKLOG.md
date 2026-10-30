# Vesopa Go 1.2.x: the owner's list (2026-10-28)

The owner chose to build everything in Go 1.2 first, before Go on the till's
code (ONE_CODEBASE_PLAN.md). Ticked items are on main.

## Done

- [x] 1.2.3 Back-office layout on every device; the sale on the left on
      iPad; bars top and bottom; the till's keys working; words never split.
- [x] 1.2.4 Teya card machines (Teya has no Tap to Pay SDK for other apps).
- [x] 1.2.5 Bar keys as the till's (icon over a centred name); one Pay,
      disabled until something is on the sale; tender totals (items,
      subtotal, deals, discounts, service); animated empty sale; Quick sale
      on the sale screen; icon status bar with detail dialogs; V + Go lockup;
      modules not switched on are hidden from the menu; idle screen without
      underlines, glass "Touch to begin", brightness controls; screen kept
      on and full screen; Android battery and NFC settings; shorter settings.

## Next

- [x] 1.2.6 Tables: round buttons coloured by state on phones, a phone
      layout for the table screen (bigger screens keep the plan and named
      tiles). The till's round buttons still to do.
- [ ] Tables live: changes from another till land silently on that table;
      two devices on the same table see each other's changes at once; slide
      to pick up a table.
- [x] 1.2.6 Payment approved: Print and Email, a short "No thanks" under them.
- [x] 1.2.6 The receipt PDF sized to the printer's paper (roll or A4).
- [x] 1.2.7 The till's payment page: Cash and Card tender keys, the venue's
      banknote pictures, Manual card, the other card route, Split bill,
      Voucher, Points (with a member on the bill), Discount, Customer,
      Gratuity, Print bill, the pad with Exact and the next note up; a Check
      tab. Still to come: Redeem points, Gift card and Deposit (they need the
      till's loyalty, gift card and deposit routes on Go).
- [x] 1.2.8 Light, dark and automatic appearance (automatic by default);
      the customer's screens and the PIN pad stay dark.
- [x] 1.2.10 Start animation: the mark builds, flips into a card, a tick is drawn.
- [x] 1.2.9 Reports: the whole venue today (every till and device, from
      /api/tap/today), refreshed every 15 seconds, digits that roll.
- [ ] Idle screen settings per kind of device (iPad, Android, iPhone).
- [ ] Notifications, vibration and sounds checked on every device.
- [ ] Screen programming on the device: lines (horizontal and vertical,
      with or without space, resizable), drafts with a preview, a manager's
      PIN to save, and an AI arrangement (the Vesopa AI client) to accept or
      not. The back office shows the resolutions of the venue's devices.
- [ ] Modes, each its own licence: Vesopa EPOS, Vesopa Kitchen, Vesopa
      Display, a card terminal for the tills (Dojo or Teya), bill printing.
      Leaving a mode needs the Vesopa account password, as the till's sign
      out does.
- [ ] Ask Teya whether a Tap to Pay SDK is coming (owner to approve the
      email first).

## Outside Go

- [ ] cloud.vesopa.com: a 402 on a page (the home page answers 200 now;
      need the address) and a 5xx when creating an email account.

## The owner's TestNotes (2026-10-30): iPad, phones, the Windows till

Asked again, the owner said these go on the iPad and phones; the Windows
till items are built now (venues update only when the owner says).

Done in 1.2.11 (and the till):
- [x] Tap to Pay on iPhone: start afresh after an error, a decline at once,
      readied when the app opens, errors to the Card payments page.
- [x] Customer search found nobody ("0.00000" points as text).
- [x] The card prompt centred.
- [x] Till: Last Bill crashed on numbers sent as text.

Vesopa Go (iPad and phones):
- [x] 1.2.12 Bars fit by shrinking; when they cannot, an arrow by a Pay key fixed
      at the right shows the rest in a row above (animated; a tap outside
      hides it); icon-only keys as the last resort.
- [x] 1.2.12 Narrow screens (iPad portrait, Split View, Android): keys never
      squeezed into broken words; reflow as on a phone when cells get narrow;
      a smaller section title; a line before the category keys.
- [x] 1.2.12 Open tables as chips at the top (Current £11.00, Table 7 £22.95), one
      tap to switch, as on the till.
- [x] 1.2.12 A tapped table opens the sale screen with that table's bill, as on the
      till, not a separate order page.
- [x] 1.2.12 The check's header: who and when (Muzahid Islam · 10:12am).
- [x] 1.2.14 (gift card, deposit, discount, gratuity, attach customer; loyalty
      points and split by item still to come) Payment dialogs as the till's: Discount with the bill after it,
      Attach customer with results as you type, Gratuity (5/10/12.5/15/20%,
      none, an amount), Voucher, Redeem deposit, Loyalty points, Split bill
      by item or equally.
- [x] 1.2.13 Cancel and Void with the till's reasons from the back office.
- [x] 1.2.13 The Covers key and modifier keys (MIXERS ?) on Go's screens.
- [ ] Idle: the venue's logo; one quick button that opens a brightness
      slider; Touch to begin in the back office's lettering.
- [ ] A better start animation: Apple-like square tick, the card animated
      in time.
- [ ] Bills: each bill's payments and its refund.
- [ ] One Cards page: payment cards, staff cards, membership, loyalty and
      gift cards.
- [ ] Top bar keys (Clock in, Sign on, Sign off) as compact icon keys.

Windows till (vesopa_epos):
- [ ] On-screen keyboard: hold to resize as on Windows; the number pad only
      as wide as it needs; A- and A+ scale the keys, not only the height.
- [ ] Top bar: a hamburger on the left opening the side menu from the left
      (no dropdown); keys the same height; no two-line labels; an arrow for
      the keys that do not fit; Pay fixed bottom right; the clerk's name as an
      icon key when it does not fit.
- [ ] The empty sale's moving basket.
- [ ] Functions: the Cash and Card tiles readable at any width.
- [ ] Settings: Appearance and Side menu as one row of icons; less text,
      an info button for the rest; the idle picture shown, not its path.
- [ ] Idle: the quick brightness button.

Website:
- [ ] go.vesopa.com: real screenshots of the till and the plans.
- [x] 1.2.13 Night and Day follow the till's colours exactly (PosColors and the
      payment board's PayPalette); Night by default; lime text deepens in Day;
      disabled keys grey; the mark ringed in Night.
