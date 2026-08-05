/// Every environment-dependent value in the till, in one place.
///
/// Flip [useLiveServer] to move the whole app between the local development
/// server and the live one. Nothing else needs editing.
library;

import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;

/// **The switch.** `true` = live server, `false` = the local dev server.
///
/// Deliberately a plain `const bool` rather than a setting: which server a till
/// talks to is a property of the build, not something a cashier should be able
/// to change from inside the app. A till that can be pointed at a different
/// server from its own settings screen is a till that can be pointed at the
/// wrong one during a shift.
///
/// A build-time define still wins, so CI (or a developer) can produce the
/// other flavour from the same source without editing this file — the default
/// below is live, so it is the *local* build that now needs the define:
///
///     flutter build apk --dart-define=USE_LIVE_SERVER=false
const bool useLiveServer = bool.fromEnvironment(
  'USE_LIVE_SERVER',
  defaultValue: true,
);

/// Server endpoints, one set per environment.
///
/// Kept as a class with a const constructor rather than loose top-level
/// constants so the two environments are defined side by side: it is obvious at
/// a glance that every field set for live is also set for local, and adding a
/// field to one forces you to fill it in for the other.
class ServerEnvironment {
  const ServerEnvironment({
    required this.name,
    required this.scheme,
    required this.host,
    required this.port,
    required this.secure,
  });

  /// Shown in Settings and on the sign-in screen so an operator can see which
  /// server a till is on without digging through a build log.
  final String name;

  final String scheme;
  final String host;

  /// Null means the scheme's default (443 for https, 80 for http) — a live URL
  /// should read `https://backoffice.vesopaepos.com`, never `…:443`.
  final int? port;

  /// TLS. Drives `wss://` vs `ws://` for the socket, which must match the HTTP
  /// scheme — a browser and most proxies refuse a plain `ws://` socket opened
  /// from an `https://` origin.
  final bool secure;

  String get _authority => port == null ? host : '$host:$port';

  /// Base for REST calls, no trailing slash.
  String get apiBase => '$scheme://$_authority';

  /// The push socket the sync service listens on.
  String get wsUrl => '${secure ? 'wss' : 'ws'}://$_authority/ws';

  /// The back-office admin site, for the "Open back office" link.
  String get backOfficeUrl => apiBase;
}

/// The live server.
///
/// One host serves both the admin SPA and the API, so the till and the back
/// office share an origin — no CORS, one certificate.
const liveServer = ServerEnvironment(
  name: 'Live',
  scheme: 'https',
  host: 'backoffice.vesopaepos.com',
  // Default https port; see [ServerEnvironment.port].
  port: null,
  secure: true,
);

/// The development server on your machine.
///
/// Not `const`, because the host is only knowable at runtime — see [_localHost]
/// for why an emulator and a desktop need different addresses for the same
/// machine.
///
/// Port 5060 is what `vesopa_server/.env` actually sets. Note it is on the
/// WHATWG restricted-ports list, so browsers and Node's `fetch` refuse it
/// without an explicit allowance — that affects tooling, not this app, but it
/// is the reason the live server should never be moved onto a port like this.
ServerEnvironment get localServer => ServerEnvironment(
  name: 'Local dev',
  scheme: 'http',
  host: _localHost,
  port: 5060,
  secure: false,
);

/// The dev server as seen *from the device the app runs on*.
///
/// On the Android emulator `localhost` is the emulator itself, so the till
/// would never find a server running on the Mac; 10.0.2.2 is the host machine.
/// A real phone or tablet is on neither — it needs the Mac's LAN address, which
/// only you know:
///
///     flutter run --dart-define=API_HOST=192.168.1.42
String get _localHost {
  const override = String.fromEnvironment('API_HOST');
  if (override.isNotEmpty) return override;
  // Platform.isAndroid throws on web; the till does not target web, but guard
  // anyway so this constant is safe to read from anywhere.
  if (!kIsWeb && Platform.isAndroid) return '10.0.2.2';
  return 'localhost';
}

/// The environment this build talks to.
ServerEnvironment get server => useLiveServer ? liveServer : localServer;

/// Convenience accessors, so callers read `Api.base` rather than reaching
/// through the environment object.
class Api {
  const Api._();

  static String get base => server.apiBase;
  static String get ws => server.wsUrl;
  static String get backOffice => server.backOfficeUrl;

  /// Whether this build points at production. Used to keep destructive or
  /// noisy developer affordances out of a live till.
  static bool get isLive => useLiveServer;

  /// Full override escape hatches, kept for CI and for pointing a till at a
  /// staging box without touching source. An explicit define beats the switch.
  static String get resolvedBase {
    const full = String.fromEnvironment('API_BASE');
    return full.isNotEmpty ? full : base;
  }

  static String get resolvedWs {
    const full = String.fromEnvironment('WS_URL');
    return full.isNotEmpty ? full : ws;
  }
}

/// Dojo card-payment configuration.
///
/// The API key is **not** here and must never be: this repository is public, so
/// a key in source is a published key. It comes from `--dart-define`, and the
/// operator can enter one in Settings. Only non-secret values live here.
class DojoConstants {
  const DojoConstants._();

  /// Dojo has a single API host for both sandbox and live — the key decides
  /// which environment a request lands in. The old `api.sandbox.dojo.tech` does
  /// not resolve (NXDOMAIN).
  static const apiHost = 'https://api.dojo.tech';

  /// Dojo's own published sandbox placeholders, documented publicly and safe to
  /// ship. Real credentials are issued on onboarding.
  static const sandboxSoftwareHouseId = 'softwareHouse1';
  static const sandboxResellerId = 'reseller1';
}

/// Company contact details, shown on the About screen and printed on receipts.
class VesopaBrand {
  const VesopaBrand._();

  static const appName = 'Vesopa EPOS';
  static const slogan = 'Vending · Software · Payments';

  static const phone = '+441792316282';
  static const email = 'info@vesopa.com';
  static const website = 'https://vesopaepos.com';
  static const websiteAlt = 'https://vesopaepos.co.uk';

  static const linkedIn =
      'https://uk.linkedin.com/company/made-to-measure-nutrition';
  static const x = 'https://x.com/vesopa_uk';

  static const whatsAppNumber = '447501928043';
  static const whatsAppUrl =
      'https://wa.me/447501928043?text=Hello%2C%20I%20am%20interested%20in%20Vesopa%20EPOS!';
}

/// Printing defaults.
class PrintConstants {
  const PrintConstants._();

  /// Thermal roll widths in millimetres. 80mm is the usual receipt roll, 58mm
  /// the narrow one; the server stores whichever the venue uses per office.
  static const wideRollMm = 80;
  static const narrowRollMm = 58;
  static const defaultRollMm = wideRollMm;

  /// Bundled Unicode faces. Without these the PDF library's built-in Helvetica
  /// silently drops "£" and every non-Latin-1 character.
  static const fontRegular = 'assets/fonts/OpenSans-Regular.ttf';
  static const fontBold = 'assets/fonts/OpenSans-Bold.ttf';
  static const fontItalic = 'assets/fonts/OpenSans-Italic.ttf';
}
