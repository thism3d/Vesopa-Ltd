import 'dart:ui' show Color;

/// What this venue's screens call themselves, and what they show while they
/// start up.
///
/// White label, and owned by the venue rather than the machine — the same split
/// as the station names and the screen profiles. A group running four sites can
/// put its own mark on the wall in all of them from one page in the back
/// office, and a reseller can put *theirs* on every venue it sells to.
///
/// **Everything here falls back rather than failing.** An empty name becomes
/// "Vesopa Kitchen"; an empty logo becomes the venue's receipt logo and then the
/// bundled mark; an unparseable colour becomes the built-in one. A screen must
/// never be able to end up looking at a crash because somebody typed a colour
/// wrong in an office thirty miles away.
class KitchenBranding {
  const KitchenBranding({
    this.splashEnabled = true,
    this.splashHold = const Duration(milliseconds: 1800),
    this.appName = '',
    this.tagline = '',
    this.logoUrl,
    this.background,
    this.accent,
    this.showPoweredBy = true,
  });

  /// Whether the start screen is shown at all.
  final bool splashEnabled;

  /// How long it holds *after* its animation has finished.
  ///
  /// Capped at six seconds by the server. The board is fetched behind the start
  /// screen either way, so this never delays an order arriving — only how long
  /// it waits to be looked at.
  final Duration splashHold;

  /// Empty means [fallbackName].
  final String appName;

  /// The line under the name. Empty means the venue's trading name, which the
  /// server has already substituted by the time this arrives, and then nothing.
  final String tagline;

  /// A path on the back office (`/uploads/…`), not a full URL — the app puts
  /// its own server in front of it. Null means the bundled mark.
  final String? logoUrl;

  final Color? background;
  final Color? accent;

  final bool showPoweredBy;

  /// The product's own name, used when a venue has not chosen one.
  static const fallbackName = 'Vesopa Kitchen';

  /// The default look, for a venue that has never opened the branding page —
  /// and for a screen that has never yet reached the server.
  static const standard = KitchenBranding();

  String get displayName => appName.trim().isEmpty ? fallbackName : appName.trim();

  /// Whether anything at all has been white-labelled.
  ///
  /// Drives the wording on the settings panel: "Vesopa Kitchen" and "this
  /// venue's own branding" are different enough situations to say out loud.
  bool get isCustomised =>
      appName.trim().isNotEmpty ||
      tagline.trim().isNotEmpty ||
      logoUrl != null ||
      background != null ||
      accent != null ||
      !showPoweredBy;

  /// The logo as something [Image.network] can fetch.
  ///
  /// Resolved against the API base rather than stored absolute, so a venue
  /// moved to a different server — or a screen pointed at staging — does not
  /// keep fetching the old one's pictures.
  String? logoFor(String apiBase) {
    final path = logoUrl?.trim();
    if (path == null || path.isEmpty) return null;
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    return '$apiBase${path.startsWith('/') ? '' : '/'}$path';
  }

  KitchenBranding copyWith({
    bool? splashEnabled,
    Duration? splashHold,
    String? appName,
    String? tagline,
    String? logoUrl,
    bool clearLogo = false,
    Color? background,
    bool clearBackground = false,
    Color? accent,
    bool clearAccent = false,
    bool? showPoweredBy,
  }) => KitchenBranding(
    splashEnabled: splashEnabled ?? this.splashEnabled,
    splashHold: splashHold ?? this.splashHold,
    appName: appName ?? this.appName,
    tagline: tagline ?? this.tagline,
    logoUrl: clearLogo ? null : (logoUrl ?? this.logoUrl),
    background: clearBackground ? null : (background ?? this.background),
    accent: clearAccent ? null : (accent ?? this.accent),
    showPoweredBy: showPoweredBy ?? this.showPoweredBy,
  );

  /// `#RRGGBB` to a [Color]. Null for anything else, which is what makes a
  /// malformed value fall back instead of throwing.
  static Color? parseHex(Object? raw) {
    final text = '${raw ?? ''}'.trim().replaceFirst('#', '');
    if (text.length != 6) return null;
    final value = int.tryParse(text, radix: 16);
    return value == null ? null : Color(0xFF000000 | value);
  }

  /// A [Color] back to `#RRGGBB`, for sending to the server.
  static String toHex(Color? colour) {
    if (colour == null) return '';
    int channel(double c) => (c * 255).round().clamp(0, 255);
    final r = channel(colour.r).toRadixString(16).padLeft(2, '0');
    final g = channel(colour.g).toRadixString(16).padLeft(2, '0');
    final b = channel(colour.b).toRadixString(16).padLeft(2, '0');
    return '#$r$g$b';
  }

  factory KitchenBranding.fromJson(Map<String, dynamic>? j) {
    if (j == null) return standard;
    final ms = (j['splashMs'] as num?)?.round();
    final logo = '${j['logoUrl'] ?? ''}'.trim();
    return KitchenBranding(
      splashEnabled: j['splashEnabled'] != false,
      splashHold: Duration(
        milliseconds: (ms ?? standard.splashHold.inMilliseconds).clamp(0, 6000),
      ),
      appName: '${j['appName'] ?? ''}'.trim(),
      tagline: '${j['tagline'] ?? ''}'.trim(),
      logoUrl: logo.isEmpty ? null : logo,
      background: parseHex(j['splashBg']),
      accent: parseHex(j['accent']),
      showPoweredBy: j['showPoweredBy'] != false,
    );
  }

  /// The wire form, and the cached form. One shape for both so a screen that
  /// has been offline since a release still reads its own cache.
  Map<String, dynamic> toJson() => {
    'splashEnabled': splashEnabled,
    'splashMs': splashHold.inMilliseconds,
    'appName': appName,
    'tagline': tagline,
    'logoUrl': logoUrl ?? '',
    'splashBg': toHex(background),
    'accent': toHex(accent),
    'showPoweredBy': showPoweredBy,
  };
}
