/// How the customer display looks.
///
/// Dark, always, and that is not a preference. This screen faces a customer
/// across a counter, often under downlights and often at an angle, and a white
/// panel at that distance is a lamp pointed at somebody's face. It is also the
/// half of the screen sitting next to a full-brightness advert, where a light
/// panel makes the advert look washed out and the bill look like a browser.
///
/// The type is large for the same reason. Every figure on here is read from
/// three or four feet away by somebody who is not wearing their glasses, so the
/// total is set at a size that would be absurd on a till and is barely enough
/// here.
library;

import 'package:flutter/material.dart';

class Brand {
  /// The till's own lime. Shared deliberately: a customer looking at the
  /// display and then at the receipt should be looking at one company.
  static const lime = Color(0xFFA5C715);
  static const onLime = Color(0xFF10130A);

  /// The panel behind the bill. Nearly black rather than black, so the line
  /// separators have something to be lighter than.
  static const panel = Color(0xFF14161A);
  static const panelSoft = Color(0xFF1E2127);
  static const ink = Color(0xFFF2F4F0);
  static const inkSoft = Color(0xFF9AA0A6);
  static const line = Color(0xFF2C3038);
}

ThemeData buildDisplayTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: Brand.lime,
    brightness: Brightness.dark,
  ).copyWith(
    primary: Brand.lime,
    onPrimary: Brand.onLime,
    surface: Brand.panel,
    onSurface: Brand.ink,
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: Brand.panel,
    // Tabular figures throughout. A column of prices whose decimal points do
    // not line up is a column nobody can scan, and this one is being scanned by
    // somebody checking their own bill.
    textTheme: const TextTheme().apply(
      bodyColor: Brand.ink,
      displayColor: Brand.ink,
    ),
    dividerColor: Brand.line,
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Brand.lime,
        foregroundColor: Brand.onLime,
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 16),
      ),
    ),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(),
      filled: true,
      fillColor: Brand.panelSoft,
    ),
  );
}

/// The one place money is turned into words, so every figure on the screen is
/// formatted the same way.
String money(int minor) {
  final negative = minor < 0;
  final pounds = (negative ? -minor : minor) / 100;
  return '${negative ? '-' : ''}£${pounds.toStringAsFixed(2)}';
}
