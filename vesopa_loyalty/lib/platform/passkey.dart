/// Passkeys, where the platform has them.
///
/// WebAuthn is a browser API. There is no Dart binding, no Win32 equivalent
/// this app can reach from Flutter, and nothing to fall back to — so only the
/// web build can make or use one. The Windows, Android and iPhone builds answer
/// `false` to [passkeysSupported] and the sign-in page never draws the button.
///
/// That is a real limit, honestly reported, rather than a stub: a venue that
/// switches passkeys on is told in the back office that they are browsers only.
///
/// The ceremony itself lives in web/index.html as `vesopaPasskey`, for the same
/// reason the push helper does — the base64url juggling that WebAuthn needs is
/// half a page of JavaScript and reads far better there than through interop.
library;

export 'passkey_io.dart' if (dart.library.js_interop) 'passkey_web.dart';

/// What the browser gave back, ready to send to the server.
class PasskeyResult {
  const PasskeyResult({required this.challenge, required this.credential});

  final String challenge;
  final Map<String, dynamic> credential;
}

/// The member cancelled, or the device refused. Carries nothing to show: a
/// cancelled passkey is not an error anybody needs telling about.
class PasskeyCancelled implements Exception {
  const PasskeyCancelled();
}
