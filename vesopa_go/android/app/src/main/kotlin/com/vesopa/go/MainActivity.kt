package com.vesopa.go

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * A FlutterFragmentActivity, not a FlutterActivity: fingerprint and face
 * sign-in (local_auth) need the fragment host.
 *
 * `com.vesopa.go/dojo` is the same channel the iPhone answers in
 * ios/Runner/DojoTapToPay.swift. On Android the card is read by Dojo's own
 * app on a Dojo Pocket (package com.dojo.tap), through Dojo's documented
 * intents: Go asks for a sale, the Pocket reads the card, and its answer
 * comes back to a PendingIntent of ours. Go never touches card data.
 *
 *   pocketAvailable  whether Dojo's payment app is on this device
 *   pocketInit       com.dojo.action.INIT, once a day is plenty
 *   pocketSale       com.dojo.action.SALE: amount in pence -> the result
 *   pocketRefund     com.dojo.action.REFUND
 *   pocketLastTx     com.dojo.action.LAST_TX: what the last one did, after a
 *                    crash or a lost answer
 *
 * A phone without the Pocket app answers isSupported false, and the app
 * offers the venue's card machine.
 */
class MainActivity : FlutterFragmentActivity() {
    private var waiting: MethodChannel.Result? = null
    private var receiver: BroadcastReceiver? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.vesopa.go/dojo").setMethodCallHandler { call, result ->
            when (call.method) {
                "isSupported", "pocketAvailable" -> result.success(pocketInstalled())
                // Dojo's SDK once the venue's Dojo account is known
                // (DojoPocketSdk.kt); the intents below until then.
                "pocketConfigure" -> {
                    val key = call.argument<String>("apiKey").orEmpty()
                    val house = call.argument<String>("softwareHouseId").orEmpty()
                    if (key.isEmpty() || house.isEmpty()) {
                        result.error("setup", "The venue's Dojo account is not set up in the back office.", null)
                    } else if (!pocketInstalled()) {
                        result.error("unsupported", DojoPocketSdk.friendly("DpaNotInstalled"), null)
                    } else {
                        DojoPocketSdk.configure(this, key, house, call.argument<String>("resellerId") ?: house, result)
                    }
                }
                "pocketInit" -> if (DojoPocketSdk.ready) DojoPocketSdk.initDojo(result) else ask(result, Intent(INIT))
                "pocketSale" -> {
                    val amount = call.argument<Int>("amount") ?: 0
                    if (DojoPocketSdk.ready) DojoPocketSdk.sale(amount, call.argument<String>("reference"), result)
                    else ask(result, Intent(SALE).putExtra(BASE_AMOUNT, amount))
                }
                "pocketRefund" -> {
                    val amount = call.argument<Int>("amount") ?: 0
                    if (DojoPocketSdk.ready) DojoPocketSdk.refund(amount, result)
                    else ask(result, Intent(REFUND).putExtra(BASE_AMOUNT, amount))
                }
                "pocketLastTx" -> if (DojoPocketSdk.ready) DojoPocketSdk.lastTx(result) else ask(result, Intent(LAST_TX))
                else -> result.error("unsupported", "This Android device has no Dojo payment app. Use the card machine.", null)
            }
        }
        // This device's settings (lib/ui/device_prefs.dart): battery saving and NFC.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.vesopa.go/device").setMethodCallHandler { call, result ->
            when (call.method) {
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

    private fun pocketInstalled(): Boolean = try {
        packageManager.getPackageInfo(DOJO, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    /** Sends one request to Dojo's app; its answer finishes [result]. One at a time. */
    private fun ask(result: MethodChannel.Result, request: Intent) {
        if (!pocketInstalled()) return result.error("unsupported", "Dojo's payment app is not on this device.", null)
        if (waiting != null) return result.error("busy", "A card payment is already under way.", null)
        waiting = result
        val reply = Intent(REPLY).setPackage(packageName)
        // Mutable: Dojo's app fills in the result's extras.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val pending = PendingIntent.getBroadcast(this, 7, reply, flags)
        listen()
        try {
            // The flags Dojo's intent guide gives (docs.dojo.tech/tap-to-pay-on-pocket/intent-integration).
            startActivity(
                request.setPackage(DOJO).putExtra(PENDING_INTENT, pending)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            )
        } catch (e: Exception) {
            finish("unsupported", e.message ?: "Dojo's payment app did not open.")
        }
    }

    private fun listen() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val x = intent.extras
                val answer = HashMap<String, Any?>()
                // Every extra Dojo sends, by its short name: result, transactionId, ...
                x?.keySet()?.forEach { k -> answer[k.removePrefix("com.dojo.extra.").lowercase()] = x.get(k)?.let { v -> if (v is Number || v is Boolean) v else v.toString() } }
                answer["action"] = intent.action
                val done = waiting
                waiting = null
                done?.success(answer)
            }
        }
        val filter = IntentFilter(REPLY).apply {
            addAction(TX_COMPLETE); addAction(INIT_COMPLETE); addAction(REFUND_COMPLETE); addAction(LAST_TX_COMPLETE)
        }
        // Not exported: the PendingIntent is ours, so its broadcast comes as us.
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED) else registerReceiver(r, filter)
        receiver = r
    }

    private fun finish(code: String, message: String) {
        val done = waiting
        waiting = null
        done?.error(code, message, null)
    }

    override fun onDestroy() {
        receiver?.let { unregisterReceiver(it) }
        receiver = null
        finish("cancelled", "Vesopa Go closed during the payment.")
        super.onDestroy()
    }

    companion object {
        const val DOJO = "com.dojo.tap"
        const val INIT = "com.dojo.action.INIT"
        const val SALE = "com.dojo.action.SALE"
        const val REFUND = "com.dojo.action.REFUND"
        const val LAST_TX = "com.dojo.action.LAST_TX"
        const val TX_COMPLETE = "com.dojo.action.TX_COMPLETE"
        const val INIT_COMPLETE = "com.dojo.action.INIT_COMPLETE"
        const val REFUND_COMPLETE = "com.dojo.action.REFUND_COMPLETE"
        const val LAST_TX_COMPLETE = "com.dojo.action.LAST_TX_COMPLETE"
        const val BASE_AMOUNT = "com.dojo.extra.BASE_AMOUNT"
        const val PENDING_INTENT = "com.dojo.extra.PENDING_INTENT"
        const val REPLY = "com.vesopa.go.DOJO_REPLY"
    }
}
