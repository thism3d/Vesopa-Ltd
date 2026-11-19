package uk.co.vesopa.vesopa_loyalty.wear

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * The members' card by NFC on a Wear OS watch: raise the watch to the club's
 * reader and it answers with the card's code, as the phone does (the phone
 * app's CardHceService.kt has the whole story and the protocol). The code is
 * the one the phone last sent (CardStore), so the watch works with the phone
 * out of reach. Enabled by @bool/nfc_card, per venue.
 */
class CardHceService : HostApduService() {
    override fun processCommandApdu(command: ByteArray?, extras: Bundle?): ByteArray {
        val card = CardStore.load(this)
        return CardApdu.answer(command, if (card.signedIn) card.qr else null)
    }

    override fun onDeactivated(reason: Int) {}
}

/** The same SELECT and answer as the phone's (CardApdu in the phone app). */
object CardApdu {
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
