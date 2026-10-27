# Vesopa EPOS Lite: brief

## The reference

The owner sent ICRTouch's TouchPoint Lite promotional film (2 min 8 s, 26 Oct 2026, no voice-over)
with "I want a lite version of Vesopa EPOS". What the film shows, in order:

* "Lightweight on hardware, heavyweight on features." It runs on a Dojo handheld card terminal, a phone,
  an Android tablet and a counter terminal.
* For festival bars, pop-up street food, small businesses, beer gardens.
* **Sale screen:** a category rail down the left, item keys in a grid with a coloured bar per category,
  the last line rung up, then **View Sale** and **Pay £x** along the bottom.
* **Portions:** Coke offers Standard £2.20 / Small £1.14, a quantity stepper and **Add**.
* **Set menu:** "Three Course Meal" opens a Starters list (Soup of the Day, Potted Shrimps…) and **Set**.
* **Pay:** "To Pay £22.28"; Cash: £5 £10 £20 £50 and **Pay by Cash £22.28**; Card: **Pay by Card**;
  **Back to Sale**. Then a white card screen ("£33.60, Tap your payment card") and **Payment approved!**
* **Reports:** a donut with the day's total and a sales table, on the phone and the tablet.
* Features called out: sales, refunds, discounts, receipts, allergen alerts, offline, cloud.
* "Speed up service. Access features in one handheld device. Take orders and payments anywhere."

## What Lite does

| In the film | In Vesopa EPOS Lite |
|---|---|
| Category rail + coloured keys | `sell_page.dart`. Colours and categories come from the back office's screens. |
| Last line, View Sale, Pay £x | Bottom bar on a phone. On a tablet the sale has its own column. |
| Portions, quantity, Add | `product_sheet.dart`. Pint/Half, sizes and measures start on the standard choice. |
| Set menu courses | The same sheet, one choice per course; Add stays off until every course is chosen. |
| Pay: £5–£50, exact cash, card, back | `pay_page.dart`. A note smaller than the bill is taken as part-payment. Change is shown big. |
| Tap your card, approved | The card screen; Tap to Pay on the device, or the Dojo card machine (Settings). |
| Discounts | % or £ off the sale; recorded on the sale for the back office. |
| Refunds | Manager's PIN; card back to the card through Dojo, cash from the drawer; on the Z. |
| Receipts | On screen, and emailed (the back office's own receipt PDF). |
| Allergen alerts | A hand on the key, allergens on the line, and a notice when one goes on (can be turned off). |
| Reports | Net, sales, average, discounts, refunds, cash/card, cash in the drawer, staff, categories, top items. Ranked bars, not a donut: a share is easier to read off a bar on a small screen. |
| Offline, cloud | Tap's outbox: sales, tickets and refunds wait on the device and go when the signal is back. |
| — | **Quick sale** (type an amount) and **End of day (Z)** with past Zs, as a till has. |

## Still needed from the owner

1. **Dojo's on-terminal SDK.** In the film, TouchPoint Lite runs *on* the Dojo handheld (printer and
   card reader built in). Lite runs on Android phones and tablets today. To run on the Dojo terminal
   itself and print on its printer, Vesopa needs Dojo's app-on-terminal SDK and a partner listing. The
   Android Tap to Pay SDK is the same open question as for Vesopa Tap (asked of partnertech@dojo.tech).
2. **Store listings.** An icon (the lime till mark is a placeholder), screenshots and the listing text.
   The app id `com.vesopa.eposlite` must be registered on the Play Console and App Store Connect.
3. **Licence.** Each Lite device commissions as a till seat, like Tap. Decide whether Lite has a
   cheaper seat price.
4. **iPhone build on a Mac.** Add the Dojo package in Xcode, as for Tap (`ios/Runner/DojoTapToPay.swift`).
