# Vesopa Tap: build plan

The working plan for building Vesopa Tap. The product itself is in [BRIEF.md](BRIEF.md).

## Decisions (owner, 25 Oct 2026)

- **Name:** Vesopa Tap. **Bundle id:** `com.vesopa.tap` on both stores.
- **Payments:** the venue's own Dojo account; the key stays on the server. Vesopa has the live Dojo API and the Apple Tap to Pay entitlement.
- **For now:** the sandbox everywhere. That's Dojo's public Tap to Pay key (`TAP_SANDBOX_KEY` in `vesopa_server/src/tap.js`, also `DOJO_TAP_SANDBOX_KEY` in `.env.claude`) and the card-machine sandbox key from `dojo_settings.js`.
- **Licence:** each phone counts as a till. It commissions with `device_kind: 'till'` and takes a till seat.
- **Clerk sign-in:** PIN, NFC staff card and Face ID / fingerprint, all from the back office's staff list.
- **Tips:** a venue setting, on by default at 10 / 12.5 / 15%.
- **Platforms:** Android and iPhone launch together.

## Done

### Phase 1: the app (commit d3a1855f)
- [x] Flutter project for Android and iOS, `com.vesopa.tap`, display name Vesopa Tap
- [x] Design: `lib/ui/theme.dart` (lime on ink, light and dark, 56pt targets, tabular money, table-state colours)
- [x] Sign-in with Continue with Vesopa (PKCE, system browser); two modes; demo venue
- [x] Clerk lock: PIN, NFC staff card, Face ID / fingerprint
- [x] Tables, ordering, bill, splits (equal / item / seat), tips, quick sale
- [x] Dojo Tap to Pay on iPhone bridge (`ios/Runner/DojoTapToPay.swift`, SDK 0.0.11); Android channel

### Phase 2: switched on in the back office
- [x] `tapRoutes` mounted in `server.js`; Dojo webhook hook (a phone that goes away mid-tap still gets its payment marked paid)
- [x] Venue settings `epos_tap_settings`: on/off, tips on/off and %, service-charge choices, cash, emailed receipts (`/api/tap/settings`, `/api/tap/config`)
- [x] Back office page **Vesopa Tap** (Dine-in & QR menu): the switch, tips, phones (till seats), today's card payments and tips
- [x] `POST /api/tap/register`: a new standalone venue from the app (verified Vesopa email, one venue per account, unusable password, sandbox Dojo, the phone as its first till)
- [x] Sales recorded through the till's own `POST /till/orders` (`src/sales.js`), so the Z report, stock and reports count them. Card payments are `method: card`, `entry_mode: contactless`, with Dojo's intent as the reference.

### Phase 3: live with the tills
- [x] Menu from `/till/products`, `/till/modifiers` and `/till/screens` (choices are a modifier group's screen buttons); prices in pence from strings or numbers; allergens; kitchen stations from printer routes; courses from department names
- [x] Floor from `/till/floor` (rooms, table numbers); staff from `/till/staff`; settings from `/api/tap/config`; the last good copy cached for offline use
- [x] Shared open bills: push this phone's bills (`/till/open-bills`, the till's own payload), pull every 5s and mirror the others as held by them, claim before changing, retire on settle
- [x] Kitchen: tickets to `/till/kitchen/tickets` with stations; **Hold mains** and **Fire**; a "food ready" banner when every station has finished (`/till/kitchen/board`)
- [x] Voids of sent lines: a reason and a manager's PIN (a manager / supervisor / owner group); the void goes to the kitchen and onto the sale's notes
- [x] Outbox: sales, tickets and voucher redemptions are kept on the phone until the server takes them; card payments are never taken offline

### Phase 4: payments complete
- [x] Card machine instead of the phone: `via: 'machine'` (the venue's Dojo key and default machine, the way the tills drive it)
- [x] Refunds, all or part, back to the card: a manager's PIN in the app, `POST /api/tap/payments/:id/refund`, logged in the card log
- [x] Emailed receipt: the back office's own receipt PDF, from the venue's mailer (`POST /api/tap/receipts`)
- [x] Vesopa Loyalty member on the bill: scan their app (camera) or type the number (`/api/loyalty/card`). Their standing discount applies, and the sale carries `customer_id` and points by the till's rule.
- [x] Vouchers: checked against the bill (`/api/vouchers/validate`), redeemed when the bill is paid

### Tests
- [x] App (`flutter test`, 26): bill maths, members and vouchers, clerks, venue data mapping, payload shapes (sale lines add up to the subtotal), outbox retries, hold/fire, manager voids, claims, a whole demo service
- [x] Server (`node test/tap.test.js`): secret, one intent per payment id, paid only on Captured, tips setting, switched-off venue, webhook once, registration, card machine, refunds

## Still to do

- [ ] **Deploy to the live server** when the owner says: run `schema/schema_tap.sql`, then the usual back-office deploy (`tool/deploy_memberships.py --backoffice`). Until then nothing of this is live.
- [ ] **Android Tap to Pay:** Dojo's Android SDK isn't published (docs 404). The channel `com.vesopa.tap/dojo` is ready, and Android takes card-machine payments meanwhile.
- [ ] **iPhone build on a Mac:** add the Dojo package in Xcode (top of `DojoTapToPay.swift`), sign with the Vesopa team, then test on a real iPhone XS or newer against staging.
- [ ] **Android build check:** Gradle runs out of memory on the owner's PC, so build in GitHub Actions like the other apps (a new workflow for `vesopa_go`).
- [ ] Gift cards (hold, capture, release, as the till's `commerce.dart`).
- [ ] auth.vesopa.com: a `vesopa-tap` client of its own (the app uses `vesopa-epos` until then).
- [ ] Stores: icon, screenshots, listing text, privacy labels; TestFlight and Play internal testing.

## Risks and how they're handled

| Risk | Handling |
|---|---|
| Double charge on a flaky connection | One intent per payment id on the server; Dojo ignores Idempotency-Key |
| "Approved" on the phone but not at Dojo | The bill settles only on the server's Captured (poll, or the webhook) |
| A lost phone | It holds a till token only: no Dojo key, and the back-office session from the commission is thrown away. Sign the seat out in the back office |
| Two clerks taking one table | A bill held on another terminal must be claimed first (the till's own rule) |
| No signal mid-service | Orders, tickets and sales queue in the outbox; card payments say plainly that they need a connection |

## How to run

```powershell
cd vesopa_go
flutter test                 # 26 tests
flutter run                  # "Try the demo": PINs 1111 (Sam, manager), 2222, 3333
flutter run --dart-define=VESOPA_API_BASE=http://<your-pc>:5060   # against a local vesopa_server
cd ..\vesopa_server; node test\tap.test.js
```
