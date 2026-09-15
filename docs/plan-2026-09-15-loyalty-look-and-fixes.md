# Loyalty app — look, notifications, photo, membership (2026-09-15)

The owner's list, from two screenshots of The Vesopa Kitchen (test venue,
slug `vesopa-test`, office manager@vesopa.co.uk), saved under
`Documents\Vesopa-Claude-Images\loyalty-brief-2026-09-15\`.

| # | Ask | What is actually wrong / what it needs |
|---|-----|----------------------------------------|
| 1 | Upload a customer photo from the app | No member route exists; the back office has `POST /api/customer-photo` (multer → `/uploads`). Add `POST /loyalty/v1/me/photo`, `photo_url` on `/me`, and a photo on the Account page. |
| 2 | Activity and points not working | **A till bug.** `payment_page.dart` earns points from `_customer`, a page variable set only when the member is attached *on the payment page*. A member attached on the sale page or by card swipe reaches settle with `_customer == null`: no `/loyalty/points` call, no ledger row, no visit. Nicky's two sales on 14 Sep: `points_earned = 0`, `visits = 0`. Earn from the order's `customer_id`, as the renewal code beside it already does. |
| 3 | Font colour, icon colour, font size, per venue | `colour_text` exists but the card's facts and the news sheet draw on Material's seeded surfaces (dark grey on a `#990000` venue) where black text vanishes. Derive every surface from the venue's background; add `colour_icon` and `font_scale`. |
| 4 | Bebas Neue is small | Same `font_scale` (80–160 %, default 100). |
| 5 | Brightness to 100 % on the QR page | `screen_brightness` on Android/iOS/Windows while the card's front is showing; restored on leaving. No browser API — the web app cannot. |
| 6 | Notifications building up | Venue setting: keep the latest N (default 12) or show all with load-on-scroll. Server caps `/me/messages`; nothing is deleted, so raising N brings older ones back. |
| 7 | Text hard to read on the news page | Same as 3. |
| 8 | Show membership expiry; set it; renew | Expiry already on `/me`; shown on the card facts when set. Add it to Account with the term, fee and renewal date from loyalty settings. Setting it stays in the back office (Customers). **Renewal in the app is a question for the owner** — see below. |

## Left to ask the owner

*Renew from the app*: the venue's fee is £10 for 12 months. Taking that in the
app means an online card payment (the gift shop's Dojo checkout could be
reused) and the membership moving only when it is paid. The alternative is
"renew at the till", which the till already does. Built here: the expiry,
the fee and term, and a Renew button that explains how — payment in the app
follows the owner's answer.

## Test account

The owner supplied manager@vesopa.co.uk / a password for Continue with
Vesopa. Not typed anywhere by this session (credentials are the person's to
enter); the app is driven with a member token minted on the server
(`scripts/console-session.js` pattern), which is what every earlier check did.

## Order of work

1. Commit the pending 2026-09-14 loyalty work (Android, Continue with Vesopa). Done: d396de6.
2. Server: schema, branding fields, inbox cap, photo route, membership block on `/me`.
3. App: theme from the venue's surfaces, icon colour, font scale, brightness, inbox paging, photo, membership.
4. Back office: the new fields on the Loyalty App page.
5. Till: earn from the order's customer. (Queues behind 1.8.0.0 in Certification — one submission per app.)
6. Tests, web build + deploy, server deploy, live check, msix 1.0.2.0 → Store, Android .aab.
