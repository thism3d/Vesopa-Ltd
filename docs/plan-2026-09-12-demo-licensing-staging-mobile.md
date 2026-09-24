# Demo venues, licensing, staging and the mobile app — the plan (12 September 2026)

A second round on four of the five features from 11 September. Each one shipped
narrower than the brief asked for; this closes the gap rather than rebuilding.
Like the last plan, every section starts from **what exists**.

Decisions taken with the owner on 12 September:

* Training mode becomes a **shadow demo venue** — practice data is *kept*, in a
  venue of its own, not thrown away.
* The loyalty app **adds iOS and Android** to the web and Windows builds that
  already work. Nothing already built is discarded.
* Licensing covers **all four apps** and is bound to the **machine**, not to a
  name the machine chooses for itself.
* Both a **Store beta track** and a **staging environment** get built.

Order of work: staging first (so the rest can be tested on something that is
not a live venue), then demo venues, then licensing, then the mobile app.

---

## 1. Demo venues — training mode, properly

> "Demo sales data separately comes to the sales data in the demo... if the demo
> staff log with their account in the Epos, Kitchen, Menu or express app they
> never can reach anything to the live database."

**Exists.** `bo_clarks.training` marks a person. The till (1.7.3.0) keeps a
trainee's bills to itself: no outbox row, no kitchen ticket, no drawer, no card,
out of X and Z, receipts marked. The server's half (`src/training.js`) answers a
training sale `200 {ignored:'training'}` and **writes it nowhere**.

**What is wrong with that.** Two things.

1. The practice data does not exist, so nobody can ever look at it. A trainee
   cannot be shown what they did, and a manager cannot check they can do it.
2. It is EPOS-only. There is no training awareness at all in `express_kiosk.js`,
   `express_board.js`, the Menu/QR ordering path, or back-office sign-in — so
   "demo staff can never reach the live database" is not true today outside the
   till.

**The change: a demo venue is a second office row.**

Every back-office route, every till call, every kitchen ticket and every kiosk
order finds its venue the same way — an office key (`offices.contact_email`)
that every table is scoped by. So a demo venue needs no filtering, no flags on
sales, and no new isolation mechanism: **it is a tenant, and tenants already
cannot see each other.** This is the same insight that made multi-site small.

**Added — schema** (`schema_demo_venue.sql`)

* `offices.demo_of INT NULL` — the live office this one is a practice copy of.
  `NULL` for every real venue. A unique key, so a venue has at most one.
* A demo office is `status = 'active'` (it must be sign-in-able) but is excluded
  from billing, from platform totals, and from licence counts by `demo_of`
  being set.

**Added — server**

* `src/demo_venue.js`
  * `ensureDemo(office)` — creates the twin and **clones the setup**:
    departments, products, prices, screens and bars, tax rates, printers,
    terminal settings, floor plan, loyalty settings. Never sales, never real
    customers, never staff PINs beyond the training accounts.
  * `refreshDemo(office)` — re-clone the setup so practice happens against the
    current menu. Explicit, from the back office; never automatic.
  * `resetDemo(office)` — empty the practice data, keep the setup.
* **One seam on the till.** `requireTerminal` sets `req.office = claims.office`
  in exactly one place. A till in training sends `X-Vesopa-Demo: 1`; the server
  checks the signed-on staff member really is a training account, and if so
  points `req.office` at the twin. Every route downstream is unchanged and
  cannot tell the difference — which is the point.
* **The back office.** The twin appears in the existing site switcher as
  *"Pontardawe RFC — Demo"*, with an amber banner across the page. `/api/sites`
  and `/api/sites/switch` need no change; `sitesFor` simply includes the demo
  twin of any site the login manages.
* **Kitchen, Menu and Express follow for free.** They resolve the office the
  same way, so a demo kiosk order reaches a demo kitchen screen and a demo bill.

**What must never leak.** The list worth being explicit about, because each is
a way a practice session could touch the real world:

* No card is charged — the demo venue's Dojo config is forced to simulated.
* No email or push is sent to a real customer from a demo venue.
* A demo venue is never billed, never counted in platform totals, and holds no
  licence seat.
* Loyalty points earned in demo are the demo venue's own; a demo sale can never
  move a real customer's balance.

**The old backstops stay.** An old till that marks nothing and sends a training
sale to the *live* office is still ignored by `training.js`. Belt and braces:
the twin is where practice is meant to go, and the discard is what catches a
till that never learnt about it.

**Tests.** A demo sale lands in the demo office and is absent from the live X/Z
and the live figures; a training account cannot reach a live route; a kiosk
order placed in demo reaches the demo kitchen and no real printer; resetting a
demo venue leaves the live venue untouched.

---

## 2. Licensing all four apps, bound to the machine

> "If they pay for two kitchen apps then let two devices log in... we provide the
> license key and only activate it on that device and store hardware information."

