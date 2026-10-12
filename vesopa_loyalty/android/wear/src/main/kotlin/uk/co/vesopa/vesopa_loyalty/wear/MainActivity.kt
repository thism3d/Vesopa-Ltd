package uk.co.vesopa.vesopa_loyalty.wear

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue

/**
 * The watch app. It opens on the card, so raising the wrist and tapping the
 * app (or the Tile) is all it takes at a till.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = CardStore.card(this)
        setContent {
            val card by store.collectAsState()
            WearApp(card ?: WatchCard(), getString(R.string.app_name), onPage = ::bright)
        }
    }

    override fun onResume() {
        super.onResume()
        CardStore.refresh(this)
    }

    /**
     * Full brightness and no dimming while the code is on screen, the way a
     * boarding pass behaves: a scanner reads a bright code first time, and a
     * watch that dims halfway through a queue is a second try. Back to the
     * watch's own settings on every other page.
     */
    private fun bright(page: Int) {
        val on = page == 0
        window.attributes = window.attributes.apply {
            screenBrightness =
                if (on) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
                else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        }
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}
