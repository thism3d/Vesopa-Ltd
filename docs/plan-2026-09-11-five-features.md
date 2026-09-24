# Five features — the plan (11 September 2026)

Training mode, a white-label loyalty app, control over updates, till licences,
and more than one site under one login. Written after reading the code each one
touches, so every section starts from **what exists**, then says what is added.

Decisions taken with the owner on 11 September:

* The loyalty app ships as a **web app** (installable from the browser on any
  phone) and a **Windows app from the Microsoft Store**. **No Android build, no
  Firebase.** Push goes four ways: Web Push, Windows native push (WNS),
  location-based push, and in-app notifications ("software push").
* Pontardawe RFC (office 35) is the first venue. Their logo, colours and fonts
  come from the owner; until then the app draws from the venue's existing
  Wallet-card branding.

Order of work: server and back office first (one deploy, everything off by
default), then the till release (1.7.3.0), then the loyalty app. Nothing here
changes what a venue sees until somebody switches it on.

---

## 1. Training mode

> A staff account for training. Its sales are not sent to the back office and
> do not count in the till's figures.

**Exists.** Staff are `bo_clarks` rows (the back office's Staff page; the till
pulls them over `/till/staff` into its local `Staff` table for offline PIN
checks). A sale lives in the till's own SQLite (`Orders`, `OrderLines`,
`Payments`), reaches the server only through the outbox (`OrderRepository._enqueue`
→ `SyncService.flush` → `POST /till/orders`), and the X/Z report reads the local
tables. Voids and no-sales go to `TillEvents` and also to the outbox.

**Added — server and back office**

* `bo_clarks.training TINYINT(1) NOT NULL DEFAULT 0`.
* Staff page: a **Training account** switch on each person, a *Training* badge
  in the list, and **Add a training account** (a clerk called "Training" with a
  PIN the manager chooses).
* `/till/staff` sends `training` — and **leaves training accounts out entirely
  for a till that does not say it understands them** (a till older than 1.7.3
  would otherwise let a trainee sell for real). The till says so with
  `?features=training`.
* Backstops on the server, for whatever an older or broken till sends anyway:
  `POST /till/orders`, the void log, open bills and kitchen tickets answer
  `200 {ignored:'training'}` for an order marked `training` or rung by a
  training account, and record nothing. 200 rather than an error so the till's
  outbox does not retry it for ever.

**Added — the till (1.7.3.0)**

* `Staff.training` and `Orders.training` columns (schema bump + migration).
* While a training account is signed on the till is **in training mode**: an
  amber TRAINING bar across the top, and every bill opened is marked training.
* A training bill is **never queued** (no outbox row for the sale, its voids or
  its no-sales), **never shared** with other tills (open-bill sync skips it),
  **never sent to the kitchen** (printers and screens), earns and spends **no
  points or gift-card balance**, and **opens no cash drawer**.
* **Card payments are simulated** — no Dojo request; the dialog says
  "Training — no card was charged".
* Receipts print **TRAINING — NOT A VALID RECEIPT** top and bottom.
* **X and Z reports exclude training bills** and training events. A live clerk
  cannot open a training bill and a trainee cannot open a live one, so a real
  table can never be settled in training and vanish.
* Training bills older than a day are cleared from the till automatically.

**Tests.** Server: training staff hidden from old tills, shown to new ones;
`/till/orders` ignores both markings. Till: a training sale leaves no outbox
row, is absent from X/Z, and a card tender makes no card-machine call.

---

## 2. The loyalty app

> White-labelled, shows a QR code, points and history, and the venue sends push
> notifications from the back office.

**Exists — and it is most of the backend.** Members are `epos_customers`
(`card_number`, `points_balance`, `membership_expiry`), every movement of points
is `epos_loyalty_txns`, sales are `epos_orders`. Per-venue branding already
exists for Wallet cards (`epos_wallet_settings`: programme name, logo, hero,
colour, address, hours, location). The Wallet pass barcode is the **card
number**, and tills already recognise a scanned card number — so the app's QR
code is that same number and **works on every till today, with no till change**.
Email sending (`mailer.js`) and one-time codes (`dinein_otp.js`) exist.

