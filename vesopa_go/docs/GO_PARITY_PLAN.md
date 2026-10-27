# Vesopa Go: every till feature, on iPhone, iPad, Android and Android TV

The owner tried Go 1.1.0 on an iPad on 2026-10-27 and asked for everything the
till (`vesopa_epos`) does, except what only works on Windows. Every decision
below is theirs, taken that day. Read this, then `GO_PLAN.md` (rules, stores,
server), before working on Go. Tick items off as they land.

**Rule for every phase: port the till's code, don't redraw it.** The till's
screens, engines and wording are the specification (`vesopa_epos/lib`).
Where a till file can be shared unchanged (pricing, mix & match, tender,
modifier layout, receipt builder), copy it with a sync script, as
`tool/sync_lan_link.py` does for the LAN link. Don't fork it.

## Decisions

| Question | Decision |
| --- | --- |
| Demo mode | Gone from the app. Store reviewers sign in to a **review venue** (a copy of The Vesopa Kitchen, sandbox Dojo). Its login is only in the store review notes, never in the repo |
| Who sees what | **Exactly the till's permission groups and keys** (back office, Staff permissions). Every Go button is gated like the till's (`permission_gate.dart`) |
| PIN screen | The till's own pad: **PIN only, no list of names** (`sign_on_pad.dart`). After sign-in, the clerk's **photo and name sit at the top right** |
| Staff photos | A new **photo upload per staff member** in the back office (crop like product images); shown on the till and in Go; initials until one is added |
| Biometric login | A **Vesopa Auth passkey per clerk**, under the venue. It's made after the first PIN sign-in on a device, syncs through iCloud or Google, and the back office can revoke it |
| Gestures | Product: **tap** adds 1, **double tap** adds 2, **long press** opens choices, note and quantity. Ticket line: **swipe left** removes (void with a reason once sent), **swipe right** adds one more, **tap** edits (quantity, note, price override, discount), **long press** selects several |
| Payment screen | **The till's payment page, ported**: the live receipt and the tenders for the clerk, then a **full-screen, centred customer view** (amount, tip, Tap to Pay or "pay on the card machine" with its name, receipt choice, loyalty). Software House ID and Dojo details shown as the till shows them |
| Customers | The till's customer search, add, edit, loyalty and points, memberships and wallet passes |
| Printers | **Scan** the Wi-Fi for ESC/POS printers (port 9100) and AirPrint printers, with a test print. Routing (receipt, KP1-6, bill, X/Z, merchant copy) is **stored in the back office per device** and shared with the tills |
| Card machine | Pick or switch the Dojo terminal with live status. **Dojo, Teya or Barclaycard** per device, as the till offers. The till's **diagnostics page** (Software House ID, reseller ID, environment, recent transactions, test payment). **Failed payments and refunds** |
| Screen programming | Go uses the till's programmed screens exactly (buttons, colours, sizes, positions, home/top/bottom bars, finalise keys). A manager can **rearrange and edit on the device**, saved to the back office, separately for iPad and phone |
| Layout and floor editor | On the device for managers: the till's floor editor and the screen layout editor |
| LAN link | The till's **plain TCP link** (TCP 47821, venue key, encrypted). The back office tells Go the main till's local IP. We also **apply to Apple for the multicast entitlement**, so Go can later find tills by UDP itself |
| Android TV | **Build a TV layout** (remote, D-pad focus, keyboard). Card payments on the machine only. The owner decides later how it's used |
| Order | Service first: phases 1 to 6 below |

## Impossible, and what we do instead

