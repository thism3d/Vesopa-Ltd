# Vesopa Go: store listings

Play: `play.json` beside this file (uploaded by `.github/workflows/go-android.yml`).
App Store Connect: `app_store.json` (filled by `go-ios.yml`, never submitted); TestFlight's test information is filled by
`tool/testflight.py`. Pictures: `icon-1024.png`, `play-icon-512.png`,
`play-feature-graphic-1024x500.png`, `screenshots/android-phone` (1080x1920) and
`screenshots/iphone-6.9` (1290x2796), `screenshots/ipad-13` (2732x2048, landscape), from the demo build
(`tool/make_icons.py`, `tool/make_feature_graphic.py`).

## App Store

- **Name:** Vesopa Go
- **Subtitle (30):** Orders & payments, anywhere
- **Promotional text (170):** Seat a table, send the order to the kitchen and take the payment, all from your phone, with everything in the same Vesopa back office as your tills.
- **Keywords (100):** epos,pos,till,restaurant,bar,cafe,table service,orders,kitchen,dojo,tap to pay,hospitality
- **Category:** Business (secondary: Food & Drink)
- **Support URL:** https://go.vesopa.com/support/
- **Marketing URL:** https://go.vesopa.com/
- **Privacy policy:** https://go.vesopa.com/privacy/
- **Description:** as `play.json`'s full description.
- **Sign-in for App Review:** Continue with Vesopa with The Vesopa Kitchen's manager account (Dojo sandbox), typed by hand into App Store Connect > App Review Information > Sign-in required (user name, password), with a staff PIN in the Notes. Never in this repo.

## Play Console questions the API cannot answer

Every box, with the answer to type: **`play_console.md`** beside this file. In short:

- **App access:** some functions need sign-in; reviewers use The Vesopa Kitchen's manager account (see `play_console.md`).
- **Ads:** none.
- **Content rating:** utility / business, no user content shared publicly.
- **Target audience:** 18+ (venue staff).
- **Data safety:** staff name and email (sign-in, app functionality); purchase
  history (the venue's sales, app functionality). Encrypted in transit; not
  shared with third parties except Dojo for card payments; not sold. Card data
  is read by Dojo's software, never by the app.
- **Financial features:** point of sale for the venue's own customers, through Dojo.

## App Privacy (App Store Connect > Vesopa Go > App Privacy, by hand)

Apple's API cannot answer these. Data collected, all **linked to the user**,
**not used for tracking**:

- **Contact info: name, email address**: app functionality (staff sign-in).
- **Identifiers: user ID**: app functionality (the Vesopa account).
- **Purchases: purchase history**: app functionality (the venue's sales).

Card numbers are never collected by the app: Dojo's software reads cards.
No advertising, no analytics SDKs, nothing sold or shared for tracking.
