import 'dart:convert';
import 'dart:js_interop';

import 'passkey.dart';

@JS('vesopaPasskey.supported')
external JSBoolean _supported();

@JS('vesopaPasskey.create')
external JSPromise<JSString> _create(JSString optionsJson);

@JS('vesopaPasskey.get')
external JSPromise<JSString> _get(JSString optionsJson);

/// Whether this browser can do WebAuthn at all.
///
/// False in an insecure context, in a browser too old, and in a webview that
/// has it switched off — all of which are ordinary and none of which is a
/// fault. The sign-in page simply offers the other ways in.
bool passkeysSupported() {
  try {
    return _supported().toDart;
  } catch (_) {
    return false;
  }
}

/// Both ceremonies answer the same shape, and both treat a cancel as a cancel.
Future<PasskeyResult> _run(Future<JSString> Function() job, Map<String, dynamic> options) async {
  final String raw;
  try {
    raw = (await job()).toDart;
  } catch (_) {
    // The browser throws for a cancelled prompt, a timed-out one and a refused
    // one alike, and tells them apart only in wording that changes by browser.
    // None of them is worth showing somebody, so all of them are a cancel.
    throw const PasskeyCancelled();
  }
  if (raw.isEmpty) throw const PasskeyCancelled();
  final decoded = jsonDecode(raw);
  if (decoded is! Map<String, dynamic>) throw const PasskeyCancelled();
  return PasskeyResult(
    // The challenge goes back to the server with the credential: it is what the
    // server looks the in-flight ceremony up by, and it is single use there.
    challenge: (options['challenge'] as String?) ?? '',
    credential: decoded,
  );
}

Future<PasskeyResult> passkeyCreate(Map<String, dynamic> options) =>
    _run(() => _create(jsonEncode(options).toJS).toDart, options);

Future<PasskeyResult> passkeyGet(Map<String, dynamic> options) =>
    _run(() => _get(jsonEncode(options).toJS).toDart, options);
