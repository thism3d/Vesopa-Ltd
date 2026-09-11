import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

/// Setting a kiosk up with a Vesopa account.
///
/// A copy of `vesopa_epos_kitchen/lib/data/vesopa_sso.dart`, which is itself a
/// copy of the till's, and deliberately a copy rather than a shared package:
/// the apps ship separately, and a change to one app's sign-in must not be able
/// to break a kiosk in a venue that never installed the new build. Keep them in
/// step by hand; it changes about once a year.
///
/// THE KIOSK IS A PUBLIC CLIENT. It stands in the room with the customers, and
/// anything compiled into it can be read by whoever has the machine. So it
/// holds no client secret -- it cannot -- and what stops a stolen authorisation
/// code being redeemed by somebody else is PKCE: the code is bound to a
/// verifier that never left this process.
///
/// WHY THE SYSTEM BROWSER AND NOT A WINDOW INSIDE THE APP
///
/// An embedded web view would mean a manager typing their Vesopa password into
/// a field this kiosk is drawing, in public. The system browser shows the real
/// address bar and padlock, already has the passkey and the password manager,
/// and is what RFC 8252 asks native applications to do.
///
/// HOW THE ANSWER GETS BACK: a one-shot HTTP server on 127.0.0.1, on a port the
/// operating system chooses. Loopback only, so nothing on the network can reach
/// it; it accepts exactly one request and closes.
class VesopaSso {
  VesopaSso({
    required this.issuer,
    required this.clientId,
    http.Client? client,
  }) : _client = client ?? http.Client();

  /// `https://auth.vesopa.com`, without a trailing slash.
  final String issuer;

  /// The `vesopa-epos` public client, which the till and the kitchen share.
  /// The back office decides what the person may commission from their
  /// back-office account, not from which application asked.
  final String clientId;

  final http.Client _client;

  static final _random = Random.secure();

  /// Long enough to find a phone for a code; short enough that an abandoned
  /// attempt does not leave a socket open all day.
  static const _wait = Duration(minutes: 5);

  static String _randomString([int bytes = 32]) {
    final value = List<int>.generate(bytes, (_) => _random.nextInt(256));
    return base64Url.encode(value).replaceAll('=', '');
  }

  /// Run the whole round trip and return the ID token.
  ///
  /// [onUrl] is called with the address that was opened, so the screen can
  /// show it: on a locked-down kiosk the browser may not open at all, and a
  /// manager who can read the address can finish on their phone.
  Future<String> authorize({void Function(Uri url)? onUrl}) async {
    final verifier = _randomString(32);
    final challenge = base64Url
        .encode(sha256.convert(ascii.encode(verifier)).bytes)
        .replaceAll('=', '');
    final state = _randomString(16);
    final nonce = _randomString(16);

    // Port 0: the operating system picks a free one. The server registration
    // ignores the port for loopback addresses (RFC 8252 section 7.3).
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final redirectUri = 'http://127.0.0.1:${server.port}/callback';

    try {
      // `/oauth/authorize`, as `/.well-known/openid-configuration` publishes it.
      // The till once built `/authorize` by hand and opened a 404 for months.
      final authorizeUrl = Uri.parse('$issuer/oauth/authorize').replace(
        queryParameters: {
          'response_type': 'code',
          'client_id': clientId,
          'redirect_uri': redirectUri,
          'scope': 'openid profile email',
          'state': state,
          'nonce': nonce,
          'code_challenge': challenge,
          'code_challenge_method': 'S256',
          // A kiosk is set up by a person standing at it. Reusing a browser
          // session somebody left signed in would commission it as THEM.
          'prompt': 'login',
        },
      );

      onUrl?.call(authorizeUrl);
      await launchUrl(authorizeUrl, mode: LaunchMode.externalApplication);

      final code = await _waitForCode(server, state).timeout(
        _wait,
        onTimeout: () => throw VesopaSsoFailed(
          'The sign-in was not finished in time. Please try again.',
        ),
      );

      return await _exchange(
        code: code,
        verifier: verifier,
        redirectUri: redirectUri,
        nonce: nonce,
      );
    } finally {
      // On every path: a listener left bound outlives the failure that made it.
      await server.close(force: true);
    }
  }

