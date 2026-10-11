import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../platform/page_venue.dart';
import 'brand.dart';

/// A venue app's own look: its club colours, its own typeface, the device's
/// light or dark mode, and colour that moves.
///
/// ONLY IN A VENUE'S OWN BUILD, OR ITS OWN PAGE. tool/make_venue_app.py
/// passes the venue's colours (venue.json) as dart-defines and bundles its
/// typeface as the "VenueFont" family. In a browser the server writes the
/// colours into the page for a venue with a look (venue_looks.js) and sends
/// its typeface as the venue's font; the shared Store app and every other
/// venue's page look exactly as they always did.
///
/// WHY THE BUILD'S COLOURS WIN OVER THE BACK OFFICE'S HERE: the store
/// listing, the icon and the splash are all drawn in venue.json's colours, and
/// a back office set up for the web page (Pontardawe RFC's is black buttons on
/// red) turns to black on near-black in dark mode. The app is the club's, so
/// it is the club's palette, in both modes.
class VenueStyle {
  static const _bgDefine = String.fromEnvironment('VENUE_SPLASH_BG');
  static const _font = String.fromEnvironment('VENUE_FONT');

  /// In a browser, the look the server wrote into the page for a venue that
  /// has one (vesopa_server/src/venue_looks.js): the club's members' site
  /// looks like the club's app. Every other venue's page has none.
  static final List<String>? _page = kIsWeb ? pageLook() : null;

  static String get _bg => _page?[0] ?? _bgDefine;
  static String get _deep => _page?[1] ?? const String.fromEnvironment('VENUE_SPLASH_DEEP');
  static String get _glow => _page?[2] ?? const String.fromEnvironment('VENUE_SPLASH_GLOW');

  /// A venue build with a look of its own, or a venue's page that has one.
  static final bool enabled = kIsWeb ? _page != null : _bgDefine != '';

  static Color _colour(String hex, Color fallback) {
    final v = int.tryParse(hex.replaceFirst('#', ''), radix: 16);
    return v == null ? fallback : Color(0xFF000000 | v);
  }

  /// The club colour, its deep shade and its bright one.
  static final Color club = _colour(_bg, const Color(0xFF8F0000));
  static final Color deep = _colour(_deep, Color.lerp(club, Colors.black, 0.55)!);
  static final Color glow = _colour(_glow, Color.lerp(club, Colors.white, 0.15)!);

  /// The club colour for the device's mode: a bright red reads on near-black
  /// where the deep club red sinks into it.
  static Color clubFor(Brightness b) => b == Brightness.dark ? Color.lerp(club, glow, 0.65)! : club;

  /// The venue in its own palette, before light or dark is chosen.
  static Brand apply(Brand brand) {
    if (!enabled) return brand;
    return brand.recoloured(
      primary: club,
      accent: glow,
      iconTint: club,
      font: _font.isEmpty ? null : const BrandFont(family: _font, faces: []),
    );
  }

  /// The venue's shades for the device's light or dark mode.
  ///
  /// Light is a warm paper white with the club colour in it; dark is near
  /// black with the club colour in it. Neither is grey: both are the club's.
  static Brand forBrightness(Brand brand, Brightness b) {
    if (b == Brightness.dark) {
      return brand.recoloured(
        primary: clubFor(b),
        background: Color.lerp(const Color(0xFF0B0909), club, 0.10)!,
        text: const Color(0xFFF7F1F0),
        iconTint: Color.lerp(glow, Colors.white, 0.25),
      );
    }
    return brand.recoloured(
      background: Color.lerp(const Color(0xFFFFFCFA), club, 0.035)!,
      text: Color.lerp(const Color(0xFF17100F), club, 0.08)!,
    );
  }
}

/// Club colour that drifts: three soft lights moving slowly over the club's
/// deep shade, never the same picture twice in a minute.
///
/// Behind the sign-in page, the bar along the top and the membership card.
/// It costs one repaint of a gradient per frame and stands still where the
/// device asks for less motion.
class ClubGradient extends StatefulWidget {
  const ClubGradient({super.key, this.child, this.radius = BorderRadius.zero, this.intensity = 1});

  final Widget? child;
  final BorderRadius radius;

  /// 0..1, how bright the lights are. The card wants all of it; the bar less.
  final double intensity;

  @override
  State<ClubGradient> createState() => _ClubGradientState();
}

class _ClubGradientState extends State<ClubGradient> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 24));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (still) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: widget.radius,
    child: CustomPaint(
      painter: _ClubPainter(_c, widget.intensity, Theme.of(context).brightness),
      // Without a child a CustomPaint is no size at all: fill the space.
      child: widget.child ?? const SizedBox.expand(),
    ),
  );
}

class _ClubPainter extends CustomPainter {
  _ClubPainter(this.t, this.intensity, this.brightness) : super(repaint: t);

  final Animation<double> t;
  final double intensity;
  final Brightness brightness;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final a = t.value * 2 * math.pi;
    final dark = brightness == Brightness.dark;
    final base = dark ? Color.lerp(VenueStyle.deep, Colors.black, 0.35)! : VenueStyle.deep;
    canvas.drawRect(
      rect,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment(math.cos(a) * 0.6 - 0.4, -1),
          end: Alignment(math.sin(a) * 0.6 + 0.4, 1),
          colors: [VenueStyle.club, base],
        ).createShader(rect),
    );
    // Three lights, each on its own slow orbit; the hue of the brightest
    // turns a little warmer and back as it goes.
    final lights = [
      (Offset(0.2 + 0.25 * math.cos(a), 0.25 + 0.2 * math.sin(a * 2)), VenueStyle.glow, 0.85),
      (Offset(0.8 + 0.2 * math.sin(a + 1.3), 0.7 + 0.25 * math.cos(a + 0.4)), Color.lerp(VenueStyle.glow, const Color(0xFFFF6A3D), 0.5 + 0.5 * math.sin(a))!, 0.55),
      (Offset(0.5 + 0.35 * math.sin(a * 2 + 2), 1.0 + 0.15 * math.cos(a)), VenueStyle.club, 0.7),
    ];
    final r = math.max(size.width, size.height) * 0.75;
    for (final (c, colour, strength) in lights) {
      final centre = Offset(size.width * c.dx, size.height * c.dy);
      canvas.drawCircle(
        centre,
        r,
        Paint()
          ..shader = RadialGradient(
            colors: [colour.withValues(alpha: strength * intensity * (dark ? 0.6 : 0.75)), colour.withValues(alpha: 0)],
          ).createShader(Rect.fromCircle(center: centre, radius: r)),
      );
    }
  }

  @override
  bool shouldRepaint(_ClubPainter old) => old.intensity != intensity || old.brightness != brightness;
}