| Asked | Why not | Instead |
| --- | --- | --- |
| Tap to Pay on an **iPad** | Apple offers Tap to Pay on iPhone only (iPhone XS or later); iPads have no card reader | iPad takes cards on the Dojo, Teya or Barclaycard machine; the screen says so |
| Card payments on **Android TV** | No NFC and no touch | The card machine only, if the TV build is used for orders |
| Tap to Pay on **Android phones** | Dojo has no Android phone SDK yet (Dojo Pocket only) | Dojo Pocket, or the card machine; ask partnertech@dojo.tech again |
| USB and serial printers, Windows print queues, the cash drawer on a USB printer | Windows only | Network ESC/POS printers (a network printer can still kick a drawer), AirPrint, Android printing |
| The till's hardware fingerprint licence lock | Reads Windows serials | Go's licence is per venue (`go` seats), the device id and the Vesopa Auth sign-in |
| UDP discovery of tills on iPhone and iPad | iOS blocks broadcast and multicast without Apple's entitlement | The back office hands out the main till's IP (applying for the entitlement meanwhile) |
| A second customer screen plugged into an iPad | No HDMI second screen control on iOS for this | The customer view on the device itself, or the Vesopa Display app paired over the network |

## Fix first (seen on the owner's iPad)

- [x] Idle screen: the message overflows. Fit it, wrap it, scale it, as the till's `idle_screen.dart` does
- [x] Tapping the idle screen opens the till's plain PIN pad, not the staff list
- [x] Top-right chip: the clerk's photo and name, and the menu to sign off or hand over (`staff_handover.dart`)
- [x] Screen programming isn't followed. Draw the till's screens, buttons, colours and bars from `/api/till/screens` as `layout.dart` and `sale_page.dart` do
- [x] Payment screen sits on the left on iPad. Centre it, full width (part of phase 1)
- [x] Software House ID and reseller ID shown where the till shows them

## Phase 1: service, as the till

- [ ] Sale screen ported from `sale_page.dart` with `layout.dart`: programmed screens, home/top/bottom bars, price levels (`price_level_sheet.dart`), the live receipt (`widgets/live_receipt.dart`)
- [x] Gestures as decided above, with haptics and animations
- [x] Pricing, mix & match, promotions and discounts: `pricing_engine.dart`, `mix_match_engine.dart`, `discount_dialog.dart`, `price_override_dialog.dart`
- [ ] Modifiers: `modifier_prompt.dart`, `modifier_layout.dart`
- [ ] Voids with reasons and manager approval: `void_dialog.dart`, `manager_approval.dart`
- [x] Payment: `payment_page.dart`, `confirm_tender_dialog.dart`, `split_bill_sheet.dart`, the tender engine. Then the centred customer view: tip, Tap to Pay or the machine, receipt choice, loyalty, and person-by-person hand-over
- [x] Customers: `customer_picker.dart`, `customer_repository.dart`, `loyalty_repository.dart`, `redemption_dialogs.dart`, `membership_prompt.dart`, `wallet_passes_sheet.dart`
- [ ] Tables: the till's `tables_page.dart`, `table_picker.dart`, `transfer_table.dart`, and `dinein_*` for online orders arriving at the table
- [ ] Refunds and receipts: `refund_page.dart`, `receipts_page.dart`, `print_receipt_sheet.dart`
- [x] Permissions: every action gated by the till's keys
- [x] PIN pad, staff photo chip, hand-over: `sign_on_pad.dart`, `staff_handover.dart`, `pin_dialog.dart`
- [x] Back office: staff photo upload (bo_clarks gains a photo; the till shows it too)

## Phase 2: printers and card machines

- [x] Printer scan (port 9100 sweep of the subnet, Bonjour `_ipp._tcp`/`_printer._tcp`, AirPrint) with a test print: `printers_page.dart`
- [ ] Routing per device stored in the back office (receipt, KP1-6, bill, X/Z, merchant copy) and read by the tills too: `print_targets.dart`, `print_categories.dart`
- [ ] Receipts, kitchen tickets and X/Z through the till's `receipt_builder.dart` (shared)
- [ ] Cash drawer kick through a network receipt printer: `cash_drawer_sheets.dart`
- [x] Card machine page: list terminals with live status, pick and switch, Dojo, Teya or Barclaycard per device: `card_machine_page.dart`
- [x] Diagnostics with Software House ID and reseller ID: `card_diagnostics_page.dart`
- [ ] Failed card payments and refunds: `failed_card_payments.dart`, `dojo_refund.dart`, `teya_refund.dart`
- [ ] Gift cards: top-up and sell by swipe or scan: `gift_top_up.dart`, `card_actions.dart`

