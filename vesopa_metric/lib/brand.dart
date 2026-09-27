import 'package:flutter/material.dart';

/// Metric Group's brand: the navy and green of their mark, taken from the logo
/// on metricgroup.co.uk, and their published phone numbers.
///
/// A white-label build for one customer, so the brand is fixed here rather
/// than read from a back office the way a venue's loyalty app reads its own.
class MetricBrand {
  static const appName = 'Metric Membership';
  static const company = 'METRIC Group Ltd';
  static const tagline = 'Your car is your pass.';

  static const navy = Color(0xFF002788);
  static const navyDark = Color(0xFF003D6B);
  static const green = Color(0xFF5BD601);
  static const greenDark = Color(0xFF4A9C1C);
  static const ink = Color(0xFF1F2430);
  static const surface = Color(0xFFF4F6FA);

  static const website = 'https://www.metricgroup.co.uk/';
  static const phone = '01793 647800';
  static const servicePhone = '01793 647871';

  static const logo = 'assets/brand/metric-logo.png';
  static const logoWhite = 'assets/brand/metric-logo-white.png';
  static const icon = 'assets/brand/metric-icon.png';

  static ThemeData theme() {
    final scheme = ColorScheme.fromSeed(
      seedColor: navy,
      primary: navy,
      secondary: greenDark,
      surface: Colors.white,
    );
    final base = ThemeData(colorScheme: scheme, useMaterial3: true, scaffoldBackgroundColor: surface);
    return base.copyWith(
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.white,
        foregroundColor: navy,
        elevation: 0,
        scrolledUnderElevation: 1,
        centerTitle: false,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: navy,
          foregroundColor: Colors.white,
          minimumSize: const Size(48, 52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: navy,
          minimumSize: const Size(48, 52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: greenDark, width: 2),
        ),
      ),
      cardTheme: CardThemeData(
        color: Colors.white,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: Color(0xFFDDE2EC)),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: Colors.white,
        indicatorColor: green.withValues(alpha: 0.25),
        iconTheme: WidgetStateProperty.resolveWith(
          (s) => IconThemeData(color: s.contains(WidgetState.selected) ? navy : const Color(0xFF5D6679)),
        ),
      ),
    );
  }
}
