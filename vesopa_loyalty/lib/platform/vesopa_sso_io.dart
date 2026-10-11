import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'device_label.dart';
import 'vesopa_sso.dart';

/// Continue with Vesopa on Windows, Android and iOS.
///
/// The same shape as the till's, the kitchen's and the kiosk's, and a copy for
/// the same reason they are copies of each other: these apps ship separately,
/// and a change to one app's sign-in must not be able to break a venue that
/// never installed the new build.
///
/// THE SYSTEM BROWSER, NOT A WINDOW INSIDE THE APP. An embedded web view means
/// somebody typing their Vesopa password into a field this app is drawing. The
/// system browser shows the real address bar and padlock, already holds their
/// passkey and password manager, and is what RFC 8252 asks of a native app.
///
/// THE ANSWER COMES BACK ON A LOOPBACK PORT the operating system chooses.
/// Nothing on the network can reach 127.0.0.1, the listener takes exactly one
/// request, and it is closed on every path out of here.
const _issuer = String.fromEnvironment(
  'VESOPA_AUTH_ISSUER',
  defaultValue: 'https://auth.vesopa.com',
);
const _clientId = String.fromEnvironment('VESOPA_LOYALTY_CLIENT_ID');

final _random = Random.secure();

String _randomString([int bytes = 32]) =>
    base64Url.encode(List<int>.generate(bytes, (_) => _random.nextInt(256))).replaceAll('=', '');

/// Long enough to find a phone for a code; short enough that an abandoned
/// attempt does not leave a socket open all day.
const _wait = Duration(minutes: 5);

bool get _inApp => Platform.isIOS;

/// [idp] goes straight to one way in on auth.vesopa.com -- `apple`, `google`,
/// `phone` or `passkey` -- for the buttons that name one; without it the
/// member sees Vesopa's own sign-in page with all of them.
Future<VesopaAnswer?> startVesopaSignIn({required String slug, required String venue, String? idp}) async {
  if (_clientId.isEmpty) {
    return const VesopaAnswer(error: 'This app was built without a Vesopa sign-in.');
  }
  final verifier = _randomString(32);
  final challenge =
      base64Url.encode(sha256.convert(ascii.encode(verifier)).bytes).replaceAll('=', '');
  final state = _randomString(16);
  final nonce = _randomString(16);

  // Port 0: the operating system picks a free one. Registration ignores the
  // port for loopback addresses (RFC 8252 section 7.3).
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final redirectUri = 'http://127.0.0.1:${server.port}/callback';
  try {
    final url = Uri.parse('$_issuer/oauth/authorize').replace(queryParameters: {
      'response_type': 'code',
      'client_id': _clientId,
      'redirect_uri': redirectUri,
      'scope': 'openid profile email',
      'state': state,
      'nonce': nonce,
      'code_challenge': challenge,
      'code_challenge_method': 'S256',
      'idp': ?idp,
    });
    // AN IPHONE SIGNS IN INSIDE THE APP. Sent out to Safari, the app is
    // suspended within seconds and this listener with it, so the page Vesopa
    // returns to cannot connect and the sign-in never finishes. A Safari view
    // over the app keeps the app running; it is closed below once the code is
    // in. Android and Windows keep the listener alive in the background.
    await launchUrl(url, mode: _inApp ? LaunchMode.inAppBrowserView : LaunchMode.externalApplication);

    final code = await _waitForCode(server, state, venue).timeout(
      _wait,
      onTimeout: () => throw const _Failed('That sign-in was not finished in time.'),
    );
    final idToken = await _exchange(
      code: code, verifier: verifier, redirectUri: redirectUri, nonce: nonce,
    );
    return VesopaAnswer(idToken: idToken);
  } on _Failed catch (e) {
    return VesopaAnswer(error: e.message);
  } catch (_) {
    return const VesopaAnswer(error: 'That sign-in could not be completed. Please try again.');
  } finally {
    // On every path: a listener left bound outlives the failure that made it.
    await server.close(force: true);
    if (_inApp) {
      try {
        await closeInAppWebView();
      } catch (_) {
        // Already closed by the member.
      }
    }
  }
}

