import 'package:flutter/widgets.dart';

/// How big the whole screen is drawn, for kitchen screens on TVs (2026-10-17).
///
/// Meirion: "Can we put the option of zooming in or the possibility of making
/// the kitchen screen larger please", and the screen is a TV across the
/// kitchen, not a touch panel at arm's length. The back office and the till
/// choose a preset; this turns it into a scale.
///
/// A preset is the width the board is laid out at, in the logical pixels
/// Flutter is given (the panel's pixels divided by Windows' display scale).
/// Laying out at a fixed width and stretching to fill the panel is what makes
/// a preset resolution independent: a 55" TV at 4K and a 55" TV at HD both
/// draw the board as if it were 1280 wide, so a ticket is the same physical
/// size on either, and fewer, larger cards fit across.
class BoardScale {
  const BoardScale._();

  /// The presets the server knows, in order, with what the till and the
  /// settings panel call them.
  static const presets = <String, String>{
    'auto': 'Auto',
    'monitor': 'Monitor (up to 27")',
    'tv32': '32" TV',
    'tv43': '43" TV',
    'tv55': '50-55" TV',
    'tv65': '65" TV',
    'tv75': '75" TV',
    'tv100': '85-100" TV',
  };

  /// The layout width for a preset. Null means "draw at the panel's own size".
  static double? _layoutWidth(String preset) => switch (preset) {
    'tv32' => 1600,
    'tv43' => 1440,
    'tv55' => 1280,
    'tv65' => 1150,
    'tv75' => 1024,
    'tv100' => 860,
    _ => null,
  };

  /// The scale for [preset] on a panel [width] logical pixels wide, with the
  /// venue's [zoomPercent] and this machine's [nudgePercent] on top.
  ///
  /// Auto leaves every screen up to 1920 wide exactly as it always was, and
  /// only enlarges a panel wider than that -- a 4K TV left at 100% scaling,
  /// where an unscaled board is a postage stamp in the middle of a wall.
  static double of({
    required String preset,
    required double width,
    int zoomPercent = 100,
    int nudgePercent = 100,
  }) {
    if (!width.isFinite || width <= 0) return 1;
    double base;
    final target = _layoutWidth(preset);
    if (target != null) {
      base = width / target;
    } else if (preset == 'auto') {
      base = width > 1920 ? width / 1920 : 1;
    } else {
      base = 1;
    }
    final scale = base * (zoomPercent / 100) * (nudgePercent / 100);
    return scale.clamp(0.5, 5.0);
  }
}

/// Draws [child] at [scale]: laid out in a smaller (or larger) box and
/// stretched to fill the screen, so text, cards, dialogs and taps all scale
/// together and stay crisp (it is a transform, not a bitmap).
class ScaledBoard extends StatelessWidget {
  const ScaledBoard({super.key, required this.scale, required this.child});

  final double scale;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if ((scale - 1).abs() < 0.01) return child;
    return LayoutBuilder(
      builder: (context, box) {
        if (!box.hasBoundedWidth || !box.hasBoundedHeight) return child;
        final size = Size(box.maxWidth / scale, box.maxHeight / scale);
        final media = MediaQuery.of(context);
        return FittedBox(
          fit: BoxFit.fill,
          alignment: Alignment.topLeft,
          child: SizedBox.fromSize(
            size: size,
            child: MediaQuery(
              data: media.copyWith(
                size: size,
                padding: media.padding / scale,
                viewPadding: media.viewPadding / scale,
                viewInsets: media.viewInsets / scale,
              ),
              child: child,
            ),
          ),
        );
      },
    );
  }
}
