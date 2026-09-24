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

  /// A square panel: 4:3, 5:4, and the 1024x768 tills a lot of venues still run.
  ///
  /// Width alone cannot tell these apart from a laptop. 1024x768 and 1024x600
  /// are the same [PosLayout] and want different things, because the square one
  /// has to fit the same four columns across a screen that is spending its
  /// pixels on height instead.
  bool get isSquarish {
    final size = MediaQuery.sizeOf(this);
    return size.height > 0 && size.width / size.height < 1.5;
  }

  /// How wide the check view may be.
  ///
  /// This was a hardcoded 420px, which is a fifth of a 1920px till and *two
  /// fifths* of a 1024px one — so the venues on square panels were paying for a
  /// number chosen on a widescreen, and said so: "the check view is way too big
  /// and not much room for buttons".
  ///
  /// A share rather than a constant, and a smaller share when the panel is
  /// square, because that is the case with the least width to give away. The
  /// 420 ceiling means nothing changes at all on the wide tills this was tuned
  /// for — a 16:9 screen is over the cap from 1313px up — so this can only make
  /// the check narrower on the screens that were complaining.
  ///
  /// The floor is 280px. Below that the check stops being readable across a
  /// counter, and a till that small should be running the phone layout anyway.
  double get checkWidth {
    final size = MediaQuery.sizeOf(this);
    final share = isSquarish ? 0.28 : 0.32;
    return (size.width * share).clamp(280.0, 420.0);
  }
}
