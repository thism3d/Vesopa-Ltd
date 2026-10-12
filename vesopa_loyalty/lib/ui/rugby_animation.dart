import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Which game the ball in [KickAnimation] belongs to.
///
/// Only rugby is drawn today. The flight, the timing and the posts are the
/// game's own description below ([_Game]), so football is one more entry --
/// a round ball, a net instead of the H -- rather than another animation.
enum Sport { rugby }

/// A ball kicked through the posts, over and over: the club's sport, alive,
/// for the welcome and for the moments the app is waiting on the server.
///
/// Drawn by hand ([CustomPainter]), not from a file: nothing to fetch or
/// bundle, it takes the club's colours from whatever it is placed on, and it
/// costs one small repaint per frame. It stands still, mid-flight, where the
/// device asks for less motion.
class KickAnimation extends StatefulWidget {
  const KickAnimation({
    super.key,
    this.sport = Sport.rugby,
    this.size = 180,
    this.colour = Colors.white,
    this.accent,
  });

  final Sport sport;

  /// Height of the picture; it is a little wider than tall.
  final double size;

  /// The posts and the ball's panels: white on the club colour.
  final Color colour;

  /// The ball's stripes and seam. The club colour, by default.
  final Color? accent;

  @override
  State<KickAnimation> createState() => _KickAnimationState();
}

class _KickAnimationState extends State<KickAnimation> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: _Game.of(widget.sport).cycle);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    if (still) {
      _c
        ..stop()
        ..value = 0.55;
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
  Widget build(BuildContext context) => Semantics(
    image: true,
    label: 'A rugby ball kicked between the posts',
    child: SizedBox(
      height: widget.size,
      width: widget.size * 1.25,
      child: CustomPaint(
        painter: _KickPainter(
          _c,
          _Game.of(widget.sport),
          widget.colour,
          widget.accent ?? Theme.of(context).colorScheme.primary,
        ),
      ),
    ),
  );
}

/// One game's kick: how long it takes and what it looks like.
class _Game {
  const _Game({required this.cycle, required this.flight, required this.spins});

  /// One kick, from the boot to the next.
  final Duration cycle;

  /// The part of [cycle] the ball is in the air; the rest is the pause
  /// before the next one, so it reads as kicks rather than a conveyor belt.
  final double flight;

  /// Times the ball turns over end to end on its way.
  final double spins;

  static const _rugby = _Game(cycle: Duration(milliseconds: 2600), flight: 0.72, spins: 2.5);

  static _Game of(Sport sport) => switch (sport) {
    Sport.rugby => _rugby,
  };
}

class _KickPainter extends CustomPainter {
  _KickPainter(this.t, this.game, this.colour, this.accent) : super(repaint: t);

  final Animation<double> t;
  final _Game game;
  final Color colour;
  final Color accent;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;

    // THE POSTS, at the far end: an H whose crossbar sits a little under
    // half way up, slightly smaller toward the top for a hint of distance.
    final postX = w * 0.62;
    final gap = w * 0.30;
    final ground = h * 0.92;
    final bar = h * 0.56;
    final top = h * 0.04;
    final posts = Paint()
      ..color = colour.withValues(alpha: 0.9)
      ..strokeWidth = math.max(2, w * 0.022)
      ..strokeCap = StrokeCap.round;
    final left = postX - gap / 2;
    final right = postX + gap / 2;
    canvas
      ..drawLine(Offset(left, ground), Offset(left - 2, top), posts)
      ..drawLine(Offset(right, ground), Offset(right + 2, top), posts)
      ..drawLine(Offset(left - 1, bar), Offset(right + 1, bar), posts);
    // The pitch: one line, fading off either side.
    canvas.drawRect(
      Rect.fromLTWH(0, ground, w, 2),
      Paint()
        ..shader = LinearGradient(
          colors: [colour.withValues(alpha: 0), colour.withValues(alpha: 0.5), colour.withValues(alpha: 0)],
        ).createShader(Rect.fromLTWH(0, ground, w, 2)),
    );

    final p = t.value / game.flight;
    if (p > 1) {
      // Over. A little burst where it went through, fading in the pause.
      final after = ((t.value - game.flight) / (1 - game.flight)).clamp(0.0, 1.0);
      final centre = Offset(postX, bar - h * 0.2);
      final burst = Paint()
        ..color = colour.withValues(alpha: 0.6 * (1 - after))
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round;
      for (var i = 0; i < 8; i++) {
        final a = i * math.pi / 4;
        final r1 = h * (0.05 + 0.1 * after);
        final r2 = r1 + h * 0.05;
        canvas.drawLine(centre + Offset(math.cos(a), math.sin(a)) * r1, centre + Offset(math.cos(a), math.sin(a)) * r2, burst);
      }
      return;
    }

