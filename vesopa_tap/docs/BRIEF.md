# Vesopa Tap: product brief

**Take orders at the table and card payments on the phone itself. No card machine needed.**

Vesopa Tap is the handheld app of the Vesopa EPOS family for Android and iPhone (bundle id `com.vesopa.tap`). A clerk seats a table, takes the order, sends it to the kitchen and bar, splits the bill, and the customer pays by tapping their card, Apple Pay or Google Pay on the clerk's phone. Contactless card acceptance on the phone comes from Dojo's certified Tap to Pay SDK.

It works two ways:

| | **With Vesopa EPOS** | **On its own** |
|---|---|---|
| For | pubs, restaurants and clubs that already have Vesopa tills | stalls, pop-ups, events, small cafés, a beer garden, new venues |
| Tables, bills | the same ones as the tills, live | simple tabs, or none |
| Menu | the tills' own screens, prices, modifiers, allergens | the same back office, a smaller menu, or type an amount |
| Kitchen | Vesopa Kitchen screens and printers | optional |
| Card payments | the venue's own Dojo account | the venue's own Dojo account |
| Where sales go | the Vesopa back office | the Vesopa back office |
| Licence | each phone is a till seat | each phone is a till seat |

A venue that starts on its own can add Vesopa EPOS tills at any time, because it is already on the back office.

## Where it sits in the Vesopa ecosystem

```
                         auth.vesopa.com  (Continue with Vesopa, passwordless)
                                │  ID token
                                ▼
 Vesopa Tap (phone) ──HTTPS──▶ backoffice.vesopaepos.com (vesopa_server) ──▶ Dojo
   PIN / staff card / Face ID   ├ /api/terminal/vesopa/commission  phone becomes a till
   orders, splits, tips         ├ /api/till/staff, screens          same staff and menu as the tills
   Dojo SDK reads the card      ├ /api/till/open-bills              tables shared with every till
                                ├ /api/tap/*  (src/tap.js)          Tap to Pay secret, payment intents
                                └ card log, sales, reports, stock
        ▲                                   │ broadcast
        │                     ┌─────────────┼───────────────┐
   Vesopa EPOS tills    Vesopa Kitchen   customer display   Vesopa Loyalty (member cards)
```

* **One staff list.** The PIN and staff card set in the back office work on every till and every phone. A leaver is removed once, everywhere.
* **One set of bills.** A table opened on a phone is on every till straight away, and the other way round. Before a bill held on another terminal can be settled, it must be claimed, so two clerks can never take payment for one table.
* **The key stays on the server.** A phone leaves the building in a pocket, so the venue's Dojo key never goes onto it. The server creates each payment and obtains the six-hour Tap to Pay secret.
* **Nothing is paid until Dojo says Captured.** The phone's own "approved" is what the clerk sees first. The bill is settled only on the server's answer, read from Dojo.

## The clerk's day: use cases

Learned from ICRTouch TouchPoint and PocketTouch (the UK standard for handheld ordering) and improved where they fall short.

**Signing on**
1. Enter the till's own 4–6 digit PIN, straight on the pad with no name list to scroll.
2. Tap a staff card or fob on the phone (NFC). It's the same card the back office holds as the staff card.
3. Use Face ID or fingerprint on a clerk's own phone, to bring back the last clerk without typing.
4. Sign off in one tap, so a colleague can sign on for one sale.

**At the table**
5. See the floor by area (Restaurant, Garden, Bar), with every table's state in one colour: free, seated, ordered, mains away, bill asked, paid.
6. Seat a table with a number of covers.
7. Take over a table another terminal is holding, with an explicit claim step.
8. Order by category. Dishes that need a choice ask for it before they go on (cooking, side), and a cancelled choice leaves nothing half-added.
9. Order by seat, so the bill can later split by seat.
10. Show allergens on every dish and on the bill line, and add a note to any line.
11. Grey out out-of-stock dishes, which can't be rung up (the back office stock flag).
12. Send what's new to the kitchen and bar in one press ("Send 3"). A sent line can only come off with a void, as on the till.
13. *(phase 3)* Hold and fire courses: send mains when the starters are cleared.
14. *(phase 3)* Get a buzz when the kitchen marks the food ready to collect.

**Paying**
15. Take the whole bill by tap.
16. Split equally (2–8 ways). Shares always add up to the penny.
17. Split by item ("my two pints and the burger"), never paying for more than is left.
18. Split by seat: each seat's own lines plus a fair share of the table's.
19. Add a service charge (none, 10%, 12.5%) and a tip (10%, 12.5%, 15%), taken as one payment, with the tip kept separate in the records.
20. Over £100, the card asks for its PIN on the phone's screen.
21. On a decline, say so plainly. On a timeout, "No answer from Dojo yet. Check the payment before taking it again", never a guess.
22. Take cash as an alternative.
23. *(phase 4)* Send a receipt by email or text, and offer a loyalty card scan from Vesopa Loyalty.

**Selling on its own**
24. Type an amount and charge it (a market stall, a raffle, a deposit).
25. Ring up a new sale from a small menu.

## Why it beats PocketTouch

| | PocketTouch (ICRTouch) | **Vesopa Tap** |
|---|---|---|
| Card payment | through a separate PAX or Dojo terminal | **on the phone itself** (Tap to Pay), plus the card machine |
| Without a till | no: companion to TouchPoint only | **yes**: works on its own |
| Setup | by an authorised ICRTouch partner | the venue, with Continue with Vesopa |
| Staff sign-in | clerk | PIN, NFC staff card, Face ID / fingerprint |
| Splits | split bill | equal, by item, by seat, service charge and tip, exact to the penny |
| Updates | iOS app last updated June 2023 | released with the Vesopa family |
| Dark mode, accessibility | not stated | follows the phone, 56-point targets, reduced motion respected |

## Phones

* **iPhone:** iPhone XS or newer on iOS 16.7 or later for Tap to Pay. Older iPhones can still take orders.
* **Android:** an NFC phone, not rooted or in developer mode, on Android 8 or later for the app. Tap to Pay on Android arrives with Dojo's Android SDK.
* **Cards accepted** (Dojo): Visa, Mastercard / Maestro and American Express. Apple Pay and Google Pay are accepted through those cards.

## Security in one paragraph

Sign-in is Vesopa's own OAuth with PKCE in the system browser, never a web view. The phone's terminal token sits in the Keychain or Keystore. It is a till token: it opens one venue's till endpoints and nothing of its back office. Card data is read only by Apple's and Dojo's certified software and never by this app. The venue's Dojo key stays on the server. Every card attempt, approved or declined, is written to the venue's card log, as Dojo's accreditation requires.
