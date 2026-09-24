# Vesopa Express

The self-service ordering kiosk for Vesopa EPOS. A customer taps **Touch to
start**, chooses eat in or take away, builds a basket from the venue's own menu,
pays on the Dojo card machine beside the screen, and walks away with a
collection number. The kitchen gets the ticket, the till is told, and a
collection board shows the number go from *Preparing* to *Ready*.

Windows first, portrait first -- and it adapts to landscape and to any screen
size by the shape of the window, not by the device. Flutter, so Android and iOS
come later from the same code. Its Microsoft Store listing is **Vesopa
Express** (Store ID 9N5W5VLP2948; see *Packaging*).

![The mark](assets/brand/express_mark_256.png)

## How it fits together

```
 kiosk (this app)  ──HTTPS──▶  backoffice.vesopaepos.com  ──▶  Dojo (card machine)
   no secrets                  vesopa_server/src/express_kiosk.js
   draws screens               prices the basket, holds the Dojo key,
   polls its order             writes the sale + kitchen ticket once paid
                                     │
                    kitchen screens ◀┤ (the till's own ticket tables)
                    tills          ◀┤ (express.order broadcast)
                    TV board       ◀┘ /express/board/<secret>
```

* **Nothing is a sale until the money is in.** An order is created
  *awaiting payment* with a number. Only when Dojo reports it **Captured** --
  seen by the kiosk's poll, by the Dojo webhook, or by the sweep that looks
  after kiosks switched off mid-payment -- does the server write the sale, raise
  the kitchen ticket and tell the venue. Once, whichever gets there first.
* **The kiosk never holds a Dojo key.** The server creates the intent and
  starts the card machine; the kiosk asks how it is going. Dojo ignores
  idempotency keys, so the intent is created once per order and reused on
  *Try again*.
* **The menu is the venue's Dine-in menu** -- dishes, pictures, allergens and
  add-ons -- priced live from the catalogue by the same function the QR menu
  uses (`vesopa_server/src/menu_core.js`).
* **Off by default.** A venue turns it on in the back office under
  *Dine-in & QR › Vesopa Express*.

The full plan, including where the build departs from it and why, is
[tasks.md](tasks.md).

## Setting a kiosk up

1. In the back office: **Vesopa Express › Settings** -- tick *Run Vesopa
   Express kiosks at this venue*, choose eat in / take away and how customers
   pay, and save. Set a passcode there, or let the first kiosk choose one.
2. On the kiosk: open Vesopa Express and press **Continue with Vesopa** as a
   manager of the venue. The browser opens; sign in; come back.
3. If the venue has no passcode yet, choose one on the kiosk (4-8 digits).
4. Back office: **Vesopa Express › Kiosks** -- name the kiosk and pair it with
   the Dojo card machine beside it. Card payments appear on the kiosk within a
   minute.
5. Optional: open the **collection board** address (Settings tab) on any TV.

**Leaving kiosk mode:** hold the **bottom-left corner for three seconds** on
any screen, type the passcode, then *Exit Vesopa Express*. It works with no
network. Five wrong tries rest the pad for a minute.

**Locking the machine too:** the app cannot be closed or minimised from the
screen, but Windows' own *Assigned Access* ("kiosk mode", Settings › Accounts
› Other users › Set up a kiosk) is what stops the Start menu, the taskbar and
Ctrl+Alt+Del. Use it on any kiosk facing the public.

## Accessibility and language

Every customer screen has **English / Cymraeg**, **High contrast** and
**Lower the screen** (reach mode: everything interactive in the bottom two
thirds, for somebody ordering from a wheelchair). They are cleared when the
order ends -- they belonged to that customer. An untouched basket asks
*Still there?* and clears itself after the venue's idle time.

The Welsh is a **draft** and must be checked by a Welsh speaker before a venue
shows it to the public (`lib/l10n/strings.dart`).

## Developing

```bash
flutter pub get
flutter run -d windows --dart-define=EXPRESS_WINDOWED=true
flutter run -d windows --dart-define=EXPRESS_WINDOWED=true --dart-define=EXPRESS_W=1280 --dart-define=EXPRESS_H=720
flutter run -d windows --dart-define=EXPRESS_API=http://127.0.0.1:4000
```

| Where | What |
|---|---|
| `lib/data/session.dart` | who the kiosk is, whether its venue wants it, its menu |
| `lib/data/order_flow.dart` | one customer's visit, as a state machine; resumes a payment after a restart |
| `lib/data/api.dart` | the nine calls to the back office |
| `lib/data/passcode.dart` | PBKDF2 exit check, byte-identical to the server's |
| `lib/data/vesopa_sso.dart` | Continue with Vesopa (PKCE, system browser, loopback) |
| `lib/ui/pages/` | setup, ordering, paying, settings |
| `lib/platform/kiosk_window.dart` | the full-screen lock |
| `tool/make_icons.py` | draws the mark, icon and tiles from the V's geometry |

## Testing

```bash
flutter analyze
flutter test                                   # unit + widget
flutter test test/screens_gallery_test.dart --update-goldens   # every screen, to test/gallery/*.png
```

The server half has its own real-database test
(`vesopa_server/test/express.test.js`, 45 checks: one sale per payment when a
poll and a webhook race, one intent per order, tenancy, the board, the sweep)
and a live check against production that creates and removes only its own rows
(`vesopa_server/tool/verify-express-live.js`).

## Packaging

`msix_config` in `pubspec.yaml` carries the identity Partner Center reserved
(`MeirionDavies.VesopaExpress`, publisher `CN=3AD172E6-…`, *Vesopa EPOS Ltd*)
and `store: true`: the Store signs the package, so no certificate is involved.
`dart run msix:create` builds `build/store/vesopa-express-store.msix`; upload
it with the version in its name (`vesopa-express-store-1.0.0.0.msix`), because
a package that replaces another must not share its file name.

Bump `version:` and `msix_config.msix_version` together for every
submission, including a resubmission after a failed certification — the Store
never takes a version twice, and its last part must be 0.

The first release (1.0.0.0) was typed into Partner Center by hand: the Store
API cannot fill in an app's first submission (see "A new app's first
submission" in `ms-store-submission-client/README.md`). What went into it —
the listing, the properties and which picture goes where — is
`ms-store-submission-client/listings/express-1.0.0.0.json`. The Store's
pictures are drawn by `tool/make_store_art.py` (tiles and poster) and
`tool/make_store_hero.py` (the 16:9 hero: a generated restaurant with the real
app put on the kiosk's screen). From 1.0.1.0 a release is `stage.js` then
`commit.js` under the name `vesopa-express`, like the till's.