    // THE FLIGHT. From the boot at the bottom left, up in an arc and away
    // between the posts, over the bar, getting smaller as it goes.
    final e = Curves.easeOut.transform(p);
    final start = Offset(w * 0.12, ground - h * 0.05);
    final end = Offset(postX, bar - h * 0.24);
    final x = start.dx + (end.dx - start.dx) * e;
    final lift = math.sin(e * math.pi * 0.85) * h * 0.42;
    final y = start.dy + (end.dy - start.dy) * e - lift;
    final scale = 1 - 0.6 * e;
    final ball = Offset(x, y);

    // A shadow on the pitch, under it, smaller and fainter the higher it is.
    final height = ((ground - y) / h).clamp(0.0, 1.0);
    canvas.drawOval(
      Rect.fromCenter(center: Offset(x, ground), width: w * 0.12 * scale * (1 - height * 0.6), height: h * 0.02),
      Paint()..color = Colors.black.withValues(alpha: 0.22 * (1 - height)),
    );

    // A faint trail behind it.
    final trail = Paint()
      ..color = colour.withValues(alpha: 0.18)
      ..style = PaintingStyle.stroke
      ..strokeWidth = math.max(1.5, w * 0.012)
      ..strokeCap = StrokeCap.round;
    final path = Path();
    for (var i = 0; i <= 12; i++) {
      final q = (p - 0.18 + 0.18 * i / 12).clamp(0.0, 1.0);
      final eq = Curves.easeOut.transform(q);
      final px = start.dx + (end.dx - start.dx) * eq;
      final py = start.dy + (end.dy - start.dy) * eq - math.sin(eq * math.pi * 0.85) * h * 0.42;
      i == 0 ? path.moveTo(px, py) : path.lineTo(px, py);
    }
    canvas.drawPath(path, trail);

    // The ball, end over end: its length shortens and grows as it turns
    // toward and away from us, and it leans along its line of flight.
    final turn = p * game.spins * 2 * math.pi;
    final length = w * 0.2 * scale;
    final girth = length * 0.62;
    final apparent = math.max(girth * 1.02, length * (0.55 + 0.45 * math.cos(turn).abs()));
    final heading = math.atan2(
      (end.dy - start.dy) - math.cos(e * math.pi * 0.85) * h * 0.42 * math.pi * 0.85,
      end.dx - start.dx,
    );
    canvas
      ..save()
      ..translate(ball.dx, ball.dy)
      ..rotate(heading + math.sin(turn) * 0.5);
    _ball(canvas, apparent, girth, math.cos(turn));
    canvas.restore();
  }

  /// A rugby ball lying along x: panels, two stripes near the ends and the
  /// seam down the middle, lit from above.
  void _ball(Canvas canvas, double length, double girth, double facing) {
    final body = Rect.fromCenter(center: Offset.zero, width: length, height: girth);
    final shape = Path()
      ..moveTo(-length / 2, 0)
      ..quadraticBezierTo(0, -girth * 0.98, length / 2, 0)
      ..quadraticBezierTo(0, girth * 0.98, -length / 2, 0)
      ..close();
    canvas
      ..drawPath(shape.shift(Offset(0, girth * 0.06)), Paint()..color = Colors.black.withValues(alpha: 0.2))
      ..drawPath(
        shape,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Colors.white, Color.lerp(colour, const Color(0xFFD9D2CC), 0.6)!],
          ).createShader(body),
      )
      ..save()
      ..clipPath(shape);
    // The stripes, in the club colour, a fifth of the way in from each end.
    final stripe = Paint()..color = accent;
    for (final s in [-1.0, 1.0]) {
      canvas.drawRect(Rect.fromCenter(center: Offset(s * length * 0.3, 0), width: length * 0.07, height: girth), stripe);
    }
    // The seam, showing as the ball turns it toward us.
    final seam = Paint()
      ..color = accent.withValues(alpha: 0.35 + 0.5 * facing.abs())
      ..strokeWidth = math.max(1, girth * 0.06)
      ..style = PaintingStyle.stroke;
    canvas
      ..drawLine(Offset(-length * 0.22, -girth * 0.12 * facing), Offset(length * 0.22, -girth * 0.12 * facing), seam)
      ..restore()
      ..drawPath(
        shape,
        Paint()
          ..color = accent.withValues(alpha: 0.55)
          ..style = PaintingStyle.stroke
          ..strokeWidth = math.max(1, girth * 0.05),
      );
  }

  @override
  bool shouldRepaint(_KickPainter old) => old.colour != colour || old.accent != accent || old.game != game;
}
