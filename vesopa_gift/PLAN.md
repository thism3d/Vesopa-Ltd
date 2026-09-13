# Vesopa Gift — vouchers and tickets, sold online, redeemed at the till

*Plan, 13 September 2026. "Vesopa Gift" is a working name; the owner names it.*

---

## The brief

From the owner (Meirion), on WhatsApp:

> "It's not loyalty as such it's a voucher system."

> "after the customer purchase a voucher for any amount the till system will
> need to be able to scan or enter a code to redeem it"

> "they purchase it on a web page so it has to be white label and they redeem
> at the till"

The link is only for the customers he chooses ("Yes"), and: "Can you keep the
smart gift app between us please".

From the developer: it is managed from vesopaepos.com/admin, only the owner's
account can reach it for now, it is hidden from everybody else, and access is
given to specific people.

---

## What Smart Gift is — the reference

Read from smart-gift.co.uk and its public API documentation, for understanding
only. Nothing of theirs is copied, and the name is theirs.

* A **white-label shop** for vouchers and tickets — the venue's logo, colours
  and domain — for hotels, restaurants and leisure venues.
* **Monetary vouchers** (any amount, spent a bit at a time) and **experience
  vouchers** (a named thing, "afternoon tea for two", with the revenue split
  across food, drink, retail and rooms). **Tickets** for events, tastings and
  classes from the same shop.
* Redeemed at the EPOS or the hotel system, by QR or typed code, or in their own
  back office. **Multi-site:** one voucher, any site of a group.
* Money goes **straight to the venue** through its own payment account (Stripe,
  Ryft). **Zero commission**, a per-site subscription, and **sold only through
  partners** — EPOS, hotel-system and payment companies — who keep the customer.
* Their EPOS partners include **Newbridge** — the system The Bridge Llangennech
  came to Vesopa from. A venue moving off Newbridge may already expect this.
* **Their till API is check → hold → redeem, with release and reverse.** Check
  says what is left. Hold reserves it for five minutes and returns a token.
  Redeem spends against the token; release gives a hold back; reverse undoes a
  finished redemption (a refunded bill). Monetary vouchers spend any amount up
  to the balance; experience vouchers spend by item.

---

## What Vesopa already has — more than it looks

**The redemption half exists today.** A code somebody brings to the counter can
already be spent at a Vesopa till.

| Already built | Where | What it gives this product |
|---|---|---|
| Gift cards: balance, expiry, top-up, void, a ledger of every movement, spent under a row lock so two tills cannot spend one twice | `vesopa_server/src/commerce.js`, `epos_gift_cards`, `epos_gift_card_txns` | The balance. A voucher sold online **is** a gift card. |
| A Gift Card tender on the till, for any part of a bill | `vesopa_epos/lib/ui/payment_page.dart` | Redemption, with no till release |
| A Gift Cards page in the back office | `vesopa_server/public/index.html` | Venues see, void and top up online vouchers with no new screen |
| Apple and Google Wallet passes for gift cards, refreshed when the balance moves | `vesopa_server/src/wallet*.js` | "Add to Wallet" on the voucher email |
| Venue branding — logo, colours, fonts — per slug | the loyalty app's branding | The shop's white-label look, set once |
| Venue-branded email that survives Outlook and Gmail | `vesopa_server/src/loyalty_email.js` | The voucher and receipt emails |
| Dojo payment intents, and venues' own Dojo keys sealed on the server | `src/dojo_client.js`, Vesopa Express | Card, Apple Pay and Google Pay into the venue's own account |
| Per-application membership in Vesopa Auth, self-enrolment off, invitations, a People page | `vesopa_auth` | "Only these people", with no new code |
| Entitlements: Auth holds what a venue has, the back office caches it | `vesopa_server/src/entitlements.js` | "Only these venues", at launch |

Discount vouchers (`bo_vouchers`) exist too and are a different thing: an
amount or a percentage off a bill, not money somebody paid for. They stay as
they are.

So what is missing is the **shop**, the **delivery**, the **admin**, and two
things the till does not yet do properly.

---

## Two faults in what exists — fix these first