  Future<String> _waitForCode(HttpServer server, String state) async {
    await for (final request in server) {
      if (request.uri.path != '/callback') {
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        continue;
      }

      final query = request.uri.queryParameters;
      final error = query['error'];
      final code = query['code'];

      // The CSRF defence, before the code is touched: without it anybody could
      // hand this listener a code from their own sign-in and the kiosk would be
      // commissioned to an account the manager never chose.
      final returned = query['state'] ?? '';
      final ok = returned.length == state.length &&
          List<int>.generate(
                state.length,
                (i) => state.codeUnitAt(i) ^ returned.codeUnitAt(i),
              ).fold<int>(0, (a, b) => a | b) ==
              0;

      if (!ok) {
        await _reply(request, 'Something went wrong',
            'That response did not match this sign-in. Please start again on the kiosk.');
        throw VesopaSsoFailed('The response did not match this sign-in attempt.');
      }
      if (error != null) {
        await _reply(request, 'Sign-in cancelled',
            'You can close this tab and try again on the kiosk.');
        throw VesopaSsoFailed(
          error == 'access_denied'
              ? 'Sign-in was cancelled.'
              : 'Vesopa refused the sign-in ($error).',
        );
      }
      if (code == null || code.isEmpty) {
        await _reply(request, 'Something went wrong',
            'No authorisation was returned. Please try again on the kiosk.');
        throw VesopaSsoFailed('No authorisation code came back.');
      }

      await _reply(request, 'You can close this tab',
          'The kiosk has been signed in. Go back to it to finish.');
      return code;
    }

    throw VesopaSsoFailed('The sign-in window closed before it finished.');
  }

  /// Swap the code for tokens. No secret -- PKCE is what authenticates this.
  Future<String> _exchange({
    required String code,
    required String verifier,
    required String redirectUri,
    required String nonce,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$issuer/oauth/token'),
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: {
            'grant_type': 'authorization_code',
            'code': code,
            'redirect_uri': redirectUri,
            'client_id': clientId,
            'code_verifier': verifier,
          },
        )
        .timeout(const Duration(seconds: 20));

    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw VesopaSsoFailed(
        (body['error_description'] as String?) ?? 'Vesopa would not issue a token.',
      );
    }

    final idToken = body['id_token'] as String?;
    if (idToken == null) {
      throw VesopaSsoFailed('Vesopa did not return an identity token.');
    }

    // The nonce ties this token to the request this process started, which is
    // the one thing the kiosk can usefully verify. The signature is the back
    // office's to check: it has the keys and decides what the token is worth.
    final claims = _claims(idToken);
    if (claims['nonce'] != nonce) {
      throw VesopaSsoFailed('The identity token did not match this sign-in.');
    }

    return idToken;
  }

  static Map<String, dynamic> _claims(String jwt) {
    final parts = jwt.split('.');
    if (parts.length != 3) throw VesopaSsoFailed('That is not a valid identity token.');
    final payload = parts[1].padRight((parts[1].length + 3) & ~3, '=');
    return jsonDecode(utf8.decode(base64Url.decode(payload))) as Map<String, dynamic>;
  }

  Future<void> _reply(HttpRequest request, String heading, String message) async {
    request.response
      ..statusCode = HttpStatus.ok
      ..headers.contentType = ContentType.html
      // The last hop of a sign-in, whose URL still carries the code.
      ..headers.set('Cache-Control', 'no-store')
      ..write('<!doctype html><meta charset="utf-8"><title>$heading</title>'
          '<body style="font:16px -apple-system,Segoe UI,Roboto,Arial,sans-serif;'
          'padding:48px;text-align:center;color:#10130A;background:#F6F7F0">'
          '<h1 style="font-size:20px">$heading</h1><p>$message</p></body>');
    await request.response.close();
  }
}

class VesopaSsoFailed implements Exception {
  VesopaSsoFailed(this.message);
  final String message;

  @override
  String toString() => message;
}
