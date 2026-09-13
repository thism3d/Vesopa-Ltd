import 'dart:convert';
import 'dart:js_interop';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:web/web.dart' as web;

import 'vesopa_sso.dart';

/// Where Vesopa Auth lives, and which client this is.
///
/// Both are build-time constants rather than settings fetched from the server,
/// because the authorize URL is built before the app has asked the server
/// anything and because an issuer that could be set remotely is a way to send
/// somebody's sign-in somewhere else.
const _issuer = String.fromEnvironment(
  'VESOPA_AUTH_ISSUER',
  defaultValue: 'https://auth.vesopa.com',
);
const _clientId = String.fromEnvironment('VESOPA_LOYALTY_CLIENT_ID');

/// One callback address for every venue — see the note on the route in
/// src/loyalty_app.js. Which venue it was rides in `state`.
String _redirectUri() => '${web.window.location.origin}/app/vesopa/callback';

const _verifierKey = 'vesopa_pkce_verifier';
const _stateKey = 'vesopa_pkce_state';

String _random(int bytes) {
  final rng = Random.secure();
  return base64Url.encode(List<int>.generate(bytes, (_) => rng.nextInt(256))).replaceAll('=', '');
}

/// Leave for auth.vesopa.com.
///
/// Answers null because there is nothing to answer WITH: the page is gone by
/// the time this would return, and the code arrives in the address on the way
/// back, where [takeVesopaAnswer] picks it up. The signature matches the
/// native one so the caller does not have to know which platform it is on.
Future<VesopaAnswer?> startVesopaSignIn({required String slug, required String venue}) async {
  if (_clientId.isEmpty) {
    return const VesopaAnswer(error: 'This app was built without a Vesopa sign-in.');
  }
  final verifier = _random(48);
  final challenge = base64Url.encode(sha256.convert(ascii.encode(verifier)).bytes).replaceAll('=', '');
  // "<slug>.<nonce>": the callback page reads the slug to know which venue's
  // app to return to, and the nonce is ours to check when we get back.
  final state = '$slug.${_random(12)}';

  /*
   * SESSION storage, not local.
   *
   * The verifier is worth exactly one sign-in and is rubbish afterwards.
   * sessionStorage dies with the tab, which is the right lifetime: a verifier
   * left in localStorage would outlive the attempt, survive the browser being
   * closed, and sit there on a shared machine.
   */
  web.window.sessionStorage.setItem(_verifierKey, verifier);
  web.window.sessionStorage.setItem(_stateKey, state);

  final url = Uri.parse('$_issuer/oauth/authorize').replace(queryParameters: {
    'client_id': _clientId,
    'response_type': 'code',
    'redirect_uri': _redirectUri(),
    'scope': 'openid email profile',
    'state': state,
    'code_challenge': challenge,
    'code_challenge_method': 'S256',
  });
  web.window.location.assign(url.toString());
  return null;
}

/// The answer waiting in this page's address, if there is one.
///
/// Takes it: the query is stripped from the address bar on the way out, so a
/// reload cannot try to spend the same code twice and a shared link cannot
/// carry somebody's code to another machine.
VesopaAnswer? takeVesopaAnswer() {
  final here = Uri.parse(web.window.location.href);
  final code = here.queryParameters['vesopa_code'];
  final error = here.queryParameters['vesopa_error'];
  if (code == null && error == null) return null;

  final verifier = web.window.sessionStorage.getItem(_verifierKey) ?? '';
  final expected = web.window.sessionStorage.getItem(_stateKey);
  final got = here.queryParameters['vesopa_state'];
  web.window.sessionStorage.removeItem(_verifierKey);
  web.window.sessionStorage.removeItem(_stateKey);

  // Clean the address whatever happened next.
  final clean = here.replace(queryParameters: {
    for (final e in here.queryParameters.entries)
      if (!e.key.startsWith('vesopa_')) e.key: e.value,
  });
  web.window.history.replaceState(
    null.jsify(),
    '',
    clean.hasQuery ? '${clean.path}?${clean.query}' : clean.path,
  );

  if (error != null) {
    return VesopaAnswer(
      error: error == 'access_denied'
          ? 'That sign-in was cancelled.'
          : 'Vesopa could not sign you in. Please try again.',
      verifier: verifier,
      redirectUri: _redirectUri(),
    );
  }
  /*
   * The state has to match what this tab set.
   *
   * Without the check, a link crafted by somebody else carrying THEIR code
   * would sign this browser into THEIR membership — which sounds harmless
   * until you notice the victim then hands over their own details believing
   * it is their card.
   */
  if (expected == null || got != expected || verifier.isEmpty) {
    return VesopaAnswer(
      error: 'That sign-in could not be matched to this device. Please try again.',
      verifier: '',
      redirectUri: _redirectUri(),
    );
  }
  return VesopaAnswer(code: code, verifier: verifier, redirectUri: _redirectUri());
}
