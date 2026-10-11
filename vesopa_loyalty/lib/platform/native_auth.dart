import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'passkey.dart';

/// Signing in with what an iPhone or iPad already has, in a venue's own app:
/// Sign in with Apple, passkeys, and Google's own sign-in sheet. No web page
/// of ours opens (ios/Runner/AuthBridge.swift).
///
/// ONLY IN A VENUE BUILD ON APPLE DEVICES. tool/make_venue_app.py gives the
/// app the Sign in with Apple and associated-domains entitlements and sets
/// VENUE_NATIVE_AUTH; the shared app has neither and keeps Continue with
/// Vesopa as it was.
class NativeAuth {
  NativeAuth._();

  static const _channel = MethodChannel('vesopa_loyalty/auth');
  static const _flag = bool.fromEnvironment('VENUE_NATIVE_AUTH');

  /// Google's iOS OAuth client for this app (venue.json google_ios_client_id).
  /// Empty until one is made in Google Cloud; Google then goes through Vesopa.
  static const googleClientId = String.fromEnvironment('GOOGLE_IOS_CLIENT_ID');

  static bool get enabled => _flag && !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;
  static bool get google => enabled && googleClientId.isNotEmpty;

  /// Apple's sheet. Null when the member cancelled.
  static Future<({String token, String? name})?> apple() async {
    final answer = await _call<Map>('apple');
    if (answer == null) return null;
    final token = answer['identity_token'] as String?;
    if (token == null || token.isEmpty) throw NativeAuthError('Apple did not confirm who you are. Please try again.');
    final name = [answer['given_name'], answer['family_name']].whereType<String>().join(' ').trim();
    return (token: token, name: name.isEmpty ? null : name);
  }

  static Future<PasskeyResult> passkeyGet(Map<String, dynamic> options) =>
      _passkey('passkeyGet', options);

  static Future<PasskeyResult> passkeyCreate(Map<String, dynamic> options) =>
      _passkey('passkeyCreate', options);

  static Future<PasskeyResult> _passkey(String method, Map<String, dynamic> options) async {
    final raw = await _call<String>(method, jsonEncode(options));
    if (raw == null || raw.isEmpty) throw const PasskeyCancelled();
    return PasskeyResult(
      challenge: (options['challenge'] as String?) ?? '',
      credential: jsonDecode(raw) as Map<String, dynamic>,
    );
  }

  /// Google's own sign-in sheet (the one Google's SDK shows), then the code
  /// swapped for an id token with PKCE. An iOS client has no secret.
  static Future<String?> googleIdToken() async {
    final id = googleClientId;
    final scheme = 'com.googleusercontent.apps.${id.replaceFirst('.apps.googleusercontent.com', '')}';
    final redirect = '$scheme:/oauth2redirect';
    final random = Random.secure();
    String token(int n) => base64Url.encode(List.generate(n, (_) => random.nextInt(256))).replaceAll('=', '');
    final verifier = token(48);
    final state = token(16);
    final challenge = base64Url.encode(sha256.convert(ascii.encode(verifier)).bytes).replaceAll('=', '');
    final url = Uri.https('accounts.google.com', '/o/oauth2/v2/auth', {
      'client_id': id,
      'redirect_uri': redirect,
      'response_type': 'code',
      'scope': 'openid email profile',
      'code_challenge': challenge,
      'code_challenge_method': 'S256',
      'state': state,
      'prompt': 'select_account',
    });
    final back = await _call<String>('webAuth', {'url': url.toString(), 'scheme': scheme});
    if (back == null) return null;
    final answer = Uri.parse(back).queryParameters;
    if (answer['state'] != state || answer['code'] == null) {
      if (answer['error'] == 'access_denied') return null;
      throw NativeAuthError('Google did not confirm who you are. Please try again.');
    }
    final res = await http.post(Uri.parse('https://oauth2.googleapis.com/token'), body: {
      'grant_type': 'authorization_code',
      'code': answer['code']!,
      'code_verifier': verifier,
      'client_id': id,
      'redirect_uri': redirect,
    });
    final idToken = res.statusCode == 200 ? (jsonDecode(res.body) as Map)['id_token'] as String? : null;
    if (idToken == null) throw NativeAuthError('Google did not confirm who you are. Please try again.');
    return idToken;
  }

  /// Null for a cancel; a [NativeAuthError] with words worth showing otherwise.
  static Future<T?> _call<T>(String method, [Object? args]) async {
    try {
      return await _channel.invokeMethod<T>(method, args);
    } on PlatformException catch (e) {
      if (e.code == 'cancelled') return null;
      throw NativeAuthError(e.message ?? 'That sign-in could not be completed.', code: e.code);
    }
  }
}

class NativeAuthError implements Exception {
  NativeAuthError(this.message, {this.code = 'failed'});
  final String message;

  /// `none`: no passkey for that site on this device.
  final String code;
  @override
  String toString() => message;
}
