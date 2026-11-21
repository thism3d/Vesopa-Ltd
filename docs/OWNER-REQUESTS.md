# What the owner has asked for

The owner, 2026-11-19: "Keep everything in notes what I'm asking you so that I
don't have to repeat again and again." Read this before working on Vesopa Go,
the club apps (Pontardawe RFC, Loughor RFC), their websites or their store
listings, and keep it up to date: a new ask goes in, a finished one is marked
done with the date. Nothing secret goes here (passwords live in GitHub
secrets only).

## Standing rules

- **Live servers:** "Do not alter coding in cloud Vesopa or mailbox, only create
  everything being a user." Create accounts, mailboxes and domains as a panel
  user does. Never change Exim, Hestia or the mail set-up; mail forwarding is
  opt-in only (`MAIL_FORWARD=1`).
- **Branding:** keep each club's own branding. Use the crest exactly as the
  club supplied it. Never draw, redraw or AI-generate a club crest, and never
  draw another club's badge.
- **Pontardawe RFC app:** do **not** release a new Pontardawe RFC app build
  until the owner says so (2026-11-19). Website and server-side changes such
  as deep-link files are fine.
- **Every workflow** runs from GitHub Actions, and everything is pushed to
  main through a pull request.
- **iOS builds** use the newest Xcode, as Vesopa Go does: the `xcode-27`
  runner, with the iOS 27 SDK that ITMS-90725 requires.
- **Google Wallet** passes for every venue are issued by **Vesopa Software
  Ltd** (issuer `BCR2DN6D3LQ5NWRK`). The service account is
  `firebase-adminsdk-fbsvc@vesopa.iam.gserviceaccount.com`, an Admin in the
  Google Pay & Wallet Console, in Google Cloud project `vesopa`
  (561180189171).
- **Loughor RFC app releases** go to Play **open testing** (`beta`, and
  `wear:beta` for the watch) from now on (owner, 2026-11-19): `LoughorRFC/store/play.json`
  `track`. iPhone builds go to TestFlight and its external groups.
  Straight to open testing only (owner, 2026-11-19: "Directly publish to
  open testing no need to submit to internal and closed testing from now
  on"): never upload or promote a Loughor build to `internal`, `alpha`,
  `wear:internal` or wear closed testing.
- **Decisions:** "Go on, finish all the tasks. Full consent given. Do pick
  the best decisions." Ask the owner straight away when something is
  genuinely theirs to decide.

## Vesopa Go

| Ask | Status |
| --- | --- |
| Every release goes to go.vesopa.com/install as well as the stores | done (the `install_page` input of Go - Android, on by default) |
| Android TV: proper TV app, TV screenshots, TV banner, TV store listing, remote buttons work | 1.2.71: kitchen grid on a TV, the remote works throughout, 4 TV screenshots, banner, listing. The owner then opts in under Play Console > Advanced settings > Form factors > Android TV |
| Dedicated Android TV and Wear OS tracks (switched on by the owner, 2026-11-19). Play's TV track takes only a bundle that requires leanback, so each Go release builds a TV-only bundle (version code 2,000,000 + build) for tv:<track> (else tv:internal); TV screenshots, banner and the TV opt-in are done | go-android.yml, tool/play_upload.py |
| On a TV offer only Kitchen and Customer display (same app, same `com.vesopa.go` listing; Android TV is a form factor, not a second app) | 1.2.71 |
| Read the Loughor members' card by NFC (Android phone and Wear OS) | 1.2.70 |
| go.vesopa.com/install: Android and Android TV downloads (owner, 2026-11-19) | live with 1.2.72: the page has an Android TV section (the same APK, via Google Play on the TV or the Downloader app); publish_install.py stamps its version |
| Publish the new Go to Play open testing, matching the Wallet cards' NFC (owner, 2026-11-19) | 1.2.72: the card sheet also reads a Wallet NFC reader that types the card number (Google Smart Tap / Apple VAS readers by USB or Bluetooth). Live 2026-11-19: 1.2.72 (73) on Play open testing (beta) and Android TV open testing (tv:beta, 2000073); go.vesopa.com/install 200 |
| A new Android TV open-testing release on its own (owner, 2026-11-19) | Go - Android with part "tv": only the TV bundle to tv:<track>. Done: 1.2.72 (74), version code 2000074, on tv:beta |
| TV: offer only what the hardware has (owner, 2026-11-19: "There is no camera on a TV ... check hardware first and then offer items and functionality") | 1.2.73: Go reads the device's camera, NFC and touchscreen (MainActivity deviceInfo); Tap member card / Scan your pass only where they work, the scan sheet types the number where there is no camera |
| TV settings PIN with the remote, no on-screen keyboard | 1.2.73: the remote's number buttons, or Up/Down/Right/OK; or unlock from a phone |
| First screen colours with the remote | 1.2.73: focus ring and OK on each colour |
| Control the TV kitchen and customer display from Go on Android, iPhone and iPad | 1.2.73: More (or Settings > Screens and TVs) > Control a screen or TV: arrows, OK, Back, adverts, reload, Settings after a manager's PIN on the phone. Server: src/go_remote.js (keys over the venue's live connection) |
| Why one TV is compatible and another not | the plugins' permissions made Play require a camera, Bluetooth and GPS; 1.2.73 marks every such feature not required (AndroidManifest.xml) |
| The Vesopa Kitchen: promotion banners with real food | 9 banners (real food photos, Unsplash licence) in vesopa_server/tool/kitchen-adverts, put on the venue's displays by tool/kitchen-display-adverts.js (Back office - patch, run kitchen-display-adverts) |
| "I did not get the updates" (2026-11-19) | Go 1.2.73 had gone to open testing only, while the owner's devices take internal testing (still 1.2.71): 1.2.73 (75) and TV 2000075 now also on internal and tv:internal; Go iOS 1.2.73 (1) on TestFlight, sent to Beta App Review (public link https://testflight.apple.com/join/zgg5YSn8). Check any time with Go - Android / Android - venue app, mode status |
| Faster workflows: cache tools between runs | done (Gradle, NDK, SwiftPM, Flutter caches) |

