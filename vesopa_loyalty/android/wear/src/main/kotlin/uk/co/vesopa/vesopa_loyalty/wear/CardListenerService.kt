package uk.co.vesopa.vesopa_loyalty.wear

import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.WearableListenerService

/**
 * Woken by Play services when the phone puts a new card in the Data Layer,
 * whether or not the watch app is open, so the Tile and the complication are
 * up to date before anyone looks.
 */
class CardListenerService : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED || event.dataItem.uri.path != CardStore.PATH) continue
            DataMapItem.fromDataItem(event.dataItem).dataMap.getString(CardStore.KEY)?.let { CardStore.save(this, it) }
        }
    }
}
