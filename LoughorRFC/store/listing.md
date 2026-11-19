# Loughor RFC: store listing

The text Google Play and the App Store show. `play.json` and `app_store.json`
hold the same words in the form the release workflows type into the consoles;
change it there.

**App name:** Loughor RFC
**Android package / iOS bundle id:** `com.vesopaepos.loughorrfc` (Apple Watch: `com.vesopaepos.loughorrfc.watchkitapp`)

**Short description (Play, max 80):**
Your Loughor RFC members' card: tap or scan at the bar, plus club news.

**Subtitle (App Store, max 30):**
Members' card and club news

**Full description:** see `play.json` (`full_description`) and `app_store.json` (`description`).

**Keywords (App Store, max 100):**
loughor,rfc,rugby,club,members,membership,card,discount,wales,swansea,blues,leucarum

**Category:** Lifestyle (secondary: Sports)

## Addresses the stores ask for

| | |
|---|---|
| Privacy policy | https://loughorrfc.site/app/privacy |
| Privacy choices (account deletion) | https://loughorrfc.site/app/privacy-choices |
| Support | https://loughorrfc.site/app/help |
| Terms | https://loughorrfc.site/app/terms |
| Marketing / website | https://loughorrfc.site/ |
| Members on the web | https://member.loughorrfc.site/ |
| Contact email | info@vesopasoftware.com |
| Developer | Vesopa Software Limited |

The app pages are drawn by the club's website (`website/src/pages.js`:
`/app/privacy`, `/app/privacy-choices`, `/app/help`, `/app/terms`) and are
live once the "Club site" workflow has deployed loughorrfc.site.

**Content rating:** Everyone / 4+ (no user-generated content, no ads, no purchases in the app)

**Store review sign-in:** members only. Add a reviewer member in the back
office (Customers) with a password, and put its email and password in
`app_store.json` `review.demo_user` / `demo_password` (and Play Console's App
access) before submitting for review.

## Pictures

All drawn from the club's own crest (`brand/crest.png`, the club's file as
supplied, `brand/crest-original.jpeg`), never redrawn or recoloured, by
`python vesopa_loyalty/tool/make_venue_art.py LoughorRFC`:

- `play-icon-512.png`, `play-feature-graphic-1024x500.png`, `app-store-icon-1024.png`
- Screenshots: `python vesopa_loyalty/tool/make_store_screenshots.py LoughorRFC` (needs Flutter)

## App Privacy (App Store Connect, by hand: Apple's API cannot set it)

Data collected, all **linked to the user**, none used for tracking:

| Data | Used for |
|---|---|
| Contact info: Name | App Functionality |
| Contact info: Email Address | App Functionality |
| Contact info: Phone Number (optional) | App Functionality |
| User Content: Photos (optional profile photo) | App Functionality |
| Identifiers: Device ID (the notification token) | App Functionality |
| Purchases: Purchase History (what was spent at the club) | App Functionality |

"Do you or your third-party partners use data for tracking purposes?" No.

Play Data safety: the same list; data is encrypted in transit; members can
ask for deletion in the app (Account > Delete account) or at the privacy
choices address above.
