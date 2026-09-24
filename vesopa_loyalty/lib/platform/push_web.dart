import 'dart:convert';
import 'dart:js_interop';

import '../data/brand.dart';
import 'push.dart';

@JS('vesopaPush.supported')
external JSBoolean _supported();

@JS('vesopaPush.subscribe')
external JSPromise<JSString> _subscribe(JSString vapidKey);

@JS('vesopaPush.unsubscribe')
external JSPromise<JSString> _unsubscribe();

@JS('vesopaPush.current')
external JSPromise<JSString> _current();

@JS('vesopaPush.onOpen')
external void _onOpen(JSFunction callback);

/// Whether notifications can be offered here at all.
bool pushAvailable(Brand brand) {
  if (brand.vapidPublicKey == null) return false;
  try {
    return _supported().toDart;
  } catch (_) {
    return false;
  }
}

/// Ask the browser. Null when refused or impossible.
Future<PushChannel?> pushSubscribe(Brand brand) async {
  final key = brand.vapidPublicKey;
  if (key == null) return null;
  try {
    final json = (await _subscribe(key.toJS).toDart).toDart;
    if (json.isEmpty) return null;
    return PushChannel.web(jsonDecode(json) as Map<String, dynamic>);
  } catch (_) {
    return null;
  }
}

/// The subscription this browser already has, to hand the server again.
Future<PushChannel?> pushCurrent(Brand brand) async {
  try {
    final json = (await _current().toDart).toDart;
    if (json.isEmpty) return null;
    return PushChannel.web(jsonDecode(json) as Map<String, dynamic>);
  } catch (_) {
    return null;
  }
}

/// Drop it. Returns the endpoint that went, for the server to forget.
Future<String?> pushUnsubscribe() async {
  try {
    final endpoint = (await _unsubscribe().toDart).toDart;
    return endpoint.isEmpty ? null : endpoint;
  } catch (_) {
    return null;
  }
}

/// A tapped notification while the app is open: its `#/inbox/<id>` address.
void onOpenRequest(void Function(String hash) handler) {
  try {
    _onOpen(((JSString hash) => handler(hash.toDart)).toJS);
  } catch (_) {
    // An old page without the hook: the tap still opens the app.
  }
}

/// The address the app was opened at, e.g. `/inbox/<id>` from a notification.
String openedAt() => Uri.base.fragment;
