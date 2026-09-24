import 'dart:io';

import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/brand.dart';
import 'push.dart';

const _wns = MethodChannel('vesopa_loyalty/wns');

/// Android and iPhone both answer one channel; the native half says which kind
/// of token it is handing back, so this file does not have to guess from the
/// platform and be wrong on the day one of them changes.
const _mobile = MethodChannel('vesopa_loyalty/push');

const _lastUri = 'wns_channel_uri';

bool get _isPhone => Platform.isAndroid || Platform.isIOS;

/// Whether notifications can be offered here.
///
/// On a phone, always: the platform asks the customer itself, and a venue that
/// has not set its Windows notification secret up still has a working app on
/// every phone. On Windows, only once that secret is in the back office —
/// without it there is nothing to send with.
bool pushAvailable(Brand brand) => _isPhone || brand.windowsPush;

/// This installation's channel, or null where the platform will not give one.
///
/// Null is not a failure worth showing anybody: a customer who declined
/// notifications, a build outside a Store package, a phone with no Google
/// services. The app simply keeps its inbox, which is why the inbox exists.
Future<PushChannel?> pushSubscribe(Brand brand) async {
  if (_isPhone) return _phoneToken();
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

/// The phone's own push token, from the native half.
///
/// The native side is responsible for asking the customer's permission and for
/// whatever registration its platform needs — Firebase on Android, APNs
/// registration on an iPhone — and answers a map of `{kind, token}`. It answers
/// nothing at all until that platform configuration exists, which is the
/// honest state of an app whose venue has no Firebase project yet.
Future<PushChannel?> _phoneToken() async {
  try {
    final result = await _mobile.invokeMapMethod<String, dynamic>('token');
    final kind = result?['kind'] as String?;
    final token = (result?['token'] as String?)?.trim();
    if (kind == null || token == null || token.isEmpty) return null;
    if (kind != 'fcm' && kind != 'apns') return null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_lastUri, token);
    return PushChannel.phone(kind, token);
  } on MissingPluginException {
    // The native half is not in this build yet. Not an error: the app works,
    // and messages still arrive in the inbox next time it is opened.
    return null;
  } catch (_) {
    return null;
  }
}

/// A WNS channel lasts thirty days and a phone token can be replaced by the
/// platform at any time, so both are asked for again on every start.
Future<PushChannel?> pushCurrent(Brand brand) => pushSubscribe(brand);

Future<String?> pushUnsubscribe() async {
  final prefs = await SharedPreferences.getInstance();
  final uri = prefs.getString(_lastUri);
  await prefs.remove(_lastUri);
  return uri;
}

/// A tapped notification.
///
/// Windows opens the app itself on a tapped toast. An iPhone tells the app
/// (ios/Runner/AppDelegate.swift): `open` while it is running, or kept for
/// `opened` when the tap is what started it. The address is `/inbox/<id>`.
void onOpenRequest(void Function(String hash) handler) {
  if (!Platform.isIOS) return;
  _mobile.setMethodCallHandler((call) async {
    if (call.method == 'open') handler('${call.arguments}');
  });
  _mobile.invokeMethod<String>('opened').then((address) {
    if (address != null && address.isNotEmpty) handler(address);
  }, onError: (Object _) {});
}

String openedAt() => '';
