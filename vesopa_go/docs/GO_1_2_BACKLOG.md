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
- [ ] Light, dark and automatic appearance (automatic by default).
- [ ] Start animation: the app icon built, turning into a card and a tick.
- [ ] Reports live, with digits that roll when they change.
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
