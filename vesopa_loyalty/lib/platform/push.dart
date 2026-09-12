/// Notifications, whichever way this device gets them.
///
///  * In a browser: Web Push, through the worker in web/push-sw.js and the
///    `vesopaPush` helper in web/index.html. No Firebase: the server signs with
///    its own VAPID key.
///  * On Windows: a WNS channel from the Store package, asked for by the
///    runner (windows/runner/flutter_window.cpp). Windows itself draws the
///    toast, so the app need not be running.
///  * On Android: an FCM registration token. Firebase is here only as the
///    delivery pipe -- Android has no other way to wake an app that is not
///    running -- and nothing about a customer is kept there.
///  * On an iPhone: an APNs device token.
///
/// All of them hand the server a channel; the server does the sending
/// (src/loyalty_push.js).
library;

export 'push_io.dart' if (dart.library.js_interop) 'push_web.dart';

/// Where this device can be reached.
class PushChannel {
  const PushChannel.web(Map<String, dynamic> this.subscription)
    : kind = 'webpush',
      channelUri = null;
  const PushChannel.windows(String this.channelUri)
    : kind = 'wns',
      subscription = null;

  /// A phone's own token: `fcm` on Android, `apns` on an iPhone.
  ///
  /// Not a URL, unlike the other two — it is an id the platform issues, and the
  /// server posts to Google's or Apple's gateway rather than to anything the
  /// device named. It rides in [channelUri] so everything that already carries
  /// a channel around keeps working.
  const PushChannel.phone(this.kind, String this.channelUri)
    : subscription = null;

  final String kind;
  final Map<String, dynamic>? subscription;
  final String? channelUri;

  /// Whether this is one of the phone builds, which the server registers by
  /// `device_token` rather than by a subscription or a channel URI.
  bool get isDeviceToken => kind == 'fcm' || kind == 'apns';

  String get endpoint => channelUri ?? (subscription?['endpoint'] as String? ?? '');
}
