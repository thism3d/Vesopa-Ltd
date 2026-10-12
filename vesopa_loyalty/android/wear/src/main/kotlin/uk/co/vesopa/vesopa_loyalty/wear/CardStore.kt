package uk.co.vesopa.vesopa_loyalty.wear

import android.content.ComponentName
import android.content.Context
import androidx.wear.tiles.TileService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The last card the phone sent, kept on the watch.
 *
 * Nothing here talks to the server. The phone puts the card in the Wearable
 * Data Layer (WearBridge.kt) whenever it has fresh figures, and the watch
 * keeps a copy of its own, so the code still shows at a counter with the
 * phone left in a bag or out of range: the same promise the Apple Watch app
 * makes.
 */
object CardStore {
    /** The Data Layer path and key; WearBridge.kt writes the same two. */
    const val PATH = "/card"
    const val KEY = "json"

    private const val PREFS = "card"

    private val state = MutableStateFlow<WatchCard?>(null)

    fun card(context: Context): StateFlow<WatchCard?> {
        if (state.value == null) state.value = load(context)
        return state
    }

    fun load(context: Context): WatchCard =
        WatchCard.parse(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null))

    /** Keeps [json], shows it, and tells the Tile and the complication. */
    fun save(context: Context, json: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY, null) == json) return
        prefs.edit().putString(KEY, json).apply()
        state.value = WatchCard.parse(json)
        TileService.getUpdater(context).requestUpdate(CardTileService::class.java)
        ComplicationDataSourceUpdateRequester
            .create(context, ComponentName(context, PointsComplicationService::class.java))
            .requestUpdateAll()
    }

    /**
     * Whatever the Data Layer holds now, for a card that changed while the
     * watch app was not running and the listener was not woken (a watch
     * that was off, say). Quietly nothing without Play services.
     */
    fun refresh(context: Context) {
        val app = context.applicationContext
        try {
            Wearable.getDataClient(app).dataItems.addOnSuccessListener { items ->
                try {
                    for (item in items) {
                        if (item.uri.path != PATH) continue
                        DataMapItem.fromDataItem(item).dataMap.getString(KEY)?.let { save(app, it) }
                    }
                } finally {
                    items.release()
                }
            }
        } catch (_: Exception) {
            // No Play services on this watch: the saved card is all there is.
        }
    }
}
