import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

/// Commissioning a till with a Vesopa account.
///
/// THE TILL IS A PUBLIC CLIENT. It is installed in venues, on machines Vesopa
/// does not own, and anything compiled into it can be read by whoever has the
/// machine. So it holds no client secret — it cannot — and what stops a stolen
/// authorisation code being redeemed by somebody else is PKCE: the code is
/// bound to a verifier that never left this process.
///
/// WHY THE SYSTEM BROWSER AND NOT A WINDOW INSIDE THE APP
///
/// An embedded webview would mean the clerk types their Vesopa password into a
/// text field the till itself is drawing. Even when the app is honest, that
/// teaches people to type their password into whatever asks — and it is the
/// habit an attacker needs. The system browser shows the real address bar and
/// the real padlock, it has the passkey and the password manager already, and
/// it is what RFC 8252 asks native applications to do.
///
/// HOW THE ANSWER GETS BACK: a one-shot HTTP server on 127.0.0.1, on a port
/// chosen by the operating system. Loopback only, so nothing on the network can
/// reach it; it accepts exactly one request and then closes.
class VesopaSso {
  VesopaSso({
    required this.issuer,
    required this.clientId,
    http.Client? client,
  }) : _client = client ?? http.Client();

  /// `https://auth.vesopa.com`, without a trailing slash.
  final String issuer;

  /// The `vesopa-epos` client id. Public — it identifies, it does not
  /// authorise, and it is meant to be readable.
  final String clientId;

  final http.Client _client;

  static final _random = Random.secure();

  /// How long the clerk has to finish in the browser before the till gives up
  /// and closes the listener. Long enough to find a phone for a code; short
  /// enough that an abandoned attempt does not leave a socket open all day.
  static const _wait = Duration(minutes: 5);

  static String _randomString([int bytes = 32]) {
    final value = List<int>.generate(bytes, (_) => _random.nextInt(256));
    return base64Url.encode(value).replaceAll('=', '');
  }

  /// Run the whole round trip and return the ID token.
  ///
  /// [onUrl] is called with the address that was opened, so the sign-in screen
  /// can show it. On a kiosked Windows till the browser may not open at all,
  /// and a clerk who can read the address can finish on their phone.
  Future<String> authorize({void Function(Uri url)? onUrl}) async {
    final verifier = _randomString(32);
    final challenge = base64Url
        .encode(sha256.convert(ascii.encode(verifier)).bytes)
        .replaceAll('=', '');
    final state = _randomString(16);
    final nonce = _randomString(16);

    /*
     * Port 0 — the operating system picks a free one.
     *
     * A fixed port would collide with whatever else is on the machine, and a
     * till that cannot be set up because some other program holds port 9004 is
     * a support call nobody can diagnose from the shop floor. The server
     * registration ignores the port for loopback addresses, exactly so this can
     * be chosen at run time (RFC 8252 §7.3).
     */
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final redirectUri = 'http://127.0.0.1:${server.port}/callback';

    try {
      /*
       * `/oauth/authorize`, NOT `/authorize`.
       *
       * This said `/authorize` and had done since the file was written, so the
       * browser opened a 404 — "That page is not here" — and Continue with
       * Vesopa on the till has never once completed. The token exchange below
       * has the path right, which is exactly why nobody caught it: the half
       * that is unit-tested was correct and the half that only a real browser
       * exercises was not.
       *
       * The server publishes the truth at
       * `/.well-known/openid-configuration`, where `authorization_endpoint` is
       * `https://auth.vesopa.com/oauth/authorize`. A future version of this
       * client should read it from there rather than assembling paths by hand;
       * until it does, these two strings have to agree with that document and
       * with each other.
       */
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
          // A till is commissioned by a person who is physically here. Reusing
          // a browser session somebody left signed in on this machine would
          // commission the till as THEM, and nobody would know until a refund
          // was traced to the wrong name.
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

      return await _exchange(code: code, verifier: verifier, redirectUri: redirectUri, nonce: nonce);
    } finally {
      // Always, on every path. A listener left bound outlives the failure that
      // created it and the next attempt inherits a machine in a worse state.
      await server.close(force: true);
    }
  }

  /// Accept exactly one callback and read the code out of it.
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

      /*
       * The state check is the CSRF defence, and it must happen before the code
       * is touched. Without it somebody can hand this listener a code from
       * their own sign-in — the till is listening on a predictable address on
       * this machine — and the terminal is commissioned to an account the clerk
       * never chose. Compared in constant time out of habit, not necessity.
       */
      final returned = query['state'] ?? '';
      final ok = returned.length == state.length &&
          List<int>.generate(state.length, (i) => state.codeUnitAt(i) ^ returned.codeUnitAt(i))
              .fold<int>(0, (a, b) => a | b) ==
              0;

      if (!ok) {
        await _reply(request, 'Something went wrong', 'That response did not match this sign-in. Please start again on the till.');
        throw VesopaSsoFailed('The response did not match this sign-in attempt.');
      }
      if (error != null) {
        await _reply(request, 'Sign-in cancelled', 'You can close this tab and try again on the till.');
        throw VesopaSsoFailed(
          error == 'access_denied' ? 'Sign-in was cancelled.' : 'Vesopa refused the sign-in ($error).',
        );
      }
      if (code == null || code.isEmpty) {
        await _reply(request, 'Something went wrong', 'No authorisation was returned. Please try again on the till.');
        throw VesopaSsoFailed('No authorisation code came back.');
      }

      await _reply(request, 'You can close this tab', 'The till has been signed in.');
      return code;
    }

    throw VesopaSsoFailed('The sign-in window closed before it finished.');
  }

  /// Swap the code for tokens. No secret — PKCE is what authenticates this.
  Future<String> _exchange({
    required String code,
    required String verifier,
    required String redirectUri,
    required String nonce,
  }) async {
    final res = await _client.post(
      Uri.parse('$issuer/oauth/token'),
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirectUri,
        'client_id': clientId,
        'code_verifier': verifier,
      },
    ).timeout(const Duration(seconds: 20));

    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw VesopaSsoFailed(
        (body['error_description'] as String?) ?? 'Vesopa would not issue a token.',
      );
    }

    final idToken = body['id_token'] as String?;
    if (idToken == null) throw VesopaSsoFailed('Vesopa did not return an identity token.');

    /*
     * The nonce is checked HERE and the signature is not.
     *
     * Checking the nonce ties this token to the request this process started,
     * which is the one thing the till can usefully verify for itself. The
     * signature is deliberately left to the back office: it has the JWKS, it
     * decides what the token is worth, and a public client verifying its own
     * token proves nothing to anybody — the till could be lying about the whole
     * exchange. The token is a bearer credential to be handed on, not evidence.
     */
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
      // The browser must not keep this page: it is the last hop of a sign-in
      // and its URL still carries the authorisation code.
      ..headers.set('Cache-Control', 'no-store')
      ..write('<!doctype html><meta charset="utf-8"><title>$heading</title>'
          '<body style="font:16px -apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;'
          'padding:48px;text-align:center;color:#111">'
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
