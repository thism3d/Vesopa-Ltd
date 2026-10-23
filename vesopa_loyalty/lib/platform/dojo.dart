import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Dojo's own checkout, inside the app (ios/Runner/DojoBridge.swift).
///
/// On an iPhone or iPad a membership is paid in Dojo's iOS checkout over the
/// app, never in a browser (owner, 2026-10-23). Elsewhere the app still opens
/// Dojo's checkout page, as the web always has.
const _channel = MethodChannel('vesopa_loyalty/dojo');

/// What the member did in Dojo's checkout.
enum DojoOutcome { paid, closed, failed }

class DojoCheckout {
  DojoCheckout._();

  static bool get native => !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;

  /// The intent's id: the server's `intent_id`, or the last part of the
  /// checkout address (`https://pay.dojo.tech/checkout/<id>`) from a server that
  /// does not send it yet.
  static String? intentOf(Map<String, dynamic> checkout) {
    final id = checkout['intent_id'] as String?;
    if (id != null && id.isNotEmpty) return id;
    final url = Uri.tryParse('${checkout['url'] ?? ''}');
    if (url == null || url.pathSegments.length < 2 || url.pathSegments[url.pathSegments.length - 2] != 'checkout') return null;
    return url.pathSegments.last.isEmpty ? null : url.pathSegments.last;
  }

  /// Show Dojo's checkout for [intent]. Throws a [PlatformException] whose
  /// message can be shown as it is when it cannot be shown at all.
  static Future<DojoOutcome> pay(String intent, {bool dark = false}) async {
    final code = await _channel.invokeMethod<int>('pay', {'intent': intent, 'dark': dark});
    return switch (code) {
      0 => DojoOutcome.paid,
      7780 => DojoOutcome.closed,
      _ => DojoOutcome.failed,
    };
  }
}
