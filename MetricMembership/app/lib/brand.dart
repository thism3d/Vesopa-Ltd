import 'package:flutter/material.dart';

/// Metric Group's brand and the app's design tokens (MetricMembership/DESIGN.md).
///
/// Navy carries the product; green is a signal (open, recognised, active) and
/// only sits on navy, or as `green700` on white where it must pass contrast.
/// The staff console uses the same values (server/public/admin/admin.css).
class MetricBrand {
  static const appName = 'Metric Membership';
  static const company = 'METRIC Group Ltd';
  static const tagline = 'Your car is your pass.';

  static const navy900 = Color(0xFF00144D);
  static const navy = Color(0xFF002788);
  static const navy600 = Color(0xFF1D3FA8);
  static const navy50 = Color(0xFFEEF2FB);
  static const green = Color(0xFF5BD601);
  static const green700 = Color(0xFF2F7A00);
  static const green50 = Color(0xFFEEFBE3);
  static const ink = Color(0xFF0B1530);
  static const slate = Color(0xFF4A5670);
  static const muted = Color(0xFF8792A8);
  static const line = Color(0xFFE4E9F2);
  static const canvas = Color(0xFFF5F7FB);
  static const amber = Color(0xFFB45309);
  static const amber50 = Color(0xFFFFF6E5);
  static const red = Color(0xFFC62828);
  static const red50 = Color(0xFFFDECEC);

  // Older names, kept so nothing else has to change at once.
  static const navyDark = navy900;
  static const greenDark = green700;
  static const surface = canvas;

  static const font = 'Jakarta';

  static const heroGradient = LinearGradient(
    colors: [navy900, navy, navy600],
    stops: [0, 0.55, 1],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  static const shadowMd = [BoxShadow(color: Color(0x1A002788), blurRadius: 24, offset: Offset(0, 8))];
  static const shadowLg = [BoxShadow(color: Color(0x2E002788), blurRadius: 40, offset: Offset(0, 18))];

  static const website = 'https://www.metricgroup.co.uk/';
  static const privacyPolicy = 'https://metricgroup.co.uk/privacy-policy/';
  static const phone = '01793 647800';
  static const servicePhone = '01793 647871';

  static const logo = 'assets/brand/metric-logo.png';
  static const logoWhite = 'assets/brand/metric-logo-white.png';
  static const icon = 'assets/brand/metric-icon.png';

  static ThemeData theme() {
    final scheme = ColorScheme.fromSeed(
      seedColor: navy,
      primary: navy,
      onPrimary: Colors.white,
      secondary: green700,
      surface: Colors.white,
      onSurface: ink,
      error: red,
    );
    final base = ThemeData(colorScheme: scheme, useMaterial3: true, scaffoldBackgroundColor: canvas, fontFamily: font);
    final t = base.textTheme.apply(fontFamily: font).copyWith();
    return base.copyWith(
      textTheme: t.copyWith(
        headlineMedium: t.headlineMedium?.copyWith(fontSize: 30, height: 1.15, fontWeight: FontWeight.w800, letterSpacing: -0.5, color: ink),
        headlineSmall: t.headlineSmall?.copyWith(fontSize: 24, height: 1.2, fontWeight: FontWeight.w800, letterSpacing: -0.3, color: ink),
        titleLarge: t.titleLarge?.copyWith(letterSpacing: 0, fontSize: 18, height: 1.3, fontWeight: FontWeight.w700, color: ink),
        labelLarge: t.labelLarge?.copyWith(letterSpacing: 0),
        titleMedium: t.titleMedium?.copyWith(letterSpacing: 0, fontSize: 16, height: 1.35, fontWeight: FontWeight.w700, color: ink),
        bodyLarge: t.bodyLarge?.copyWith(letterSpacing: 0, fontSize: 15.5, height: 1.5, color: slate),
        bodyMedium: t.bodyMedium?.copyWith(letterSpacing: 0, fontSize: 14.5, height: 1.5, color: slate),
        bodySmall: t.bodySmall?.copyWith(letterSpacing: 0, fontSize: 13, height: 1.45, fontWeight: FontWeight.w500, color: muted),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: canvas,
        foregroundColor: navy,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: true,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: navy,
          foregroundColor: Colors.white,
          disabledBackgroundColor: line,
          disabledForegroundColor: muted,
          minimumSize: const Size(48, 54),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          textStyle: const TextStyle(fontFamily: font, fontWeight: FontWeight.w700, fontSize: 15.5),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: navy,
          backgroundColor: Colors.white,
          side: const BorderSide(color: line),
          minimumSize: const Size(48, 50),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          textStyle: const TextStyle(fontFamily: font, fontWeight: FontWeight.w700, fontSize: 15),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: navy,
          textStyle: const TextStyle(fontFamily: font, fontWeight: FontWeight.w700),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: line)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: line)),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: navy, width: 2),
        ),
        labelStyle: const TextStyle(color: slate),
      ),
      cardTheme: CardThemeData(
        color: Colors.white,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: const BorderSide(color: line),
        ),
      ),
      listTileTheme: const ListTileThemeData(
        titleTextStyle: TextStyle(fontFamily: font, fontSize: 15, fontWeight: FontWeight.w700, color: ink),
        subtitleTextStyle: TextStyle(fontFamily: font, fontSize: 13.5, height: 1.45, color: slate),
      ),
      dividerTheme: const DividerThemeData(color: line, space: 1, thickness: 1),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: ink,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        height: 70,
        indicatorColor: navy50,
        labelTextStyle: WidgetStateProperty.resolveWith(
          (s) => TextStyle(
            fontFamily: font,
            fontSize: 12,
            fontWeight: s.contains(WidgetState.selected) ? FontWeight.w800 : FontWeight.w600,
            color: s.contains(WidgetState.selected) ? navy : muted,
          ),
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (s) => IconThemeData(color: s.contains(WidgetState.selected) ? navy : muted),
        ),
      ),
    );
  }
}