Both are live today. Neither matters much while gift cards are plastic and
handed over a counter. Both matter the moment codes are sold online and sent by
email.

**1. Anybody can spend a gift card from the internet.** `POST
/api/gift-cards/redeem` and `GET /api/gift-cards/lookup` take no credentials.
They take `office` — which is the venue's contact email — and the code, and the
till sends nothing else. A code and a venue's email address, both of which will
be sitting in people's inboxes once vouchers are emailed, are enough to check a
balance or empty it with one request from anywhere. `/vouchers/redeem` and
`/deposits/redeem` are open the same way.

*Fix, staged so no till in the field breaks:* the server accepts the till's
Vesopa device token and logs every call that arrives without one; a till release
sends the token; once the log shows nothing arriving without one, the server
requires it. Lookups get a rate limit per address as well. This changes the
live EPOS, so it needs the owner's yes.

**2. Undo gives the till its money back, but not the customer.** Taking a gift
card as a tender spends it on the server first and records it on the till
second. The payment screen's Undo removes the tender from the till and does
not put the amount back on the card. A customer who pays £20 off their card and
then decides to pay by debit card instead has lost £20 from the card. Read from
the code (`payment_page.dart`, `_takeGiftCard` and `onUndo`); not yet
reproduced on a till. Fixed in Phase 2 by holding instead of spending.

---

## The shape

```
 Buyer's phone                vesopa_gift (new, private)         Vesopa EPOS (exists)
 -------------                --------------------------         --------------------
 gift.vesopaepos.com/<slug>
        |
        +--------------->  shop, basket  --- create payment --->  venue's sealed Dojo key
                                  |                                       |
                           Dojo hosted checkout  <------------------------+
                                  | paid
                                  v
                           issue the voucher  --- issuing API --->  epos_gift_cards row
                           email, PDF, Wallet pass
                                                                          |
 Recipient at the bar  ---------- code or QR -------------------->  till: Gift Card tender
                                                                          |
                           reports  <-------- movements --------  epos_gift_card_txns
```

**A separate program, attached to the EPOS.** `vesopa_gift/` is its own Node
service with its own database and its own pm2 process, the way `vesopa_web` and
`vesopa_auth` are. It speaks to the EPOS through a small authenticated API and
never reads the EPOS database itself. That lets it ship on its own timetable,
and keeps open Smart Gift's own business — selling it to venues that are not
on Vesopa EPOS.

**The EPOS keeps the balance. One ledger, not two.** A voucher sold online is
issued as an ordinary gift card in the venue's EPOS. The till, the back office
and the Wallet pass already understand it, and it is already protected against
being spent twice. A second ledger in the new service would mean two balances
for one voucher and a nightly job to argue about which is right.

**The venue is paid directly.** Dojo's hosted checkout — cards, Apple Pay,
Google Pay, Strong Customer Authentication — into the venue's own Dojo account,
using the same sealed-key arrangement Express already has. The key never leaves
the back office: the gift service asks the back office to create the payment,
and is told when it is captured. Zero commission is then true by construction;
Vesopa charges a subscription. Stripe Connect is the fallback for a venue that
is not with Dojo. *Each venue's Dojo account has to have online payments
switched on — ask Dojo before promising it.*

**Not an app.** The buyer is on a web page, and the recipient gets an email
with a PDF and a Wallet pass. A separate app would be another Store listing per
venue for something people use twice a year. Vouchers can show in the loyalty
app later — one app for a venue's customers, not two.

---

## Who can see it

### People — a Vesopa Auth application with the door shut

