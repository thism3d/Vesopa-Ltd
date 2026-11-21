package uk.co.vesopa.vesopa_loyalty

import android.content.Context
import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * The members' card by NFC: hold the phone near the club's reader and it
 * answers with the card's code, the same code its QR holds (owner,
 * 2026-11-18: "hold near reader" on Android phones and Wear OS watches).
 *
 * Host card emulation, on a private application id (CardApdu.AID), so it
 * never answers a payment terminal and a payment app is never disturbed.
 * The reader selects that id and gets the code back; anything else is
 * refused. With nobody signed in there is no code and the select is refused
 * too. Android only offers this while the phone is unlocked
 * (res/xml/card_apdu_service.xml requireDeviceUnlock).
 *
 * Switched on per venue: the service is enabled by @bool/nfc_card, false in
 * this project and true in the overlays of the venues that have it
 * (LoughorRFC/overlay, written by vesopa_loyalty/tool/make_venue_app.py when
 * venue.json has "nfc": true).
 */
class CardHceService : HostApduService() {
    override fun processCommandApdu(command: ByteArray?, extras: Bundle?): ByteArray =
        CardApdu.answer(command, CardNfc.code(this))

    override fun onDeactivated(reason: Int) {}
}

/** The code the card answers with, kept by WearBridge each time the card changes. */
object CardNfc {
    private const val PREFS = "nfc_card"
    private const val KEY = "qr"

    fun code(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.takeIf { it.isNotBlank() }

    fun save(context: Context, card: Map<*, *>) {
        val signedIn = card["signedIn"] as? Boolean ?: false
        val qr = if (signedIn) (card["qr"] as? String).orEmpty() else ""
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, qr).apply()
    }
}

/**
 * The reader's side of the conversation, the same on the phone and the watch
 * (android/wear CardHceService): ISO 7816-4 SELECT by name of the Vesopa
 * card id, answered with the code in UTF-8 and 90 00.
 */
object CardApdu {
    /** F0 + "VESOPA" + 01: a proprietary id (F0 prefix), version 1. */
    val AID = byteArrayOf(0xF0.toByte(), 0x56, 0x45, 0x53, 0x4F, 0x50, 0x41, 0x01)
    private val OK = byteArrayOf(0x90.toByte(), 0x00)
    private val NOT_FOUND = byteArrayOf(0x6A, 0x82.toByte())
    private val UNKNOWN = byteArrayOf(0x6D, 0x00)

    fun answer(command: ByteArray?, code: String?): ByteArray {
        if (command == null || !isSelect(command)) return UNKNOWN
        if (code.isNullOrEmpty()) return NOT_FOUND
        return code.toByteArray(Charsets.UTF_8) + OK
    }

    private fun isSelect(c: ByteArray): Boolean {
        if (c.size < 5 + AID.size) return false
        if (c[0] != 0x00.toByte() || c[1] != 0xA4.toByte() || c[2] != 0x04.toByte()) return false
        val len = c[4].toInt() and 0xFF
        if (len != AID.size || c.size < 5 + len) return false
        return c.copyOfRange(5, 5 + len).contentEquals(AID)
    }
}
