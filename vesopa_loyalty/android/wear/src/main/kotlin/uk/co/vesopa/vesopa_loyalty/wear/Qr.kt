package uk.co.vesopa.vesopa_loyalty.wear

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/**
 * The card's QR code, one pixel per module, black on white with no quiet
 * zone (the white panel around it is the quiet zone). Drawn on the watch,
 * not sent as a picture, so the Data Layer item stays a few hundred bytes;
 * the caller scales it up with no smoothing, so the edges stay sharp for a
 * till's scanner.
 */
fun qrBitmap(text: String): Bitmap? {
    if (text.isEmpty()) return null
    return try {
        val m = QRCodeWriter().encode(
            text,
            BarcodeFormat.QR_CODE,
            0,
            0,
            mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M),
        )
        val pixels = IntArray(m.width * m.height) { i ->
            if (m.get(i % m.width, i / m.width)) Color.BLACK else Color.WHITE
        }
        Bitmap.createBitmap(pixels, m.width, m.height, Bitmap.Config.ARGB_8888)
    } catch (_: Exception) {
        null
    }
}
