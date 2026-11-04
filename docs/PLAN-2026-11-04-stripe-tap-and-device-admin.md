# Plan: Stripe Tap to Pay, device licensing and the admin device centre

Owner, 2026-11-04. Three requests, built in this order. Each phase ends tested,
committed, deployed (server) and released (apps) before the next starts.

1. **Stripe Tap to Pay in Vesopa Go** (iPhone and Android), sandbox first.
2. **Tills licensed by access key, settings kept in the back office**, as
   Newbridge does (Nicky, 2026-11-04: "the till needs to work 24/7 without
   asking customers to log in"; "each terminal all the settings are saved to
   the back office so we never lose the settings").
3. **admin.vesopa.com device centre**: every device type, per venue and per
   site, each provider configured its own way, with a dashboard.

Rules that hold throughout: Dojo, Teya and Barclaycard are never removed;
Pontardawe RFC's live data is not changed; venues update only on request;
mobile-responsive pages; Apple's Tap to Pay HIG and review guide v1.8.

---

## Why Stripe for Tap to Pay now

Dojo's iPhone SDK activates but never provisions a terminal for our app
(live and sandbox accounts alike: fingerprint missing, status "unknown",
"Order-id is missing"). That needs Dojo to register com.vesopa.go. Stripe is
an Apple-approved Tap to Pay PSP whose Terminal SDK provisions any app holding
the entitlement, and its test mode has a **simulated reader**, so the whole
flow can be tested without a card or real money. Dojo Tap to Pay stays in the
code; a venue chooses its provider.

## Phase 1: Stripe Tap to Pay in Vesopa Go

**Server** (vesopa_server/src/stripe.js, already live):
- `/api/till/stripe/connection-token`, `/payments`, `/refunds` exist; the
  Terminal location is per venue account.
- Add `/api/till/stripe/config` fields the app needs: `simulated` (test mode),
  `location`, `ready`, `provider: stripe`.
- Test venue: finish The Vesopa Kitchen's sandbox connected account with
  Stripe's test onboarding values (test mode only) so `card_payments` is
  active; `use_tap` on.

**App** (vesopa_go):
- Dependency `mek_stripe_terminal` 5.7.x (Flutter wrapper of Stripe Terminal
  iOS/Android SDKs, Tap to Pay supported).
- `lib/payments/stripe_tap.dart`: a `PaymentService` like DojoTapToPay:
  init with a connection-token callback; discover `TapToPay` (localMobile)
  reader (simulated in test mode); connect with the venue's location; create
  the PaymentIntent on the server (direct charge on the venue's account);
  `processPaymentIntent`; the server confirms; refunds.
- Provider choice: the venue's back office `uses.tap` on Stripe picks
  StripeTap; otherwise Dojo as now.
- Android: minSdk check, location permission; iOS: Info.plist location
  string, entitlement already in place.
- **Apple UI only**: the Tap to Pay screen is Apple's sheet. Go's own screens
  before and after it are neutral (no PSP branding): "Getting Tap to Pay on
  iPhone ready" with progress, then Apple's sheet, then Processing, then the
  result. Remove the provider name and the green "Starting" stage from the
  Tap to Pay path; keep it for the card machine.
- Set-up flow reuses tap_to_pay_intro.dart (terms are Stripe-triggered via
  Apple's sheet on first connect; manager-only check kept).

**Test**: unit tests for the service; simulated reader end to end at The
Vesopa Kitchen; a real iPhone with the development build; Android device.

**Release**: iOS development build for the registered iPhone (install page),
TestFlight build (Tap to Pay switches on there once Apple grants publishing),
Android to Play internal then open testing.

## What Nicky's two videos show (Newbridge console, 2026-11-04)

console.newbridgesoftware.co.uk, logged in as Pontardawe RFC, reseller VESOPA.

1. **Partner Management › Manage Companies** (13 s video): a table of every
   company: ID, Company Name, Contact Name, Contact Number, **Access Key**
   (Pontardawe RFC is company 61), Live Date (or a red "Push Live"), Status
   Active, Reseller VESOPA, and Stock Calculation "Calculate". Buttons: Create,
   Edit, Add Terminal, Template. Also Company Import/Export and Versions
   Manager.
2. **My Company › Manage Sites** (27 s video): Site Number 1 "Pontardawe RFC",
   3 terminals. Buttons: New, Edit, **Manage Terminals**, Printer Names,
   Colour Settings, Shared Paths. Also Purge Files, Import File, Import
   Customers, Transaction Exports, Export All Data.
3. **Terminal Management**: Terminal Number, Name, Version, Last Ping
   (3 Lounge 7.1.7.27; 4 Bar (M) 7.1.7.27; 5 Terminal 5 6.30.1.17). Buttons:
   Edit Terminal Settings, View Pending Updates, Update Functions, Add
   Terminal, Delete Terminal.
4. **Edit POS Settings** for one terminal: a search box and about 40
   categories (System, Application, Printers, Logging, ClerkOverlap,
   PMSService, StaffClockInOut, CardPrefix, PaymentSense, General,
   CustomerDisplay, Messages, Financials, EFTSettings, PMSSettings,
   ClerkSettings, FilePaths, CashDrawers, RestrictSignOn, PrinterSettings,
   Misc, MessageBroker, PMSMappings, Scales, Barcode, Performance, ResDiary,
   TableManager, SmartGift, Guestline, SoftwareUpdates, Premier). Each is a
   table of Label / Description / Value, with **Edit** and **Copy To
   Terminal** on every row. Examples: Bill Printer "Direct (Ethernet)
   192.168.1.61", kp1 "KP806 PLUS", Receipt Printer "Direct (Serial) COM1",
   Idle Page after clerk sign-off True, Block Table Unlocks True, Poll Server
   Interval 10000.

What we build from it:
- Company → Site → Terminal in admin.vesopa.com and the venue back office,
  with the same columns (number, name, version, last ping).
- Per-terminal settings as **searchable categories of label, description and
  value**, each row editable, with **Copy to terminal** (one row to another
  till, or the whole category, or a whole site).
- An access key per company and per terminal, so a till is licensed once and
  never asks anyone to sign in again after an update.
- "View pending updates" per terminal: settings changed in the back office
  that the till has not picked up yet.

## Phase 2: tills licensed by access key; settings in the back office

What Newbridge does (Nicky's video): a till is licensed once with company,
terminal number, site number and an **access token**; every terminal's
settings live in the back office, so a reinstall or update never loses them.

- **Back office**: per venue, "Terminals": each till has a number, a site, an
  access key (generated, shown once, revocable) and its settings document
  (printers, card machine, display, kitchen routes, drawers, scales, layout,
  receipt options). Edit here; tills pull on change.
- **Till (vesopa_epos)**: "License this till" screen taking the venue code,
  terminal number and access key (no email/password); a till token is issued
  that does not expire and is revoked only from the back office; on start it
  pulls its settings document and applies it; every local settings change is
  pushed back.
- Same for Vesopa Go devices, kitchen screens, displays and kiosks (each its
  own settings schema).
- Migration: existing tills keep working; the back office imports each till's
  current settings the first time it reports.

## Phase 3: admin.vesopa.com device centre

- **Venue > Devices**: every device of every type (tills, Go, kitchen,
  display, kiosk, card machines) with status, version, site, last seen,
  licence, and its settings; edit one, a selection, a whole site or the
  venue at once.
- **Payment providers per venue**, each with its own page because each works
  differently: Dojo (Connect machines, online key, Tap to Pay on Pocket/
  iPhone), Teya (store, machines), Barclaycard (online), Stripe (connected
  account, Tap to Pay, online). Enable/disable per provider and per way of
  paying.
- **Licensing**: seats per product, access keys, revoke, transfer.
- **Dashboard**: takings, device health, errors, payment success rates, per
  venue and per site, with charts; mobile responsive; icons consistent.

## Outside our code (owner actions)

- Apple: Tap to Pay capability ticked on com.vesopa.go; publishing
  entitlement after the review videos.
- Dojo: register com.vesopa.go (Team G238FR2ZC9) for Tap to Pay on iPhone;
  Pontardawe's location id; a staging key.
- Stripe: live account activation when we move beyond test mode.
