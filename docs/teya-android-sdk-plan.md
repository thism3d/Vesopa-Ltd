# Teya on Android tills: plan (for later)

Written 2026-10-19, after Windows tills moved to Teya's SDK app (EPOS 1.16.21).

## Why

Teya's ePOS SDK overview says: "Only integrate against the POSLink API directly
if no SDK is available for your platform. Where an Android, Windows or iOS SDK
covers your platform, always use the SDK." Windows tills already follow this,
through Teya's SDK app (`lib/payments/teya_sdk.dart`). Android tills still use
the interim route, where the Vesopa server calls the POSLink REST API
(`lib/payments/teya_provider.dart` `TeyaProvider`, server `src/teya.js`
`/till/teya/*`). Teya will expect the Android SDK for certification.

Docs (fetch the `.md` versions with headers `Accept: */*`,
`Sec-Fetch-Mode: cors`, `Sec-Fetch-Dest: empty`):

- https://docs.teya.xyz/epos-sdk/poslink/android/getting-started
- https://docs.teya.xyz/epos-sdk/overview
- https://docs.teya.xyz/downloads
- Sample app: https://github.com/teya-engineering/unified-epos-sdk/tree/main/android-samples/poslink/EposPosLinkExample

## What Teya's Android SDK needs

| | Teya needs | Till today (`vesopa_epos/android`) |
|---|---|---|
| minSdkVersion | 23 | `flutter.minSdkVersion` (check) |
| compileSdkVersion | 37 | `flutter.compileSdkVersion` (set 37 explicitly) |
| Android Gradle Plugin | 8.13.2 or newer | 8.11.1 (`settings.gradle.kts`) |
| Gradle | 8.13 | 8.14 (fine) |
| Kotlin | 2.3.0 | 2.2.20 (`settings.gradle.kts`) |

- Dependency (Maven Central): `com.teya.epos:unified-sdk:<latest stable>` (callbacks)
  or `com.teya.epos:unified-sdk-poslink-kt` (coroutines). Use the coroutines one.
- Credentials: the same Device Code app as Windows (client ID and secret).
  The server already sends them to the till in `/api/till/teya/config` → `sdk`.
  Add `sdk.android = { min_version }` there, or just send `sdk` without the
  `windows` block to Android tills.
- Android SDK platform 37 must be installed on the build machine
  (`sdkmanager "platforms;android-37"`).

## Steps

1. **Toolchain upgrade (on its own commit, and test it before Teya):**
   AGP to 8.13.2+, Kotlin to 2.3.0, compileSdk 37. Build the APK/AAB, run it,
   and check the Dojo drop-in (`DojoPaymentHandler.kt`) still works, because the
   upgrade touches it too.
2. **Native bridge** `android/app/src/main/kotlin/com/vesopaepos/app/TeyaHandler.kt`,
   registered in `MainActivity.configureFlutterEngine` beside Dojo's. It needs a
   MethodChannel `vesopa/teya` and an EventChannel `vesopa/teya/events` for
   payment state changes. Its methods mirror the Windows JSON-RPC ones, so the
   Dart side stays the same:
   - `initialize(clientId, clientSecret, isProductionEnv, eposInstanceId)` → `initTeyaPosLinkSDK(PosLinkAuthConfig.Managed(...))`
   - `setup()` / `setupAuthAndStore()` → returns store and terminal
   - `getTerminals(forceRefresh)`, `linkTerminal(terminalId|null)`
   - `makePayment(transactionId, amount, tip, currency)` → stream state changes to the EventChannel
   - `cancelPayment(transactionId)`, `refundPayment(gatewayPaymentId, amount, currency)`
   - `clearUserAuth()`, `clearDeviceLink()`
   - Read the Android make-payment and refund pages for exact names. Do not guess them.
3. **Dart:** a `TeyaAndroidSdk` with the same surface as `TeyaSdk`
   (`call`, `notifications`, `setup`, `store`, `terminal`), backed by the
   channels. Then let `TeyaSdkProvider` take either. `teyaProvider` in
   `teya_provider.dart` picks the Android SDK when `Platform.isAndroid && config.sdk != null`.
   Map states exactly as Windows does: SUCCESSFUL, CANCELED, PROCESSING_FAILED
   (declined or failed), and COMMUNICATION_FAILED, which must be "not confirmed",
   never declined.
4. **Settings › Teya** on Android: the same panel as Windows (`_TeyaSdkPanel`),
   without "Teya logs" unless the Android SDK has a log export.
5. **Retire the interim route** once Android is on the SDK: `TeyaProvider` and
   the server's `/till/teya/payments*` and `/till/teya/refunds`. Keep the back
   office store link, which lists machines, lets you pick a machine per till,
   and sends the sandbox test payment.
6. **Test:** an Android emulator or phone running Teya's mock payment app
   (APK on the downloads page) as the card machine, signed in to the same
   sandbox store. Try approved, declined, cancel from the till, cancel on the
   machine, stop waiting, refund full and part, and a lost connection.
7. **Release:** bump EPOS, build the AAB, upload to Play. The Play API upload
   gave 403 before (see memory), so it may need a manual upload in Play Console.

## Blocked on Teya, whatever the platform

- The sandbox account (muzahid@vesopa.com) has **no store** yet. Ask
  partnersupport@teya.com to add a staging company and store, then the
  QR / SDK sign-in can pick it.
- Live credentials and the production `pluginType` for online payments come
  from Teya after certification. Live credentials go in Card Payments › Teya
  › App credentials (per venue) or `.env.teya` as `TEYA_LIVE_*`.
