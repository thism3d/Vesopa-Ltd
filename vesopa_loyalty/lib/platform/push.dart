/// Notifications, whichever way this device gets them.
///
///  * In a browser: Web Push, through the worker in web/push-sw.js and the
///    `vesopaPush` helper in web/index.html. No Firebase: the server signs with
///    its own VAPID key.
///  * On Windows: a WNS channel from the Store package, asked for by the
///    runner (windows/runner/flutter_window.cpp). Windows itself draws the
///    toast, so the app need not be running.
///
/// Both hand the server a channel; the server does the sending
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

  final String kind;
  final Map<String, dynamic>? subscription;
  final String? channelUri;

  String get endpoint => channelUri ?? (subscription?['endpoint'] as String? ?? '');
}