A new application in Vesopa Auth: **Vesopa Gift**, first-party, **self-enrolment
off**, consent off (Vesopa staff and venue managers using Vesopa's own tool).
With self-enrolment off, Auth refuses to sign in anybody without a membership
row for the application. That check already exists (`vesopa_auth/src/routes/
oidc.js`) and the back office and the till already rely on it.

* **Today: one member — the owner — with the `owner` role.** Nobody else can
  sign in, other Vesopa admins included. There is no link to hide from them,
  because the sign-in itself turns them away.
* **Giving somebody access** is an invitation from Auth's existing People page
  for the application (`/developers/a/<client_id>/people`): an email address
  and a role. Taking it away is suspending that membership. No passwords, no
  user table in the new service, nothing to self-register — the platform's
  one-way-in rule, unchanged. The sign-in button reads **Continue with Vesopa**.
* **Roles.** `owner` switches venues on, invites people and sees every venue.
  `support` finds a voucher, resends it and refunds an order, for any venue.
  `venue` sees one venue's shop, orders and reports and nothing else.

**Which address.** `info@vesopaepos.com` does not exist anywhere in Vesopa: not
in Auth, not in the back office, not in the vesopaepos.com console.
`info@vesopasoftware.com` does — Vesopa account 4, verified, and a back-office
admin. This plan uses that one. If a new `info@vesopaepos.com` mailbox is
wanted instead, it needs a Vesopa account first.

### Where the admin lives

`vesopaepos.com/admin` is the `vesopa_web` staff console, and it signs in with a
**username and password** from its own `admin_table` (Admin, Subadmin,
Contributor) — not with a Vesopa account. Neither address above is on any of
its accounts. As it stands, it cannot tell who the owner is.

Recommended:

1. **The gift admin lives inside the gift service, at
   `gift.vesopaepos.com/admin`**, and signs in with Continue with Vesopa. Its
   own origin, so nothing wrong in the marketing site's console can ever reach
   vouchers or customers' payments, and the whole product stays one program.
2. **`vesopaepos.com/admin` gets a Gift vouchers entry, shown only to members of
   the Vesopa Gift application.** That needs the console to sign in with
   Vesopa, which the licences plan of 13 September already asks for. Until
   then there is no entry at all and the owner keeps a bookmark. The link is a
   convenience; the lock is Auth.

If it has to be literally `vesopaepos.com/admin/gift`, that is one nginx
location on the live marketing site, forwarding to the gift service. It works,
but it puts two applications on one origin, and it is a change to a live
site's configuration — the owner's call.

### Venues — off everywhere, switched on one at a time

Off for every venue. The owner switches a venue on from the gift admin and
invites its manager with the `venue` role.

Until a venue is switched on, its shop address answers 404 — not "coming
soon" — nothing appears in its back office, and its tills are unchanged. Nobody
at a venue without it can find out it exists. The first venue is the test venue
(office 9, `manager@vesopa.co.uk`).

For now the switch lives in the gift service's own database. Putting `gift`
into Auth's product catalogue and the back office's entitlements means a line
in public code. At launch it joins the catalogue like every other product, so
it can be billed and counted.

---

## Phases

### Phase 0 — make the existing gift cards safe *(EPOS, public repository)*

* Token-checked redemption and lookup, staged as above, and a rate limit on
  lookups. The same for vouchers and deposits.
* An **issuing API** on the EPOS for a trusted service: issue a gift card for a
  venue (idempotent on the order id, so a retried payment never makes two), and
  read its balance and movements. Authenticated as a service, never by a
  venue's email address.
* Named for what it is — safer gift cards, an API for issuing them from another
  system — because this half is in the public repository.
* A till release, whose Store notes say only that gift-card redemption is now
  tied to the till.

### Phase 1 — the shop, for monetary vouchers *(private)*

**The buyer.** The venue's own page at `gift.vesopaepos.com/<slug>`, in its
colours. Preset amounts and a custom amount within the venue's limits; a choice
of the venue's designs; send it to me or straight to them, now or on a date,
with a message; pay; receipt.

**The recipient.** A branded email with the code, a QR, a printable PDF and Add
to Apple Wallet / Google Wallet, delivered at the time the buyer chose. A
"check my balance" page, rate-limited.

**The venue** (`venue` role). Amounts, designs, wording, expiry period and terms.
Orders: resend, refund (voids what is unspent and refunds it through Dojo).
Vouchers searchable by code or email. Reports: sold, redeemed, **outstanding**
(food and drink the venue still owes), expired; CSV export. An email to the
venue on every sale.

**The owner** (`owner` role). Every venue, the switch for each, totals across
venues, and a link to the People page.

**At the till: nothing new.** The code is typed into Gift Card, or read by a
hand scanner that types. The QR carries the plain code so that either works.

**Fraud.** Buying e-vouchers with stolen cards is a well-worn fraud. Strong
Customer Authentication at Dojo, a ceiling per order and per card, a limit on
orders from one address, and an optional delay before a high-value voucher can
be spent.

### Phase 2 — the till does it properly *(EPOS, needs a till release)*

* **Hold, then spend.** Check, hold, redeem, release, reverse — the shape
  Smart Gift's till API has. Tendering a voucher holds the amount, finishing
  the sale spends it, Undo or a voided bill releases it, and a refund reverses
  it. This fixes fault 2.
* **Camera scanning** of the QR, for tills without a hand scanner.
* **Selling a voucher at the till,** printed with its QR on the receipt.
* **Experience vouchers:** a voucher for a named product, spent by ringing that
  product up, with the revenue reported against what was actually served.
* **The venue's own domain** for its shop (`vouchers.<venue>.co.uk`), with a
  certificate for each.

### Phase 3 — tickets

Events with a date, a capacity and ticket types, sold from the same shop. Each
ticket is a QR, checked in at the door from a phone page in the gift service or
at the till, and cannot be let in twice.

### Later, if wanted

* **Groups:** one voucher at any site of a group. Gift cards belong to one venue
  in the EPOS today.
* **Physical gift packs** through a fulfilment partner.
* **Venues not on Vesopa EPOS:** an open API and a ledger of the gift service's
  own for their vouchers — Smart Gift's whole business. A later decision; it
  changes nothing in Phase 1.

---

## Money, tax and law — for the venue's accountant and a solicitor

The software has to support these; it does not get to decide them.

* **VAT.** A monetary voucher that can be spent on food and drink at different
  rates is generally a *multi-purpose* voucher: no VAT when it is sold, VAT on
  whatever it is spent on. So a voucher sale must not count in the till's sales
  or VAT figures, and spending one is a tender, not a discount. A voucher for
  one named thing at one rate may be *single-purpose*, taxed when sold. Every
  product in the shop carries which it is, confirmed by the accountant.
* **Outstanding balances are a liability** in the venue's books, and expired
  balances need reporting on their own.
* **Selling online** needs terms, a refund and cancellation policy — distance-
  selling rules are likely to give the buyer a cancellation period — and a
  privacy notice, because a buyer is handing us somebody else's email address.
* **Expiry** is the venue's choice, shown on every voucher and in the terms.
  Take advice before choosing a short one.

---

## Keeping it private

The owner asked for this to stay between the two of them.

`vesopa_gift/` is committed and pushed to GitHub like every other part of
Vesopa, and that repository is **public** — so this plan and the code are
readable by anybody who looks. What keeps the product out of sight of venues is
everything else:

* **No venue sees anything** until the owner switches it on for that venue: no
  shop address, no back-office entry, no change on its tills.
* **Phase 1 needs no till release,** so nothing appears in Store release notes.
* **Nothing names Smart Gift** — not the code, not a commit message, not a
  screen.
* **We build our own.** None of Smart Gift's wording, design or documentation is
  copied, and the product does not carry their name.

If the plan itself has to stay unseen, the one way that still pushes everything
is making the Vesopa-Ltd repository private.

---

## Needed from the owner

1. **Yes to Phase 0.** It changes live gift-card redemption and needs a till
   release.
2. **The address:** `info@vesopasoftware.com`, or a new `info@vesopaepos.com`.
3. **Where the admin lives:** `gift.vesopaepos.com/admin` (recommended) or
   `vesopaepos.com/admin/gift`.
4. **The server and hostname** for a new pm2 process and database. The EPOS box
   is nearest the EPOS database, and also runs two other customers' services.
5. **Dojo:** confirm venues' accounts can take online payments.
6. **The product's name.**
7. **The first real venue,** after the test venue.

---

## How it is tested

Against live, on the test venue only. Buy a voucher on the real shop with a Dojo
sandbox card, receive it at `manager@vesopa.co.uk`, spend part of it on a real
till, check the balance page and the venue's report, refund the rest. Every row
a test creates is recorded and removed afterwards, and the removal checked with
SQL. Screenshots go to `Documents\Vesopa-Claude-Images`.
