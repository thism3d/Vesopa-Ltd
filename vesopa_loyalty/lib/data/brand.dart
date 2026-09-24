import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'signin.dart';

/// Everything the app draws for a venue, from `/loyalty/v1/app/:slug`.
///
/// White-labelled at run time: the same build is every venue's app, and what
/// makes it Pontardawe RFC's (or anyone's) is this -- set in the back office
/// under Loyalty App, and changed there without a new release.
class Brand {
  const Brand({
    required this.slug,
    required this.name,
    required this.venue,
    required this.welcome,
    this.logo,
    this.icon,
    this.hero,
    required this.primary,
    required this.accent,
    required this.background,
    required this.text,
    this.iconTint,
    this.fontScale = 1.0,
    this.inboxMode = 'limit',
    this.inboxLimit = 12,
    this.headingFont,
    this.bodyFont,
    this.links = const {},
    this.address,
    this.hours,
    this.location,
    this.pointValueMinor = 1,
    this.minRedeem = 0,
    this.vapidPublicKey,
    this.windowsPush = false,
    this.signIn = SignInConfig.fallback,
  });

  final String slug;
  final String name;
  final String venue;
  final String welcome;
  final String? logo;
  final String? icon;
  final String? hero;
  final Color primary;
  final Color accent;
  final Color background;
  final Color text;

  /// The icons -- tab bar, the card's facts, the account page. Null is
  /// "the main colour", which is what they were before the venue could
  /// choose, and which on a white card is white on white.
  final Color? iconTint;

  /// How much bigger than the app's own type the venue wants everything.
  /// 0.8 to 1.6; 1 is as it was. A condensed face like Bebas Neue reads
  /// small at 1.
  final double fontScale;

  /// How the news page keeps its messages: 'limit' (the newest [inboxLimit])
  /// or 'scroll' (all of them, a page at a time).
  final String inboxMode;
  final int inboxLimit;

  final BrandFont? headingFont;
  final BrandFont? bodyFont;

  Color get iconColour => iconTint ?? primary;

  /// website, phone, email, facebook, instagram, x, tiktok, booking, menu.
  final Map<String, String> links;
  final String? address;
  final String? hours;
  final ({double latitude, double longitude, int radiusM})? location;
  final int pointValueMinor;
  final int minRedeem;

  /// Present when the server can send browser notifications.
  final String? vapidPublicKey;

  /// Whether the venue's Windows app is set up for notifications.
  final bool windowsPush;

  /// The ways in this venue offers. Arrives with the branding because the
  /// sign-in page has to be drawn before anybody has a token to ask with.
  final SignInConfig signIn;

  static Color _hex(Object? v, Color fallback) {
    final s = (v as String?)?.trim() ?? '';
    final m = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch(s);
    if (m == null) return fallback;
    return Color(int.parse('FF${m.group(1)}', radix: 16));
  }

