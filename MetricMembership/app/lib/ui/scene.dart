import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../brand.dart';

/// The moving picture on the entry screen: a Metric car park at dusk.
///
/// A car drives up to the barrier, the ANPR camera reads its plate, a
/// "Member recognised" tick pops up, the arm lifts and the car drives through.
/// Traffic passes on the far lane and people walk along the pavement. It is
/// the whole product in eight seconds, so a new member understands it before
/// reading a word.
///
/// Drawn in code rather than shipped as video: it is sharp at any size, costs
/// nothing to download, and follows the brand colours. With reduced motion
/// switched on it holds still on the moment the barrier opens.
class CarParkScene extends StatefulWidget {
  const CarParkScene({super.key, this.plate = 'MG24 PAS'});

  final String plate;

  @override
  State<CarParkScene> createState() => _CarParkSceneState();
}

class _CarParkSceneState extends State<CarParkScene> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: _cycleMs));

  static const _cycleMs = 8000;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.of(context).disableAnimations) {
      _c.stop();
      _c.value = 3.4 / 8;
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: AnimatedBuilder(
      animation: _c,
      builder: (context, _) => CustomPaint(
        painter: _ScenePainter(t: _c.value * 8, plate: widget.plate),
        size: Size.infinite,
      ),
    ),
  );
}

double _ease(double x) => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

double _seg(double t, double a, double b) => ((t - a) / (b - a)).clamp(0.0, 1.0);

class _ScenePainter extends CustomPainter {
  _ScenePainter({required this.t, required this.plate});

  /// Seconds into the eight-second loop.
  final double t;
  final String plate;

  static const _roadTop = 0.58;
  static const _roadBottom = 0.82;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    _sky(canvas, size);
    _skyline(canvas, size);
    _building(canvas, size);

