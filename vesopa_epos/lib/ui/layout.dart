import 'package:flutter/material.dart';

/// How much room the till has to work with.
///
/// The four-column till (nav + basket + grid + categories) only makes sense on
/// a wide screen. A phone cannot show four columns at once at any font size, so
/// below the breakpoint the app reorganises rather than shrinks: one thing at a
/// time, with the basket as a sheet the clerk pulls up.
enum PosLayout { phone, tablet, desktop }

extension PosLayoutX on BuildContext {
  PosLayout get layout {
    final width = MediaQuery.sizeOf(this).width;
    if (width < 600) return PosLayout.phone;
    if (width < 1100) return PosLayout.tablet;
    return PosLayout.desktop;
  }

  bool get isPhone => layout == PosLayout.phone;
  bool get isDesktop => layout == PosLayout.desktop;

  /// Phones and small tablets get a bottom nav / drawer instead of the fixed
  /// left rail, which would otherwise eat a third of the screen.
  bool get useCompactNav => layout != PosLayout.desktop;
}
