# Releasing and deploying: the commands

Everything is run from the repository folder (`C:\Users\azureuser\develop\Vesopa-Ltd`)
in PowerShell or Git Bash. Each tool loads the server login from `.env.claude`
itself, backs up what it changes, checks the result, and stops at the first
problem. If a step fails, read the last red line; run the same command again
once it is fixed.

Before any release: `git pull origin main`.

## 1. Back office (backoffice.vesopaepos.com, member sites, card settings, menus)

```
python tool/deploy_memberships.py --backoffice
```
Uploads `vesopa_server/src` and `public`, applies the schema files listed in the
tool (all safe to run again), restarts the back office, and checks it.
Ends with `back office health 200`.

## 2. EPOS till (Windows): Microsoft Store and the EXE installer

1. Raise the version in `vesopa_epos/pubspec.yaml` (`version:` and
   `msix_version:`) and `vesopa_epos/lib/config/constants.dart` (`appVersion`).
2. Copy the latest `tool/release_*_1_16_*.py`, change the version and the
   "What's new" text in it.
3. Run it:
```
python tool/release_connect_1_16_6.py            # everything: back office, build, Store, installer
python tool/release_connect_1_16_6.py --from build    # skip the back office deploy
python tool/release_connect_1_16_6.py --from store    # package already built
python tool/release_connect_1_16_6.py --from installers
```
It refuses to send an old package (it reads the version inside the .msix).
The Store publishes on its own once Microsoft certifies it; the EXE goes to
https://admin.vesopa.com/downloads.

## 3. Pontardawe RFC Android app (phone + Wear OS)

1. Raise `"build"` (and `"version"` if you like) in `PontardaweRFC/venue.json`.
   Google Play refuses a build number it has seen.
2. Double-click `PontardaweRFC\build-android.cmd`, or:
```
cmd /c PontardaweRFC\build-android.cmd
```
Writes to `Desktop\Android-builds\`:
- `PontardaweRFC-<version>-<build>.aab` (Google Play, phone)
- `PontardaweRFC-<version>-<build>-wear.aab` (Google Play, Wear OS track)
- `PontardaweRFC-<version>-<build>.apk` (install directly)

3. Upload to Google Play: Play Console > Pontardawe RFC > Test and release >
   the track > Create new release > drop in the .aab files.
   (`python tool/play_upload.py PontardaweRFC` does it from here once a Play
   service account key is saved as `Documents\Vesopa-Keys\play-service-account.json`.)

4. Put the APKs on the club website (step 5).

## 4. Pontardawe RFC iPhone app (TestFlight), on GitHub Actions

```
python tool/github_ios_release.py --run-only        # build, sign, upload to TestFlight
python tool/github_ios_release.py --wait            # follow it; shows the error if a step fails
python tool/github_ios_release.py --run-only --mode check     # only report what App Store Connect has
python tool/github_ios_release.py --run-only --mode listing   # only the App Store text and screenshots
```
Or on github.com: Actions > "iOS - venue app" > Run workflow > `PontardaweRFC`.
The build number is picked automatically. The secrets live in Settings >
Environments > "App Store Connect API" (`ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8`, `FIREBASE_IOS_API_KEY`); `python tool/github_ios_release.py --secret-only`
refreshes the Firebase one from `PontardaweRFC\GoogleService-Info.plist`.

## 5. pontardawerfc.com (club website) and its APK downloads

```
python tool/deploy_pontardawe_site.py --site-only
```
Ships the site and copies the newest phone and Wear OS APKs from the last
Android build to https://pontardawerfc.com/downloads/ (linked from
/membership, "Get the club app"). Without `--site-only` it also rebuilds the
members' web app and redeploys the back office.

## 6. Vesopa sign-in (auth.vesopa.com)

```
python tool/deploy_pontardawe_app.py --auth --apply
```
Uploads the auth files listed in the tool, runs auth's tests on the server,
puts the old files back if they fail, then restarts.

## 7. Android passkeys / Google sign-in fingerprints

When the app's signing key changes, add its SHA-256 to `android_sha256` in
`PontardaweRFC/venue.json` (both the upload key and Google Play's app signing
key belong there; Firebase lists both), then:
```
python tool/deploy_pontardawe_app.py --android-check   # shows what it will publish
python tool/deploy_pontardawe_app.py --android --apply
```

## 8. One-off Pontardawe setup tools

```
python tool/setup_pontardawe_menu.py --check   # menu.pontardawerfc.com and the club mailbox: what is there
python tool/setup_pontardawe_menu.py           # set them up
python tool/set_pontardawe_card_account.py --check   # the live Paymentsense Connect account: test it
python tool/set_pontardawe_card_account.py           # save it as the venue's card settings
python tool/pontardawe_kitchen_check.py "SELECT ..."  # read-only look at the venue's data
```

## Where things live

| What | Where |
|---|---|
| Server login | `.env.claude` (never committed) |
| Android upload key | `Documents\Vesopa-Keys\vesopa-upload.jks` + `key.properties` |
| Firebase admin key | `Documents\Vesopa-Keys\firebase-adminsdk-vesopa.json` |
| Pontardawe live card account | `PontardaweRFC\.env.dojolive` (never committed) |
| Android builds | `Desktop\Android-builds\` |
| Till installers | `dist\installers\` and https://admin.vesopa.com/downloads |
