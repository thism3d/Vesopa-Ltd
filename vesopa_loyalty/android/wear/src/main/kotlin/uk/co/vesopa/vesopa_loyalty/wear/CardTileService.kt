package uk.co.vesopa.vesopa_loyalty.wear

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.core.content.ContextCompat
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture

/**
 * "Show my card": a Tile one swipe from the watch face with the points on it,
 * and the whole Tile a button that opens the app on the code. The QR code
 * itself stays in the app, where the screen can be held at full brightness.
 */
class CardTileService : TileService() {
    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
        val card = CardStore.load(this)
        val accent = ContextCompat.getColor(this, R.color.wear_accent)
        val onAccent = ContextCompat.getColor(this, R.color.wear_on_accent)

        val open = ModifiersBuilders.Clickable.Builder()
            .setId("open")
            .setOnClick(
                ActionBuilders.LaunchAction.Builder()
                    .setAndroidActivity(
                        ActionBuilders.AndroidActivity.Builder()
                            .setPackageName(packageName)
                            .setClassName(MainActivity::class.java.name)
                            .build(),
                    )
                    .build(),
            )
            .build()

        val column = LayoutElementBuilders.Column.Builder()
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text(card.title.ifEmpty { getString(R.string.app_name) }, 14f, accent, bold = true))
        if (card.signedIn) {
            column
                .addContent(text("${card.points}", 40f, 0xFFFFFFFF.toInt(), bold = true))
                .addContent(text(if (card.points == 1) "point" else "points", 13f, 0xFFB4B4B4.toInt()))
                .addContent(LayoutElementBuilders.Spacer.Builder().setHeight(dp(10f)).build())
                .addContent(
                    LayoutElementBuilders.Box.Builder()
                        .setModifiers(
                            ModifiersBuilders.Modifiers.Builder()
                                .setBackground(
                                    ModifiersBuilders.Background.Builder()
                                        .setColor(argb(accent))
                                        .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(20f)).build())
                                        .build(),
                                )
                                .setPadding(
                                    ModifiersBuilders.Padding.Builder()
                                        .setStart(dp(16f)).setEnd(dp(16f)).setTop(dp(8f)).setBottom(dp(8f))
                                        .build(),
                                )
                                .build(),
                        )
                        .addContent(text("Show my card", 14f, onAccent, bold = true))
                        .build(),
                )
        } else {
            column.addContent(text("Sign in on your phone", 13f, 0xFFB4B4B4.toInt()))
        }

        val root = LayoutElementBuilders.Box.Builder()
            .setWidth(expand())
            .setHeight(expand())
            .setModifiers(ModifiersBuilders.Modifiers.Builder().setClickable(open).build())
            .addContent(column.build())
            .build()

        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RESOURCES)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
            .build()
        return CallbackToFutureAdapter.getFuture { it.set(tile) }
    }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        CallbackToFutureAdapter.getFuture { it.set(ResourceBuilders.Resources.Builder().setVersion(RESOURCES).build()) }

    private fun text(s: String, size: Float, colour: Int, bold: Boolean = false) =
        LayoutElementBuilders.Text.Builder()
            .setText(s)
            .setMaxLines(1)
            .setFontStyle(
                LayoutElementBuilders.FontStyle.Builder()
                    .setSize(sp(size))
                    .setColor(argb(colour))
                    .setWeight(
                        if (bold) LayoutElementBuilders.FONT_WEIGHT_BOLD else LayoutElementBuilders.FONT_WEIGHT_NORMAL,
                    )
                    .build(),
            )
            .build()

    private companion object {
        const val RESOURCES = "1"
    }
}
