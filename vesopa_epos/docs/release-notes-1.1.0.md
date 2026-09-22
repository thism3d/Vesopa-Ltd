# Vesopa EPOS 1.1.0 — release notes

Store submission: `msix_version: 1.1.0.0` (previous submission was 1.0.2.0).
Flutter `version: 1.1.0+2`.

---

## Microsoft Store — "What's new in this version"

Paste the block below into Partner Center → Store listings → What's new in
this version. Written for a venue owner, not a developer: no API names, no
internal terminology, and every "Fixed" line is something a user could have
hit on 1.0.0. Partner Center allows 1,500 characters; this is inside it.

```
The biggest update since launch — card payments, loyalty, and receipt printing.

CARD PAYMENTS
• Take payment on your Dojo or Paymentsense card machine directly from the till
• The reader's own prompts ("present card", "enter PIN") now show on screen, and you can cancel a payment instead of waiting
• Keyed and telephone card payments, for a chip that will not read
• Google Pay on Android handhelds
• PDQ report and refunds from the till
• Fixed: Windows no longer hangs on "Waiting for the card…"

LOYALTY, GIFT CARDS AND VOUCHERS
• Points redemption with tier multipliers, customer search and counter sign-up
• Gift cards, deposits and vouchers
• Automatic promotions applied as you ring the sale

BILLS AND PAYMENT
• Split bills, part payment, and cash suggestions
• Percentage or fixed-amount discounts with quick presets
• A confirmation step before every payment, so a mis-tap cannot take money
• Gratuity charged on discounted goods only

RECEIPTS AND PRINTING
• Separate receipt and kitchen printers per terminal, 80mm and 58mm
• Live receipt on screen as you build the bill
• Reprint or share any past receipt
• Fixed: the £ sign now prints correctly on every receipt
• Fixed: receipts show your venue name, not your login email

PRODUCTS
• Stock, PLU, VAT and printer routing on the products page
• Fixed: prices now show on product tiles on Windows

ALSO
• New Vesopa look, and a sharper app icon at every size
• Open bills bar always available, so you can serve two parties at once
```

---

## What actually changed (internal)

Every item traces to a commit after `c9aeab1 v1.0.0`. 13,163 added lines in
`lib/` across 39 files.

### Card payments — `27c2c32`, `9c7ea9b`

- Replaced a call to a `/payment-intents/{id}/terminal` endpoint that does not
  exist, and which polled an intent nothing would ever settle. That was the
  Windows hang on "Waiting for the card…". The flow is now
  `POST /terminal-sessions` polled to `Captured`, with the signature step
  answered.
- `reseller-id` sent alongside `software-house-id`; without it Dojo returns 401
  on the terminal endpoints, which made the card-machine route look
  partner-gated.
- Only `Captured` counts as paid. `Authorized` precedes signature verification,
  so treating it as money in would book a sale a rejected signature declines.
- Dojo and Paymentsense Connect separated into an explicit stored platform
  choice rather than being guessed from the URL.
- Paymentsense Connect WebSocket transport, with REST fallback.
- `DesktopDojoProvider`: card machine when configured, otherwise hosted
  checkout in a window. There is no Dojo desktop SDK.
- Native Google Pay in the Android drop-in.
- PDQ report + refund screen, and an admin diagnostics console.

### Commerce, pricing and tender — `1722b5e`, `ca80a20`

- New pricing engine with a fixed order of operations: goods, automatic
  promotions, manual discount, voucher, points, gratuity. Gratuity is charged
  on discounted goods only, and every reduction is clamped so a bill cannot
  pass through zero.
- Tender engine: split bills, partial payment, cash suggestions that never fall
  below what is owed.
- Manual card provider that deliberately omits `terminalId`, so it bypasses a
  paired card machine.
- Gift cards, deposits, vouchers, loyalty redemption.
- Loyalty redemption dialog; fixed a MySQL `DECIMAL`-as-string trap that
  silently zeroed the tier multiplier.
- Confirmation step before cash/card/manual-card tenders.
- Discount dialog: percentage or fixed amount, clamped to subtotal.
- Enforced the till's `allowPartialCard` setting, which was defined but never
  checked.

### Receipts and printing — `1722b5e`, `ca80a20`

- Open Sans bundled and wired into both PDF paths. The PDF package's built-in
  Helvetica is Latin-1 only and dropped "£" **silently** — a receipt reading
  "24.50" makes a different claim about the money than "£24.50".
- `ReceiptFonts.safeText` substitutes rather than drops, so an unsupported
  character shows as evidence of a problem.
- Per-terminal receipt and kitchen printers, 80mm and 58mm.
- Live receipt on the sale and payment pages.
- Fixed the receipt header showing the office's login email instead of the
  venue's trading name.

### Windows-specific fixes — `27c2c32`, `8fc4798`, `e2a0d5d`

- Product tiles were passing `showPrice: false` on Windows, so a desktop till
  showed a name and no price.
- Tiles size to available width rather than a fixed column count.
- Open-bills bar always shown; hiding it left a desktop till with no visible
  way to run two parties.
- `.gitattributes` pins CMake/Dart build tooling to LF. Windows checkouts with
  default `core.autocrlf` corrupted `windows/flutter/CMakeLists.txt` into a
  configure-time parse error.
- `webview_windows` commented out — its CMake step fetches NuGet and the
  WebView2 SDK at configure time, which blocked Windows builds. Card checkout
  falls back to opening in a browser via `url_launcher`.

### Branding and icons — `a42107d` + working tree

- New Vesopa identity across app icons, Android adaptive icon and in-app assets.
- Windows icon rebuilt as a true multi-resolution `.ico` — 16, 20, 24, 32, 40,
  48, 64, 96, 128, 256. It previously held a single 48×48 frame
  (`flutter_launcher_icons`' default), which Windows upscaled ~5× for the
  desktop and Alt-Tab icon. See `tool/make_windows_icon.dart`.
- `msix_config.logo_path` repointed from that 48px `.ico` to the 1024×1024
  master, so Store tiles are no longer generated from a 48px source.

### Configuration — `c3f2c2a`, `46fef55`

- `lib/config/constants.dart` gathers every environment-dependent value; one
  `useLiveServer` switch moves the till between dev and
  `https://backoffice.vesopaepos.com`.
- Fixed `main.dart` defaulting to port 4000 while the server listens on 5060.
- Builds default to the live server; local development needs
  `--dart-define=USE_LIVE_SERVER=false`.

---

## Before submitting

1. `dart run tool/make_windows_icon.dart` if `flutter_launcher_icons` has been
   re-run since the last build — it overwrites the multi-frame icon.
2. Build with the Dojo key defined; it is never in source:
   `flutter build windows --dart-define=DOJO_API_KEY=…`
3. `dart run msix:create --store`
4. `msix_version` can never be reused. If certification fails, bump to 1.1.0.1
   (or 1.1.1.0) before resubmitting — a resubmission at 1.1.0.0 is rejected.
