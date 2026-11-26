# Vesopa Go: everything Google Play asks for

Package: `com.vesopa.go`. Version 1.2.0. The listing text (name, short and full
description, release notes) is in `play.json`, and `.github/workflows/go-android.yml`
uploads it with the pictures in this folder. This page lists every other box in
Play Console, in the order Play shows them, with the answer to give. Google's
API can't fill these in, so they're typed by hand once. (Written 2026-10-27.)

**Release rule (owner, 2026-10-27):** Android goes to **Internal testing** only,
until the owner says otherwise. (Since then 1.2.73 has been sent to production; it was in review on 2026-11-26.) Vesopa Go has never been published, so Play
keeps it a **draft app** and every release arrives as a **draft**: open Testing >
Internal testing and press **Review release > Start roll-out**.

## Main store listing (Grow users > Store presence > Main store listing)

Uploaded by the workflow; check it looks right.

| Field | Answer |
|---|---|
| App name | Vesopa Go |
| Short description | Orders and payments anywhere in your venue, at the counter or the table. |
| Full description | `full_description` in `play.json` |
| App icon | `play-icon-512.png` (512x512) |
| Feature graphic | `play-feature-graphic-1024x500.png` |
| Phone screenshots | `screenshots/android-phone/` (1080x1920, 6 of them) |
| 7-inch and 10-inch tablet screenshots | use the iPad set, `screenshots/ipad-13/` (2732x2048 landscape): upload 4 to each |
| Android TV screenshots | needed only if Android TV is added (below): 1920x1080, at least 1 |
| TV banner | `android/app/src/main/res/drawable-xhdpi/tv_banner.png` (320x180), already in the app |
| Video | none yet |

## Store settings (Grow users > Store presence > Store settings)

| Field | Answer |
|---|---|
| App or game | App |
| Category | Business |
| Tags | Point of sale, Restaurant, Business, Payments (the closest Play offers) |
| Email address | info@vesopasoftware.com |
| Phone | leave blank |
| Website | https://go.vesopa.com/ |
| External marketing | Off (an app for venue staff, not the public) |

## App content (Policy and programmes > App content)

**Rewritten 2026-11-26 for Go 1.2.74.** The answers before this date predated
the in-app sign-up (1.2.65), Stripe (1.2.68) and the demo's return, and said
the app used no location, which no longer matched the app. Google rejects an
app whose answers do not match what it does, so type these in as they are.

**Privacy policy:** https://go.vesopa.com/privacy/

**App access:** "All or some functionality is restricted". One set of
instructions:
- Name: Try the demo (no sign-in)
- Username / Password: leave empty (not needed)
- Any other information: "No account is needed to review Vesopa Go. On the
  first screen tap **Try the demo**, then sign on with staff PIN **1111** (Sam,
  a manager; 2222 and 3333 are staff). The demo venue runs on the device and
  its card payments are pretend, so no real money moves. Register a new venue
  shows the sign-up: the business, Stripe's identity and business checks, and a
  14-day free trial that asks for no payment in the app."

**Ads:** No.

**Content rating** (IARC, category "All other app types"): No to violence,
sexuality, language, controlled substances, gambling, user content shared
between users, sharing the user's location with others.
- "Does the app allow users to purchase digital goods?" **No.** The licence is
  not sold in the app (1.2.74); the payments in the app are the venue's own
  sales of food, drink and tickets.
- Menus can name drinks: if Play asks about references to alcohol, answer Yes
  for a product list only. Expected rating: Everyone / PEGI 3 or Teen / PEGI 12.

**Target audience and content:** 18 and over only (venue staff and owners).
"Could the app unintentionally appeal to children?" No.

**News app:** No. **COVID-19, government, health apps:** No to each.

