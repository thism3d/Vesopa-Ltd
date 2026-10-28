# Vesopa Go on the till's code (one codebase)

The owner's decisions, 2026-10-28, after trying Go 1.2.2 on an iPad:

- **One codebase.** Vesopa Go is a phone and iPad build of Vesopa EPOS
  (`vesopa_epos/`), so every till feature (the sale on the left, the bars,
  every function key, the menus, the side rail, settings) is Go's too. Go
  adds what the till does not have: Tap to Pay, the standalone venue,
  AirPrint and Android printing, sounds, NFC and camera scanning.
- **The back office's layout and photos on every device**, as on the till:
  the programmed screens, the key's own picture or else the product's
  back-office picture. No online menu or section photos.
- **Responsive** on Android phones, iPhone and iPad, for Go and for the till
  itself.
- **No internet, power cut, router still on:** every device on the venue's
  network (Wi-Fi included) still sees every change at once. Any device can
  lead: the main till, else another till, else a Vesopa Go device.
- **Port forwarding** as an advanced option: a till reachable from outside
  the venue's network through a rule on the router, encrypted with the venue
  key.

## How

`vesopa_go/` keeps what makes it its own app in the stores: the Android and
iOS projects (`com.vesopa.go`, signing, entitlements, the Tap to Pay native
code), the store workflows and listings, go.vesopa.com. Its Dart becomes a
thin start-up that depends on `vesopa_epos` by path and runs the till's app
as the **Go edition**. The till's own Windows build is unchanged by that.

## Phases

0. **Feasibility.** Build `vesopa_epos` for Android and iOS in GitHub
   Actions (the owner's PC locks Gradle's folder). List every Windows-only
   call on the way up (window manager, kiosk lock, updater and hand-over,
   Windows print queues, serial ports, the hardware fingerprint) and guard it
   behind the edition.
1. **The host.** `vesopa_go/pubspec.yaml` depends on `vesopa_epos`; the
   till's 17 asset loads go through one helper so they work from a package;
   `main()` in Go calls the till's start-up with the Go edition.
2. **Signing in and licensing.** The Go edition signs in with Vesopa (the
   sheet Go uses now) and takes a Go seat, not a till seat
   (`licences.js` kind `go`, `placeGoForAdmin`). Standalone venues work
   without tills.
3. **Responsive till.** Tablet: the till's layout as it is. Phone: the sale
   as a sheet with Pay always in reach, the side rail as a drawer, the
   programmed screen's keys a few to a row in order, the bars as strips, and
   words that never split (Go 1.2.3 already does this on Go's own screens).
4. **Go's extras in the till's code.** Tap to Pay (iPhone, Android), the
   card machine choice per device, AirPrint and Android printing, sounds,
   NFC (sign on, cards, tables), camera scanning, the manager's photo and
   price edit.
5. **The local link, everywhere.** Go devices may lead when no till is on
   (the election in `lan_link.dart`), they keep the last known addresses so
   they find each other without the internet, and iOS gets Apple's multicast
   entitlement for discovery. Port forwarding: the back office keeps the
   router's public address and port per venue; devices away from the Wi-Fi
   connect to it directly.
6. **Cut-over.** Go 2.0 in the stores from the shared code (internal
   testing and TestFlight first, never production without the owner). The
   old `vesopa_go/lib` is retired once 2.0 does everything 1.2 does.

Tills are released to venues only when the owner asks; Pontardawe is live.
Until 2.0, Go 1.2.x keeps getting fixes (1.2.3: the till's layout on
iPad, the till's keys working, back-office photos, words that never split).