**Added — the API** (`/loyalty/v1`, new `src/loyalty_app.js`)

| Call | What |
|---|---|
| `GET /loyalty/v1/app/:slug` | The venue's app: name, logo, colours, fonts, links, location. Public. |
| `POST /loyalty/v1/app/:slug/code` | Email a 6-digit sign-in code (throttled; never says whether the address is a member). |
| `POST /loyalty/v1/app/:slug/verify` | Code → a customer token (scope `loyalty`, one venue, one customer). Joins the scheme if the address is new (card number from the venue's own sequence). |
| `GET /loyalty/v1/me` | Name, card number (the QR), points, tier, membership expiry. |
| `GET /loyalty/v1/me/history` | Points movements and visits, newest first, paged. |
| `GET /loyalty/v1/me/messages` | The in-app inbox. |
| `POST /loyalty/v1/me/push` | Register a Web Push subscription or a Windows (WNS) channel. |
| `POST /loyalty/v1/me/location` | Last known position, only with the customer's consent, kept 24 hours. |
| `DELETE /loyalty/v1/me` | Sign out everywhere; forget push channels and location. |

**Added — the back office: Loyalty app** (under Customers)

* **Branding**: app name, logo (square), colours (primary, accent, background,
  text), font (from the venue's font library), welcome line, links — prefilled
  from the Wallet settings. A live preview of the phone screen.
* **Where**: the venue's position and a radius, for location push.
* **Notifications**: title, message, optional picture and link; audience (all
  members, members near the venue now, members with a given tier, members who
  have not visited for N days); send now or at a time. Shows how many phones
  and Windows PCs it reached, and keeps every message in the app's inbox.
* **The app's address** and a QR code to put on posters and receipts.

**The four ways a notification reaches a customer**

1. **Web Push** — standard VAPID push (the `web-push` package; keys generated
   for the server). Android browsers, desktop browsers, and iPhones where the
   app has been added to the home screen (iOS 16.4+). No Firebase.
2. **Windows (WNS)** — the Store app registers a push channel; the server
   sends a toast. Needs the app's WNS credentials from Partner Center (Package
   SID + secret) in the server's `.env`; until then this channel is skipped and
   says so in the back office.
3. **Location** — "members near the venue now": customers who allowed location
   and were last seen within the radius in the last few hours get the message by
   whichever channel they have. The app also greets a member with the current
   offer when it is opened near the venue.
4. **In the app** — every message lands in the app's inbox, so a customer who
   declined notifications still sees it next time they open it.

**Added — the app** (`vesopa_loyalty/`, Flutter, **web + Windows**)

* Screens: sign in with a code → **card** (big QR of the card number, name,
  points, tier) → history → inbox → venue (hours, address, links) → settings
  (notifications, location, sign out).
* **White-label two ways.** At run time the app draws everything from
  `GET /app/:slug` — logo, colours, fonts — so a venue rebrands without a
  release. At build time a brand file (`brands/<slug>.json`) sets the name, icon
  and Store identity for that venue's own Windows app.
* **The web app** is served per venue at `https://menu.vesopaepos.com/app/<slug>/`
  with its own generated manifest, icons and theme colour, so "Add to Home
  Screen" installs *Pontardawe RFC*, not Vesopa.
* **The Windows app** is one MSIX per venue (`--dart-define=BRAND=<slug>`),
  published under that venue's own reserved name. The first submission of a new
  app has to be done in Partner Center (the Store API refuses it — see
  `ms-store-submission-client/README.md`).

**Privacy.** Location is off until the customer turns it on, is a single last
position (not a trail), and is deleted after 24 hours. Push channels are
forgotten on sign-out. A customer can delete their app access from Settings.

---

## 3. Updates only when you say so

> Stop the tills updating by themselves; approve each update after testing.

**Exists.** Every Vesopa app is published through `ms-store-submission-client`
with `targetPublishMode: Immediate` — the moment Microsoft certifies a release,
every till downloads it.

**Added**

* **Manual publishing, by default.** `stage.js` sets `targetPublishMode:
  Manual` on every submission. Microsoft certifies it and then it **waits**:
  nothing reaches a till until somebody presses **Publish now** in Partner
  Center. `commit.js` says so when it finishes.
* **Test before publishing.** `tool/build-test-msix` (per app) builds the same
  version signed for testing, to install on the office's own till first.
* **The tills themselves.** Microsoft Store automatic app updates can be turned
  off per machine (`HKLM\SOFTWARE\Policies\Microsoft\WindowsStore`,
  `AutoDownload = 2`). `tool/till-updates.ps1` turns it off or on, and the
  Vesopa till's **About** page shows the installed version and whether a newer
  approved one exists, with an **Update now** button that opens its Store page.
* The release notes format is unchanged.

---

## 4. Till licences

> A venue that paid for two tills can have two signed in at once.

**Exists.** A till is commissioned with a terminal token (`auth.js`
`issueTerminalToken`, 10-year JWT) — there is no record of which tokens exist,
so nothing can count them or take one back. `bo_devices` records devices that
connect.

**Added**

* `offices.till_licences INT NULL` — **null means no limit**, and every venue
  starts null, so deploying this locks nobody out. The platform admin sets the
  number per venue.
* `bo_till_seats` — one row per signed-in till: office, seat id, device id,
  device name, when, who, last seen, released. Every terminal token carries its
  seat id (`jti`).
* **Signing a till in takes a seat.** When the venue has a limit and every seat
  is taken, sign-in is refused with the list of tills holding them: *"Both till
  licences are in use: Bar, Door. Sign one out in the back office (Devices), or
  ask Vesopa for another licence."* Signing in again on the **same** machine
  reuses its own seat.
* **Tills already signed in** (tokens issued before this) are given a seat the
  first time they connect, keyed on the token itself, so the count becomes true
  without anyone signing in again.
* **Back office → Devices**: *Till licences: 2 of 3 in use*, each till with
  **Sign out**. A signed-out till's next call is refused and it returns to its
  sign-in screen (1.7.3.0).
* Signing out on the till releases its seat.

---

## 5. More than one site under one login

> One login, a drop-down of sites, each site with its own settings.

**Exists — and it makes this safe.** Every back-office route finds its venue
the same way: `req.user.officeId` from the signed session → `offices.contact_email`,
the tenant key every table is scoped by. The platform admin already "inspects"
another office by this route. Each venue's products, prices, terminals and
hardware settings already live under its own key, so **sites are independent
by construction** — nothing is shared unless it is copied on purpose.

**Added**

* `bo_user_sites (user_id, office_id, role)` — the extra sites a login may
  manage, beside its home office.
* `GET /api/sites` and `POST /api/sites/switch` — the switch checks the link,
  checks the site is active, and issues a new session for that office. Every
  existing route then works unchanged.
* **The back office header** gets a site drop-down when a login has more than
  one; the page reloads into the chosen site, and the site name stays visible.
* **The admin** links a login to more sites (Admin → Office → *Managed by*).
* **Copy to another site** on products, for when a change *is* meant to go
  everywhere — explicit, per item, never automatic.
* **Tills**: commissioning a till with a multi-site login asks **which site this
  till is for** (1.7.3.0); the till then belongs to that site alone.

---

## Releases

| What | Where | Needs from the owner |
|---|---|---|
| Server + back office | backoffice.vesopaepos.com | — |
| Vesopa EPOS 1.7.3.0 (training mode, licences, site picker, update check) | Microsoft Store, **Manual publish** | Press *Publish now* after testing |
| Loyalty web app | menu.vesopaepos.com/app/`<slug>` | Pontardawe RFC's logo, colours, fonts |
| Loyalty Windows app | Microsoft Store | Reserve the venue's app name; WNS credentials from Partner Center |

Kitchen and Customer Display are untouched and are not resubmitted.

## Risks

* **A trainee on an old till** — handled by hiding training accounts from tills
  that do not declare the feature.
* **Licences** — the first deploy must not refuse a single till: the limit is
  null everywhere until the admin sets it.
* **Web Push on iPhone** only works once the app is on the home screen; the app
  says so on an iPhone.
* **Store auto-update** can only be switched off on the tills themselves; a
  venue that does not run the script still updates when a release is
  *published* — which, with manual publishing, is only when you say.
