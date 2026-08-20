# Vesopa EPOS 1.3.6 — release notes

Store submission: `msix_version: 1.3.6.0` (previous submission was 1.3.5.0).
Flutter `version: 1.3.6+8`.

1.3.5.0 sent receipts straight to the printer. This release fixes what came out
of it. Every item here is a defect found on real hardware after that release —
nothing new is added.

Server: no changes. No migration to run.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in this
version. Written for a venue owner: every claim is something they can watch
happen on paper. 1,289 of the 1,500 characters Partner Center allows — check the
count again if you edit it.

Prose rather than bullets, matching 1.3.4.0 and 1.3.5.0.

```
Version 1.3.6.0 – Receipts That Print Right

A repair release. Everything here is something that reaches your customer's hand.

The Pound Sign: Receipts sent straight to a thermal printer showed the wrong character where the £ belonged. Every amount on every document now prints a proper pound sign. Test Print checks it for you — it prints a sample amount, so you confirm your printer while setting up rather than with a customer waiting.

Receipts No Longer Fail To Print: A dash, a curly quote or a bullet in your footer message, a product name or a customer's name could stop a receipt printing at all — nothing came out and the till reported an error about invalid characters. Text like that is now handled properly. A name pasted in from a spreadsheet can no longer take the receipt down with it, and accented names print as they should.

Reprints: A reprinted receipt was headed with your account name rather than your venue's trading name, in oversized text several lines deep. It now prints the name you set in the Back Office, sized to fit the roll.

Narrow Rolls: Receipts, bills, reports and kitchen tickets are laid out for the paper actually loaded in each printer. A 58mm roll no longer receives an 80mm layout with the price column running off the edge of the paper.
```

---

## What changed, and why

### The pound sign was never the till's fault

Two layers have to agree, and only one was ever set up. The till encodes text as
Latin-1, which puts `£` on the wire as byte `0xA3` — always correct. The printer
then decodes that byte using whichever **code page** it is on, and nothing ever
sent it `ESC t n`. So it stayed on its power-on default, which is CP437 on
essentially every thermal printer sold, and CP437 draws `0xA3` as `ú`.

Every document now selects CP1252 before printing anything. CP1252 agrees with
Latin-1 across the whole `0xA0–0xFF` range, so the bytes the till already
produced are now read back the same way they were written.

This depends on the printer supporting code page 16 — near-universal, but a
property of the hardware rather than of the till. That is why the check lives on
the test slip, which now prints a sample amount, instead of being assumed.

### A dash stopped the receipt entirely

The encoder throws on anything outside Latin-1 rather than substituting it. So a
single em dash did not print a wrong character — it produced no receipt at all,
and an `Invalid argument (string): Contains invalid characters.` error at the
counter.

Two sources, and fixing only the first would have missed the point:

- `BILL — NOT A RECEIPT`, a string literal in the till.
- The venue's own footer message, typed in the Back Office. That one is *data*,
  so no amount of care over literals could have prevented it.

All printer-bound text now passes through `escPosSafe`, which folds typography
the printer cannot draw (dashes, smart quotes, ellipses, bullets, `€` → `EUR`),
keeps the accented characters CP1252 *can* draw, turns anything else into `?`
rather than letting it vanish, and flattens control characters that would
otherwise derail the column layout. The generator is reached through two
helpers and nothing else, so a future call site cannot bypass it.

### Reprints were headed with the wrong name

The direct path printed `Session.venueName` — the Back Office *account* name,
which for a sole trader is a person's name — at double width and double height.
The PDF path and the automatic-receipt path had both always preferred the
branding trading name; only the reprint path had been missed.

It now prefers the branding name, and drops to single width when the name is
longer than fits on a double-width line (24 characters on 80mm) rather than
wrapping into a block of oversized text at the top of the receipt.

### Roll width was read but never used

`PrinterConfig.paperWidthMm` was displayed on the setup screen and then ignored:
the builder was constructed for 80mm regardless. A 58mm roll got an 80mm layout,
which does not wrap — it prints off the edge of the paper, taking the right-hand
price column with it. The width is now threaded through every document.

The test slip's ruler line is likewise sized to the actual roll, which is what
made it worth printing in the first place.

### Known issues, unchanged by this release

The same three tests were failing before this work and still are:
`functions_page_layout_test` (stale golden), `widget_test` (pending-timers
assertion) and `dojo_terminal_live_test` (needs a live account). Confirmed
unrelated by re-running them against the previous code.

Kitchen tickets fan out to several stations from a single builder, so they use
the receipt printer's roll width for all of them. A kitchen printer taking a
different roll from the counter will still be laid out for the counter's.
