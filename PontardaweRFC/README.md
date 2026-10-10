# Pontardawe RFC app (Android and iPhone)

The club's own members app, under its own name, icon and store listings. It is
the Vesopa Loyalty app (`vesopa_loyalty/`) built for one venue: it opens
straight on Pontardawe RFC (on the web at https://member.pontardawerfc.com/) with no
venue code to type, and everything a member sees inside it (colours, logo,
the welcome line, members-only sign-in, news) comes from Loyalty App in the
back office, as it does on the web.

What is Pontardawe's own, and lives here:

| | |
|---|---|
| `venue.json` | slug, names, package / bundle id, colours, **version and build number** |
| `brand/crest.png` | the club crest (the logo uploaded in the back office, 512px) |
| `overlay/` | launcher icons, themed and notification icons, the splash pictures, the iPhone app and Watch icons, and the crest the opening animation uses. Drawn from the crest by `vesopa_loyalty/tool/make_venue_art.py`; laid over the project at build time |
| `store/` | Play icon (512), Play feature graphic (1024x500), App Store icon (1024), and the listing text (`listing.md`) |
| `build-android.ps1` | the Android release, on the Windows PC |
| `build-ios.sh` | the iPhone release, on a Mac |

Nothing else is copied: `vesopa_loyalty/tool/make_venue_app.py` makes a fresh
project in `build/app/` (gitignored) from `vesopa_loyalty/` plus the above on
every build, so a fix to the Loyalty app reaches this app the next time it is
built.

| | |
|---|---|
| Android package / iOS bundle id | `com.vesopaepos.pontardawerfc` (Watch app: `.watchkitapp`) |
| App name | Pontardawe RFC |
| Colours | club red `#8F0000`, deep `#3F0000`, glow `#C41414`, white |

## The opening

The phone's own splash shows the crest on club red (Android 12+, older Android
and the iPhone launch screen all draw it at the same 140pt). The app then picks
up from that exact picture: the crest rises and settles, a light passes across
it, a ring goes out, and PONTARDAWE RFC rises underneath with "Members' Club ·
Est. 1881". Once the club's branding is loaded the crest lifts away and the app
settles up into place (`vesopa_loyalty/lib/ui/venue_intro.dart`). Inside the
app the sign-in page assembles itself, the card and what is under it arrive in
turn, and the tabs fade through. Reduced-motion settings are respected.

## The look

In this app (and only here: the shared Store app and the web page keep the
back office's colours) everything is in the club's own palette from
`venue.json` and set in Montserrat (`overlay/assets/venue/fonts/`, bundled by
the generator as "VenueFont"). It follows the phone into dark mode: warm
white with club red in the light, near black with club red in the dark. The
sign-in page, the bar along the top and the membership card are club red with
slowly drifting light (`vesopa_loyalty/lib/data/venue_style.dart`); it stands
still when the phone asks for less motion. Dialogs, switches and spinners are
the iPhone's own on Apple devices.

## Signing in

Members can use an emailed code, email and password, a passkey, a texted
code, and Continue with Apple, Continue with Google, phone and passkey
buttons. Those four ARE Continue with Vesopa (there is no separate Vesopa
button), so the venue's "vesopa" method must stay on; each goes straight
there through auth.vesopa.com's `idp` hint. They are switched on in the back office
(Loyalty App > Sign-in) or by `python tool/deploy_pontardawe_app.py --apply`.

## Android (Windows PC)

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File PontardaweRFC\build-android.ps1
```

It writes `PontardaweRFC-<version>-<build>.aab` (for Play) and `.apk` (to
install directly) to `Desktop\Android-builds`. The first run also registers
the app in the Vesopa Firebase project and saves `PontardaweRFC\google-services.json`
(gitignored), which push notifications need.

Signed with the Vesopa upload key (`Documents\Vesopa-Keys\vesopa-upload.jks`,
through `vesopa_loyalty\android\key.properties` or
`MetricMembership\app\android\key.properties`).

**Play Console, first time:** Create app > "Pontardawe RFC", App, Free. Upload
the .aab to Internal testing first. Use `store/play-icon-512.png`,
`store/play-feature-graphic-1024x500.png` and the text in `store/listing.md`.
Data safety: email address, name, phone number (optional), approximate and
precise location (optional, only while the app is open), photos (optional
profile photo); nothing shared with third parties; data can be deleted from
Account in the app.

## iPhone (no Mac needed)

GitHub > Actions > "iOS - venue app" > Run workflow, venue `PontardaweRFC`.
It builds on GitHub's Mac. With the App Store Connect API key in the
"App Store Connect API" environment (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8; see the top
of `.github/workflows/ios-venue-app.yml`) it also:

- registers the App IDs (app and Watch app) with Push Notifications on,
- picks the next free build number, signs the app and uploads it,
- fills the App Store listing from `store/app_store.json` and uploads the
  screenshots in `store/screenshots/` (categories, age rating 4+, free, every
  country, copyright, review notes),
- waits for Apple to process the build, gives it to the internal TestFlight
  group (everyone on the App Store Connect team) and attaches it to the App
  Store version.

Nothing is sent for App Review. The run's summary lists what is left by hand:
the app record the very first time (Apple's API cannot create one; the run
says exactly what to type), App Privacy (answers in `store/listing.md`), and
a member account for Apple's reviewer (ASC_REVIEW_USER / ASC_REVIEW_PASSWORD,
plus ASC_REVIEW_PHONE, in the same environment).

## iPhone (Mac)

From the repository root:

```bash
bash PontardaweRFC/build-ios.sh
```

It makes the project, builds the archive (iPhone app with its Apple Watch
app) and opens it in Xcode's Organizer: Distribute App > App Store Connect >
Upload.

**First time:**

1. App Store Connect > Apps > + New App: iOS, name "Pontardawe RFC", bundle id
   `com.vesopaepos.pontardawerfc` (if it is not in the list yet, run the script
   once, open `PontardaweRFC/build/app/ios/Runner.xcworkspace`, and let Xcode's
   automatic signing (team G238FR2ZC9) create the App IDs for the app and
   `.watchkitapp`; tick Push Notifications on the app's App ID if Xcode asks).
2. Icon: `store/app-store-icon-1024.png` is already in the build.
3. Push notifications reach the app once the server knows its bundle id: add
   `APNS_TOPICS=pontardawe-rfc=com.vesopaepos.pontardawerfc` to the back
   office server's `.env` (the same APNs key works for every app on the team).

## A new release

Raise `build` in `venue.json` (and `version` when it is a release members
should notice), commit, then run the build script. To redraw the pictures
after a new crest: replace `brand/crest.png` and run
`python vesopa_loyalty/tool/make_venue_art.py PontardaweRFC` (needs Pillow).

## Another club

Copy this folder, change `venue.json` and `brand/crest.png`, run
`make_venue_art.py` on it, and build. Nothing in `vesopa_loyalty/` changes.

## The club website (pontardawerfc.com)

`website/` is the club's own site: history, teams, news, the clubhouse,
the live menu with ordering (to a table, or for collection), membership and
an AI helper. See [website/README.md](website/README.md). It is deployed with
`python tool/deploy_pontardawe_site.py`, which also puts the members' app on
member.pontardawerfc.com.