## Phase 3: programming on the device

- [x] Screen layout editor for managers: rearrange, resize, recolour, add and remove buttons; saved to the back office; separately for iPad and phone
- [ ] Product editor (`product_editor.dart`, `products_page.dart`), with a photo from the camera
- [ ] Floor editor: `floor_editor_page.dart`, `room_walls.dart`
- [ ] Functions page: `functions_page.dart`, `till_actions.dart`

## Phase 4: the LAN link and passkeys

- [x] Port `lib/data/lan/` (plain TCP, TCP_NODELAY, venue key, encryption) into Go. Connect to the main till's IP from the back office; take part in tables, kitchen and offline points
- [ ] Back office: the main till reports its LAN IP. Go reads it with the venue key
- [ ] Apple: request the multicast entitlement (`com.apple.developer.networking.multicast`) for com.vesopa.go. Use UDP discovery once granted
- [ ] Clerk passkeys in Vesopa Auth: register after the PIN, sign in with Face ID or fingerprint, revoke in the back office (`vesopa_auth/src/authmethods.js`)

## Phase 5: everything else from the till

- [x] Stock and wastage: `stock_page.dart`, `wastage_sheet.dart`
- [x] Paid in and out, cash tally, Z reprint: `paid_out_sheet.dart`, `cash_tally.dart`, `reprint_z_sheet.dart`
- [ ] Reports: the till's `reports_page.dart`
- [x] Clock in and out, timesheets: `clock_sheet.dart`
- [x] Memberships, gym, events and tickets: `memberships_page.dart`, `gym_page.dart`, `tickets_page.dart`
- [ ] Kitchen remote and delivery: `kitchen_remote_page.dart`, `kitchen_delivery_card.dart`
- [ ] Settings for Go, mirrored with the back office (Vesopa Go options)

## Phase 6: Android TV, and the stores

- [x] A TV build: leanback launcher entry, D-pad focus on every control, landscape 1080p layout, card machine payments only
- [ ] Demo removed; the review venue created (sandbox Dojo); its login added to the store review notes only
- [ ] Android: internal testing only until the owner says otherwise. iOS: TestFlight
- [ ] Store pictures and the app film made from the finished build

## Notes on what is done (2026-10-27)

- Shared with the till, copied by `tool/sync_go_shared.py` (`--check` finds drift):
  `till_permissions.dart`, `mix_match_engine.dart` (Go's own row types in
  `mix_match_types.dart`), and the screen model (`screen_set.dart`). The LAN
  library is copied by `tool/sync_lan_link.py`.
- Pricing: mix & match by the till's engine. The till's promotions engine
  (`pricing_engine.dart`, which needs `commerce.dart`) is not ported yet.
- Payment: the till's two-column layout on iPad and the customer's own tip
  screen. Split hand-over, receipt choice and loyalty on the customer view are
  still to do.
- Go's own layouts per kind of device: `epos_go_layouts` (`go_options.js`),
  edited on the device by managers, never the till's screens.
- The receipt printer is per device (Settings). Back-office printer routing
  shared with the tills is still to do (the till keeps its printers locally).
- The multicast entitlement request to Apple is still to be filed (in App Store
  Connect, by the account holder).

- Memberships (join, renew, freeze, cancel, reinstate) and Events & tickets
  (sell at the counter through POST /till/events/:id/sell, the gate) are on Go;
  who may use them is a Vesopa Go option (staff, managers, off). The gym and
  class bookings are not on Go yet. Cash & stock covers no sale, paid out and
  in, wastage and the clock; the cash count and Z reprint are not.
- Play: every hand-typed box is in `store/play_console.md`.

## How each phase is done

1. Port from the till; share files where they can be shared.
2. `flutter analyze` and `flutter test` clean, with new tests for every engine ported.
3. Push to main (fast-forward), update the ticks here, deploy the server half with `go-server` (it backs up first).
4. A store build only when the owner asks: Android to **internal testing**, iOS to TestFlight.
