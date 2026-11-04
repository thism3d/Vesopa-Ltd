# Tap to Pay on iPhone: go-live checklist (Vesopa Go, Dojo)

Owner request 2026-11-04. PSP for the Apple entitlement is **Dojo** only. Stripe is built on the
server for later and is not mentioned to Apple.

## Timeline (estimates)

| When | What | Who |
|---|---|---|
| 4 Nov 2026 | Entitlement request submitted to Apple | Meirion |
| 4 Nov 2026 | Email Alex Radzio (alex.radzio@dojo.tech): confirm Vesopa to Apple as a Dojo Tap to Pay partner; enable Tap to Pay on iPhone for the account; development entitlement guidance | Muzahid, cc Meirion |
| ~1–3 weeks | Apple grants the **development** entitlement | Apple |
| on grant | Tick Tap to Pay on iPhone on App ID `com.vesopa.go`; next iOS build picks it up (go-ios.yml "Tap to Pay from the App Store profile") | Meirion / Claude |
| +1 week | Build and test against Dojo sandbox on a real iPhone: education, T&C acceptance, payment, refund, failure cases | Claude + tester |
| +1 week | Submit Apple's Tap to Pay **checklist review** (screenshots/video of the flows below) and request the **publishing** entitlement | Meirion |
| Dec 2026 | App Store release (UK), first venue: The Vesopa Kitchen, then Pontardawe RFC on request | Owner |

## Apple requirements to build into Vesopa Go

From Apple's Tap to Pay on iPhone HIG and marketing guidelines:

1. **Merchant T&C acceptance**: the first time at a venue, an admin or owner accepts Apple's Tap to Pay terms
   (ProximityReader `PaymentCardReader` prepare flow shows Apple's sheet). Staff without admin rights
   see "Ask your manager to accept the Tap to Pay terms".
2. **Merchant education**: show Apple's education screens (`ProximityReaderDiscovery`, iOS 18+) after
   T&C acceptance, and keep them reachable from Settings ("How to use Tap to Pay on iPhone").
3. **Naming**: the checkout button says **"Tap to Pay on iPhone"**; use Apple's contactless symbol only as provided.
4. **Readiness**: call `prepare` when the app comes to the foreground and before checkout, so the
   reader is warm; show progress if configuring (first run can take up to a minute).
5. **Checkout**: the amount is shown before the sheet; the sheet is Apple's (no overlays); result
   screen shows approved / declined clearly, with a receipt option (print or email).
6. **Errors**: plain messages for unsupported device (iPhone XS or later), outdated iOS, passcode not
   set, not signed in to iCloud, no network, and terms not accepted.
7. **Refunds** go through the same flow (card present) where Dojo supports it, otherwise to the card
   by reference.
8. **Privacy**: Info.plist location string if the SDK needs it; App Privacy answers unchanged
   (payment data handled by Dojo).
9. **Marketing**: go.vesopa.com and the App Store page use "Tap to Pay on iPhone" exactly, with no
   claims Apple processes payments.

## Dojo requirements

- Dojo Tap to Pay SDK (iOS) integrated against Dojo sandbox; the server already issues the Tap secret
  (`/api/tap/...`, `sdk_env` from the secret prefix).
- Dojo enables Tap to Pay on iPhone for each venue's Dojo account (Pontardawe RFC is live on Dojo).
- Dojo's accreditation checklist in Go (Settings > Dojo checklist) re-run for Tap to Pay: sale,
  decline, cancel, refund, signature-not-applicable, offline/timeout.

## Merchant onboarding (what Apple was told)

Published at https://go.vesopa.com/get-started/: apply by email, Dojo KYC (1–3 working days for a
new account; none for existing Dojo merchants), Vesopa sets up the venue the same day, install and
sign in, admin accepts the Tap to Pay terms in the app, take payments. Minimum: about 1 working day.
