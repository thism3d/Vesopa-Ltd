# Vesopa Go: sign-up, TV connect, wallets and release (2026-11-18)

The owner's list from 18 November, with the decisions taken, what is behind
each problem and the work to finish it. Ticked when done and released.

## Decisions (owner, 18 Nov)

| Question | Answer |
|---|---|
| Apple Pay on the licence card sheet | A GitHub workflow creates the Merchant ID and turns Apple Pay on for the app. The owner then adds Stripe's Apple Pay certificate (one manual step). Google Pay on Android works straight away. |
| What a TV shows first | Only the QR and the code. No registration or sign-in on the TV. |
| Skipping a step in sign-up | Allowed. The step stays "Not done" on the progress dots and card payments keep the £250 / £1,000 limits until it is done. A banner in Go leads back to it. |
| The 14-day trial | All Go modes open (EPOS, Kitchen, Customer display, Card terminal). A branded welcome email from Vesopa, plus Stripe's own card and receipt emails. |
| Tap to Pay on this device | Phones only (iPhone, Android). Not on TVs. iPad keeps it for now as the demo device. |
| Dojo | Remove Dojo's Tap to Pay on Pocket SDK. Keep the Dojo card terminal, Stripe Terminal, Stripe Tap to Pay and the Teya terminal. |

## What is behind each problem

1. **"Verify your business" spins for ever**
   - The spinning button is inside Stripe's own Connect screen. Vesopa accounts are Accounts v2 with Stripe collecting the requirements, so the button opens Stripe's own pop-up.
   - Closed early, or once finished, Stripe's screen keeps spinning. Our step only learns the outcome when the sheet closes, and it shows nothing in the meantime.
   - Fix:
     - Our own checklist of Stripe's requirements (what is done, what Stripe still wants).
     - A clear Check again / Continue with Stripe.
     - Re-read the account each time the sheet closes, and show the result straight away.
2. **No Apple Pay / Google Pay on the card sheet.** PaymentSheet is set up without `applePay` / `googlePay`.
   - The app has no Apple Pay Merchant ID or `in-app-payments` entitlement.
   - Android lacks Google Pay's `wallet.api.enabled` meta-data.
3. **"Vesopa Go is not on this venue's licence" after sign-up**
   - Go is opt-in in `licences.js` (`OPT_IN = ['go']`): with no `bo_licence_limits` row for `go`, the venue has no seats.
   - Sign-up never writes one. Fix: the trial writes a `source = 'trial'` row, which a manager's override never loses.
4. **The TV QR opens a web page; connecting from the iPad failed**
   - The QR holds `https://go.vesopa.com/link/?c=CODE`. There are no universal links (iOS) or verified app links (Android), so phones open the browser.
   - Approving makes a Go licence with `enforce: true`, so a venue whose Go seats are used up (or never given) is refused.
   - The TV's name is not shown in the app's prompt.
5. **Sign-up looks plain.** It needs a stepped progress bar (● ● ○ ○ ○), an animated move from step to step, icons and graphics, skippable steps, a congratulations moment at the end and a welcome email.
6. **ITMS-90725 (iOS 27 SDK)**
   - GitHub's `macos-26` image tops out at Xcode 26.6.
   - Xcode 27 is on the **`xcode-27`** runner label: a public preview with Xcode 27.1 by default, and 27.2 (actions/runner-images `xcode-27-arm64-Readme.md`).

## Tasks

### Server (vesopa_server)
- [x] Sign-up steps can be **skipped** (`identity`, `stripe`, `licence`). `next` passes over skipped steps, `complete` counts them, and the mode stays `capped` until every check is truly done. Add `POST /go/onboarding/skip` and `/unskip`.
- [x] Stripe's **requirements as a checklist**: the account's `requirements.entries` (v2), grouped into readable rows (business details, people, ID document, bank account, terms), each due or done.
- [x] **Trial licences.** When the licence card is saved (trialing), write `bo_licence_limits` go = 5 seats, `source = 'trial'`, `status = 'trialing'`, `ends_at` = the trial end. Never lower an existing row, and never touch `override`.
- [x] **Welcome email** once sign-up is complete: branded, with the trial end date and the next steps (devices, the back office).
- [x] **TV link:** the approve prompt gets the TV's name (`GET /api/device/link/:code`). A venue with no free Go seat gets a clear message. A test covers start → approve → poll → license.
- [x] `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` on go.vesopa.com (the go-site deploy).

