package uk.co.vesopa.vesopa_loyalty

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * The Android half of notifications.
 *
 * Android has no way to wake an app that is not running except Firebase Cloud
 * Messaging, so this is the one place Firebase enters the product, and only as
 * a delivery pipe: nothing about a customer is stored there. The server
 * already registers and sends to `fcm` (src/loyalty_push.js) and the Dart side
 * already routes a phone token to `addDeviceToken`; this answers the token.
 *
 * WHY THIS ASKS PERMISSION ITSELF. Android 13 shows nothing until the customer
 * has said yes to notifications, and the question has to come from an
 * Activity. The Dart side asks for a token on every start, so the question is
 * put the first time and never again; a customer who says no gets null, which
 * `lib/platform/push_io.dart` already treats as "no notifications here" -- the
 * app works, and messages still arrive in its inbox when it is opened.
 *
 * A WHITE-LABEL NOTE. Each venue's Android build is its own app with its own
 * package name, so each needs its own `google-services.json` in android/app/.
 * The file is per-build configuration, not a secret: it identifies the app to
 * Google and carries nothing that lets anyone send on the venue's behalf. What
 * does is the service account on the server (FCM_* in .env), and that is one
 * account for every venue.
 */
class MainActivity : FlutterActivity() {
    private var waiting: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        PushService.ensureChannel(this)

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
     * This device's FCM registration token, as `{kind: "fcm", token: ...}`.
     *
     * Null rather than an error on every path that is not a token: the Dart
     * side asks on every start, and an error here would be reported to a
     * customer who has done nothing wrong and can do nothing about it.
     */
    private fun deviceToken(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            // One question at a time: a second ask while the first dialog is
            // up would leave a Result that is never answered.
            if (waiting != null) {
                result.success(null)
                return
            }
            waiting = result
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), ASK_NOTIFICATIONS)
            return
        }
        fetchToken(result)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        // The engine forwards every other request (location, for one) to the
        // plugin that made it.
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != ASK_NOTIFICATIONS) return
        val result = waiting ?: return
        waiting = null
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            fetchToken(result)
        } else {
            result.success(null)
        }
    }

    private fun fetchToken(result: MethodChannel.Result) {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            val token = if (task.isSuccessful) task.result else null
            result.success(
                if (token.isNullOrEmpty()) null else mapOf("kind" to "fcm", "token" to token),
            )
        }
    }

    private companion object {
        const val ASK_NOTIFICATIONS = 7301
    }
}
