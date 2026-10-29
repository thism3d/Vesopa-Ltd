/// The start animation (owner, 2026-10-28): the app's mark builds itself,
/// turns into a card, and a tick is drawn on it; then the app shows through.
/// Plays once per start, over whatever the app opens on, in about two
/// seconds. Skipped when the device asks for less motion (and under tests).
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../counter/ui/brand.dart';
import 'theme.dart';

class GoSplash extends StatefulWidget {
  const GoSplash({super.key, required this.child});
  final Widget child;
  @override
  State<GoSplash> createState() => _GoSplashState();
}

class _GoSplashState extends State<GoSplash> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2100));
  bool _done = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_done || _c.isAnimating) return;
    if (!ambientMotion(context)) {
      _done = true;
      return;
    }
    _c.forward().whenComplete(() {
      if (mounted) setState(() => _done = true);
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_done) return widget.child;
    return Stack(fit: StackFit.expand, children: [
      widget.child,
      AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          final v = _c.value;
          // 0.00-0.35 the mark builds; 0.35-0.60 it turns into a card;
          // 0.60-0.85 the tick is drawn; 0.85-1.00 it all fades away.
          final build = Curves.easeOutBack.transform((v / 0.35).clamp(0.0, 1.0));
          final turn = Curves.easeInOutCubic.transform(((v - 0.35) / 0.25).clamp(0.0, 1.0));
          final tick = Curves.easeOutCubic.transform(((v - 0.60) / 0.25).clamp(0.0, 1.0));
          final fade = 1 - Curves.easeIn.transform(((v - 0.85) / 0.15).clamp(0.0, 1.0));
          final showCard = turn > 0.5;
          // A flip about the vertical axis: the mark's face away, the card's toward.
          final angle = turn * math.pi;
          return IgnorePointer(
            ignoring: v > 0.85,
            child: Opacity(
              opacity: fade,
              child: ColoredBox(
                color: Tp.inkDeep,
                child: Center(
                  child: Transform(
                    alignment: Alignment.center,
                    transform: Matrix4.identity()
                      ..setEntry(3, 2, 0.0015)
                      ..rotateY(showCard ? angle - math.pi : angle)
                      ..scaleByDouble(0.6 + 0.4 * build, 0.6 + 0.4 * build, 1, 1),
                    child: Opacity(
                      opacity: build.clamp(0.0, 1.0),
                      child: showCard ? _Card(tick: tick) : const GoMark(size: 120),
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    ]);
  }
}

/// A payment card in the brand's lime, with a tick drawn across it.
class _Card extends StatelessWidget {
  const _Card({required this.tick});
  final double tick;

  @override
  Widget build(BuildContext context) => Container(
        width: 190,
        height: 120,
        decoration: BoxDecoration(
          color: Tp.lime,
          borderRadius: BorderRadius.circular(18),
          boxShadow: [BoxShadow(color: Tp.lime.withValues(alpha: 0.35), blurRadius: 36, spreadRadius: 2)],
        ),
        child: Stack(children: [
          // The chip and the contactless mark, as on a real card.
          Positioned(left: 20, top: 22, child: Container(width: 32, height: 24, decoration: BoxDecoration(color: Tp.onLime.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(5)))),
          const Positioned(right: 18, top: 18, child: Icon(Icons.contactless_rounded, color: Tp.onLime, size: 28)),
          Positioned.fill(child: CustomPaint(painter: _TickPainter(tick))),
        ]),
      );
}

class _TickPainter extends CustomPainter {
  _TickPainter(this.progress);
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0) return;
    final path = Path()
      ..moveTo(size.width * 0.36, size.height * 0.58)
      ..lineTo(size.width * 0.47, size.height * 0.72)
      ..lineTo(size.width * 0.68, size.height * 0.40);
    final metric = path.computeMetrics().first;
    final paint = Paint()
      ..color = Tp.onLime
      ..style = PaintingStyle.stroke
      ..strokeWidth = 9
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(metric.extractPath(0, metric.length * progress), paint);
  }

  @override
  bool shouldRepaint(_TickPainter old) => old.progress != progress;
}