/// Nothing waiting in an address: a native app has no address to wait in.
VesopaAnswer? takeVesopaAnswer() => null;

Future<String> _waitForCode(HttpServer server, String state, String venue) async {
  await for (final request in server) {
    if (request.uri.path != '/callback') {
      request.response.statusCode = HttpStatus.notFound;
      await request.response.close();
      continue;
    }
    final q = request.uri.queryParameters;
    final returned = q['state'] ?? '';
    // Checked before the code is touched: without it anybody could hand this
    // listener a code from their own sign-in and the app would open THEIR card.
    final ok = returned.length == state.length &&
        List<int>.generate(state.length, (i) => state.codeUnitAt(i) ^ returned.codeUnitAt(i))
                .fold<int>(0, (a, b) => a | b) ==
            0;
    if (!ok) {
      await _reply(request, venue, 'Something went wrong',
          'That response did not match this sign-in. Please start again in the app.');
      throw const _Failed('That response did not match this sign-in.');
    }
    if (q['error'] != null) {
      await _reply(request, venue, 'Sign-in cancelled',
          'You can close this tab and try again in the app.');
      throw _Failed(q['error'] == 'access_denied'
          ? 'That sign-in was cancelled.'
          : 'Vesopa refused the sign-in (${q['error']}).');
    }
    final code = q['code'];
    if (code == null || code.isEmpty) {
      await _reply(request, venue, 'Something went wrong',
          'No authorisation came back. Please try again in the app.');
      throw const _Failed('No authorisation code came back.');
    }
    await _reply(request, venue, 'You can close this tab', 'Go back to $venue to finish.');
    return code;
  }
  throw const _Failed('The sign-in window closed before it finished.');
}

/// Swap the code for tokens. No secret — PKCE is what authenticates this.
Future<String> _exchange({
  required String code,
  required String verifier,
  required String redirectUri,
  required String nonce,
}) async {
  final res = await http.post(
    Uri.parse('$_issuer/oauth/token'),
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: {
      'grant_type': 'authorization_code',
      'code': code,
      'redirect_uri': redirectUri,
      'client_id': _clientId,
      'code_verifier': verifier,
    },
  ).timeout(const Duration(seconds: 20));

  final body = jsonDecode(res.body) as Map<String, dynamic>;
  if (res.statusCode != 200) {
    throw _Failed((body['error_description'] as String?) ?? 'Vesopa would not issue a token.');
  }
  final idToken = body['id_token'] as String?;
  if (idToken == null) throw const _Failed('Vesopa did not return an identity token.');

  // The nonce ties this token to the request this process started, which is the
  // one thing the app can usefully check. The signature is the server's to
  // verify: it has the keys and decides what the token is worth.
  final parts = idToken.split('.');
  if (parts.length != 3) throw const _Failed('That is not a valid identity token.');
  final payload = parts[1].padRight((parts[1].length + 3) & ~3, '=');
  final claims = jsonDecode(utf8.decode(base64Url.decode(payload))) as Map<String, dynamic>;
  if (claims['nonce'] != nonce) throw const _Failed('The identity token did not match this sign-in.');
  return idToken;
}

