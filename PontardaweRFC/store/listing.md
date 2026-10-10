# Pontardawe RFC: store listing

Same text for Google Play and the App Store. Draft: the club may want to
change the wording.

**App name:** Pontardawe RFC

**Short description (Play, max 80):**
Your Pontardawe RFC membership card, members' discount and club news.

**Subtitle (App Store, max 30):**
Members' card and club news

**Full description:**

The official members' app of Pontardawe RFC, est. 1881.

Your membership card lives on your phone. Show the code at the bar and your
members' discount is applied, every time, with no card to carry or lose.

- Your members' card: one tap to show the code at the till, with the screen
  turned up so it scans first time
- Members' discount on every visit
- See what you have spent and saved
- Club news and offers, straight to your phone
- Add your card to Apple Wallet on iPhone
- Your card on your Apple Watch

Sign in with Apple, Google, your phone, a passkey, or your email address with a one-time code or a password. The app is for club
members: if you are not a member yet, ask at the club.

**Keywords (App Store, max 100):**
pontardawe,rfc,rugby,club,members,membership,card,discount,wales,swansea valley

**Category:** Lifestyle (Play: Lifestyle)

**Privacy policy URL:** https://pontardawerfc.com/privacy

**Support URL:** https://member.pontardawerfc.com/ (club website: https://pontardawerfc.com)

**Contact email:** info@vesopasoftware.com

**Developer:** Vesopa Software Limited

**Content rating:** Everyone / 4+ (no user-generated content, no ads, no
purchases in the app)

**Store review sign-in:** the app is members-only with emailed codes. Give the
reviewer a member account the club has added in the back office (Customers),
and note in the review notes that the sign-in code is emailed to that address,
or set a password on it so the reviewer can use "Sign in with a password".

**Pictures:** `play-icon-512.png`, `play-feature-graphic-1024x500.png`,
`app-store-icon-1024.png` (in this folder). The App Store screenshots are in
`screenshots/` (iPhone 6.9" and iPad 13"), drawn from the app itself by
`python vesopa_loyalty/tool/make_store_screenshots.py PontardaweRFC`; the
captions are in `app_store.json`.

**App Store fields:** `app_store.json` holds what the iOS workflow types into
App Store Connect (name, subtitle, description, keywords, URLs, categories,
review notes, TestFlight text). Change it there and run the workflow again.

## App Privacy (App Store Connect, by hand: Apple's API cannot set it)

Data collected, all **linked to the user**, none used for tracking:

| Data | Used for |
|---|---|
| Contact info: Name | App Functionality |
| Contact info: Email Address | App Functionality |
| Contact info: Phone Number (optional) | App Functionality |
| User Content: Photos (optional profile photo) | App Functionality |
| Location: Coarse and Precise (optional, only while the app is open; compared with the club's and not stored) | App Functionality |
| Identifiers: Device ID (the notification token) | App Functionality |
| Purchases: Purchase History (what was spent at the club) | App Functionality |

"Do you or your third-party partners use data for tracking purposes?" No.
