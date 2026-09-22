package com.vesopaepos.app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Card payments go through Dojo's native drop-in SDK, driven from this
        // Activity. FlutterActivity is a plain Activity (NOT a ComponentActivity
        // in this embedding), so the handler uses the SDK's Activity-based entry
        // point and receives the result via onActivityResult below.
        DojoPaymentHandler.register(this, flutterEngine.dartExecutor.binaryMessenger)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        DojoPaymentHandler.onActivityResult(requestCode, resultCode, data)
    }
}
