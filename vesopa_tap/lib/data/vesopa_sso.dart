import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

/// Continue with Vesopa, on a phone.
///
/// A copy of the shape the till, the kitchen, the kiosk and the Loyalty app
/// use (vesopa_loyalty/lib/platform/vesopa_sso_io.dart), and a copy for the
/// same reason they are: these apps ship separately, and a change to one
/// app's sign-in must not break another. Keep them in step by hand.
///
/// A PUBLIC CLIENT WITH PKCE: nothing secret is compiled in; a stolen code is
/// useless without the verifier, which never leaves this process.
///
/// THE SYSTEM BROWSER, NEVER A WEB VIEW: on iPhone the in-app Safari sheet,
/// on Android the browser. It shows the real address and already holds the
/// person's passkey. The answer comes back on a one-shot loopback port.
class VesopaSso {
  VesopaSso({required this.issuer, required this.clientId, http.Client? client}) : _client = client ?? http.Client();

  final String issuer;
  final String clientId;
  final http.Client _client;

  static final _random = Random.secure();
  static const _wait = Duration(minutes: 5);

  static String _randomString([int bytes = 32]) =>
      base64Url.encode(List<int>.generate(bytes, (_) => _random.nextInt(256))).replaceAll('=', '');

  /// The whole round trip; returns the ID token. [signUp] opens Vesopa's
  /// create-an-account page first (registering a new venue).
  Future<String> authorize({bool signUp = false}) async {
    final verifier = _randomString(32);
    final challenge = base64Url.encode(sha256.convert(ascii.encode(verifier)).bytes).replaceAll('=', '');
    final state = _randomString(16);
    final nonce = _randomString(16);

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final redirectUri = 'http://127.0.0.1:${server.port}/callback';
    try {
      final url = Uri.parse('$issuer/oauth/authorize').replace(queryParameters: {
        'response_type': 'code',
        'client_id': clientId,
        'redirect_uri': redirectUri,
        'scope': 'openid profile email',
        'state': state,
        'nonce': nonce,
        'code_challenge': challenge,
        'code_challenge_method': 'S256',
        if (signUp) 'prompt': 'create',
      });
      final opened = await launchUrl(
        url,
        mode: Platform.isIOS ? LaunchMode.inAppBrowserView : LaunchMode.externalApplication,
      );
      if (!opened) throw const SsoFailed('Could not open the Vesopa sign-in page.');

      final request = await server.first.timeout(_wait, onTimeout: () => throw const SsoFailed('Sign-in timed out. Try again.'));
      final q = request.uri.queryParameters;
      request.response
        ..statusCode = 200
        ..headers.contentType = ContentType.html
        ..write('<!doctype html><meta name="viewport" content="width=device-width">'
            '<body style="font-family:system-ui;text-align:center;padding:48px">'
            '<h2>Signed in</h2><p>Go back to Vesopa Tap.</p></body>');
      await request.response.close();
      if (Platform.isIOS) unawaited(closeInAppWebView());

      if (q['state'] != state) throw const SsoFailed('The sign-in answer did not match. Try again.');
      if (q['error'] != null) throw SsoFailed(q['error_description'] ?? 'Sign-in was cancelled.');
      final code = q['code'];
      if (code == null) throw const SsoFailed('Vesopa sent no sign-in code.');

      final res = await _client.post(Uri.parse('$issuer/oauth/token'), body: {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirectUri,
        'client_id': clientId,
        'code_verifier': verifier,
      }).timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) throw SsoFailed('Vesopa refused the sign-in (${res.statusCode}).');
      final idToken = (jsonDecode(res.body) as Map<String, dynamic>)['id_token'] as String?;
      if (idToken == null) throw const SsoFailed('Vesopa sent no ID token.');
      return idToken;
    } finally {
      await server.close(force: true);
    }
  }
}

class SsoFailed implements Exception {
  const SsoFailed(this.message);
  final String message;
  @override
  String toString() => message;
}
