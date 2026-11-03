/// The welcome screen's moving tour of what Go does (owner, 2026-11-03:
/// "animated icons with texts below, like a slider showing the works of the
/// tills ... touch interactive, micro interactions").
///
/// Each slide is an animated icon with a line under it. It turns by itself
/// every few seconds, follows a finger, stops while it is held, and stands
/// still for anybody who has asked iOS or Android for less motion.
library;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

const Curve _emphasised = Cubic(0.2, 0.0, 0.0, 1.0);

class _Slide {
  const _Slide(this.icon, this.title, this.line, this.motion);
  final IconData icon;
  final String title;
  final String line;
  final _Motion motion;
}

enum _Motion { waves, orbit, scan, sync, print, rise }

const _slides = [
  _Slide(Icons.contactless_rounded, 'Tap to Pay', 'Take cards, Apple Pay and Google Pay on this phone. No card machine needed.', _Motion.waves),
  _Slide(Icons.table_restaurant_rounded, 'Orders at the table', 'Tables, seats and courses, sent straight to the bar and kitchen.', _Motion.orbit),
  _Slide(Icons.qr_code_2_rounded, 'QR Pay', 'The customer scans the bill and pays on their own phone.', _Motion.scan),
  _Slide(Icons.sync_alt_rounded, 'One with your tills', 'Bills move between Go and Vesopa EPOS, even when the internet drops.', _Motion.sync),
  _Slide(Icons.receipt_long_rounded, 'Receipts and tickets', 'Print, email or show a receipt, and send tickets to the kitchen printer.', _Motion.print),
  _Slide(Icons.insights_rounded, 'Live in the back office', 'Every sale, every member of staff and the whole menu, in one place.', _Motion.rise),
];

class WelcomeSlides extends StatefulWidget {
  const WelcomeSlides({super.key, this.height = 300});
  final double height;

  @override
  State<WelcomeSlides> createState() => _WelcomeSlidesState();
}

class _WelcomeSlidesState extends State<WelcomeSlides> with SingleTickerProviderStateMixin {
  final _pages = PageController(viewportFraction: 0.86);
  late final AnimationController _loop = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400));
  Timer? _auto;
  double _page = 0;
  bool _held = false;

  @override
  void initState() {
    super.initState();
    _pages.addListener(() => setState(() => _page = _pages.page ?? 0));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (!MediaQuery.of(context).disableAnimations) {
        _loop.repeat();
        _schedule();
      }
    });
  }

  void _schedule() {
    _auto?.cancel();
    _auto = Timer.periodic(const Duration(milliseconds: 4200), (_) {
      if (_held || !_pages.hasClients) return;
      final next = ((_pages.page ?? 0).round() + 1) % _slides.length;
      _pages.animateToPage(next, duration: const Duration(milliseconds: 650), curve: _emphasised);
    });
  }

  @override
  void dispose() {
    _auto?.cancel();
    _loop.dispose();
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final current = _page.round() % _slides.length;
    return Column(mainAxisSize: MainAxisSize.min, children: [
      SizedBox(
        height: widget.height,
        child: Listener(
          // Held: the tour waits; let go: it carries on from there.
          onPointerDown: (_) => _held = true,
          onPointerUp: (_) {
            _held = false;
            _schedule();
          },
          onPointerCancel: (_) => _held = false,
          child: PageView.builder(
            controller: _pages,
            itemCount: _slides.length,
            onPageChanged: (_) => HapticFeedback.selectionClick(),
            itemBuilder: (context, i) {
              final d = (_page - i).abs().clamp(0.0, 1.0);
              final s = _slides[i];
              return Opacity(
                opacity: 1 - d * 0.55,
                child: Transform.scale(
                  scale: 1 - d * 0.12,
                  child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                    SizedBox.square(
                      dimension: widget.height * 0.5,
                      child: AnimatedBuilder(
                        animation: _loop,
                        builder: (_, _) => CustomPaint(
                          painter: _MotionPainter(s.motion, _loop.value, Tp.lime),
                          child: Center(
                            child: Transform.translate(
                              offset: Offset(0, math.sin(_loop.value * math.pi * 2) * 4),
                              child: Container(
                                width: widget.height * 0.27,
                                height: widget.height * 0.27,
                                decoration: BoxDecoration(
                                  color: Tp.lime,
                                  borderRadius: BorderRadius.circular(widget.height * 0.08),
                                  boxShadow: [BoxShadow(color: Tp.lime.withValues(alpha: 0.35), blurRadius: 28, spreadRadius: -6, offset: const Offset(0, 10))],
                                ),
                                child: Icon(s.icon, size: widget.height * 0.15, color: Tp.onLime),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                    Text(s.title, textAlign: TextAlign.center, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 6),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Text(s.line, textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(color: t.bodySmall?.color, height: 1.35)),
                    ),
                  ]),
                ),
              );
            },
          ),
        ),
      ),
      const SizedBox(height: 14),
      // The dots: the current one stretches; each one is a button.
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        for (var i = 0; i < _slides.length; i++)
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => _pages.animateToPage(i, duration: const Duration(milliseconds: 500), curve: _emphasised),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 8),
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 320),
                curve: _emphasised,
                width: i == current ? 22 : 7,
                height: 7,
                decoration: BoxDecoration(
                  color: i == current ? Tp.lime : Tp.muted.withValues(alpha: 0.4),
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            ),
          ),
      ]),
    ]);
  }
}

