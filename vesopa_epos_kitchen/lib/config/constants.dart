/// Every environment-dependent value in the kitchen screen, in one place.
///
/// Deliberately the same shape as the till's `config/constants.dart`, down to
/// the names: the two apps talk to the same server and are pointed at a staging
/// box the same way, and a developer who has learned one should not have to
/// learn the other.
library;

/// **The switch.** `true` = live server, `false` = the local dev server.
///
/// A build-time property rather than a setting, for the same reason it is on
/// the till: a screen that can be pointed at a different server from its own
/// settings page is a screen that will be pointed at the wrong one, and the
/// person who does it will be holding a pan at the time.
///
///     flutter build windows --dart-define=USE_LIVE_SERVER=false
const bool useLiveServer = bool.fromEnvironment(
  'USE_LIVE_SERVER',
  defaultValue: true,
);

/// Server endpoints, one set per environment.
class ServerEnvironment {
  const ServerEnvironment({
    required this.name,
    required this.scheme,
    required this.host,
    required this.port,
    required this.secure,
  });

  /// Shown on the info panel, so a support call can establish which server a
  /// screen is on without reading a build log.
  final String name;

  final String scheme;
  final String host;

  /// Null means the scheme's default — a live URL should read
  /// `https://backoffice.vesopaepos.com`, never `…:443`.
  final int? port;

  /// TLS. Drives `wss://` against `ws://`, which has to match the HTTP scheme.
  final bool secure;

  String get _authority => port == null ? host : '$host:$port';

  String get apiBase => '$scheme://$_authority';

  String get wsUrl => '${secure ? 'wss' : 'ws'}://$_authority/ws';
}

const liveServer = ServerEnvironment(
  name: 'Live',
  scheme: 'https',
  host: 'backoffice.vesopaepos.com',
  port: null,
  secure: true,
);

/// The development server on your machine. Port 5060 is what
/// `vesopa_server/.env` sets.
ServerEnvironment get localServer => ServerEnvironment(
  name: 'Local dev',
  scheme: 'http',
  host: _localHost,
  port: 5060,
  secure: false,
);

String get _localHost {
  const override = String.fromEnvironment('API_HOST');
  if (override.isNotEmpty) return override;
  return 'localhost';
}

ServerEnvironment get server => useLiveServer ? liveServer : localServer;

class Api {
  const Api._();

  static String get base => server.apiBase;
  static String get ws => server.wsUrl;
  static bool get isLive => useLiveServer;
  static String get environmentName => server.name;

  /// Full override escape hatches, for CI and for pointing a screen at staging
  /// without touching source. An explicit define beats the switch.
  static String get resolvedBase {
    const full = String.fromEnvironment('API_BASE');
    return full.isNotEmpty ? full : base;
  }

  static String get resolvedWs {
    const full = String.fromEnvironment('WS_URL');
    return full.isNotEmpty ? full : ws;
  }
}

/// Defaults for a board nobody has configured yet.
///
/// Every one of these is overridden by the screen profile the back office
/// defines. They exist so the app is usable the first time it is opened in a
/// venue that has not set anything up — which is every venue, once.
class BoardDefaults {
  const BoardDefaults._();

  /// When an open ticket turns amber, then red.
  static const warn = Duration(minutes: 8);
  static const late = Duration(minutes: 15);

  /// How long a completed order stays recallable.
  static const recallWindow = Duration(minutes: 60);

  /// The board is re-fetched on this timer regardless of the socket.
  ///
  /// The socket is the fast path; this is the truth. A screen that missed a
  /// push because a proxy culled an idle connection must not miss the order,
  /// and thirty seconds is short enough that the worst case is a ticket that
  /// appears late rather than one that never appears.
  static const poll = Duration(seconds: 30);

  /// How often the elapsed clocks tick over.
  static const clock = Duration(seconds: 1);
}

/// Company details, shown on the info panel.
class VesopaBrand {
  const VesopaBrand._();

  /// What the product is called: the window title, the sign-in page, the
  /// info panel, and the Microsoft Store listing.
  ///
  /// "Vesopa Kitchen", not "Vesopa EPOS Kitchen" — it is read across a room by
  /// somebody holding a pan, and the middle word is the one that carries no
  /// information for them. The *package* is still `vesopa_epos_kitchen` and the
  /// Store identity is still `MeirionDavies.VesopaEPOSKitchen`: those are
  /// registered names and renaming them would orphan every installed copy.
  static const appName = 'Vesopa Kitchen';
  static const slogan = 'Vending · Software · Payments';

  static const phone = '+441792316282';
  static const email = 'info@vesopa.com';
  static const website = 'https://vesopaepos.com';
}
