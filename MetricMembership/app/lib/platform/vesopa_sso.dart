/// Continue with Vesopa: the OAuth dance, on whichever platform this is.
///
/// THE TWO PLATFORMS FINISH IN DIFFERENT PLACES, and the difference is real
/// rather than an inconsistency worth papering over:
///
///   * In a browser the page LEAVES for auth.vesopa.com and comes back with a
///     code in its address. [startVesopaSignIn] never returns; the answer is
///     picked up by [takeVesopaAnswer] on the next start.
///   * A native app opens the system browser and listens on a loopback port of
///     its own, so it has the whole answer before this call returns — an id
///     token, already exchanged.
///
/// So [startVesopaSignIn] answers a [VesopaAnswer] where it can and null where
/// the browser has gone.
///
/// THE WEB APP NEVER HOLDS A TOKEN FROM AUTH. It brings back a code and the
/// verifier that goes with it, and the Metric server does the exchange: a web
/// app cannot keep a client secret, and a token from auth has no business in
/// storage every script on the page can read. A native app is a public client
/// standing on somebody's counter and does its own exchange, exactly as the
/// till and the kiosk already do.
///
/// WHY PKCE IN BOTH CASES: the code travels back through an address bar, which
/// is the one part of this anybody else can see — in history, in a
/// shoulder-surf, in a mis-shared screenshot. The verifier never leaves the
/// device that started it, so a code on its own is worth nothing.
library;

export 'vesopa_sso_io.dart' if (dart.library.js_interop) 'vesopa_sso_web.dart';

/// The client id when the build was not given one (VESOPA_METRIC_CLIENT_ID):
/// read from the Metric server's /api/v1/brand before signing in. The client
/// id is minted when the server is set up, so the web build served from it
/// never has to be rebuilt to learn it. The ISSUER stays a build constant:
/// where somebody's sign-in goes is not something a server response may move.
String vesopaClientIdFromServer = '';

/// What came back from auth, ready for the server.
class VesopaAnswer {
  const VesopaAnswer({
    this.code,
    this.idToken,
    this.error,
    this.verifier = '',
    this.redirectUri = '',
  });

  /// The web path: a code for the server to exchange.
  final String? code;

  /// The native path: the identity token, already exchanged here.
  final String? idToken;

  /// Auth refused, or the member cancelled, in words already fit to show.
  final String? error;

  /// The PKCE verifier this sign-in was started with. Web only.
  final String verifier;
  final String redirectUri;

  bool get isEmpty => code == null && idToken == null && error == null;
}