/// The movement behind each slide's icon, drawn in the venue lime.
class _MotionPainter extends CustomPainter {
  _MotionPainter(this.motion, this.t, this.colour);
  final _Motion motion;
  final double t;
  final Color colour;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2;
    final line = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..color = colour;
    switch (motion) {
      case _Motion.waves:
        // Contactless: rings leaving the tile, one after another.
        for (var k = 0; k < 3; k++) {
          final p = (t + k / 3) % 1;
          line
            ..strokeWidth = 3
            ..color = colour.withValues(alpha: (1 - p) * 0.55);
          canvas.drawCircle(c, r * (0.6 + p * 0.4), line);
        }
      case _Motion.orbit:
        // Tables: four seats going round.
        line
          ..strokeWidth = 1.5
          ..color = colour.withValues(alpha: 0.25);
        canvas.drawCircle(c, r * 0.82, line);
        final dot = Paint()..color = colour;
        for (var k = 0; k < 4; k++) {
          final a = (t + k / 4) * math.pi * 2;
          canvas.drawCircle(c + Offset(math.cos(a), math.sin(a)) * r * 0.82, 6, dot..color = colour.withValues(alpha: 0.5 + 0.5 * ((k + 1) / 4)));
        }
      case _Motion.scan:
        // QR: a line sweeping inside the corners.
        line
          ..strokeWidth = 3
          ..color = colour.withValues(alpha: 0.7);
        final s = r * 0.8;
        for (final sx in [-1.0, 1.0]) {
          for (final sy in [-1.0, 1.0]) {
            final o = c + Offset(sx * s, sy * s);
            canvas.drawLine(o, o + Offset(-sx * s * 0.35, 0), line);
            canvas.drawLine(o, o + Offset(0, -sy * s * 0.35), line);
          }
        }
        final y = c.dy - s + (math.sin(t * math.pi * 2) * 0.5 + 0.5) * s * 2;
        canvas.drawLine(Offset(c.dx - s * 0.9, y), Offset(c.dx + s * 0.9, y), line..color = colour.withValues(alpha: 0.45));
      case _Motion.sync:
        // Tills: two arcs chasing each other round.
        line
          ..strokeWidth = 3.5
          ..color = colour.withValues(alpha: 0.6);
        final rect = Rect.fromCircle(center: c, radius: r * 0.82);
        final a = t * math.pi * 2;
        canvas.drawArc(rect, a, math.pi * 0.7, false, line);
        canvas.drawArc(rect, a + math.pi, math.pi * 0.7, false, line);
      case _Motion.print:
        // Receipts: paper lines feeding out below.
        line
          ..strokeWidth = 3
          ..color = colour.withValues(alpha: 0.5);
        for (var k = 0; k < 3; k++) {
          final p = (t + k / 3) % 1;
          final y = c.dy + r * 0.45 + p * r * 0.5;
          line.color = colour.withValues(alpha: (1 - p) * 0.6);
          canvas.drawLine(Offset(c.dx - r * 0.35, y), Offset(c.dx + r * 0.35, y), line);
        }
      case _Motion.rise:
        // Back office: bars growing in turn.
        final bar = Paint()..color = colour.withValues(alpha: 0.35);
        for (var k = 0; k < 5; k++) {
          final h = r * (0.25 + 0.55 * (0.5 + 0.5 * math.sin((t + k * 0.15) * math.pi * 2)));
          final x = c.dx - r * 0.85 + k * r * 0.4;
          canvas.drawRRect(
            RRect.fromRectAndRadius(Rect.fromLTWH(x, c.dy + r * 0.95 - h, r * 0.22, h), const Radius.circular(4)),
            bar,
          );
        }
    }
  }

  @override
  bool shouldRepaint(_MotionPainter old) => old.t != t || old.motion != motion;
}

/// A button that sinks a little under the finger and ticks when pressed.
class Pressable extends StatefulWidget {
  const Pressable({super.key, required this.child});
  final Widget child;
  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _down = false;
  @override
  Widget build(BuildContext context) => Listener(
        onPointerDown: (_) => setState(() => _down = true),
        onPointerUp: (_) {
          setState(() => _down = false);
          HapticFeedback.lightImpact();
        },
        onPointerCancel: (_) => setState(() => _down = false),
        child: AnimatedScale(
          scale: _down ? 0.97 : 1,
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
          child: widget.child,
        ),
      );
}