## Vesopa EPOS till (Windows, `vesopa_epos/`)

| Ask | Status |
| --- | --- |
| iPad-style keyboard replacing the old one on every field (owner, 2026-11-20; Meirion, Pontardawe RFC: "a larger keypad"): UK layout, `.?123` and `#+=` as an iPad's, no word suggestions, emoji or dictation; undo, redo, cut, copy, paste, select all; a real keyboard's typing puts it away, leaving a keyboard button in the bottom corner (drag it to the other corner); Dock, Undock, Split, Floating; fields laid out above it | 1.16.56: `lib/ui/widgets/keyboard_dock.dart` (the one keyboard, docked in the root overlay; pages make room through `MediaQuery.viewInsets`, `KeyboardInsets` in main.dart). Every text field and every number/price field uses it (`OnScreenKeyboard` and `PosTextField` only ask for it); the old inline keyboards and the old floating keyboard are removed. Number fields get a round iPad-passcode pad with Clear, the keyboard button and a tall return key. Pictures on The Vesopa Kitchen's till: `vesopa_epos/store_shots/keyboard/` (`flutter test --update-goldens store_shots/keyboard_shots_test.dart`) |
| Store upload and admin unsigned installer for the keyboard | 1.16.56: the unsigned installer is on admin.vesopa.com/downloads (2026-11-20). The Microsoft Store upload did not go: no secret signs in to Partner Center any more. MICROSOFT_APPLICATION_ID's secret (MICROSOFT_VESOPA_CLIENT_KEY) is refused as invalid (probably expired) and MS_STORE_CLIENT_ID/SECRET hold the customer sign-in app's values. The owner makes a new client secret for the Store submission app (VesopaEPOS) in Microsoft Entra (App registrations > VesopaEPOS > Certificates & secrets) and saves it in GitHub as MS_STORE_CLIENT_ID (the app's ID) and MS_STORE_CLIENT_SECRET (the secret's Value), then re-runs Windows - till release with store only |

## Loughor RFC (`LoughorRFC/`)

