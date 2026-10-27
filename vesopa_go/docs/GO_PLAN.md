# Vesopa Go: the plan, the rules and where it stands

The one place to read before working on Vesopa Go. Keep it current: every
session updates **Status** and **Next** before it pushes.

## What Vesopa Go is

The phone app for Vesopa EPOS venues: orders and payments anywhere in the
venue, at the counter or the table, with everything in the same back office as
the tills. It is Vesopa EPOS Lite and Vesopa Tap merged into one app
(`vesopa_go/`; the two old folders are gone).

- **Runs with Vesopa EPOS tills.** That is the main way: "With Vesopa EPOS"
  is the first choice after sign-in (shared tables, open bills, menu, kitchen).
- **Standalone too.** "On its own" is the second choice: the counter only, no
  tills needed. Both stay.
- **Real data.** The venue's own back office (menu, staff, tables, bills).
  Test venue: **The Vesopa Kitchen** (office 9). The manager login for testing
  was given in chat; it is never written in the repo, a log or a workflow.
- **Live.** A WebSocket to the back office's `/ws` (office-scoped nudges:
  `open-bills.updated`, `kitchen.ticket`, `catalogue.updated`, `staff.updated`,
  `screens`, `floor.updated`, `till-settings`, `dojo-settings`), with polling
  as the fallback when the socket is down.
- **Sign-in:** Vesopa Auth (OIDC, PKCE, loopback redirect). Go has its own
  client ("Vesopa Go", slug `vesopa-go`, a copy of the till's native client:
  `vesopa_auth/schema/schema_028_vesopa_go_client.sql`). The back office tells
  the app which client to use (`GET /api/go/vesopa/enabled`).
- **Payments: Dojo, native.**
  - iPhone: Dojo's Tap to Pay on iPhone SDK (SPM, exactly 0.0.11, in the
    Runner target; `ios/Runner/DojoTapToPay.swift`). Needs Apple's Tap to Pay
    entitlement on the App ID `com.vesopa.go`; until Apple grants it, CI signs
    without it and cards go to the card machine.
  - Android: Dojo has no phone SDK. On a **Dojo Pocket**, Go hands the sale to
    Dojo's own app (`com.dojo.tap`) through Dojo's documented intents
    (`MainActivity.kt`: INIT, SALE, REFUND, LAST_TX). Payment ids are
    `pocket:<transaction id>`; refunds of those go back on the Pocket.
  - Anywhere: the venue's Dojo card machine (via the back office).
- **Identity:** bundle id / package **`com.vesopa.go`** on both stores
  (App Store Apple ID 6827395109).
- **Icon:** the Vesopa V breaking out of an orbit, on ink, with a lime dot
  (`tool/make_icons.py`). Not speed lines: those are **Vesopa Express**'s.
  Not wireless or contactless waves (the owner turned those down).

## Rules (from the owner)

1. **Push to main, every time** (fast-forward only: `git merge-base
   --is-ancestor origin/main HEAD`, then `git push origin HEAD:main`).
2. **Never delete data from the live database.** Back up first, always:
   `go_server.py` dumps the back-office and Auth databases and tars the app
   into `/home/vesopasoftware/backups/go-<stamp>/` before any change. The owner
   wants a copy on their own machine too:
   `scp -r root@34.63.118.67:/home/vesopasoftware/backups/go-<stamp> .`
