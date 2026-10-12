package uk.co.vesopa.vesopa_loyalty.wear

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the watch shows, as the phone last sent it.
 *
 * The keys are the ones lib/data/watch_card.dart writes, the same card the
 * Apple Watch reads (ios/VesopaWatch/CardStore.swift): words and figures
 * already formatted on the phone, so the two watches cannot disagree with it
 * or with each other. Every key is optional; a missing one is a blank, never
 * a crash, because an older phone build may send fewer.
 */
data class WatchCard(
    val signedIn: Boolean = false,
    val title: String = "",
    val qr: String = "",
    val number: String = "",
    val points: Int = 0,
    val worth: String = "",
    val tier: String = "",
    val canSpend: Boolean = false,
    val spendNote: String = "",
    val rows: List<Pair<String, String>> = emptyList(),
    val news: List<News> = emptyList(),
) {
    data class News(val title: String, val date: String, val unread: Boolean)

    companion object {
        fun parse(json: String?): WatchCard {
            if (json.isNullOrEmpty()) return WatchCard()
            val d = try {
                JSONObject(json)
            } catch (_: Exception) {
                return WatchCard()
            }
            return WatchCard(
                signedIn = d.optBoolean("signedIn"),
                title = d.optString("title"),
                qr = d.optString("qr"),
                number = d.optString("number"),
                points = d.optInt("points"),
                worth = d.optString("worth"),
                tier = d.optString("tier"),
                canSpend = d.optBoolean("canSpend"),
                spendNote = d.optString("spendNote"),
                rows = (d.optJSONArray("rows") ?: JSONArray()).let { a ->
                    (0 until a.length()).mapNotNull { i ->
                        val r = a.optJSONArray(i) ?: return@mapNotNull null
                        if (r.length() == 2) r.optString(0) to r.optString(1) else null
                    }
                },
                news = (d.optJSONArray("news") ?: JSONArray()).let { a ->
                    (0 until a.length()).mapNotNull { i ->
                        val n = a.optJSONObject(i) ?: return@mapNotNull null
                        News(n.optString("title"), n.optString("date"), n.optBoolean("unread"))
                    }
                },
            )
        }
    }
}
