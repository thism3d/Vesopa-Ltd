/// Passkeys, where the platform has them.
///
/// In a browser, WebAuthn. In a venue's own app on an iPhone, iPad or Android
/// phone, the device's own passkey sheets (NativeAuth: AuthBridge.swift,
/// AuthBridge.kt), for the same site, so one passkey works in both. The
/// Windows build and the shared Store app have neither -- the Store app is not
/// named in the site's apple-app-site-association -- so they answer `false` to
/// [passkeysSupported] and the sign-in page never draws the button.
///
/// The ceremony itself lives in web/index.html as `vesopaPasskey`, for the same
/// reason the push helper does — the base64url juggling that WebAuthn needs is
/// half a page of JavaScript and reads far better there than through interop.
library;

import 'package:shared_preferences/shared_preferences.dart';

export 'passkey_io.dart' if (dart.library.js_interop) 'passkey_web.dart';

/*
 * WHICH PASSKEY THIS DEVICE HOLDS, in a venue's own app.
 *
 * Two kinds can sign somebody in there: the one on their Vesopa account
 * (vesopa.com, through auth.vesopa.com) and one made for the venue's own
 * sign-in (Account > Signing in > Add a passkey, kept by the venue's server).
 * The sign-in page asks for the Vesopa one first. On an iPhone with none, iOS
 * does not say "none" -- it offers a passkey from another device instead -- so
 * a member who added a venue passkey here would be shown the wrong sheet.
 * Remembering that they did lets the sign-in page ask for the right one first.
 * Lost with the app's data, which only means the old order comes back.
 */
const _venuePasskeyKey = 'venue_passkey_here';

/// Note that a passkey for the venue's own sign-in was made on this device.
Future<void> rememberVenuePasskeyHere() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_venuePasskeyKey, true);
  } catch (_) {
    // Only a hint for the sign-in page; nothing breaks without it.
  }
}

/// Whether a passkey for the venue's own sign-in was made on this device.
Future<bool> venuePasskeyHere() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_venuePasskeyKey) ?? false;
  } catch (_) {
    return false;
  }
}

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
