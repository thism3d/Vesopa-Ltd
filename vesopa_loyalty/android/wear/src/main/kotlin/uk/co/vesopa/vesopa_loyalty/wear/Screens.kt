package uk.co.vesopa.vesopa_loyalty.wear

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.pager.VerticalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.compose.material3.VerticalPageIndicator

/*
 * The watch's four pages, one swipe apart, as the Apple Watch app has them
 * (ios/VesopaWatch): the card to show at the till, the points, the membership
 * and the latest news. Black behind everything, which is what an OLED watch
 * draws for free, and the club's colour only where it says something.
 *
 * The Play screenshots are drawn from these same functions
 * (src/test/.../StoreScreenshots.kt); change one and the other follows.
 */

private val Secondary = Color(0xFFB4B4B4)
private val Panel = Color(0xFF1C1C1E)

/** The whole app: the pages once the phone has sent a card, else how to get one. */
@Composable
fun WearApp(card: WatchCard, appName: String, onPage: (Int) -> Unit = {}, clock: Boolean = true) {
    MaterialTheme {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (!card.signedIn) {
                SignedOutPage(appName)
            } else {
                val pager = rememberPagerState(pageCount = { 4 })
                LaunchedEffect(pager.currentPage) { onPage(pager.currentPage) }
                VerticalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
                    when (page) {
                        0 -> CardPage(card)
                        1 -> PointsPage(card)
                        2 -> MembershipPage(card)
                        else -> NewsPage(card)
                    }
                }
                VerticalPageIndicator(pagerState = pager)
            }
            if (clock) TimeText()
        }
    }
}

/**
 * A page's frame: room for the clock at the top, and on a round screen the
 * sides drawn in so nothing is cut by the curve.
 */
@Composable
private fun Page(title: String, centred: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    val round = LocalConfiguration.current.isScreenRound
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val side = maxWidth * (if (round) 0.16f else 0.06f)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(PaddingValues(start = side, end = side, top = 30.dp, bottom = if (round) 28.dp else 12.dp)),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = if (centred) Arrangement.Center else Arrangement.Top,
        ) {
            if (title.isNotEmpty()) {
                Text(
                    title,
                    color = colorResource(R.color.wear_accent),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
            }
            content()
        }
    }
}

/** The code the till scans, as big as the screen allows, on white. */
@Composable
fun CardPage(card: WatchCard) {
    val qr = remember(card.qr) { qrBitmap(card.qr)?.asImageBitmap() }
    val round = LocalConfiguration.current.isScreenRound
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // The panel's corners have to stay inside the circle.
        val panel = maxWidth * (if (round) 0.5f else 0.62f)
        Column(
            Modifier.fillMaxSize().padding(top = 26.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Image(
                    painterResource(R.drawable.crest),
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(5.dp))
                Text(card.title, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.height(5.dp))
            Box(
                Modifier
                    .size(panel)
                    .background(Color.White, RoundedCornerShape(14.dp))
                    .padding(7.dp)
                    .semantics { contentDescription = "Your membership QR code" },
                contentAlignment = Alignment.Center,
            ) {
                if (qr != null) {
                    Image(
                        qr,
                        contentDescription = null,
                        filterQuality = FilterQuality.None,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
            if (card.number.isNotEmpty()) {
                Text(
                    card.number,
                    color = Color.White,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 1.2.sp,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            Text("Show this at the till", color = Secondary, fontSize = 11.sp)
        }
    }
}

@Composable
fun PointsPage(card: WatchCard) {
    val accent = colorResource(R.color.wear_accent)
    Page("Points", centred = true) {
        Text("${card.points}", color = Color.White, fontSize = 52.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        Text(if (card.points == 1) "point" else "points", color = Secondary, fontSize = 15.sp)
        if (card.worth.isNotEmpty()) {
            Text(card.worth, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 5.dp))
        }
        if (card.tier.isNotEmpty()) {
            Text(
                card.tier,
                color = colorResource(R.color.wear_on_accent),
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .padding(top = 8.dp)
                    .background(accent, RoundedCornerShape(50))
                    .padding(horizontal = 10.dp, vertical = 3.dp),
            )
        }
        if (card.spendNote.isNotEmpty()) {
            // A tick in the club colour and the words in white: a line of red
            // text on a rugby club's watch reads as a warning.
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (card.canSpend) {
                    Text("✓", color = accent, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.width(4.dp))
                }
                Text(
                    card.spendNote,
                    color = if (card.canSpend) Color.White else Secondary,
                    fontSize = 12.sp,
                    fontWeight = if (card.canSpend) FontWeight.SemiBold else FontWeight.Normal,
                )
            }
        }
    }
}

@Composable
fun MembershipPage(card: WatchCard) {
    Page("Membership") {
        for ((label, value) in card.rows) {
            PanelBox {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(label, color = Secondary, fontSize = 13.sp, modifier = Modifier.weight(1f))
                    Text(value, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                }
            }
        }
    }
}

/** The venue's latest three messages. Reading them in full is for the phone. */
@Composable
fun NewsPage(card: WatchCard) {
    val accent = colorResource(R.color.wear_accent)
    Page("News") {
        if (card.news.isEmpty()) {
            Text("No news yet", color = Secondary, fontSize = 13.sp, modifier = Modifier.padding(top = 20.dp))
        }
        for (item in card.news) {
            PanelBox {
                Column {
                    Row(verticalAlignment = Alignment.Top) {
                        if (item.unread) {
                            Box(
                                Modifier
                                    .padding(top = 6.dp)
                                    .size(6.dp)
                                    .background(accent, CircleShape)
                                    .semantics { contentDescription = "Unread" },
                            )
                            Spacer(Modifier.width(5.dp))
                        }
                        Text(item.title, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 3)
                    }
                    Text(item.date, color = Secondary, fontSize = 12.sp)
                }
            }
        }
    }
}

/** Before the phone has sent a card, or after signing out on the phone. */
@Composable
fun SignedOutPage(appName: String) {
    Page("", centred = true) {
        Image(painterResource(R.drawable.crest), contentDescription = null, modifier = Modifier.size(48.dp))
        Text(
            "Open $appName on your phone and sign in. Your card appears here.",
            color = Secondary,
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 10.dp),
        )
    }
}

/** The dark rounded panel the membership rows and the news sit on. */
@Composable
private fun PanelBox(content: @Composable () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 2.5.dp)
            .background(Panel, RoundedCornerShape(12.dp))
            .padding(horizontal = 10.dp, vertical = 7.dp),
    ) { content() }
}
