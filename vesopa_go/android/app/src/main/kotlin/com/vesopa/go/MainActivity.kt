package com.vesopa.go

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * A FlutterFragmentActivity, not a FlutterActivity: fingerprint and face
 * sign-in (local_auth) need the fragment host, and Stripe's sheets need it too.
 *
 * `com.vesopa.go/device` answers what Go asks about this device: whether it is
 * a TV, its NFC, battery saving and its Android id. Dojo's Tap to Pay on Pocket
 * was taken out on 2026-11-18 (owner: "Remove DOJO Tap to Pay SDK completely");
 * Tap to Pay on this device is Vesopa Tap to Pay, through Stripe's Terminal SDK.
 */
class MainActivity : FlutterFragmentActivity() {

    private fun isTelevision(): Boolean {
        val pm = packageManager
        if (pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)) return true
        if (pm.hasSystemFeature("amazon.hardware.fire_tv")) return true
        val ui = getSystemService(Context.UI_MODE_SERVICE) as? android.app.UiModeManager
        if (ui?.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION) return true
        // Android TV boxes that call themselves tablets: no touch screen,
        // and a D-pad to move with (owner, 2026-11-18).
        val config = resources.configuration
        val noTouch = !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN) ||
            config.touchscreen == android.content.res.Configuration.TOUCHSCREEN_NOTOUCH
        val dpad = config.navigation == android.content.res.Configuration.NAVIGATION_DPAD
        return noTouch && dpad
    }

    // Stripe's Identity and card sheets register for results here, as Android
    // allows only while the activity is created (packages/stripe_onboarding).
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        com.vesopa.stripe_onboarding.StripeOnboarding.onActivityCreate(this)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // This device's settings (lib/ui/device_prefs.dart, lib/ui/tv.dart).
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.vesopa.go/device").setMethodCallHandler { call, result ->
            when (call.method) {
                "deviceInfo" -> result.success(mapOf(
                    "model" to "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}",
                    "sdk" to android.os.Build.VERSION.SDK_INT,
                    "nfc" to nfcState(),
                    // A television (Android TV, Google TV, Fire TV): a remote, no
                    // touch, no browser. Go opens as a screen there (lib/ui/tv.dart).
                    "tv" to isTelevision(),
                ))
                "isIgnoringBatteryOptimizations" -> {
                    val power = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                    result.success(power.isIgnoringBatteryOptimizations(packageName))
                }
                "openBatterySettings" -> open(result, Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                "openNfcSettings" -> open(result, Intent(android.provider.Settings.ACTION_NFC_SETTINGS))
                // The same answer after a reinstall (one per phone, app signing key and
                // user), so a reinstalled phone keeps its Go licence (2026-10-30).
                "androidId" -> result.success(
                    android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID)
                )
                else -> result.notImplemented()
            }
        }
    }

    private fun open(result: MethodChannel.Result, intent: Intent) {
        try {
            startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            result.success(null)
        } catch (e: Exception) {
            result.error("unavailable", e.message, null)
        }
    }

    private fun nfcState(): String {
        val nfc = android.nfc.NfcAdapter.getDefaultAdapter(this) ?: return "none"
        return if (nfc.isEnabled) "on" else "off"
    }
}
