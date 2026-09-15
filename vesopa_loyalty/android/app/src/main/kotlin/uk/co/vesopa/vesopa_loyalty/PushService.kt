package uk.co.vesopa.vesopa_loyalty

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * What happens when a message from the venue arrives.
 *
 * The server sends a `notification` (title and body) with a `data` part (the
 * message id and where a tap should go). While the app is in the background
 * Android itself draws the notification from the defaults in the manifest and
 * this is never called; while the app is open, Firebase hands the message
 * here instead and it would otherwise vanish -- so it is drawn by hand, the
 * same way, on the same channel.
 */
class PushService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val note = message.notification ?: return
        val open = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            for ((k, v) in message.data) putExtra(k, v)
        }
        val tap = PendingIntent.getActivity(
            this,
            (message.data["id"] ?: message.messageId ?: "").hashCode(),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        ensureChannel(this)
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this).setPriority(Notification.PRIORITY_DEFAULT)
        }
        val drawn = builder
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(getColor(R.color.brand))
            .setContentTitle(note.title ?: "")
            .setContentText(note.body ?: "")
            .setStyle(Notification.BigTextStyle().bigText(note.body ?: ""))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(tap.hashCode(), drawn)
    }

    /**
     * Nothing to do: the Dart side asks for the current token on every start
     * and the server keeps whichever it was last given, so a replaced token
     * is registered the next time the app opens.
     */
    override fun onNewToken(token: String) {}

    companion object {
        const val CHANNEL_ID = "venue_messages"

        /** Android 8+ shows nothing on a channel that does not exist yet. */
        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.push_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ),
            )
        }
    }
}