**Financial features:** Yes. Choose the point-of-sale / payment acceptance
option ("the app lets a business take payments from its customers").
- What it does: the venue's own card payments, taken by the venue's payment
  provider: Stripe (Tap to Pay on Android and Stripe card readers, through
  Stripe's Terminal SDK, and QR Pay), or the venue's Dojo or Teya card
  machine. Card details are read by the provider's certified software and go
  straight to it; Vesopa never stores a card number.
- Not a bank, a loan, crypto, a money transfer, a wallet or investments.

**Advertising ID:** No. No ads or analytics SDK.

**Data safety.** "Does your app collect or share any of the required user
data types?" Yes. "Is all of the user data collected by your app encrypted in
transit?" Yes. "Do you provide a way for users to request that their data is
deleted?" Yes. Account deletion URL: **https://auth.vesopa.com/delete-account**
(also in the app: More > Delete my Vesopa account).

Shared: only where marked. Stripe, Dojo and Teya act as the venue's payment
processors, and Stripe as Vesopa's identity checker.

| Data type | Collected | Shared | Required or optional | Purposes |
|---|---|---|---|---|
| Location: Precise location | Yes (Tap to Pay on Android needs it while a payment is taken; Stripe's SDK) | No | Optional | App functionality; Fraud prevention, security and compliance |
| Location: Approximate location | Yes (as above) | No | Optional | App functionality; Fraud prevention, security and compliance |
| Personal info: Name | Yes (staff; the owner at sign-up; customers the staff add) | No | Required | App functionality; Account management |
| Personal info: Email address | Yes (sign-in; customers' receipts, tickets, memberships) | No | Required | App functionality; Account management |
| Personal info: Phone number | Yes (customers, for loyalty; the owner, in Stripe's checks) | No | Optional | App functionality; Fraud prevention, security and compliance |
| Personal info: Address | Yes (the venue's and the business's address at sign-up) | No | Required | App functionality; Fraud prevention, security and compliance |
| Personal info: User IDs | Yes (Vesopa account, staff, member number) | No | Required | App functionality; Account management |
| Personal info: Other info | Yes (the owner's date of birth and ID details, in Stripe's identity check) | No | Optional | Fraud prevention, security and compliance |
| Financial info: User payment info | Yes (customers' cards, read by Stripe's SDK for Tap to Pay and sent straight to Stripe) | No | Optional | App functionality |
| Financial info: Purchase history | Yes (the venue's sales) | No | Required | App functionality |
| Financial info: Other financial info | Yes (the payout bank account and expected takings, at sign-up) | No | Optional | App functionality; Fraud prevention, security and compliance |
| Photos and videos: Photos | Yes (the owner's photo ID and selfie, in Stripe's identity check; staff photos set in the back office) | No | Optional | Fraud prevention, security and compliance; App functionality |
| Device or other IDs | Yes (the device's id for its till seat) | No | Required | App functionality |
| App activity, app info and performance, web browsing, contacts, messages, audio, files, calendar, health | No | | | |

- The camera scans QR codes and barcodes; no picture is kept or sent, except
  the photo ID and selfie that the owner takes in Stripe's identity check.
- NFC reads staff cards, fobs and members' cards; ids are matched on the device.

**Permissions declaration** (if Play asks):
| Permission | Why |
|---|---|
| CAMERA | Scanning table QR codes, product barcodes, gift cards, member cards and tickets; the owner's ID check at sign-up |
| NFC | Staff cards and fobs, members' cards, NFC tags on tables |
| ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION | Tap to Pay on Android: Stripe's SDK needs the location while a card payment is taken (foreground only, never in the background) |
| BLUETOOTH_SCAN, BLUETOOTH_CONNECT | Stripe card readers and receipt printers |
| USE_BIOMETRIC | Fingerprint or face sign-in for staff |
| INTERNET | The venue's back office, Vesopa sign-in and the payment provider |

**Government apps:** No.

## Advanced settings > Form factors

- **Phones and tablets:** covered by the one bundle; nothing to add.
- **Android TV (only if wanted):** add the Android TV form factor and opt in to
  TV distribution. Play then reviews the app for TV: it needs 1920x1080 TV
  screenshots and the banner (already in the app). Card payments on a TV go to
  the card machine only (a TV has no NFC). Leave it off until the owner decides
  how the TV build is used.

## Testers (Testing > Internal testing > Testers)

Add the email list (or a Google Group) of the people who should get the app,
then share the opt-in link Play shows there. Google's API can't copy testers
from one track to another.

## Releases

Internal testing only (see the rule at the top). Release notes for 1.2.0
(`play.json`, uploaded by the workflow):

```
<en-GB>
Vesopa Go 1.2: the till on your iPad and phone. Your programmed screens, the till's permissions and gestures, staff photos, customers and loyalty, memberships, event tickets and the gate, mix & match, cash and wastage, the card machine page, printers found on your Wi-Fi, managers arranging screens and tables, and the venue's local link with the tills.
</en-GB>
```
