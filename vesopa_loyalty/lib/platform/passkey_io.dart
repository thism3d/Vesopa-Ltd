import 'passkey.dart';

/// Everywhere that is not a browser.
///
/// Windows, Android and iOS have no WebAuthn this app can reach from Flutter,
/// so passkeys are simply not offered here. Saying so plainly — one `false`
/// and two throws that can never be reached from the UI — is better than a
/// stub that pretends and fails at the moment somebody taps it.
bool passkeysSupported() => false;

Future<PasskeyResult> passkeyCreate(Map<String, dynamic> options) async =>
    throw UnsupportedError('Passkeys need a web browser.');

Future<PasskeyResult> passkeyGet(Map<String, dynamic> options) async =>
    throw UnsupportedError('Passkeys need a web browser.');
