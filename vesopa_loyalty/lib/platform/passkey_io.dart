import 'native_auth.dart';
import 'passkey.dart';

/// Everywhere that is not a browser.
///
/// A venue's own app on an iPhone or iPad uses the device's own passkeys
/// (NativeAuth, ios/Runner/AuthBridge.swift): the same passkeys as the web
/// page, because they belong to loyalty.vesopa.com. Windows, Android and the
/// shared app have none this app can reach, so passkeys are not offered there.
bool passkeysSupported() => NativeAuth.enabled;

Future<PasskeyResult> passkeyCreate(Map<String, dynamic> options) async {
  if (!NativeAuth.enabled) throw UnsupportedError('Passkeys need a web browser.');
  return NativeAuth.passkeyCreate(options);
}

Future<PasskeyResult> passkeyGet(Map<String, dynamic> options) async {
  if (!NativeAuth.enabled) throw UnsupportedError('Passkeys need a web browser.');
  return NativeAuth.passkeyGet(options);
}
