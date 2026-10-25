package uk.co.vesopa.vesopa_loyalty.wear

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.TimeText
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Wear OS screenshots for Play, drawn from the app's own screens on the
 * JVM (Robolectric's native graphics), so they show exactly what ships.
 *
 *   WEAR_SCREENSHOTS=<folder> ./gradlew :wear:testDebugUnitTest
 *
 * A round 456 x 456 watch (228dp at 2x): Play wants square pictures of at
 * least 384 px with no device frame. Run in a venue build
 * (tool/make_venue_app.py) for that venue's colours and crest. The member is
 * made up; the figures are the kind the phone sends.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w228dp-h228dp-round-watch-xhdpi")
class StoreScreenshots {
    private val dir = System.getProperty("wear.screenshots") ?: "build/screenshots"

    private val member = WatchCard(
        signedIn = true,
        title = "Pontardawe RFC",
        qr = "VSPL:PRFC:1881-0042-7316",
        number = "1881 0042 7316",
        points = 1240,
        worth = "worth £12.40",
        tier = "Full member",
        canSpend = true,
        spendNote = "Enough to spend",
        rows = listOf(
            "Visits" to "37",
            "Last visit" to "11 Oct",
            "Until" to "31 Jul 2027",
            "Spend from" to "500 pts",
        ),
        news = listOf(
            WatchCard.News("Home to Ystradgynlais, Saturday 2.30pm", "10 Oct", true),
            WatchCard.News("Quiz night in the clubhouse on Thursday", "8 Oct", false),
            WatchCard.News("Season tickets on sale at the bar", "1 Oct", false),
        ),
    )

    @Composable
    private fun Watch(page: @Composable () -> Unit) {
        MaterialTheme {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                page()
                TimeText()
            }
        }
    }

    @Test fun card() = captureRoboImage("$dir/1-card.png") { Watch { CardPage(member) } }

    @Test fun points() = captureRoboImage("$dir/2-points.png") { Watch { PointsPage(member) } }

    @Test fun membership() = captureRoboImage("$dir/3-membership.png") { Watch { MembershipPage(member) } }

    @Test fun news() = captureRoboImage("$dir/4-news.png") { Watch { NewsPage(member) } }
}
