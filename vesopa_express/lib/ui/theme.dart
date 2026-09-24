/// Vesopa Express's look.
///
/// The Vesopa palette -- lime #A5C715 on ink #10130A -- turned towards the
/// customer. The till and the kitchen are tools and dress like tools; the kiosk
/// is the one Vesopa screen a member of the public touches, so it is light,
/// open and calm, with lime kept for the one thing to press next.
///
/// Two skins: the ordinary one, and High contrast (ink ground, larger type),
/// which a customer can switch on from any screen and which is cleared when
/// their order ends.
library;

import 'package:flutter/material.dart';

class Xp {
  static const paper = Color(0xFFF6F7F0);
  static const card = Color(0xFFFFFFFF);
  static const ink = Color(0xFF10130A);
  static const inkSoft = Color(0xFF3E4535);
  static const muted = Color(0xFF7D8570);
  static const line = Color(0xFFE2E5D6);
  static const lime = Color(0xFFA5C715);
  static const limeDeep = Color(0xFF6E8A0E);
  static const limeSoft = Color(0xFFEFF6D8);
  static const night = Color(0xFF0B0D08);
  static const nightCard = Color(0xFF171B11);
  static const nightLine = Color(0xFF2A3020);
  static const danger = Color(0xFFD93A26);
  static const amber = Color(0xFFF5B301);

  static const sans = 'Montserrat';
  static const numerals = 'Orbitron';

  static const radius = 22.0;
  static const radiusSmall = 16.0;

  /// The colour a label needs on [ground] to be read: ink on light, white on
  /// dark. Decided by luminance, so a venue that sets a dark accent still gets
  /// legible buttons.
  static Color onColor(Color ground) =>
      ground.computeLuminance() > 0.45 ? ink : Colors.white;

  static ThemeData theme({bool contrast = false, Color accent = lime}) {
    final skin = contrast ? XpSkin.highContrast : XpSkin.standard;
    final base = ThemeData(
      useMaterial3: true,
      brightness: contrast ? Brightness.dark : Brightness.light,
      fontFamily: sans,
      scaffoldBackgroundColor: skin.ground,
      colorScheme: ColorScheme.fromSeed(
        seedColor: lime,
        brightness: contrast ? Brightness.dark : Brightness.light,
        primary: accent,
        onPrimary: onColor(accent),
        surface: skin.card,
        onSurface: skin.ink,
      ),
      splashFactory: InkSparkle.splashFactory,
      extensions: [skin],
    );
    final scale = contrast ? 1.12 : 1.0;
    TextStyle t(double size, FontWeight w, [double height = 1.2]) => TextStyle(
      fontFamily: sans,
      fontSize: size * scale,
      fontWeight: w,
      height: height,
      color: skin.ink,
      letterSpacing: -0.2,
    );
    return base.copyWith(
      textTheme: TextTheme(
        displayLarge: t(64, FontWeight.w800, 1.05),
        displayMedium: t(48, FontWeight.w800, 1.08),
        headlineLarge: t(38, FontWeight.w800, 1.1),
        headlineMedium: t(30, FontWeight.w700, 1.15),
        headlineSmall: t(24, FontWeight.w700),
        titleLarge: t(21, FontWeight.w700),
        titleMedium: t(18, FontWeight.w600),
        bodyLarge: t(18, FontWeight.w500, 1.35),
        bodyMedium: t(16, FontWeight.w500, 1.35),
        bodySmall: t(14, FontWeight.w500, 1.35),
        labelLarge: t(18, FontWeight.w700),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: onColor(accent),
          minimumSize: const Size(64, 64),
          padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 18),
          textStyle: t(20, FontWeight.w800),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSmall)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: skin.ink,
          minimumSize: const Size(64, 64),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 18),
          side: BorderSide(color: skin.line, width: 2),
          textStyle: t(18, FontWeight.w700),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSmall)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: skin.inkSoft,
          minimumSize: const Size(48, 56),
          textStyle: t(17, FontWeight.w700),
        ),
      ),
    );
  }
}

/// The colours that change between the two skins.
@immutable
class XpSkin extends ThemeExtension<XpSkin> {
  const XpSkin({
    required this.ground,
    required this.card,
    required this.ink,
    required this.inkSoft,
    required this.muted,
    required this.line,
    required this.chip,
    required this.contrast,
  });

  final Color ground;
  final Color card;
  final Color ink;
  final Color inkSoft;
  final Color muted;
  final Color line;
  final Color chip;
  final bool contrast;

  static const standard = XpSkin(
    ground: Xp.paper,
    card: Xp.card,
    ink: Xp.ink,
    inkSoft: Xp.inkSoft,
    muted: Xp.muted,
    line: Xp.line,
    chip: Xp.limeSoft,
    contrast: false,
  );

  static const highContrast = XpSkin(
    ground: Xp.night,
    card: Xp.nightCard,
    ink: Colors.white,
    inkSoft: Color(0xFFE4E8DA),
    muted: Color(0xFFC3CAB4),
    line: Color(0xFF59624A),
    chip: Color(0xFF2A3319),
    contrast: true,
  );

  static XpSkin of(BuildContext context) =>
      Theme.of(context).extension<XpSkin>() ?? standard;

  @override
  XpSkin copyWith() => this;

  @override
  XpSkin lerp(ThemeExtension<XpSkin>? other, double t) =>
      other is XpSkin && t > 0.5 ? other : this;
}
