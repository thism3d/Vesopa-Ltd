/// The mark Apple asks for on a Tap to Pay on iPhone button (Human Interface
/// Guidelines: the wave.3.right.circle or wave.3.right.circle.fill symbol;
/// never the Apple logo). Flutter has no SF Symbols, so it is drawn: three
/// waves opening to the right inside a filled circle.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

class TapToPayMark extends StatelessWidget {
  const TapToPayMark({super.key, this.size = 22, this.color});
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = color ?? IconTheme.of(context).color ?? DefaultTextStyle.of(context).style.color ?? Colors.white;
    return Semantics(
      label: 'Tap to Pay',
      child: SizedBox(width: size, height: size, child: CustomPaint(painter: _Waves(c))),
    );
  }
}

class _Waves extends CustomPainter {
  _Waves(this.c);
  final Color c;

  @override
  void paint(Canvas canvas, Size size) {
    // wave.3.right.circle: a ring and three waves opening to the right, drawn
    // in the one colour (2026-11-04: the filled version cut its waves out
    // with a clear blend, which some renderers ignore, leaving a plain disc).
    final r = size.width / 2;
    final centre = Offset(r, r);
    final line = Paint()
      ..color = c
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = size.width * 0.08;
    canvas.drawCircle(centre, r - line.strokeWidth / 2, line);
    final origin = Offset(r * 0.62, r);
    for (final k in [0.22, 0.42, 0.62]) {
      canvas.drawArc(Rect.fromCircle(center: origin, radius: r * k), -math.pi / 3.4, math.pi / 1.7, false, line);
    }
  }

  @override
  bool shouldRepaint(_Waves old) => old.c != c;
}