/// Signing in to Vesopa with the device's own sheet: Sign in with Apple,
/// Google's sign-in, or a passkey (lib/platform/native_auth.dart). [proof] is
/// what the sheet gave back ({provider: apple, id_token, name}, or
/// {provider: passkey, credential, challenge}); auth.vesopa.com turns it into
/// a code for this app (vesopa_auth/src/routes/native.js), swapped here for
/// the identity token exactly as after Vesopa's page. No web page opens.
///
/// Null when the member said no to [consent]. [VesopaNeedsPage] when Vesopa
/// must ask something only its own page can (a second factor).
Future<VesopaAnswer?> nativeVesopaSignIn(Map<String, Object?> proof, {required VesopaConsent consent}) async {
  if (_clientId.isEmpty) {
    return const VesopaAnswer(error: 'This app was built without a Vesopa sign-in.');
  }
  final verifier = _randomString(32);
  final challenge = base64Url.encode(sha256.convert(ascii.encode(verifier)).bytes).replaceAll('=', '');
  final nonce = _randomString(16);
  // Never listened on: the code comes back in the answer. It is the address
  // the app is registered with, which the code is bound to.
  const redirectUri = 'http://127.0.0.1/callback';
  final request = <String, Object?>{
    'client_id': _clientId,
    'redirect_uri': redirectUri,
    'scope': 'openid profile email',
    'nonce': nonce,
    'code_challenge': challenge,
    'code_challenge_method': 'S256',
  };

  Future<(int, Map<String, dynamic>)> post(Map<String, Object?> body) async {
    final res = await http
        .post(
          Uri.parse('$_issuer/oauth/native'),
          headers: {'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': deviceUserAgent},
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 20));
    Map<String, dynamic> json;
    try {
      json = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      json = const {};
    }
    return (res.statusCode, json);
  }

  try {
    var (status, answer) = await post({...request, ...proof});
    if (status == 409 && answer['error'] == 'consent_required' && answer['ticket'] != null) {
      final scopes = [
        for (final s in (answer['scopes'] as List? ?? const []).cast<Map>())
          (title: '${s['title'] ?? s['name'] ?? ''}', description: '${s['description'] ?? ''}'),
      ];
      if (!await consent('${answer['application'] ?? 'This app'}', scopes)) return null;
      (status, answer) = await post({...request, 'ticket': answer['ticket'], 'consent': true});
    }
    if (status == 409 && answer['error'] != 'consent_required') {
      throw VesopaNeedsPage('${answer['error_description'] ?? 'Vesopa needs to ask you something first.'}');
    }
    final code = answer['code'] as String?;
    if (status != 200 || code == null) {
      return VesopaAnswer(error: '${answer['error_description'] ?? 'That sign-in could not be completed. Please try again.'}');
    }
    final idToken = await _exchange(code: code, verifier: verifier, redirectUri: redirectUri, nonce: nonce);
    return VesopaAnswer(idToken: idToken);
  } on _Failed catch (e) {
    return VesopaAnswer(error: e.message);
  } on VesopaNeedsPage {
    rethrow;
  } catch (_) {
    return const VesopaAnswer(error: 'That sign-in could not be completed. Please try again.');
  }
}

/// A passkey challenge from Vesopa, for the device's own passkey sheet.
Future<Map<String, dynamic>> vesopaPasskeyOptions() async {
  final res = await http
      .post(Uri.parse('$_issuer/webauthn/authenticate/options'),
          headers: {'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': deviceUserAgent},
          body: '{}')
      .timeout(const Duration(seconds: 20));
  if (res.statusCode != 200) throw const _Failed('Vesopa could not start a passkey sign-in. Please try again.');
  return jsonDecode(res.body) as Map<String, dynamic>;
}

Future<void> _reply(HttpRequest request, String venue, String heading, String message) async {
  final safe = venue.replaceAll('<', '&lt;').replaceAll('&', '&amp;');
  request.response
    ..statusCode = HttpStatus.ok
    ..headers.contentType = ContentType.html
    // The last hop of a sign-in, whose URL still carries the code.
    ..headers.set('Cache-Control', 'no-store')
    ..write('<!doctype html><meta charset="utf-8"><title>$heading</title>'
        '<body style="font:16px -apple-system,Segoe UI,Roboto,Arial,sans-serif;'
        'padding:48px;text-align:center;color:#111;background:#F6F6F1">'
        '<h1 style="font-size:20px">$heading</h1><p>$message</p>'
        '<p style="color:#666;font-size:13px">$safe</p></body>');
  await request.response.close();
}

class _Failed implements Exception {
  const _Failed(this.message);
  final String message;
  @override
  String toString() => message;
}