| Ask | Status |
| --- | --- |
| Website loughorrfc.site: brand new, nothing like Pontardawe's ("Heritage programme"), new friendly opening animation, no store badges until the apps are published | live |
| Members' site member.loughorrfc.site; mail info@ and contact@ | live |
| Apps `com.vesopaepos.loughorrfc` (watch `…watchkitapp`), name "Loughor RFC"; App Store Apple ID 6836592429, SKU LoughorRFC | iOS 1.0.0 (1) on TestFlight. Android 1.0.0 (3) on Play open testing (beta) and the watch on wear:beta, 2026-11-19, as drafts: Play keeps every release of a never-published app as a draft until the owner rolls out the first one in Play Console (Test and release > Open testing > Edit release > Roll out) |
| Wear OS app on Play | Play makes Wear OS internal, open and production tracks (no closed): the watch goes on wear:internal (private) |
| Crest: transparent PNG and round icon from the club's own crest | done (`LoughorRFC/brand/`) |
| Crest "still showing black" in the app and websites (owner, 2026-11-20: both the artwork's dark rim and a black box) | make_crest_cutouts.py peels the dark shadow rim and grey glow from the letters, stalks and shield (the crows stay black); every icon, splash, website crest and Wallet picture redrawn. The black box was the iPhone's dark-mode home-screen icon (iOS puts a transparent icon on black): it is now the club's own square crest |
| Google Play and TestFlight test links at the top of loughorrfc.site's homepage (owner, 2026-11-20) | a strip above the cover: "New: the Loughor RFC app", iPhone & iPad (TestFlight) and Android & Wear OS (Google Play) (layout.js appStrip); deployed with Club site |
| Wear OS open testing "not published" (owner, 2026-11-20) | 2026-11-20: wear:beta holds 1.0.0 (7) (code 1000007), completed, offered in 177 countries + rest of world; the phone's beta holds 1.0.0 (7) the same. Nothing is missing on the API side: in Play Console, Publishing overview either lists changes "Ready to publish" (managed publishing on: press Publish changes) or shows the Wear OS release "In review" (a new form factor's first release is reviewed on its own, up to a few days). Check any time with Android - venue app, mode status |
| Google Wallet: the Add to Google Wallet button always shown (Android, iPhone, iPad) but a Google account linked before it is used; "Added to Google Wallet" once saved, as Apple Wallet's | Android: Google's own sign-in sheet links the account first (POST /loyalty/v1/me/google, token checked against Google's keys), "Saves to name@gmail.com · Change" under the button. iPhone/iPad: Google Wallet's save page asks for the Google account itself, and saving links it (the app has no iOS Google client for Loughor: add one in Google Cloud and set venue.json google_ios_client_id to use the sheet there too). Once Google's save callback arrives the card shows "Added to Google Wallet" with Open Google Wallet; deleting the card in Google Wallet brings the button back (vesopa_server/src/wallet_google_state.js). Server on the back office; app in the next Loughor build |
| Wallet passes redesigned (Apple Pass Designer guidelines) | Villa Field on a match night behind the points (sky, floodlights, posts, pitch stripes, the River Loughor's waves as on the website, the club's own crows, the crest with a gold glow; the left kept dark for the number): Apple strip (@1x, @2x), Google hero and banner (LoughorRFC/brand/make_wallet_art.py). Preview: LoughorRFC/store/wallet/passes-preview.png. Image addresses versioned (?v=2) so Google fetches the new pictures |
| Back office venue "Loughor RFC" (office 99): login info@loughorrfc.site with every module, realistic demo data, the review member test@test.com / 123456 for the app stores | done |
| Vesopa accounts info@loughorrfc.site and loughorrfc@vesopa.com, and the loughorrfc@vesopa.com mailbox on Vesopa Cloud (password in the `LOUGHOR_ACCOUNT_PASSWORD` secret) | done. Mail from outside arrives only once vesopa.com's MX points at Vesopa Cloud |
| Google Wallet pass classes (loyalty, customer) through the workflow | done 2026-11-19: loyalty class approved, customer class under Google's review (issuer Vesopa Software Ltd) |
| Google Wallet passes done properly (owner, 2026-11-19): class ids `com.loughorrfc.loyalty` and `com.loughorrfc.customers` (several devices and holders); image modules (banner), wordmark, text modules, messages; links loughorrfc.com and vesopaepos.com (loughorrfc.site is temporary: move to loughorrfc.com before the final release); homepage loughorrfc.com; the ground's latitude/longitude (51.6627, -4.0655); loyalty labels as Pontardawe's card (points, tier); discoverable on the members' site (trusted testers first); callback https://backoffice.vesopaepos.com/wallet/google/callback (Google's signature checked; "update request URL" is deprecated by Google, so none); Smart Tap on, redemption issuer = Vesopa Software Ltd | live 2026-11-19: both classes made under the new ids with every field above, Smart Tap and callbacks included. Google refused only the discoverable programme ("invalid argument"): discovery is a feature Google switches on for an issuer, so the owner asks Google Wallet support (Pay & Wallet Console > Support) to enable discoverable programs for issuer Vesopa Software Ltd, then re-run Club site. The customers class is under Google's review |
| Smart Tap "hold near reader" for Google Wallet: what is a redemption issuer? | the company whose readers read the pass: Vesopa Software Ltd itself. To work, the owner adds a Smart Tap authentication key in the Google Pay & Wallet Console (Google Wallet API > Smart Tap), which gives a Collector ID, and buys a Google-certified Smart Tap reader (e.g. Socket Mobile, Elatec, Dot Origin) set up with that Collector ID and key. Google keeps the reader protocol to certified makers, so a phone running Vesopa Go cannot read a Google Wallet pass by NFC: the reader types the card number into the till like a scan |
| Apple Wallet "hold near reader" for the membership and loyalty cards | in the code (wallet_apple.js `nfc`), off until set up: the owner asks Apple for NFC on the pass type IDs (developer.apple.com/contact/passkit), Apple issues NFC-enabled pass certificates, and a VAS reader (Apple Wallet NFC, e.g. Socket Mobile, Elatec, VTAP) gives the public key for `APPLE_WALLET_NFC_KEY` |
| NFC "hold near reader" and QR on the members' card | Android phone and Wear OS done. iPhone shows the QR, and an Apple Wallet NFC pass needs Apple's NFC certificate |
| Deep links (owner's choice, 2026-11-19: "Members' site + /app"): member.loughorrfc.site (every page) and loughorrfc.site/app open the app; news, fixtures and /app/privacy, /app/terms stay in the browser | venue.json `app_links`; the app declares them (make_venue_app.py); the sites name the app (website server.js, back office loyalty_host.js); Android fingerprint read from Play at deploy (tool/play_signing.py). In the next Loughor build |
| iOS build with the newest Xcode (xcode-27 runner, iOS 27 SDK), as Vesopa Go | done: ios-venue-app.yml |
| Firebase iOS app (added by the owner): the build reads its GoogleService-Info.plist from Firebase | done: firebase_ios_app.py in ios-venue-app.yml |
| TestFlight public link and Google Play link on loughorrfc.site and member.loughorrfc.site (owner, 2026-11-19) | TestFlight public link https://testflight.apple.com/join/tegkU2kN (made by the TestFlight step, group "Vesopa Testers") and Google Play open testing https://play.google.com/apps/testing/com.vesopaepos.loughorrfc: "Try it now" on loughorrfc.site, /app sends each phone to its test, the members' site's badges (venue_looks.js). The Play link works once the owner rolls out the first open-testing release |
| Add to Google Wallet on iPhone and iPad (owner, 2026-11-19) | Loughor iOS 1.0.0 (4) on TestFlight and sent to Beta App Review for the external testers (build 2 was the last one approved). Android 1.0.0 (6) on open testing (beta, code 6) and wear:beta (code 1000006), completed 2026-11-20 after the owner re-enabled the paused open-testing track |
| Store links: account deletion https://auth.vesopa.com/delete-account/loughor-rfc, privacy https://loughorrfc.site/app/privacy, terms and trader link https://loughorrfc.site/app/terms | in progress (the owner pastes into Play Console what its API cannot set) |
| Firebase: SHA fingerprints, Apple and Web apps added by the owner | the builds use them |

## Pontardawe RFC (`PontardaweRFC/`)

| Ask | Status |
| --- | --- |
| Deep links (member.pontardawerfc.com and pontardawerfc.com/app), no app release | websites ready: pontardawerfc.com's assetlinks.json was already right; member.pontardawerfc.com names the app with its 4 fingerprints (loyalty_host.js). In Play Console > Deep links the owner sets the web links to member.pontardawerfc.com path /.* and pontardawerfc.com path /app. iPhone universal links need the next Pontardawe build (venue.json app_links is ready) |
| App Store "Ready for Distribution": is it published? | answered: that status means it is live on the App Store |

## vesopaepos.com (Vesopa EPOS website)

| Ask (owner, 2026-11-19, "quick tasks", priority) | Status |
| --- | --- |
| Google Search Console: merchant listings missing "hasMerchantReturnPolicy" and "shippingDetails" | each product's markup has its delivery (free from UK stock; standard £114 or DHL express £276 with VAT from the supplier) and the 14-day returns (hardware_catalogue.js productLd) |
| Product snippets missing "aggregateRating" and "review" | left out on purpose: only real customer reviews may be marked up (made-up ones break Google's rules); optional, the products still show |
| Merchant Center: "Missing shipping weight" | each product now states its own shipping cost, so no weight-based rate is needed; weights given where the supplier states them. The 15" kitchen screen and the kiosk have no known weight: if the account's shipping is weight-based, those two need a weight from the owner |
| Page indexing: /blog?tag=… (47) "Alternate page with proper canonical" | each tag is now its own page /blog/tag/<tag> (self-canonical, in the sitemap); the old ?tag= links 301 there; blog ?kind= and ?page= pages are their own canonical |
| www.vesopaepos.com | 301 to vesopaepos.com |
| /trial?period=1 | correct as it is: a version of /trial, which is the page to index |
| Deploy route | Back office - patch, target "website" (vesopa_web files, checked against git, backed up, health-checked). Deployed live 2026-11-19 06:06, healthy. Owner: press Validate fix in Search Console |


## Sales material

| Ask | Status |
| --- | --- |
| 4-page company catalogue (A4, prints to PDF) for prospective clients (2026-11-21) | draft: `documents/vesopa-catalogue.html` and `documents/vesopa-catalogue.pdf`. Facts from vesopa_web (`src/config.js` prices, contact, brand green #a5c715, Sora/Roboto). Left for the owner: the tagline (marked TBC), Pontardawe RFC's approval to be named as a case study, domains and hosting pricing, and a check that the plan prices match the live vesopaepos.com/pricing (the site's plans can be edited in the admin) |
| Square version of the catalogue (owner, 2026-11-21): not the same as the A4, same words, bolder, every graphic high quality and visible; for print and social, 4 pages | done: `documents/vesopa-catalogue-square.html` (210 × 210 mm), `documents/vesopa-catalogue-square.pdf`, and 2160 × 2160 px PNGs in `documents/vesopa-catalogue-square/`. Drawn vector devices (till, card machine, phone with a wallet card; Pontardawe's card shows the club's name and red only, no crest drawn); a real QR code on page 4 to vesopaepos.com/trial. Same TBC items as the A4 |
| Square catalogue "too messy": fewer words, more eye-catching graphics (owner, 2026-11-21) | done: rebuilt `documents/vesopa-catalogue-square.*` picture-first: cover with till, card machine and phone; 6 colour tiles with big icons and one line each; a "How it works" scene (kitchen screen, till, card machine) with 3 labels; Pontardawe RFC in one line with store and wallet badges; 3 big prices, 3 steps, QR and contact. The A4 version is unchanged |
| Square catalogue "still messy": clean, not too much stuff (owner, 2026-11-21) | done: rebuilt minimal, one idea and one picture per page: logo cover with the tagline; six services as a plain icon list; the till with three short facts; free trial, plans from £60 a month, QR and contact. The case study, pricing table and steps were taken off (the A4 still has them) |