  factory Brand.fromJson(Map<String, dynamic> j, String Function(String) resolve) {
    final colours = (j['colours'] as Map?) ?? const {};
    final fonts = (j['fonts'] as Map?) ?? const {};
    final loc = j['location'] as Map?;
    final points = (j['points'] as Map?) ?? const {};
    final push = (j['push'] as Map?) ?? const {};
    final web = push['web'] as Map?;
    String? url(Object? v) => (v is String && v.trim().isNotEmpty) ? resolve(v.trim()) : null;
    return Brand(
      slug: (j['slug'] as String?) ?? '',
      name: (j['name'] as String?) ?? 'Loyalty',
      venue: (j['venue'] as String?) ?? '',
      welcome: (j['welcome'] as String?) ?? '',
      logo: url(j['logo']),
      icon: url(j['icon']),
      hero: url(j['hero']),
      primary: _hex(colours['primary'], const Color(0xFF1E3A8A)),
      accent: _hex(colours['accent'], const Color(0xFFF59E0B)),
      background: _hex(colours['background'], const Color(0xFFF8FAFC)),
      text: _hex(colours['text'], const Color(0xFF0F172A)),
      iconTint: colours['icon'] is String && (colours['icon'] as String).isNotEmpty
          ? _hex(colours['icon'], const Color(0xFF1E3A8A))
          : null,
      fontScale: ((j['font_scale'] as num?)?.toDouble() ?? 1.0).clamp(0.8, 1.6),
      inboxMode: ((j['inbox'] as Map?)?['mode'] as String?) == 'scroll' ? 'scroll' : 'limit',
      inboxLimit: ((j['inbox'] as Map?)?['limit'] as num?)?.toInt() ?? 12,
      headingFont: BrandFont.fromJson(fonts['heading'], resolve),
      bodyFont: BrandFont.fromJson(fonts['body'], resolve),
      links: {
        for (final e in ((j['links'] as Map?) ?? const {}).entries)
          if (e.value is String && (e.value as String).trim().isNotEmpty) '${e.key}': (e.value as String).trim(),
      },
      address: j['address'] as String?,
      hours: j['hours'] as String?,
      location: loc == null
          ? null
          : (
              latitude: (loc['latitude'] as num).toDouble(),
              longitude: (loc['longitude'] as num).toDouble(),
              radiusM: (loc['radius_m'] as num?)?.toInt() ?? 400,
            ),
      pointValueMinor: (points['value_minor'] as num?)?.toInt() ?? 1,
      minRedeem: (points['min_redeem'] as num?)?.toInt() ?? 0,
      vapidPublicKey: web?['vapid_public_key'] as String?,
      windowsPush: push['windows'] == true,
      signIn: SignInConfig.fromJson(j['signin'] as Map<String, dynamic>?),
    );
  }

  /// Text that reads on [c].
  static Color onColour(Color c) => c.computeLuminance() > 0.5 ? const Color(0xFF111111) : Colors.white;

  bool get _dark => background.computeLuminance() <= 0.4;

  /// A shade of the venue's background for a card or a sheet to sit on.
  ///
  /// EVERY SURFACE IS THE VENUE'S BACKGROUND, LIGHTENED OR DARKENED. Material's
  /// own scheme derived the card behind the facts and the news sheet from the
  /// seed colour, which on The Vesopa Kitchen (white on #990000) came out a
  /// dark grey the venue never chose -- and their black text vanished on it.
  /// A shade of their own background is a surface their own text colour was
  /// chosen against.
  Color surface([double step = 0.08]) =>
      Color.lerp(background, _dark ? Colors.white : Colors.black, step)!;

