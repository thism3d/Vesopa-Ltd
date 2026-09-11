# Vesopa Express — the plan, again

*11 September 2026. Written after researching how the kiosks people actually
queue at work (McDonald's, Starbucks, Toast, Square, GRUBBRR), cross-checked
against Kimi K3's plan in [tasks.md](tasks.md), and narrowed to what is being
built now from [now.md](now.md).*

---

## 1. What the best kiosks do

### McDonald's — the reference everybody copies

* **Floor-standing kiosks at the door**, the first thing a customer meets. The
  flow is fixed and short: language → eat in / take away → menu → customise →
  "make it a meal?" → basket → pay by card → **printed ticket with the order
  number** → watch the number on the **customer order display** above the
  counter move from *Preparing* to *Ready*.
* **The meal is the product.** A burger offers "make it a meal" up front; the
  meal walks the customer through size, side and drink one step at a time, and
  the meal price is a real price on the menu — not the burger plus the sides
  added up.
* **Upsell at fixed points, not everywhere**: when the item is chosen (the
  meal), and once before paying ("would you like…"). Kiosk orders run higher
  than counter orders because "customers order more and add modifiers when
  there's no queue pressure behind them" (Vita Mojo).
* **The kitchen gets the order the moment it is paid** — on screens and, in
  smaller sites, on printers — and the counter is where it is collected.
* **Table service** in UK sites: a table locator (a numbered tent) is taken
  from the kiosk and the food is brought over.

### Starbucks — kiosks for the queue, people for the welcome

* Rolled out first where queues are worst: US airports (licensed stores) and
  one flagship in Seoul (Myeong-dong) with four languages.
* The kiosk takes the order and the payment; **the barista still hands the
  drink over by name**. The kiosk removes the till queue, not the person.
* Reason given: 51% of customers spend more at a kiosk.

### Toast Kiosk — what a POS company's kiosk looks like

* Start → dining option → menu groups down the left, items on the right → item
  pane with required and optional modifiers, **nested modifiers as sequential
  screens**, live price → special requests → review → **upsell before
  checkout** → guest details → pay.
* **Pay with cash**: the kiosk prints a receipt with a QR code; the cashier
  scans it at the POS to pull the check up and take the money.
* Order-ready **text messages** to cut crowding at the counter. Loyalty at the
  start (phone or email), rewards redeemed at checkout.

### Square Kiosk — the kiosk is a front end to the POS

* The kiosk is "a self-serve ordering station"; **the order flows to the
  primary POS device**, and that device decides whether kiosk orders go to the
  KDS **or print on the kitchen printer** ("print online and kiosk order
  tickets" is a toggle on the POS).
* Settings: dining option, gift cards, tipping, smart upsells, and one of
  *name*, *table number* or *generated order number* for calling the order;
  order-ready texts when the KDS expeditor bumps it.

### GRUBBRR, PAR and the order-ready board

* GRUBBRR sells the kiosk as a separate automation layer over 90+ POS systems:
  branded UI, AI upsell ("up to 30%" larger checks), accessibility,
  translation, loyalty.
* **Order-ready boards** (GRUBBRR, PAR, XPR): numbers move from *Preparing* to
  *Ready* automatically as the kitchen bumps the ticket; fewer "is mine
  ready?" questions, less shouting.

### Accessibility (ADA-style guidance, applied in the UK the same way)

* Everything interactive within reach of a wheelchair user (15–48 in above the
  floor), large targets, AA contrast, **timeouts that warn before clearing**,
  and for full compliance an audio path (headphone jack + text-to-speech).

## 2. Where Vesopa Express stands against that (as built 10 Sept)

| Capability | The best kiosks | Vesopa Express today |
|---|---|---|
| Attract screen, dining option | ✓ | ✓ attract, **Eat in / Take away** (each switchable per venue) |
| Menu, categories, pictures, allergens | ✓ | ✓ from the venue's Dine-in menu, 14 allergens on every dish |
| Modifiers with min/max | ✓ | ✓ the till's own questions ("choose up to 3") |
| **Meal builder** (size → side → drink) | ✓ core | ✗ — **task 5, building now** |
| Upsell before checkout | ✓ | ✓ "May we suggest", once per visit |
| Name / number to call | ✓ | ✓ collection number, optional first name |
| Pay by card at the kiosk | ✓ | ✓ Dojo, key on the server only |
| Pay at the counter (cash) | ✓ Toast prints a QR slip | ◑ goes to the till's queue — **but the till cannot accept it** (see §4) |
| **Printed ticket / receipt** | ✓ McDonald's always | ✗ number on screen only — **task 4, building now** |
| Kitchen screens | ✓ | ✓ tickets on Vesopa Kitchen |
| **Kitchen printers** | ✓ (Square: the POS prints them) | ✗ printer-only stations get nothing — **task 3, building now** |
| **Staff told at the till** | ✓ | ✗ server announces, till ignores — **task 2, building now** |
| Order-ready board | ✓ | ✓ secret-address web page for any TV |
| Idle warning, reach mode, high contrast | ✓ | ✓ |
| Audio / text-to-speech | ✓ at the top end | ✗ later |
| Languages | ✓ | Welsh drafted — **hidden now**, back after a Welsh speaker checks it |
| Loyalty, promo codes | ✓ | ✗ later (the till has loyalty; the kiosk does not ask yet) |
| Order-ready text / phone | ✓ | ✗ later — a QR code to a live order page needs no SMS provider |
| Analytics (conversion, abandonment) | ✓ | ◑ orders and takings in the back office; no funnel yet |

**Where Vesopa is already ahead of the pack:** the kiosk holds no payment key at
all; a sale is written exactly once, whichever of the poll, the webhook or the
sweep sees the money first; a kiosk switched off mid-payment picks up where it
was; the exit passcode works with the network down; and it is off until a venue
asks for it.

## 3. Kimi's plan against this one

Kimi's [tasks.md](tasks.md) was the build plan for the first release and most of
it is built (P1–P7, with the departures recorded in its own table). What it left
open, and what this plan does with each:

| Kimi's item | Decision now | Why |
|---|---|---|
| **P4.6 meal builder** "driven by a combo-flagged modifier group" | **Build it, differently**: a meal is a *catalogue product* (its own price), linked to the dish as one or more sizes; the meal product's own modifier questions are the steps | "Meal prices aren't in the catalogue" was the blocker. Putting the meal in the catalogue fixes it at the root: the till already sells that product at that price, reports read it, and the kiosk prices it with the one pricing function everything else uses. A combo flag on a modifier group would have been a second price list. |
| **P5.5 receipt** "via the till's Windows printing path" | **Build it**: the till's direct-USB / Windows-queue / network ESC/POS path brought across, a printer chosen in the kiosk's staff Settings, and the venue choosing *always / ask / never* | McDonald's prints every time; the number on paper is what the customer holds while waiting. "Ask" is the default: it saves paper and still gives a ticket to whoever wants one. |
| **P6.2 till handling** (toast + in-app card) | **Build it**, plus the two things it did not foresee: the till must be able to **take payment for a pay-at-counter kiosk order** (today it refuses them), and staff need **Ready / Collected** on the till for venues with no kitchen screen | Without Ready at the till, a counter-service venue has no way to move a number to *Ready* on the board except the back office. |
| Kitchen tickets for printer-only stations (listed as a follow-up) | **Build it**, the Square way: tills print kiosk tickets on their kitchen printers, and the server hands each station's ticket to exactly one till | Printers are wired to a till (they are set up per till, not per venue), so a till has to do the printing — and with two tills a claim is what stops two copies. |
| P3.4 / P0.6 Welsh | **Hide** until checked | Owner's instruction. The Welsh stays in the code; the server tells the kiosk which languages to offer, so bringing it back is a server change, not a kiosk release. |
| P8.1 msix "nothing submitted" | **Submit the first release** with the identity Partner Center reserved | Owner's instruction (now.md). The owner presses Submit on this first one. |
| Loyalty, refunds, offline ordering (non-goals) | **Still later** | Unchanged. |
| `epos_express_order_lines`, SHA-256 device tokens, bcrypt passcode | **Stay as built** | Reasons recorded in tasks.md's "As built" table. |

## 4. A fault found while planning

**The till cannot accept a pay-at-the-counter kiosk order.** The kiosk sends it
to the dine-in queue with no table (a kiosk has none), and the till's
`acceptDineInOrder` returns *"That table has been deleted since the order was
placed"* for any order without a table. The first release's live check only
looked at the server side, so this was never seen. It is fixed as part of
task 2: a kiosk order at the counter gets **Take payment**, which rings it onto
the bill on the till (when that bill is empty) and opens the sale screen.

## 5. What is being built now (now.md tasks 2, 3, 4, 5, 7)

### Task 2 — the till is told about kiosk orders

* **Server:** `GET /till/express/orders` (today's kiosk orders a till should
  know about), `POST /till/express/orders/:id/ready|collected`. Terminal token,
  venue-scoped. The dine-in list marks orders that came from a kiosk with their
  number, so the till knows a counter order is a kiosk order.
* **Till:** a card slides in for every paid kiosk order — number, eat in / take
  away, what is in it, and **Ready** (moves the number to *Ready* on the board)
  — with a Windows toast for a clerk who is not looking. Governed by the same
  rule as every till notification: venue master switch AND the venue's
  "announce to tills" AND this till's own setting. Pay-at-counter kiosk orders
  get **Take payment** instead of Accept.

### Task 3 — kiosk tickets on kitchen printers

* **Server:** when a kiosk order is paid, the stations its dishes route to that
  are set to *Printer* or *Both* are recorded as print jobs. A till asks for
  waiting jobs, **claims** the stations it has a printer for (one statement, so
  two tills cannot both win), prints, and reports back. A failed print is
  released for another till or a retry; a job older than 30 minutes is not
  printed (a till switched on at six must not print lunch), and the back office
  shows what did not print.
* **Till:** prints the claimed stations with its own kitchen-ticket layout
  (station name, KIOSK and the number, eat in / take away, the customer's name,
  the dishes with their answers). A setting per till, on by default:
  *Print kiosk orders on this till's kitchen printers*.

### Task 4 — a ticket from the kiosk

* **Kiosk:** Settings (staff only) → *Receipt printer*: a Windows printer, a
  USB printer direct, or a network printer (IP:9100); roll width; **Test
  print**. On the number screen: printed automatically, offered ("Print a
  receipt?"), or not at all — the venue chooses in the back office. The ticket
  carries the venue's receipt branding (name, address, VAT number, footer —
  the same fields the till prints), the number large, eat in / take away, the
  lines, the total with VAT, and how it was paid; a pay-at-counter ticket says
  **PAY AT THE COUNTER** in large type.
* **Server:** `receipt_mode` (default *ask*) and the venue's branding in the
  kiosk's config.

### Task 5 — make it a meal

* **Catalogue:** a meal is a product ("Cheeseburger Meal", £16.50) whose
  modifier questions are its steps ("Choose your side", "Choose your drink"),
  answered by products priced as the upgrade (£0, or +50p for sweet potato
  fries). This is how the till would sell it at the counter, so the till, the
  kiosk and the reports all agree.
* **Back office:** Vesopa Express › **Meals** — for each dish on the menu, the
  meal sizes it offers (a product each, with a label such as *Regular* or
  *Large*), showing the price and the steps each one will walk through.
* **Server:** the kiosk menu carries each dish's meals and their steps; the
  pricing function prices a meal line from the meal product, checks every
  answer is one that meal offers, and enforces each step's minimum and maximum.
* **Kiosk:** the dish sheet offers *Just the burger — £13.50* or *Make it a
  meal — £16.50*; a meal walks through size (if more than one), then one step
  per question with big picture cards and a progress rail, then a review, then
  *Add to order*. The basket shows the meal with its choices.

### Task 7 — the test venue

Vesopa Express switched **on** for The Vesopa Kitchen (the test venue,
manager@vesopa.co.uk), with a demo meal set up, and left on so it can be tried.

### Also in this release

* **Welsh hidden** (see §3).
* **Microsoft Store, first release (1.0.0.0)** — identity
  `MeirionDavies.VesopaExpress` / `CN=3AD172E6-…` / *Vesopa EPOS Ltd*;
  listing written in the same shape as Vesopa Display and Vesopa Kitchen;
  logos, hero image and landscape screenshots of the real app; filled in
  Partner Center and **left for the owner to press Submit**.
* **A till release** carrying tasks 2 and 3, prepared and staged; it goes to
  certification only on the owner's word.

## 6. After this release

1. **A live order page by QR code** on the number screen — *Preparing* →
   *Ready* on the customer's own phone. Toast and Square do this with texts;
   Vesopa can do it with no SMS provider and nothing to install.
2. **Welsh**, once a Welsh speaker has checked it (one server switch).
3. **Loyalty at the kiosk** — scan the loyalty card or type the number the till
   already knows, earn points on the sale.
4. **Promo codes and the venue's offers** at the kiosk (the till has mix &
   match; the kiosk does not price offers yet).
5. **Smarter "may we suggest"** — from what is already in the basket and what
   the venue's sales say goes with it, rather than a fixed list.
6. **Meals on the QR table menu** — the data and the pricing are shared, only
   the page is missing.
7. **Table service** — "take a number to your table" with a table tent number.
8. **Audio accessibility** — text-to-speech with a headphone jack, for full
   accessibility compliance.
9. **Kiosk funnel analytics** — started, abandoned, paid, average basket, upsell
   take-up.
10. **Android and iOS** from the same code, once the kiosk lock has an Android
    (lock task mode) and iPad (Guided Access) story.

## 7. Risks

* **Meal setup is catalogue work for the venue** (a meal product, £0 side and
  drink products, two questions). It is the same work the till needs to sell a
  meal at the counter, and the Meals page shows exactly what is missing.
* **Kitchen printing needs a till on the new release.** Until a venue's till
  updates, printer-only stations still get no kiosk tickets; the back office
  says so per order rather than failing silently.
* **Store certification** of a full-screen app that cannot be closed without a
  passcode: the notes for certification explain the exit, as they must.

## Sources

* [McDonald's Self Ordering Kiosk: Benefits & Lessons — Wavetec](https://www.wavetec.com/blog/mcdonalds-leveraging-self-service-technologies/)
* [Everything to Know About McDonald's Self Ordering Kiosk — TouchWo](https://touchwoipc.com/everything-to-know-about-mcdonalds-self-ordering-kiosk/)
* [The trick to doing self-serve kiosks like McDonald's — Vita Mojo](https://www.vitamojo.com/blog/do-self-serve-kiosks-like-mcdonalds/)
* [How to Order Table Service at McDonald's — The Rare Welsh Bit](https://www.therarewelshbit.com/how-to-order-table-service-at-mcdonalds/)
* [Starbucks tests new ordering channels for licensed stores — Restaurant Dive](https://www.restaurantdive.com/news/starbucks-licensed-locations-airport-kiosks-mobile-ordering/815578/)
* [Seoul: Starbucks Pilots Self-Order Kiosks — Invidis](https://invidis.com/news/2025/11/seoul-starbucks-pilots-self-order-kiosks/)
* [Starbucks to install self-ordering kiosks at busy US locations — Kiosk Marketplace](https://www.kioskmarketplace.com/news/starbucks-to-install-self-ordering-kiosks-at-busy-us-locations/)
* [Kiosk: Place Orders and Make Payments — Toast Support](https://support.toasttab.com/en/article/Kiosk-Placing-Orders-Making-Payments-and-Tipping)
* [Restaurant Self-Ordering Kiosks — Toast](https://pos.toasttab.com/hardware/restaurant-kiosk)
* [Adjust Square Kiosk checkout and order notification settings — Square](https://squareup.com/help/us/en/article/8313-customize-self-serve-ordering-with-square-kiosk)
* [Print order tickets from your point of sale — Square](https://squareup.com/help/us/en/article/5194-print-order-tickets)
* [Best self-ordering restaurant kiosk systems in 2026 — Otter](https://www.tryotter.com/blog/restaurant-tips/best-self-ordering-restaurant-kiosk-systems)
* [5 best self ordering kiosk software for 2026 — Guideflow](https://www.guideflow.com/blog/self-ordering-kiosk-software)
* [Order Progress Board — GRUBBRR](https://grubbrr.com/products/order-progress-board/)
* [5 Reasons Your QSR Needs an Order Ready Board — PAR](https://partech.com/2026/04/17/5-reasons-your-qsr-needs-an-order-ready-board/)
* [ADA Compliance for Self-Order Kiosks — Seen Labs](https://seenlabs.com/blog/ada-compliance-for-self-order-kiosks-what-restaurant-operators-must-know)
* [How Restaurants Can Stay ADA Compliant with Self-Service Tech — QSR Magazine](https://www.qsrmagazine.com/operations/outside-insights/how-restaurants-can-stay-ada-compliant-with-self-service-tech/)