**Exists.** `offices.till_licences` (a single number) and `bo_till_seats` (one
row per signed-in till). Seats are taken **only** when `device.kind === 'till'`
([devices.js:175](../vesopa_server/src/devices.js#L175)) — Kitchen, Display and
Express are unlimited. And the identity a seat is keyed on is a random UUID kept
in `SharedPreferences`
([terminal_identity.dart:23](../vesopa_epos/lib/data/terminal_identity.dart#L23)):
a reinstall resets it and a copy duplicates it. That is a nickname, not a licence.

**Added — per-app counts**

* `bo_licence_limits (office, kind, seats)` — a row per app kind
  (`till`, `kitchen`, `display`, `express`). Absent means no limit, so deploying
  this locks nobody out, exactly as `till_licences` NULL did.
  `offices.till_licences` is migrated into it and kept as the till's row.
* `bo_till_seats` gains `kind` and becomes the seat table for every app. The
  name stays: renaming a live table to make a document tidier is not worth the
  deploy.

**Added — a real licence key**

* `bo_licence_keys (key, office, kind, device_fingerprint, activated_at,
  activated_by, revoked_at)`. Vesopa issues keys; a key activates on exactly one
  machine and is thereafter bound to its fingerprint.
* **The fingerprint** is computed on Windows from values a copied install cannot
  carry with it: `MachineGuid` from
  `HKLM\SOFTWARE\Microsoft\Cryptography`, the motherboard serial and the system
  drive serial (WMI), hashed together. A shared Dart file, used by all four apps.
* A key presented from a different fingerprint is refused and says so. Moving a
  till to new hardware is a manager action in the back office, not a silent
  re-bind.

**Added — what happens to the sixth device**

Not the same answer for every app, because the cost of being wrong differs:

* **Till and Kitchen — refuse.** Evicting a till mid-service is how a machine
  dies with a bill half-rung; the venue is told which devices hold the seats and
  a manager signs one out. This is what the build already does and it is right.
* **Display — oldest out.** A display is read-only and losing one costs nothing,
  so the newest device wins and the oldest is bounced.
* **Express — refuse**, same reasoning as the till: a kiosk mid-order.

---

## 3. Updates: a beta track and a staging environment

> "Can I release the EPOS, Kitchen, Display and Express app in beta testing...
> a separate database where we first do anything isolated from the main database?"

**Exists.** Manual publish (`stage.js` sets `targetPublishMode: Manual`), a
registry script to stop a till auto-downloading, and an About page that checks
for a newer version. So nothing reaches a till until somebody presses *Publish
now* — but there is no way to give a build to testers only, and **no environment
to test against that is not live.** The only "sandbox" in the tree is Dojo card
payments, which is unrelated.

**Added — Store package flights**

* `ms-store-submission-client` gains flight support: list flights, create one,
  and stage/commit a package to a flight rather than to the main submission
  (`/v1.0/my/applications/{id}/flights`). A flight goes to a named group of
  testers and never to a customer.
* Per app: a **Vesopa Testers** flight group. The release path becomes
  *flight → test on the office till → main submission, Manual → Publish now*.

**Added — staging**

* A second server on the Hestia box: `staging.backoffice.vesopaepos.com`, its own
  database, its own pm2 app. Auto-updates are off on that box already.
* `deploy` takes a target, defaulting to live, so staging is deployed the same
  way and the difference cannot be a hand-typed path.
* Staging is seeded from a **scrubbed** copy of live: real shapes, no real
  customer names, addresses, emails or card tokens.

---

## 4. The loyalty app on iOS and Android

**Exists.** `vesopa_loyalty/` is a Flutter app with `web/` and `windows/` only,
on a complete `/loyalty/v1` API — email-code sign-in, QR card, history, inbox,
Web Push and WNS. The back office has its branding and notification pages. All
of that is platform-independent and is kept.

**Added**

* `ios/` and `android/` targets on the same codebase and the same API. The
  screens do not change.
* **Push.** Web Push and WNS stay for those platforms; iOS gains APNs and
  Android gains FCM. `POST /loyalty/v1/me/push` already stores a channel per
  device — it takes two more channel kinds, not a new design.
* **White-labelling per venue** works as it does on Windows: one build per venue
  from `brands/<slug>.json`, published under the venue's own name.

**Needed from the owner.** An Apple Developer account (£79/yr) and a Google Play
developer account ($25 one-off), plus each venue's store listing identity. The
API and the shared Dart code do not wait on these; the builds do.

---

## Releases

| What | Where | Needs from the owner |
|---|---|---|
| Staging server | staging.backoffice.vesopaepos.com | — |
| Server + back office (demo venues, licensing) | backoffice.vesopaepos.com | — |
| EPOS / Kitchen / Display / Express | Store, **flight first** | Name the testers |
| Loyalty iOS + Android | App Store, Play | Developer accounts; Pontardawe branding |

## Risks

* **A demo venue that is not obviously one.** Every screen in demo carries an
  amber banner, and a demo receipt keeps the TRAINING marking, because the worst
  outcome is a real customer handed a practice bill.
* **Licence limits locking a venue out.** Absent means unlimited, as before, and
  a lookup that fails lets the device through — a licence count must never be
  the thing that stops a venue trading.
* **Hardware fingerprints on replaced hardware.** A new motherboard changes the
  fingerprint; the back office can re-bind a key, and this is documented rather
  than discovered at 7am.
* **Staging drifting from live.** It is deployed by the same script and seeded
  from the same schema, or it stops being a test of anything.
