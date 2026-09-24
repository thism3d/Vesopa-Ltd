/// The Vesopa mark, drawn rather than loaded.
///
/// "(Vesopa icon) Continue with Vesopa" — the button the owner asked for carries
/// the brand's own mark, not a generic "opens a browser" arrow, which is what
/// it wore before.
///
/// WHY A PAINTER AND NOT AN ASSET
///
/// The mark is three straight-edged shapes: two white strokes forming a V and
/// a lime one cutting through it. Painted, it is sharp at 18 points on a
/// handheld and at 96 on a counter till, it costs no PNG in the bundle at four
/// densities, and — the part that matters on a sign-in screen — it cannot fail
/// to load. A missing asset on the one screen a terminal shows before it is
/// commissioned would leave a broken-image glyph beside the only button on it.
///
/// The geometry is `vesopa_server/public/assets/vesopa_mark.svg`, verbatim, on
/// its own 64×64 viewBox. Keep the two in step: this is the same mark the back
/// office draws beside the same words.
library;

import 'package:flutter/material.dart';

/// Vesopa's mark, at [size] points square.
class VesopaMark extends StatelessWidget {
  const VesopaMark({super.key, this.size = 20});

  final double size;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(painter: _VesopaMarkPainter()),
  );
}

class _VesopaMarkPainter extends CustomPainter {
  /// The mark is authored on a 64×64 grid; everything below is scaled from it.
  static const _grid = 64.0;

  static const _black = Color(0xFF000000);
  static const _white = Color(0xFFFFFFFF);
  static const _lime = Color(0xFFA5C715);

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.shortestSide / _grid;
    Offset at(double x, double y) => Offset(x * k, y * k);

    Path shape(List<(double, double)> points) {
      final path = Path()..moveTo(at(points.first.$1, points.first.$2).dx,
          at(points.first.$1, points.first.$2).dy);
      for (final (x, y) in points.skip(1)) {
        path.lineTo(at(x, y).dx, at(x, y).dy);
      }
      return path..close();
    }

    canvas.drawCircle(
      at(32, 32),
      32 * k,
      Paint()..color = _black,
    );

    // The left stroke of the V.
    canvas.drawPath(
      shape([(21.409, 18.750), (13.440, 18.750), (27.864, 45.250), (35.832, 45.250)]),
      Paint()..color = _white,
    );
    // The right stroke, above the cut.
    canvas.drawPath(
      shape([(35.384, 32.004), (43.352, 32.004), (50.560, 18.750), (42.591, 18.750)]),
      Paint()..color = _white,
    );
    // The lime cut through it, which is the whole of the brand.
    canvas.drawPath(
      shape([(35.384, 32.004), (28.168, 45.250), (36.136, 45.250), (43.352, 32.004)]),
      Paint()..color = _lime,
    );
  }

  /// Nothing about the mark depends on anything, so it never needs repainting.
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
