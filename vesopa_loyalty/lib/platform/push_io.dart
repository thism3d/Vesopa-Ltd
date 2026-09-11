import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/brand.dart';
import 'push.dart';

const _wns = MethodChannel('vesopa_loyalty/wns');
const _lastUri = 'wns_channel_uri';

/// Whether notifications can be offered here: the venue's Windows app has
/// its Store notification secret in the back office.
bool pushAvailable(Brand brand) => brand.windowsPush;

/// A WNS channel for this installation. Null outside a Store package (a
/// channel needs the package's identity) or when Windows says no.
Future<PushChannel?> pushSubscribe(Brand brand) async {
  try {
    final uri = await _wns.invokeMethod<String>('channelUri');
    if (uri == null || uri.isEmpty) return null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_lastUri, uri);
    return PushChannel.windows(uri);
  } catch (_) {
    return null;
  }
}

/// A channel lasts thirty days, so it is asked for again on every start.
Future<PushChannel?> pushCurrent(Brand brand) => pushSubscribe(brand);

Future<String?> pushUnsubscribe() async {
  final prefs = await SharedPreferences.getInstance();
  final uri = prefs.getString(_lastUri);
  await prefs.remove(_lastUri);
  return uri;
}

/// Windows opens the app itself on a tapped toast.
void onOpenRequest(void Function(String hash) handler) {}

String openedAt() => '';
