package uk.co.vesopa.vesopa_loyalty

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject

/**
 * The card, handed to the Wear OS app (android/wear) the way
 * ios/Runner/WatchBridge.swift hands it to the Apple Watch: the Dart side
 * (lib/platform/watch.dart) calls `update` with the map lib/data/watch_card.dart
 * builds, and this puts it in the Wearable Data Layer as JSON at `/card`.
 *
 * The Data Layer keeps the item and delivers it whenever the watch is next in
 * reach, so there is nothing to retry here, and it only reaches an app with
 * this one's package name and signing key: the watch app, nothing else.
 * Urgent, because a card that changed at the till should be on the wrist
 * before the member looks down. With no watch, or no Play services, it does
 * nothing and says nothing: neither is anything the member did wrong.
 */
class WearBridge(context: Context, messenger: BinaryMessenger) {
    private val app = context.applicationContext

    init {
        MethodChannel(messenger, "vesopa_loyalty/watch").setMethodCallHandler { call, result ->
            when (call.method) {
                "update" -> {
                    send(call.arguments as? Map<*, *>)
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun send(card: Map<*, *>?) {
        if (card == null) return
        if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app) != ConnectionResult.SUCCESS) return
        try {
            val request = PutDataMapRequest.create(PATH).apply {
                dataMap.putString(KEY, JSONObject(card).toString())
            }.asPutDataRequest().setUrgent()
            Wearable.getDataClient(app).putDataItem(request)
        } catch (_: Exception) {
            // No Wearable API on this phone: there is no watch to tell.
        }
    }

    private companion object {
        // The watch's CardStore reads the same path and key.
        const val PATH = "/card"
        const val KEY = "json"
    }
}