    // The far lane: traffic that passes by, smaller and dimmer.
    final farY = h * (_roadTop + 0.035);
    canvas.drawRect(Rect.fromLTWH(0, h * _roadTop, w, h * (_roadBottom - _roadTop)), Paint()..color = const Color(0xFF0A1740));
    final dash = Paint()..color = Colors.white.withValues(alpha: 0.22);
    final dashY = h * (_roadTop + 0.085);
    for (double x = -((t * 30) % 40); x < w; x += 40) {
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(x, dashY, 20, 2.5), const Radius.circular(2)), dash);
    }
    final farScale = h * 0.0016;
    for (var i = 0; i < 2; i++) {
      final p = ((t / 8) + i * 0.5) % 1.0;
      final x = w * (1.15 - p * 1.4);
      _car(canvas, Offset(x, farY), farScale, i == 0 ? const Color(0xFF8A96B8) : const Color(0xFF4F6BD8), facingRight: false, dim: true);
    }

    // The entry lane and its bay markings.
    final laneY = h * (_roadTop + 0.155);
    final gateX = w * 0.64;

    // The member's car: drive in, stop, be read, drive through.
    final scale = h * 0.0026;
    final carLen = 150 * scale;
    final stopX = gateX - 14 - carLen / 2 - 10 * scale;
    double carX;
    if (t < 2.2) {
      carX = -carLen + (stopX + carLen) * Curves.easeOutCubic.transform(_seg(t, 0, 2.2));
    } else if (t < 3.7) {
      carX = stopX;
    } else {
      carX = stopX + (w + carLen - stopX) * Curves.easeInCubic.transform(_seg(t, 3.7, 6.0));
    }
    final carDriving = t < 2.2 || (t > 3.7 && t < 6.0);

    // The arm: up after the read, down once the car is through.
    final lift = t < 3.0 ? 0.0 : t < 3.6 ? _ease(_seg(t, 3.0, 3.6)) : t < 5.6 ? 1.0 : 1 - _ease(_seg(t, 5.6, 6.3));

    // The ANPR camera stands just past the barrier, looking back at the
    // front plate of the car waiting at it.
    final camX = gateX + 34 * scale;
    final reading = t > 1.9 && t < 3.3;
    _camera(canvas, Offset(camX, laneY - 92 * scale), scale, reading, Offset(carX + carLen / 2 - 4 * scale, laneY - 6 * scale));

    _car(canvas, Offset(carX, laneY), scale, MetricBrand.green, facingRight: true, plate: plate, driving: carDriving, t: t);
    _barrier(canvas, Offset(gateX, laneY + 2 * scale), scale, lift);

    // The recognised badge.
    final pop = t < 2.5 ? 0.0 : t < 2.8 ? Curves.easeOutBack.transform(_seg(t, 2.5, 2.8)) : t < 4.6 ? 1.0 : 1 - _seg(t, 4.6, 4.9);
    if (pop > 0) _badge(canvas, Offset(stopX, laneY - 70 * scale), scale, pop);

    // Pavement and people.
    final paveTop = h * _roadBottom;
    canvas.drawRect(Rect.fromLTWH(0, paveTop, w, h - paveTop), Paint()..color = const Color(0xFF14286B));
    canvas.drawRect(Rect.fromLTWH(0, paveTop, w, 3), Paint()..color = Colors.white.withValues(alpha: 0.18));
    const walkers = [(0.0, 1.0, Color(0xFFFFFFFF)), (0.37, 0.8, Color(0xFFB9C6F2)), (0.71, 1.15, MetricBrand.green)];
    for (final (offset, speed, colour) in walkers) {
      final p = ((t / 8) * speed + offset) % 1.0;
      final goingRight = offset != 0.37;
      final x = goingRight ? w * (-0.05 + p * 1.1) : w * (1.05 - p * 1.1);
      _person(canvas, Offset(x, paveTop + (h - paveTop) * 0.5), h * 0.0019, colour, t * 6 * speed + offset * 10, goingRight);
    }
  }

  void _sky(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    canvas.drawRect(
      rect,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [MetricBrand.navy900, MetricBrand.navy, MetricBrand.navy600],
          stops: [0, 0.55, 1],
        ).createShader(rect),
    );
    // A soft green glow behind the gate, the brand's light.
    canvas.drawCircle(
      Offset(size.width * 0.64, size.height * 0.55),
      size.width * 0.45,
      Paint()
        ..shader = RadialGradient(
          colors: [MetricBrand.green.withValues(alpha: 0.18), MetricBrand.green.withValues(alpha: 0)],
        ).createShader(Rect.fromCircle(center: Offset(size.width * 0.64, size.height * 0.55), radius: size.width * 0.45)),
    );
    // Stars that breathe.
    final rnd = math.Random(7);
    for (var i = 0; i < 38; i++) {
      final x = rnd.nextDouble() * size.width;
      final y = rnd.nextDouble() * size.height * 0.4;
      final a = 0.25 + 0.35 * (0.5 + 0.5 * math.sin(t * 1.6 + i));
      canvas.drawCircle(Offset(x, y), rnd.nextDouble() * 1.2 + 0.4, Paint()..color = Colors.white.withValues(alpha: a));
    }
  }

  void _skyline(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final base = h * _roadTop;
    final rnd = math.Random(3);
    final far = Paint()..color = const Color(0xFF123090);
    double x = -10;
    while (x < w) {
      final bw = 26 + rnd.nextDouble() * 46;
      final bh = h * (0.12 + rnd.nextDouble() * 0.22);
      canvas.drawRect(Rect.fromLTWH(x, base - bh, bw, bh), far);
      final lit = Paint()..color = const Color(0xFFFFE9A8).withValues(alpha: 0.55);
      for (double wy = base - bh + 8; wy < base - 10; wy += 11) {
        for (double wx = x + 5; wx < x + bw - 6; wx += 9) {
          if (rnd.nextDouble() < 0.22) canvas.drawRect(Rect.fromLTWH(wx, wy, 4, 5), lit);
        }
      }
      x += bw + 4 + rnd.nextDouble() * 8;
    }
  }

  /// The car park building with a Metric "P" sign.
  void _building(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final base = h * _roadTop;
    final left = w * 0.7, top = base - h * 0.3;
    final rect = Rect.fromLTRB(left, top, w + 4, base);
    canvas.drawRect(rect, Paint()..color = const Color(0xFF0E2575));
    final deck = Paint()..color = Colors.white.withValues(alpha: 0.1);
    for (var i = 1; i < 4; i++) {
      final y = top + (base - top) * i / 4;
      canvas.drawRect(Rect.fromLTWH(left, y - 2, w - left + 4, 4), deck);
    }
    final signC = Offset(left + 26, top + 24);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: signC, width: 30, height: 30), const Radius.circular(7)), Paint()..color = MetricBrand.green);
    _text(canvas, 'P', signC, 20, MetricBrand.navy, FontWeight.w900);
  }

  void _camera(Canvas canvas, Offset head, double s, bool reading, Offset target) {
    final pole = Paint()..color = const Color(0xFFCBD5F0);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(head.dx - 2.5 * s, head.dy, 5 * s, 92 * s), Radius.circular(2 * s)), pole);
    if (reading) {
      final pulse = 0.55 + 0.45 * math.sin(t * 18);
      final beam = Path()
        ..moveTo(head.dx - 6 * s, head.dy + 4 * s)
        ..lineTo(target.dx - 16 * s, target.dy + 8 * s)
        ..lineTo(target.dx + 16 * s, target.dy + 8 * s)
        ..close();
      canvas.drawPath(
        beam,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [MetricBrand.green.withValues(alpha: 0.7 * pulse), MetricBrand.green.withValues(alpha: 0.05)],
          ).createShader(beam.getBounds()),
      );
      // Scan line sweeping the plate.
      final sweep = (t * 2.4) % 1.0;
      canvas.drawLine(
        Offset(target.dx - 14 * s, target.dy - 6 * s + sweep * 14 * s),
        Offset(target.dx + 14 * s, target.dy - 6 * s + sweep * 14 * s),
        Paint()
          ..color = MetricBrand.green
          ..strokeWidth = 1.6 * s,
      );
    }
    final body = RRect.fromRectAndRadius(Rect.fromCenter(center: head.translate(-8 * s, 0), width: 30 * s, height: 14 * s), Radius.circular(4 * s));
    canvas.drawRRect(body, Paint()..color = Colors.white);
    canvas.drawCircle(head.translate(-20 * s, 0), 4 * s, Paint()..color = MetricBrand.navy);
    canvas.drawCircle(head.translate(4 * s, -4 * s), 2 * s, Paint()..color = reading ? MetricBrand.green : const Color(0xFFFF5A5A));
  }

  void _barrier(Canvas canvas, Offset base, double s, double lift) {
    final housing = RRect.fromRectAndRadius(Rect.fromLTWH(base.dx - 10 * s, base.dy - 46 * s, 20 * s, 46 * s), Radius.circular(4 * s));
    canvas.drawRRect(housing, Paint()..color = Colors.white);
    canvas.drawRect(Rect.fromLTWH(base.dx - 10 * s, base.dy - 34 * s, 20 * s, 5 * s), Paint()..color = MetricBrand.green);
    // Signal light: red, green once open.
    canvas.drawCircle(Offset(base.dx, base.dy - 40 * s), 3 * s, Paint()..color = lift > 0.5 ? MetricBrand.green : const Color(0xFFFF5A5A));

    canvas.save();
    canvas.translate(base.dx, base.dy - 30 * s);
    canvas.rotate(math.pi + lift * math.pi * 0.46);
    final len = 120 * s;
    final arm = RRect.fromRectAndRadius(Rect.fromLTWH(0, -3.5 * s, len, 7 * s), Radius.circular(3.5 * s));
    canvas.drawRRect(arm, Paint()..color = Colors.white);
    final stripe = Paint()..color = MetricBrand.navy;
    for (double x = 14 * s; x < len - 6 * s; x += 22 * s) {
      canvas.drawRect(Rect.fromLTWH(x, -3.5 * s, 10 * s, 7 * s), stripe);
    }
    canvas.restore();
    canvas.drawCircle(Offset(base.dx, base.dy - 30 * s), 4.5 * s, Paint()..color = const Color(0xFF9AA8D6));
  }

  void _car(
    Canvas canvas,
    Offset centre,
    double s,
    Color colour, {
    required bool facingRight,
    String? plate,
    bool driving = true,
    bool dim = false,
    double t = 0,
  }) {
    canvas.save();
    canvas.translate(centre.dx, centre.dy);
    if (!facingRight) canvas.scale(-1, 1);

    // Shadow.
    canvas.drawOval(Rect.fromCenter(center: Offset(0, 22 * s), width: 150 * s, height: 10 * s), Paint()..color = Colors.black.withValues(alpha: 0.28));

    final bodyPaint = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Color.lerp(colour, Colors.white, 0.25)!, colour, Color.lerp(colour, Colors.black, 0.3)!],
      ).createShader(Rect.fromLTWH(-75 * s, -40 * s, 150 * s, 60 * s));

    final body = Path()
      ..moveTo(-72 * s, 10 * s)
      ..quadraticBezierTo(-74 * s, -8 * s, -60 * s, -12 * s)
      ..lineTo(-38 * s, -14 * s)
      ..quadraticBezierTo(-24 * s, -36 * s, 2 * s, -37 * s)
      ..lineTo(24 * s, -36 * s)
      ..quadraticBezierTo(40 * s, -34 * s, 52 * s, -16 * s)
      ..quadraticBezierTo(72 * s, -12 * s, 74 * s, 2 * s)
      ..lineTo(74 * s, 12 * s)
      ..quadraticBezierTo(74 * s, 18 * s, 66 * s, 18 * s)
      ..lineTo(-66 * s, 18 * s)
      ..quadraticBezierTo(-72 * s, 18 * s, -72 * s, 10 * s)
      ..close();
    canvas.drawPath(body, bodyPaint);

    // Windows.
    final glass = Paint()..color = dim ? const Color(0xFF2A3D78) : const Color(0xFF0B1B4D);
    final win = Path()
      ..moveTo(-32 * s, -14 * s)
      ..quadraticBezierTo(-20 * s, -31 * s, 0, -32 * s)
      ..lineTo(0, -14 * s)
      ..close();
    final win2 = Path()
      ..moveTo(5 * s, -32 * s)
      ..lineTo(22 * s, -31 * s)
      ..quadraticBezierTo(36 * s, -29 * s, 45 * s, -15 * s)
      ..lineTo(5 * s, -14 * s)
      ..close();
    canvas.drawPath(win, glass);
    canvas.drawPath(win2, glass);
    // Glint.
    canvas.drawLine(Offset(12 * s, -28 * s), Offset(20 * s, -18 * s), Paint()
      ..color = Colors.white.withValues(alpha: 0.35)
      ..strokeWidth = 2 * s);

    // Headlight and its beam.
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(64 * s, -8 * s, 9 * s, 6 * s), Radius.circular(2 * s)), Paint()..color = const Color(0xFFFFF4C2));
    if (!dim) {
      final beam = Path()
        ..moveTo(72 * s, -7 * s)
        ..lineTo(150 * s, -18 * s)
        ..lineTo(150 * s, 14 * s)
        ..lineTo(72 * s, -1 * s)
        ..close();
      canvas.drawPath(
        beam,
        Paint()
          ..shader = LinearGradient(colors: [const Color(0xFFFFF4C2).withValues(alpha: 0.4), const Color(0x00FFF4C2)])
              .createShader(Rect.fromLTWH(72 * s, -18 * s, 78 * s, 32 * s)),
      );
    }
    // Tail light.
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(-73 * s, -6 * s, 6 * s, 7 * s), Radius.circular(2 * s)), Paint()..color = const Color(0xFFFF4D4D));

    // Front plate (the camera reads this one).
    if (plate != null) {
      final pr = RRect.fromRectAndRadius(Rect.fromCenter(center: Offset(58 * s, 8 * s), width: 30 * s, height: 9 * s), Radius.circular(1.5 * s));
      canvas.drawRRect(pr, Paint()..color = Colors.white);
      canvas.save();
      if (!facingRight) canvas.scale(-1, 1);
      _text(canvas, plate, Offset((facingRight ? 58 : -58) * s, 8.3 * s), 5.6 * s, const Color(0xFF111111), FontWeight.w900);
      canvas.restore();
    }

    // Wheels, turning while the car moves.
    for (final wx in [-44.0, 46.0]) {
      final c = Offset(wx * s, 18 * s);
      canvas.drawCircle(c, 13 * s, Paint()..color = const Color(0xFF0B0F1C));
      canvas.drawCircle(c, 7.5 * s, Paint()..color = const Color(0xFFC9D2EA));
      final spin = driving ? t * 14 : 0.0;
      final spoke = Paint()
        ..color = const Color(0xFF6C7899)
        ..strokeWidth = 1.6 * s;
      for (var k = 0; k < 3; k++) {
        final a = spin + k * math.pi / 3;
        canvas.drawLine(c + Offset(math.cos(a), math.sin(a)) * 6.5 * s, c - Offset(math.cos(a), math.sin(a)) * 6.5 * s, spoke);
      }
    }
    canvas.restore();
  }

  void _badge(Canvas canvas, Offset at, double s, double pop) {
    canvas.save();
    canvas.translate(at.dx, at.dy);
    canvas.scale(pop.clamp(0.0, 1.2));
    final r = RRect.fromRectAndRadius(Rect.fromCenter(center: Offset.zero, width: 132 * s, height: 26 * s), Radius.circular(13 * s));
    canvas.drawRRect(r.shift(Offset(0, 3 * s)), Paint()..color = Colors.black.withValues(alpha: 0.25));
    canvas.drawRRect(r, Paint()..color = Colors.white);
    canvas.drawCircle(Offset(-52 * s, 0), 9 * s, Paint()..color = MetricBrand.green);
    final tick = Path()
      ..moveTo(-56 * s, 0)
      ..lineTo(-53 * s, 3.5 * s)
      ..lineTo(-47.5 * s, -3.5 * s);
    canvas.drawPath(
      tick,
      Paint()
        ..color = MetricBrand.navy
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.2 * s
        ..strokeCap = StrokeCap.round,
    );
    _text(canvas, 'Member recognised', Offset(10 * s, 0), 10 * s, MetricBrand.navy, FontWeight.w800);
    canvas.restore();
  }

  void _person(Canvas canvas, Offset feet, double s, Color colour, double phase, bool right) {
    final swing = math.sin(phase) * 0.5;
    final p = Paint()
      ..color = colour
      ..strokeWidth = 4 * s
      ..strokeCap = StrokeCap.round;
    final hip = feet.translate(0, -18 * s);
    final neck = hip.translate(0, -16 * s);
    canvas.drawLine(hip, hip + Offset(math.sin(swing) * 10 * s, 18 * s), p);
    canvas.drawLine(hip, hip + Offset(-math.sin(swing) * 10 * s, 18 * s), p);
    canvas.drawLine(hip, neck, p..strokeWidth = 6 * s);
    p.strokeWidth = 3.4 * s;
    canvas.drawLine(neck.translate(0, 2 * s), neck + Offset(-math.sin(swing) * 9 * s, 13 * s), p);
    canvas.drawLine(neck.translate(0, 2 * s), neck + Offset(math.sin(swing) * 9 * s, 13 * s), p);
    canvas.drawCircle(neck.translate(0, -6 * s), 5 * s, Paint()..color = colour);
    // Everyone carries a phone with the app.
    final hand = neck + Offset((right ? 1 : -1) * 7 * s, 9 * s);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromCenter(center: hand, width: 4 * s, height: 7 * s), Radius.circular(1 * s)), Paint()..color = MetricBrand.green);
  }

  void _text(Canvas canvas, String text, Offset centre, double size, Color colour, FontWeight weight) {
    final tp = TextPainter(
      text: TextSpan(text: text, style: TextStyle(fontSize: size, color: colour, fontWeight: weight, letterSpacing: size * 0.04)),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, centre - Offset(tp.width / 2, tp.height / 2));
  }

  @override
  bool shouldRepaint(_ScenePainter old) => old.t != t || old.plate != plate;
}

/// A slowly drifting glow behind content, for the premium backdrop on pages.
class GlowBackdrop extends StatefulWidget {
  const GlowBackdrop({super.key, required this.child});

  final Widget child;

  @override
  State<GlowBackdrop> createState() => _GlowBackdropState();
}

class _GlowBackdropState extends State<GlowBackdrop> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 14));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.of(context).disableAnimations) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (context, child) {
      final v = Curves.easeInOut.transform(_c.value);
      return DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(-0.8 + 1.6 * v, -1.1),
            radius: 1.2,
            colors: [MetricBrand.green.withValues(alpha: 0.10), MetricBrand.surface.withValues(alpha: 0)],
          ),
        ),
        child: child,
      );
    },
    child: widget.child,
  );
}
