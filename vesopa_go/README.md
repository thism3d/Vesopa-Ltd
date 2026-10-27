# Vesopa Tap

Take orders at the table and card payments on the phone itself, for Vesopa EPOS. Android and iPhone, `com.vesopa.tap`.

* **What it is, who it's for, the use cases:** [docs/BRIEF.md](docs/BRIEF.md)
* **The build plan and what is done:** [docs/PLAN.md](docs/PLAN.md)

```
lib/
  config/constants.dart      where it talks to (--dart-define)
  data/
    models.dart              venue, clerk, menu, table, bill, tender (whole pence)
    bill_math.dart           splits and tips, exact to the penny
    api.dart                 the back office: commission, /till/* (staff, products, floor, open bills,
                             kitchen), members, vouchers, /api/tap/* (payments, refunds, receipts)
    venue_data.dart          the venue's products, modifiers, screens and floor as Tap's menu and tables
    payloads.dart            a bill as the till's open bill, kitchen ticket and sale
    outbox.dart              sales and tickets kept on the phone until the server takes them
    vesopa_sso.dart          Continue with Vesopa (PKCE, system browser)
    clerk_auth.dart          PIN, staff card, Face ID / fingerprint
    session.dart             phases, live bills with the tills, kitchen, voids, tenders (Riverpod)
    demo_venue.dart          "Try the demo"
  nfc/staff_card.dart        staff cards and fobs by NFC
  payments/payment_service.dart   Dojo Tap to Pay (and the demo's pretend payments)
  ui/                        theme, welcome + register, setup, PIN lock, tables, order (hold/fire, voids),
                             bill (member, voucher, splits), pay (tap, card machine, cash, receipt), quick sale,
                             more (refunds, staff cards)
ios/Runner/DojoTapToPay.swift    Dojo's Tap to Pay on iPhone SDK, over com.vesopa.tap/dojo
android/.../MainActivity.kt      the same channel (Android SDK to come)
```

Server half: `vesopa_server/src/tap.js` (`schema/schema_tap.sql`, `test/tap.test.js`), mounted in
`server.js`, with the back office's **Vesopa Tap** page (`public/index.html`, `loadTap` in `public/app.js`).

```powershell
flutter test
flutter run          # then "Try the demo": PINs 1111, 2222, 3333
```
