# Vesopa EPOS Lite

A fast counter-service till for bars, pop-ups, stalls and beer gardens, on a phone, a tablet or a
handheld card terminal. Android and iPhone, `com.vesopa.eposlite`.

* **What it is, and the reference it answers:** [docs/BRIEF.md](docs/BRIEF.md)

Lite is a different till on the same engine as [Vesopa Tap](../vesopa_go). It depends on
`vesopa_go` by path for sign-in, staff, the venue's menu from the back office, the outbox and Dojo
payments, and brings its own screens. A fix to payments or sync lands in both apps at once.

```
lib/
  main.dart                  phases (welcome, PIN, selling); always a counter till on its own
  data/
    lite_state.dart          the sale on screen; the device's settings (allergen alerts, card on device or machine)
    journal.dart             the day's sales on the device: reports, receipts, refunds, End of day
    day_report.dart          the Reports numbers, pure and tested
    lite_demo.dart           "Try the demo": a festival bar with portions, a set menu and allergens
  ui/
    brand.dart               the mark, the wordmark, category icons
    start_pages.dart         Continue with Vesopa / register / demo; PIN, staff card, Face ID
    shell.dart               drawer: Sell, Quick sale, Sales, Reports, Settings
    sell_page.dart           category rail, coloured item keys, View Sale / Pay (tablet: sale column)
    product_sheet.dart       portions, sizes, measures, mixers, set-menu courses, quantity, Add
    sale_panel.dart          the sale's lines, +/-, discount, clear
    pay_page.dart            To pay; cash £5 £10 £20 £50 and exact; card on device or machine; change
    sales_page.dart          today's receipts; email; refund (manager)
    reports_page.dart        net, sales, average, discounts, refunds, payments, staff, categories, items; Z
```

What goes to the back office, all through Tap's outbox: each sale as the till's own `POST /till/orders`
(discounts in `discount_minor`), kitchen and bar tickets for items with a station, and each refund as a
till refund event (`POST /till/events`), so it is on the Z beside the takings. Card refunds go back
through `POST /api/tap/payments/:id/refund`.

```powershell
flutter test        # 7 tests, phone and tablet
flutter run         # then "Try the demo": PINs 1111 (Sam, manager), 2222, 3333
```

The web demo (a showroom link) is a build that opens straight into the demo venue, with no sign-in:
`flutter create --platforms web .` in a scratch copy, then
`flutter build web --no-web-resources-cdn --dart-define=GO_DEMO_ONLY=true`.
