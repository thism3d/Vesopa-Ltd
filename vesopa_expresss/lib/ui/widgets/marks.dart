/// The two marks the kiosk draws: its own, and Vesopa's on the sign-in button.
///
/// Painted rather than loaded, like the kitchen's. Three or five straight-edged
/// shapes are sharp at every size, cost no PNG at four densities, and cannot
/// fail to load -- the setup screen is the one screen a kiosk shows before it
/// has ever reached the server, and a broken-image glyph beside its only
/// button is the wrong first impression.
library;

import 'package:flutter/material.dart';

typedef _Pt = (double, double);

/// The Vesopa V, in favicon.svg's own units (0 0 46.35 33.09).
const List<_Pt> _leftArm = [(9.95, 0), (0, 0), (18.01, 33.09), (27.96, 33.09)];
const List<_Pt> _rightTop = [(27.40, 16.54), (37.35, 16.54), (46.35, 0), (36.40, 0)];
const List<_Pt> _wedge = [(27.40, 16.54), (18.39, 33.09), (28.34, 33.09), (37.35, 16.54)];

/// The two speed lines, cut at the V's own slant -- see tool/make_icons.py,
/// which draws the same thing for the app icon.
List<List<_Pt>> _speedLines() {
  const slant = 18.01 / 33.09;
  return [
    for (final (top, height, left, right) in const [
      (9.3, 4.6, -15.5, -2.2),
      (17.8, 4.6, -11.0, 2.5),
    ])
      [
        (left + top * slant, top),
        (right + top * slant, top),
        (right + (top + height) * slant, top + height),
        (left + (top + height) * slant, top + height),
      ],
  ];
}

/// Vesopa Express's mark.
///
/// [tile] draws the paper square behind it, as on the app icon; without it
/// the mark sits on whatever is underneath. [onDark] swaps the ink V for
/// paper, for the dark screens.
class ExpressMark extends StatelessWidget {
  const ExpressMark({super.key, this.size = 48, this.tile = false, this.onDark = false});

  final double size;
  final bool tile;
  final bool onDark;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(painter: _ExpressPainter(tile: tile, onDark: onDark)),
  );
}

class _ExpressPainter extends CustomPainter {
  _ExpressPainter({required this.tile, required this.onDark});

  final bool tile;
  final bool onDark;

  static const _paper = Color(0xFFF6F7F0);
  static const _ink = Color(0xFF10130A);
  static const _lime = Color(0xFFA5C715);

  @override
  void paint(Canvas canvas, Size size) {
    if (tile) {
      canvas.drawRRect(
        RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(size.width * 0.22)),
        Paint()..color = _paper,
      );
    }
    final shapes = <(List<_Pt>, Color)>[
      (_leftArm, onDark && !tile ? _paper : _ink),
      (_rightTop, onDark && !tile ? _paper : _ink),
      (_wedge, _lime),
      for (final bar in _speedLines()) (bar, _lime),
    ];
    final xs = [for (final (p, _) in shapes) for (final (x, _) in p) x];
    final ys = [for (final (p, _) in shapes) for (final (_, y) in p) y];
    final minX = xs.reduce((a, b) => a < b ? a : b);
    final maxX = xs.reduce((a, b) => a > b ? a : b);
    final minY = ys.reduce((a, b) => a < b ? a : b);
    final maxY = ys.reduce((a, b) => a > b ? a : b);
    final w = maxX - minX;
    final h = maxY - minY;
    final k = size.width * (tile ? 0.62 : 0.96) / w;
    final ox = (size.width - w * k) / 2 - minX * k;
    final oy = (size.height - h * k) / 2 - minY * k;
    for (final (poly, colour) in shapes) {
      final path = Path()..moveTo(ox + poly.first.$1 * k, oy + poly.first.$2 * k);
      for (final (x, y) in poly.skip(1)) {
        path.lineTo(ox + x * k, oy + y * k);
      }
      canvas.drawPath(path..close(), Paint()..color = colour);
    }
  }

  @override
  bool shouldRepaint(covariant _ExpressPainter old) => old.tile != tile || old.onDark != onDark;
}

/// Vesopa's own mark, for the Continue with Vesopa button.
///
/// The geometry is vesopa_server/public/assets/vesopa_mark.svg on its 64 x 64
/// grid, the same as the till's and the kitchen's copies -- one button, three
/// products, one appearance.
class VesopaMark extends StatelessWidget {
  const VesopaMark({super.key, this.size = 22});

  final double size;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(painter: _VesopaMarkPainter()),
  );
}

class _VesopaMarkPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final k = size.shortestSide / 64;
    Path shape(List<_Pt> points) {
      final path = Path()..moveTo(points.first.$1 * k, points.first.$2 * k);
      for (final (x, y) in points.skip(1)) {
        path.lineTo(x * k, y * k);
      }
      return path..close();
    }

    canvas.drawCircle(Offset(32 * k, 32 * k), 32 * k, Paint()..color = const Color(0xFF000000));
    canvas.drawPath(
      shape(const [(21.409, 18.750), (13.440, 18.750), (27.864, 45.250), (35.832, 45.250)]),
      Paint()..color = const Color(0xFFFFFFFF),
    );
    canvas.drawPath(
      shape(const [(35.384, 32.004), (43.352, 32.004), (50.560, 18.750), (42.591, 18.750)]),
      Paint()..color = const Color(0xFFFFFFFF),
    );
    canvas.drawPath(
      shape(const [(35.384, 32.004), (28.168, 45.250), (36.136, 45.250), (43.352, 32.004)]),
      Paint()..color = const Color(0xFFA5C715),
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
