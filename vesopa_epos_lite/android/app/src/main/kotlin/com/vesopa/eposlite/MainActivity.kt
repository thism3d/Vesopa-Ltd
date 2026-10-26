package com.vesopa.eposlite

import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * A FlutterFragmentActivity, not a FlutterActivity: fingerprint and face
 * sign-in (local_auth) need the fragment host.
 *
 * `com.vesopa.tap/dojo` is the same channel the iPhone answers in
 * ios/Runner/DojoTapToPay.swift. Dojo have not published their Tap to Pay
 * SDK for Android yet (their page was a 404 on 25 Oct 2026; asked of
 * partnertech@dojo.tech), so until it is added here this says plainly that
 * the phone cannot take a tap, and the app offers the card machine.
 */
class MainActivity : FlutterFragmentActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.vesopa.tap/dojo").setMethodCallHandler { call, result ->
            when (call.method) {
                "isSupported" -> result.success(false)
                else -> result.error(
                    "unsupported",
                    "Tap to Pay on Android is waiting for Dojo's Android SDK. Use the card machine for now.",
                    null,
                )
            }
        }
    }
}