### Go app (vesopa_go)
- [x] **Sign-up redesign** (Apple HIG / Material 3):
  - a progress bar of steps
  - one step per page with a hero icon, a short explanation and one main button, plus Skip where allowed
  - an animated move to the next step
  - Stripe's checklist inside the business step
  - Check again
  - a congratulations screen (animated) with what is open now
- [x] Banner on Go's home while a step is skipped or still being checked, leading back to Account checks.
- [x] Licence card sheet: Apple Pay (merchant `merchant.com.vesopa.go`) on iOS, Google Pay on Android (production, GB / GBP).
- [x] **Deep links:**
  - iOS: `applinks:go.vesopa.com` (entitlement) and Android: an `autoVerify` intent filter for `https://go.vesopa.com/link`. A scanned QR opens Go straight at "Connect this screen", naming the TV.
  - In-app scanning shows the TV's name too.
- [x] **TV:** the link screen shows only the QR and the code ("Sign in instead" removed on a TV), designed to Google TV guidelines: 10-foot type, focus, no typing.
- [x] **Tap to Pay on this device** is hidden on TVs. Phones keep it; iPad keeps it for the demo (one flag, `tapToPayOnTablets`).
- [x] **Remove Dojo Tap to Pay on Pocket:**
  - the `tech.dojo.pos:tap-to-pay-on-pocket` dependency and the code in `MainActivity.kt` that uses it
  - the Dart paths into it
  - the Dojo checklist where it was only for Tap to Pay
  
  Keep the Dojo cloud card terminal.

### Website (go.vesopa.com)
- [x] `/link/` page: on a phone with Go, the universal link opens the app. Without Go it says to install Go (App Store / Play / install page) and then scan again.
- [x] Sign-up page: the same stepped design, skip and congratulations.

### CI / release
- [x] `go-ios.yml` on `runs-on: xcode-27`, picking the newest stable Xcode 27, and failing if the SDK is older than 27.
- [x] `go-ios.yml` creates or keeps the Apple Pay Merchant ID `merchant.com.vesopa.go`, and turns on the APPLE_PAY and ASSOCIATED_DOMAINS capabilities for the bundle (App Store Connect API), so the profile carries them.
- [x] Android: Play's app-signing certificate SHA-256 into `assetlinks.json` (Play Developer API, `generatedApks`), with the upload key too.
- [ ] Release: server (live), go.vesopa.com (live), Go Android (Play and the install page), Go iOS (TestFlight).

## The owner's manual steps (after release)

1. **Apple Pay certificate:**
   1. Stripe Dashboard (live) → Settings → Payment methods → Apple Pay → iOS certificates → Add new application → download Stripe's CSR.
   2. In developer.apple.com → Certificates → + → Apple Pay Payment Processing Certificate → merchant `merchant.com.vesopa.go` → upload the CSR → download the `.cer`.
   3. Back in Stripe, upload the `.cer`.
   
   Until then Apple Pay is not offered; the card and Link still work.
2. **Stripe Identity:** finish the Identity application on the live account so step 2 can use Stripe's ID and selfie check. Until then step 2 hands the ID check to step 3.

## Resources
- Stripe iOS Identity guide (owner's upload): `verify-identity-documents.md`. Identity trait in stripe-ios 26.16.1.
- Stripe Connect embedded onboarding (mobile) and Accounts v2 requirements: `requirements.entries[].description`, `minimum_deadline.status`.
- Stripe PaymentSheet: `Configuration.applePay` (merchantId, merchantCountryCode "GB"), `googlePay` (countryCode "GB", currencyCode "GBP"); Android manifest `com.google.android.gms.wallet.api.enabled`.
- Apple: Universal Links (`apple-app-site-association`, `applinks:`), App Store Connect API `merchantIds`, `bundleIdCapabilities` (APPLE_PAY, ASSOCIATED_DOMAINS).
- Android: App Links (`assetlinks.json`, `android:autoVerify`), Play Developer API `generatedapks` (signing certificate SHA-256).
- Google TV design guidelines: focus, D-pad, 10-foot UI, no text entry at first run.
- GitHub runner images: `xcode-27` label (public preview, actions/runner-images #14404).
- Code:
  - `vesopa_server/src/go_onboarding.js`, `licences.js` (OPT_IN go), `terminal_licences.js` (link start/approve/poll)
  - `vesopa_go/lib/ui/pages/onboarding.dart`, `ui/pages/link_screen_page.dart`, `ui/go_frame.dart` (_NotLicensed)
  - `packages/stripe_onboarding` (iOS Swift, Android Kotlin)
  - `web/site/js/signup.js`
  - `.github/workflows/go-ios.yml`, `go-android.yml`
