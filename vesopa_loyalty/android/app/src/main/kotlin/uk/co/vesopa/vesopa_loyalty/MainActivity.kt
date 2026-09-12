package uk.co.vesopa.vesopa_loyalty

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * The Android half of notifications.
 *
 * WHY THIS ANSWERS NULL TODAY
 *
 * Android has no way to wake an app that is not running except Firebase Cloud
 * Messaging, so an Android push token means a Firebase project. Adding the
 * `firebase_messaging` plugin without a `google-services.json` does not degrade
 * gracefully — the Gradle plugin fails the build — so it is deliberately not
 * added until there is a project to point it at. Until then this answers null,
 * which `lib/platform/push_io.dart` already treats as "no notifications here":
 * the app works, and messages still arrive in its inbox when it is opened.
 *
 * The iPhone half is the other way round and is finished: APNs needs no
 * configuration file, only the capability on the App ID.
 *
 * TO SWITCH IT ON, once the venue has a Firebase project:
 *
 *   1. `google-services.json` into `android/app/`.
 *   2. `firebase_core` and `firebase_messaging` in pubspec.yaml, and the
 *      Google services Gradle plugin in `android/app/build.gradle.kts`.
 *   3. Replace the body of `deviceToken` below with a call to
 *      `FirebaseMessaging.getInstance().token`, answering
 *      `mapOf("kind" to "fcm", "token" to token)`.
 *
 * Nothing else changes. The server already registers and sends to `fcm`
 * (src/loyalty_push.js), and the Dart side already routes a phone token to
 * `addDeviceToken` — this is the only piece left.
 *
 * A WHITE-LABEL NOTE. Each venue's Android build is its own app with its own
 * package name, so each needs its own `google-services.json`. The file is
 * per-build configuration, not a secret: it identifies the app to Google and
 * carries nothing that lets anyone send on the venue's behalf. What does is the
 * service account on the server (FCM_* in .env), and that is one account for
 * every venue.
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "vesopa_loyalty/push",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "token" -> deviceToken(result)
                else -> result.notImplemented()
            }
        }
    }

    /**
     * This device's FCM registration token.
     *
     * Null rather than an error: the Dart side asks on every start, and an
     * error here would be reported to a customer who has done nothing wrong and
     * can do nothing about it.
     */
    private fun deviceToken(result: MethodChannel.Result) {
        result.success(null)
    }
}
