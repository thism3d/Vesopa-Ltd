# Vesopa Go: everything Google Play asks for

Package: `com.vesopa.go`. Version 1.2.0. The listing text (name, short and full
description, release notes) is in `play.json`, and `.github/workflows/go-android.yml`
uploads it with the pictures in this folder. This page lists every other box in
Play Console, in the order Play shows them, with the answer to give. Google's
API can't fill these in, so they're typed by hand once. (Written 2026-10-27.)

**Release rule (owner, 2026-10-27):** Android goes to **Internal testing** only,
until the owner says otherwise. Vesopa Go has never been published, so Play
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

**Privacy policy:** https://go.vesopa.com/privacy/ (terms: https://go.vesopa.com/terms/, support: https://go.vesopa.com/support/)

**App access:** "All or some functionality is restricted". Add instructions:
- Name: The Vesopa Kitchen (review venue)
- Username: The Vesopa Kitchen's manager email (manager@vesopa.co.uk)
- Password: its password, typed here by hand (never in this repo)
- Any other information: "Tap Continue with Vesopa and sign in with the email and password above. The Vesopa Kitchen is Vesopa's own test venue: its card payments run on Dojo's sandbox, so no real money moves. Then sign on with staff PIN ____ (a manager)."

The demo has been taken out of the store builds (2026-10-28). The Vesopa Kitchen
is the review venue, and the only venue with Vesopa Go on its licence.

**Ads:** No, the app does not contain ads.

**Content rating:** start the IARC questionnaire, category "All other app types"
(a business and productivity app). Answer No to violence, sexuality, language,
gambling, user-generated content shared between users, and location sharing.
- "Does the app reference alcohol?" A bar's menu can show drink names, so answer
  Yes to references to alcohol only if Play's wording covers a product list;
  otherwise No. Expected: PEGI 3 / Everyone, or PEGI 12 / Teen. Either is fine.
- "Does the app allow users to purchase digital goods?" No. Payments are the
  venue's own sales of food, drink and tickets, taken through Dojo.

**Target audience and content:** 18 and over only (venue staff). "Could the app
unintentionally appeal to children?" No.

**News app:** No.

**COVID-19, government, health:** No to each.

**Financial features:** Yes, "Payments / point of sale for a business".
- What it does: takes card payments for a venue's own sales, through Dojo (the
  venue's card machine, a Dojo Pocket, or Tap to Pay on iPhone). The app never
  reads or stores card numbers; Dojo's software does.
- Not a bank, a loan, crypto, a money transfer or a wallet.

**Advertising ID:** No, the app does not use an advertising ID. No analytics or
ads SDK is included.

**Data safety:** collected, nothing sold, shared only with Dojo (card payments),
everything encrypted in transit, users can ask for deletion.

| Data type | Collected | Shared | Optional? | Purposes |
|---|---|---|---|---|
| Personal info: Name | Yes (staff, and customers the staff add) | No | Required | App functionality, Account management |
| Personal info: Email address | Yes (staff sign-in; customers for receipts, tickets and memberships) | No | Optional | App functionality, Account management |
| Personal info: Phone number | Yes (customers, for loyalty and memberships) | No | Optional | App functionality |
| Personal info: User IDs (Vesopa account, staff ID, member number) | Yes | No | Required | App functionality, Account management |
| Financial info: Purchase history (the venue's sales) | Yes | Yes, with Dojo for card payments | Required | App functionality |
| Photos (staff photos shown at sign-on, set in the back office) | Yes | No | Optional | App functionality |
| Device or other IDs (the device's own id for its till seat) | Yes | No | Required | App functionality |
| App info and performance: Diagnostics | No | | | |
| Location | No | | | |
| Contacts, messages, audio, files, calendar, health | No | | | |

- The camera is used only to scan QR codes and barcodes on the device; no picture is kept or sent.
- NFC reads staff cards and fobs; the card's id is matched on the device.
- "Is all of the user data collected by your app encrypted in transit?" Yes.
- "Do you provide a way for users to request that their data is deleted?" Yes.
- Delete account URL: https://auth.vesopa.com/delete-account

**Permissions declaration** (if Play asks when the bundle is reviewed):
| Permission | Why |
|---|---|
| CAMERA | Scanning table QR codes, product barcodes, gift cards, member cards and event tickets |
| NFC | Staff cards and fobs at sign-on, NFC tags on tables |
| USE_BIOMETRIC | Fingerprint or face sign-in for staff on their own device |
| INTERNET | The venue's back office, Vesopa sign-in and Dojo |

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