  ThemeData theme() {
    final scheme = ColorScheme.fromSeed(
      seedColor: primary,
      primary: primary,
      onPrimary: onColour(primary),
      secondary: accent,
      onSecondary: onColour(accent),
      surface: background,
      onSurface: text,
      brightness: _dark ? Brightness.dark : Brightness.light,
    ).copyWith(
      // The tints Material reaches for behind cards, sheets, dialogs and
      // menus. All shades of the background now -- see surface().
      surfaceContainerLowest: surface(0.03),
      surfaceContainerLow: surface(0.05),
      surfaceContainer: surface(0.08),
      surfaceContainerHigh: surface(0.11),
      surfaceContainerHighest: surface(0.14),
      onSurfaceVariant: text.withValues(alpha: 0.78),
      outline: text.withValues(alpha: 0.35),
      outlineVariant: text.withValues(alpha: 0.18),
    );
    final base = ThemeData(colorScheme: scheme, useMaterial3: true, scaffoldBackgroundColor: background);
    final bodyFamily = bodyFont?.family;
    final headFamily = headingFont?.family ?? bodyFamily;
    var textTheme = base.textTheme
        .apply(fontFamily: bodyFamily, bodyColor: text, displayColor: text, fontSizeFactor: fontScale);
    if (headFamily != null) {
      TextStyle? h(TextStyle? s) => s?.copyWith(fontFamily: headFamily);
      textTheme = textTheme.copyWith(
        displayLarge: h(textTheme.displayLarge),
        displayMedium: h(textTheme.displayMedium),
        displaySmall: h(textTheme.displaySmall),
        headlineLarge: h(textTheme.headlineLarge),
        headlineMedium: h(textTheme.headlineMedium),
        headlineSmall: h(textTheme.headlineSmall),
        titleLarge: h(textTheme.titleLarge),
        titleMedium: h(textTheme.titleMedium),
      );
    }
    return base.copyWith(
      textTheme: textTheme,
      // The icons are the venue's icon colour everywhere an icon is not
      // drawn on the main colour (the app bar and buttons keep their own).
      iconTheme: IconThemeData(color: iconColour),
      listTileTheme: ListTileThemeData(
        iconColor: iconColour,
        textColor: text,
        titleTextStyle: textTheme.bodyLarge,
        subtitleTextStyle: textTheme.bodyMedium?.copyWith(color: text.withValues(alpha: 0.78)),
      ),
      cardTheme: CardThemeData(color: surface(0.08), surfaceTintColor: Colors.transparent),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: surface(0.05),
        surfaceTintColor: Colors.transparent,
        dragHandleColor: text.withValues(alpha: 0.4),
      ),
      dialogTheme: DialogThemeData(backgroundColor: surface(0.06), surfaceTintColor: Colors.transparent),
      dividerColor: text.withValues(alpha: 0.15),
      appBarTheme: AppBarTheme(
        backgroundColor: primary,
        foregroundColor: onColour(primary),
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge?.copyWith(color: onColour(primary), fontWeight: FontWeight.w700),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: primary,
          foregroundColor: onColour(primary),
          minimumSize: const Size(0, 50),
          textStyle: textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white.withValues(alpha: background.computeLuminance() > 0.4 ? 1 : 0.08),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: surface(0.06),
        surfaceTintColor: Colors.transparent,
        indicatorColor: accent.withValues(alpha: 0.3),
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(color: states.contains(WidgetState.selected) ? iconColour : iconColour.withValues(alpha: 0.7)),
        ),
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => textTheme.labelMedium?.copyWith(
            color: text,
            fontWeight: states.contains(WidgetState.selected) ? FontWeight.w700 : FontWeight.w500,
          ),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: surface(0.04),
        indicatorColor: accent.withValues(alpha: 0.3),
        selectedIconTheme: IconThemeData(color: iconColour),
        unselectedIconTheme: IconThemeData(color: iconColour.withValues(alpha: 0.7)),
        selectedLabelTextStyle: textTheme.labelMedium?.copyWith(color: text, fontWeight: FontWeight.w700),
        unselectedLabelTextStyle: textTheme.labelMedium?.copyWith(color: text),
      ),
    );
  }

  /// Register the venue's own fonts, downloaded from the server. A font that
  /// will not load leaves the default face -- never a blank screen.
  Future<void> loadFonts() async {
    for (final f in [headingFont, bodyFont]) {
      if (f == null || f.faces.isEmpty) continue;
      try {
        final loader = FontLoader(f.family);
        for (final face in f.faces) {
          loader.addFont(
            http.get(Uri.parse(face.url)).then((r) {
              if (r.statusCode != 200) throw StateError('font ${r.statusCode}');
              return ByteData.sublistView(r.bodyBytes);
            }),
          );
        }
        await loader.load();
      } catch (_) {
        // The default face, then.
      }
    }
  }
}

class BrandFont {
  const BrandFont({required this.family, required this.faces});

  final String family;
  final List<({int weight, String url})> faces;

  static BrandFont? fromJson(Object? j, String Function(String) resolve) {
    if (j is! Map) return null;
    final family = j['family'] as String?;
    if (family == null || family.isEmpty) return null;
    return BrandFont(
      // Prefixed so a venue font called "Roboto" can never collide with the
      // framework's own.
      family: 'venue-$family',
      faces: [
        for (final f in (j['faces'] as List? ?? const []))
          if (f is Map && f['url'] is String)
            (weight: (f['weight'] as num?)?.toInt() ?? 400, url: resolve(f['url'] as String)),
      ],
    );
  }
}
