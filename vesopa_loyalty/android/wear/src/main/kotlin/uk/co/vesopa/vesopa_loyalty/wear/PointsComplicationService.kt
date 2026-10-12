package uk.co.vesopa.vesopa_loyalty.wear

import android.app.PendingIntent
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.ComplicationRequest

/**
 * The points on the watch face, as a short-text complication: the figure, and
 * "pts" above it. A tap opens the app on the card. It is told when the card
 * changes (CardStore.save), so it never polls.
 */
class PointsComplicationService : ComplicationDataSourceService() {
    override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
        val card = CardStore.load(this)
        listener.onComplicationData(
            if (request.complicationType == ComplicationType.SHORT_TEXT) data(if (card.signedIn) "${card.points}" else "–")
            else null,
        )
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        if (type == ComplicationType.SHORT_TEXT) data("120") else null

    private fun data(points: String): ComplicationData {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return ShortTextComplicationData.Builder(
            PlainComplicationText.Builder(points).build(),
            PlainComplicationText.Builder("$points points").build(),
        )
            .setTitle(PlainComplicationText.Builder("pts").build())
            .setTapAction(open)
            .build()
    }
}
