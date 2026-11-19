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
- **Decisions:** "Go on, finish all the tasks. Full consent given. Do pick
  the best decisions." Ask the owner straight away when something is
  genuinely theirs to decide.

## Vesopa Go

| Ask | Status |
| --- | --- |
| Every release goes to go.vesopa.com/install as well as the stores | done (the `install_page` input of Go - Android, on by default) |
| Android TV: proper TV app, TV screenshots, TV banner, TV store listing, remote buttons work | 1.2.71: kitchen grid on a TV, the remote works throughout, 4 TV screenshots, banner, listing. The owner then opts in under Play Console > Advanced settings > Form factors > Android TV |
| Dedicated Android TV and Wear OS tracks (switched on by the owner, 2026-11-19): every Go release also goes on tv:<track> (else tv:internal); TV screenshots and the TV opt-in are done in Play | tool/play_upload.py |
| On a TV offer only Kitchen and Customer display (same app, same `com.vesopa.go` listing; Android TV is a form factor, not a second app) | 1.2.71 |
| Read the Loughor members' card by NFC (Android phone and Wear OS) | 1.2.70 |
| Faster workflows: cache tools between runs | done (Gradle, NDK, SwiftPM, Flutter caches) |

## Loughor RFC (`LoughorRFC/`)

| Ask | Status |
| --- | --- |
| Website loughorrfc.site: brand new, nothing like Pontardawe's ("Heritage programme"), new friendly opening animation, no store badges until the apps are published | live |
| Members' site member.loughorrfc.site; mail info@ and contact@ | live |
| Apps `com.vesopaepos.loughorrfc` (watch `…watchkitapp`), name "Loughor RFC"; App Store Apple ID 6836592429, SKU LoughorRFC | iOS 1.0.0 (1) on TestFlight; Android phone on Play closed testing (alpha) as a draft |
| Wear OS app on Play | Play makes Wear OS internal, open and production tracks (no closed): the watch goes on wear:internal (private) |
| Crest: transparent PNG and round icon from the club's own crest | done (`LoughorRFC/brand/`) |
| Back office venue "Loughor RFC" (office 99): login info@loughorrfc.site with every module, realistic demo data, the review member test@test.com / 123456 for the app stores | done |
| Vesopa accounts info@loughorrfc.site and loughorrfc@vesopa.com, and the loughorrfc@vesopa.com mailbox on Vesopa Cloud (password in the `LOUGHOR_ACCOUNT_PASSWORD` secret) | done. Mail from outside arrives only once vesopa.com's MX points at Vesopa Cloud |
| Google Wallet pass classes (loyalty, customer) through the workflow | Wallet API switched on by the owner; Club site creates the classes |
| NFC "hold near reader" and QR on the members' card | Android phone and Wear OS done. iPhone shows the QR, and an Apple Wallet NFC pass needs Apple's NFC certificate |
| Deep links (owner's choice, 2026-11-19: "Members' site + /app"): member.loughorrfc.site (every page) and loughorrfc.site/app open the app; news, fixtures and /app/privacy, /app/terms stay in the browser | venue.json `app_links`; the app declares them (make_venue_app.py); the sites name the app (website server.js, back office loyalty_host.js); Android fingerprint read from Play at deploy (tool/play_signing.py). In the next Loughor build |
| iOS build with the newest Xcode (xcode-27 runner, iOS 27 SDK), as Vesopa Go | done: ios-venue-app.yml |
| Firebase iOS app (added by the owner): the build reads its GoogleService-Info.plist from Firebase | done: firebase_ios_app.py in ios-venue-app.yml |
| Store links: account deletion https://auth.vesopa.com/delete-account/loughor-rfc, privacy https://loughorrfc.site/app/privacy, terms and trader link https://loughorrfc.site/app/terms | in progress (the owner pastes into Play Console what its API cannot set) |
| Firebase: SHA fingerprints, Apple and Web apps added by the owner | the builds use them |

## Pontardawe RFC (`PontardaweRFC/`)

| Ask | Status |
| --- | --- |
| Deep links (member.pontardawerfc.com and pontardawerfc.com/app), no app release | websites ready: pontardawerfc.com's assetlinks.json was already right; member.pontardawerfc.com names the app with its 4 fingerprints (loyalty_host.js). In Play Console > Deep links the owner sets the web links to member.pontardawerfc.com path /.* and pontardawerfc.com path /app. iPhone universal links need the next Pontardawe build (venue.json app_links is ready) |
| App Store "Ready for Distribution": is it published? | answered: that status means it is live on the App Store |
