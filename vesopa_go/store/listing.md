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
- **Support URL:** https://vesopaepos.com/
- **Marketing URL:** https://vesopaepos.com/
- **Privacy policy:** https://vesopaepos.com/privacy
- **Description:** as `play.json`'s full description.
- **Sign-in for App Review:** the first screen's "Try the demo", PIN 1111 (no account needed).

## Play Console questions the API cannot answer

- **App access:** some functions need sign-in; reviewers use "Try the demo", PIN 1111.
- **Ads:** none.
- **Content rating:** utility / business, no user content shared publicly.
- **Target audience:** 18+ (venue staff).
- **Data safety:** staff name and email (sign-in, app functionality); purchase
  history (the venue's sales, app functionality). Encrypted in transit; not
  shared with third parties except Dojo for card payments; not sold. Card data
  is read by Dojo's software, never by the app.
- **Financial features:** point of sale for the venue's own customers, through Dojo.
