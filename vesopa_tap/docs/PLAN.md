# Vesopa Tap: build plan

The working plan for building Vesopa Tap. The product itself is in [BRIEF.md](BRIEF.md).

## Decisions (owner, 25 Oct 2026)

- **Name:** Vesopa Tap. **Bundle id:** `com.vesopa.tap` on both stores.
- **Payments:** the venue's own Dojo account; the key stays on the server.
- **Licence:** each phone counts as a till (it takes a till seat).
- **Clerk sign-in:** PIN, NFC staff card and Face ID / fingerprint, all from the back office's staff list.
- **Platforms:** Android and iPhone launch together.
- **Sandbox:** Dojo's public Tap to Pay sandbox key (from docs.dojo.tech/tap-to-pay-on-iphone), in `vesopa_server/src/tap.js` as `TAP_SANDBOX_KEY`.

## Phase 0: permissions and partners (start now; they take weeks)

- [ ] Apple: request the **Tap to Pay on iPhone** entitlement (`com.apple.developer.proximity-reader.payment.acceptance`) for `com.vesopa.tap` on the Apple developer account. Until it's granted, signing fails with `ios/Runner/Runner.entitlements` as it is. For an earlier build, take that key out temporarily.
- [ ] Apple: register the App ID `com.vesopa.tap` with the NFC Tag Reading capability.
- [ ] Dojo (partnertech@dojo.tech): the Android Tap to Pay SDK (docs page 404) and its secret endpoint; the production host and path for `/tap/apple-terminal/secret`; confirm Tap to Pay is enabled for the software house SL942X04 and per venue account.
- [ ] Google Play: create the app `com.vesopa.tap` (upload key as the other apps, see the firebase-and-android-keys memory).
- [ ] auth.vesopa.com: a `vesopa-tap` public client (for now the app uses `vesopa-epos` through `--dart-define VESOPA_TAP_CLIENT_ID`).

## Phase 1: foundation (done 25 Oct 2026, this commit)

- [x] `vesopa_tap/` Flutter project (Android and iOS), ids `com.vesopa.tap`, display name Vesopa Tap
- [x] Design: `lib/ui/theme.dart` (lime on ink, light and dark, 56pt targets, tabular money, table-state colours)
- [x] Sign-in: `lib/data/vesopa_sso.dart` (Continue with Vesopa, PKCE, system browser), commissioning as a till
- [x] Two modes, chosen on setup (`VenueMode.connected` / `standalone`)
- [x] Clerk lock: PIN pad, NFC staff card (`lib/nfc/staff_card.dart`), Face ID / fingerprint (`lib/data/clerk_auth.dart`)
- [x] Tables by area with state colours, covers, claim a table held elsewhere
- [x] Ordering: categories, required choices, seats, allergens, out of stock, Send
- [x] Bill: service charge, split equally / by item / by seat (`lib/data/bill_math.dart`, exact to the penny)
- [x] Pay sheet: tips, tap animation, PIN-over-£100 note, decline / uncertain wording, cash
- [x] Quick sale (type an amount); standalone Sell tab
- [x] Payments: `lib/payments/payment_service.dart` (Dojo's order: secret → activate → link → intent → pay → server confirms)
- [x] iOS: `ios/Runner/DojoTapToPay.swift` (Dojo SDK 0.0.11 calls), entitlements, NFC and Face ID wording
- [x] Android: `MainActivity` (FlutterFragmentActivity, channel says "waiting for Dojo's SDK"), NFC and biometric permissions, minSdk 26
- [x] Server: `vesopa_server/src/tap.js` + `schema/schema_tap.sql` + `test/tap.test.js` (secret, payments once per id, paid only on Captured, card log)
- [x] Demo venue (`lib/data/demo_venue.dart`) and pretend payments, so the app can be shown with no back office
- [x] Tests: bill maths, clerk lookup, a whole demo service (PIN → table → order → send → pay)

## Phase 2: switch it on in the back office

- [ ] Mount `tapRoutes` in `vesopa_server/src/server.js` behind a `tap` module (`modules.js`); run `schema/schema_tap.sql` on the server.
- [ ] `/api/terminal/vesopa/commission`: accept `app: 'tap'`, name the seat "iPhone (Vesopa Tap)", and show phones as their own kind in the back office's Tills list.
- [ ] `POST /api/tap/register`: a new standalone venue (office, Vesopa account, Tap plan, sandbox Dojo) from an ID token.
- [ ] Back office: a Vesopa Tap page with the switch, the phones, the Dojo environment, Tap to Pay status, and staff cards (write the card id into `swipe_card`).
- [ ] Dojo webhook → `epos_tap_payments` (same guard as the kiosk), plus a sweep for phones that went away mid-payment.
- [ ] Record the sale through the till's own sales path when a bill is settled, so the Z report, stock and reports count it.

## Phase 3: live with the tills

- [ ] Menu from `/api/till/screens` and modifiers from `/api/till/modifiers` instead of the demo menu (and cache them for offline use).
- [ ] Tables from the floor designer (`/api/till/floor`), live bills from `/api/till/open-bills` with `rev`, and claim on open.
- [ ] Push the full bill shape (lines, seats, sent state) the way `vesopa_epos/lib/data/bill_sync.dart` does, with `heldBy` set.
- [ ] Kitchen: send to the venue's kitchen stations and printers (as the till's `kitchen_remote.dart`), courses hold/fire, and a "ready" push.
- [ ] Voids with reason and manager approval (till permissions).
- [ ] Offline: queue orders; never take a card payment offline.

## Phase 4: payments complete

- [ ] Real-device test on a Mac with the Dojo SDK in Xcode, staging, then production with one venue.
- [ ] Android Tap to Pay when Dojo publish the SDK (the same channel, `com.vesopa.tap/dojo`).
- [ ] Card machine fallback: Dojo terminal sessions through the server (as Express).
- [ ] Refunds (manager), receipts by email or text, a Vesopa Loyalty card scan with discount and points, gift cards and vouchers.
- [ ] Dojo accreditation test sheet for Tap to Pay.

## Phase 5: stores

- [ ] App icon from `brand_assets` (the lime contactless mark), screenshots, listing text, privacy labels (no tracking, card data never collected by us).
- [ ] TestFlight and Play internal testing, then release. Pontardawe RFC is a likely first venue, but only with the owner's go-ahead.

## Risks and how they're handled

| Risk | Handling |
|---|---|
| Apple entitlement slow or refused | Apply in phase 0; the app still takes orders and uses the card machine meanwhile |
| Dojo Android SDK not available | Android ships with ordering and the card machine; the channel is ready for the SDK |
| Double charge on a flaky connection | One intent per payment id on the server; Dojo ignores Idempotency-Key |
| "Approved" on the phone but not at Dojo | The bill settles only on the server's Captured |
| A lost phone | It holds a till token only (no Dojo key, no back office); sign the seat out in the back office |

## How to run

```powershell
cd vesopa_tap
flutter test                 # bill maths, clerks, the whole demo service
flutter run                  # on a phone; "Try the demo" needs no venue
flutter run --dart-define=VESOPA_API_BASE=http://<your-pc>:5060   # against a local vesopa_server
cd ..\vesopa_server; node test\tap.test.js
```

The iPhone build needs a Mac: open `ios/Runner.xcworkspace`, add the Dojo package (see the top of `DojoTapToPay.swift`) and sign with the Vesopa team.