3. **Secrets:** the same ones as PontardaweRFC's workflows, in the
   "App Store Connect API" environment: `ASC_KEY_ID`, `ASC_ISSUER_ID`,
   `ASC_KEY_P8`, `ANDROID_UPLOAD_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `PLAY_SERVICE_ACCOUNT_JSON`,
   `VESOPA_SSH_PASSWORD`.
4. **The repo and its Actions logs are public.** Print names, ids, counts and
   sizes only. Never secrets, .env values, other Hestia customers' domains,
   customer data, file contents. Never upload dumps or server files as
   artifacts.
5. Restart the back office **by name** (`pm2 restart backoffice.vesopaepos.com`),
   never `pm2 restart all`.
6. The live back office has hand edits that are not in git. Never overwrite
   them: `go_server.py` merges (three-way, then hunk by hunk) and stops on a
   conflict in Go's own code.
7. No force-push, no branch deletion.

## Where things are

| What | Where |
| --- | --- |
| App | `vesopa_go/lib` (`counter/` is the old Lite: sell, pay, sales, reports) |
| Dojo bridge | `android/.../MainActivity.kt`, `ios/Runner/DojoTapToPay.swift`, `lib/payments/payment_service.dart` |
| Icons | `tool/make_icons.py` (all sizes), `tool/make_feature_graphic.py` |
| Store | `store/play.json`, `store/listing.md`, `store/screenshots/{android-phone,iphone-6.7}` |
| Version | `vesopa_go/venue.json` (Play's build floor) and `pubspec.yaml` |
| Android CI | `.github/workflows/go-android.yml`: Play **internal** testing + listing |
| iOS CI | `.github/workflows/go-ios.yml` + `tool/testflight.py`: TestFlight team + "Closed testing" |
| Server | `.github/workflows/go-server.yml` + `tool/go_server.py` (check / staging / live) |
| Web demo | `.github/workflows/web-go-demo.yml` + `tool/web_demo.py` (GitHub Pages) |
| Back office | `vesopa_server/src/terminal_vesopa.js` (`/api/go/vesopa/enabled`, `VESOPA_AUTH_GO_CLIENT_ID`), `src/tap.js` (`/api/tap/*`) |

## Status (2026-10-27)

- [x] Merge Lite + Tap into `vesopa_go`; the old folders removed; 37 tests pass
- [x] WebSocket live updates; table sales in the day's reports; optional modifiers at the table
- [x] Dojo Pocket bridge (Android, builds), Dojo SDK package in the iOS target
- [x] Go's Auth client SQL and `/api/go/vesopa/enabled`
- [x] Icon redrawn (orbit; distinct from Express), Play listing, feature graphic, screenshots
- [x] Workflows written and pushed
- [x] `go-server check`: live has 1 conflict (`src/server.js`, one hunk); staging is far out of date (14 conflicts), so live is deployed directly, after the backup
- [x] `go-server live` (run 40449227134): backup `/home/vesopasoftware/backups/go-20261027-042114`
      (app files, back-office DB, Auth DB); 7 files deployed, live's own edits kept; Go's Auth
      client `dc20f031d1bd11f1a75342010a80000e`; `/api/go/vesopa/enabled` and `/api/tap/config` live
- [x] https://go.vesopaepos.com: DNS, web domain, proxy to 20005, Let's Encrypt, WebSocket 101
- [x] Android 1.0.0 (2) on Play internal testing, with the listing, icon, feature graphic and 6 screenshots (run 40449501378)
- [x] iOS 1.0.0 (1) on TestFlight (run 40449504307): "Vesopa team" (internal) and
      "Closed testing" (public link https://testflight.apple.com/join/zgg5YSn8)
- [ ] Beta App Review for Closed testing: needed the review contact phone
      (ASC_REVIEW_PHONE, as the venue apps); re-run go-ios with testflight_build=1
- [x] App's `apiBase` is `https://go.vesopaepos.com`
- [x] iOS bridge rewritten against Dojo SDK 0.0.11's real interface (`.prod`, result `.canceled`, iOS 16.7 guards)
- [ ] GitHub Pages: the owner switches it on (Settings > Pages > Source: GitHub Actions)

## Waiting on others

- Apple: Tap to Pay on iPhone entitlement for `com.vesopa.go`.
- Dojo: an Android phone SDK (until then, Dojo Pocket or the card machine).
- Play: a brand-new app may need its first bundle uploaded by hand in Play
  Console; `go-android` keeps the signed bundle as the run's artifact.

## Next

New store builds with the new icon and go.vesopaepos.com. Read the Android
and iOS run results and fix what fails, until both are in testing.
