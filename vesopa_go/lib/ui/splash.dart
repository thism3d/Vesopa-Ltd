/// The start animation (owner, 2026-10-28; reworked 2026-10-30 "more robust,
/// the tick like Apple's, square, the card animated in time"): the app's mark
/// springs in; its rounded square widens into a lime payment card while its
/// chip and contactless waves slide into place; then an Apple-style rounded
/// square tick pops onto the card's corner and its check is drawn; then the
/// app shows through. About 2.2 seconds, once per start; skipped when the
/// device asks for less motion (and under tests).
library;

import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';

import '../counter/ui/brand.dart';
import 'theme.dart';

class GoSplash extends StatefulWidget {
  const GoSplash({super.key, required this.child});
  final Widget child;

  /// Holds the animation at this point (0..1), for a test to look at a frame.
  @visibleForTesting
  static double? debugProgress;

  @override
  State<GoSplash> createState() => _GoSplashState();
}

class _GoSplashState extends State<GoSplash> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2200));
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

  /// [v] from 0 to 1 over [from]..[to] of the run, through [curve].
  double _phase(double from, double to, [Curve curve = Curves.easeInOutCubic]) =>
      curve.transform(((_t - from) / (to - from)).clamp(0.0, 1.0));

  double get _t => GoSplash.debugProgress ?? _c.value;

  @override
  Widget build(BuildContext context) {
    if (_done && GoSplash.debugProgress == null) return widget.child;
    return Stack(fit: StackFit.expand, children: [
      widget.child,
      AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          // 0.00-0.22 the mark springs in; 0.22-0.52 it becomes the card;
          // 0.44-0.74 the Vesopa wordmark is printed and Go follows;
          // 0.52-0.80 the tick pops on and is drawn; 0.86-1.00 fade away.
          final appear = _phase(0.0, 0.22, Curves.easeOutBack);
          final morph = _phase(0.22, 0.52);
          final details = _phase(0.38, 0.58, Curves.easeOutCubic);
          final word = _phase(0.44, 0.66, Curves.easeInOutCubic);
          final go = _phase(0.62, 0.74, Curves.easeOutBack).clamp(0.0, 1.0);
          final badge = _phase(0.52, 0.66, Curves.elasticOut);
          final check = _phase(0.60, 0.80, Curves.easeOutCubic);
          final fade = 1 - _phase(0.86, 1.0, Curves.easeIn);

          // The mark's rounded square (120) widens into a card (210 x 132).
          final w = lerpDouble(120, 210, morph)!;
          final h = lerpDouble(120, 132, morph)!;
          final r = lerpDouble(26, 18, morph)!;
          final fill = Color.lerp(const Color(0xFF0B0B0B), Tp.lime, morph)!;
          return IgnorePointer(
            ignoring: _t > 0.86,
            child: Opacity(
              opacity: fade,
              child: Material(
                color: Tp.inkDeep,
                child: Center(
                  child: Transform.scale(
                    scale: 0.7 + 0.3 * appear,
                    child: Opacity(
                      opacity: appear.clamp(0.0, 1.0),
                      child: SizedBox(
                        width: 240,
                        height: 170,
                        child: Stack(alignment: Alignment.center, clipBehavior: Clip.none, children: [
                          Container(
                            width: w,
                            height: h,
                            decoration: BoxDecoration(
                              color: fill,
                              borderRadius: BorderRadius.circular(r),
                              boxShadow: [BoxShadow(color: Tp.lime.withValues(alpha: 0.30 * morph), blurRadius: 36, spreadRadius: 2)],
                            ),
                            clipBehavior: Clip.antiAlias,
                            child: Stack(children: [
                              // The mark fades out as the card comes.
                              Center(child: Opacity(opacity: 1 - morph, child: const GoMark(size: 120))),
                              // The chip and the waves slide in, as on a card.
                              Positioned(
                                left: 20,
                                top: 24 + 12 * (1 - details),
                                child: Opacity(
                                  opacity: details,
                                  child: Container(
                                    width: 34,
                                    height: 26,
                                    decoration: BoxDecoration(color: Tp.onLime.withValues(alpha: 0.25), borderRadius: BorderRadius.circular(6)),
                                  ),
                                ),
                              ),
                              Positioned(
                                right: 18 - 12 * (1 - details),
                                top: 20,
                                child: Opacity(opacity: details, child: const Icon(Icons.contactless_rounded, color: Tp.onLime, size: 30)),
                              ),
                              // The Vesopa wordmark printed onto the card left to
                              // right, then Go slides in beside it (owner,
                              // 2026-10-31: the brand's own lettering, not plain text).
                              Positioned(
                                left: 20,
                                bottom: 19,
                                child: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
                                  ClipRect(
                                    child: Align(
                                      alignment: Alignment.centerLeft,
                                      widthFactor: word,
                                      child: Image.asset(
                                        'assets/brand/vesopa_wordmark.png',
                                        height: 15,
                                        filterQuality: FilterQuality.high,
                                        semanticLabel: 'Vesopa',
                                      ),
                                    ),
                                  ),
                                  SizedBox(width: 6 * go),
                                  Opacity(
                                    opacity: go,
                                    child: Transform.translate(
                                      offset: Offset(-8 * (1 - go), 0),
                                      child: const Text(
                                        'Go',
                                        style: TextStyle(
                                          color: Tp.onLime,
                                          fontWeight: FontWeight.w900,
                                          fontSize: 19,
                                          height: 0.9,
                                          letterSpacing: -0.6,
                                          decoration: TextDecoration.none,
                                        ),
                                      ),
                                    ),
                                  ),
                                ]),
                              ),
                            ]),
                          ),
                          // Apple's rounded-square tick, on the card's corner.
                          Positioned(
                            right: (240 - w) / 2 - 18,
                            bottom: (170 - h) / 2 - 18,
                            child: Transform.scale(
                              scale: badge,
                              child: Container(
                                width: 56,
                                height: 56,
                                decoration: BoxDecoration(
                                  color: Colors.white,
                                  borderRadius: BorderRadius.circular(14),
                                  boxShadow: const [BoxShadow(color: Color(0x66000000), blurRadius: 16, offset: Offset(0, 6))],
                                ),
                                child: CustomPaint(painter: _TickPainter(check)),
                              ),
                            ),
                          ),
                        ]),
                      ),
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

class _TickPainter extends CustomPainter {
  _TickPainter(this.progress);
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    if (progress <= 0) return;
    final path = Path()
      ..moveTo(size.width * 0.27, size.height * 0.53)
      ..lineTo(size.width * 0.43, size.height * 0.69)
      ..lineTo(size.width * 0.74, size.height * 0.34);
    final metric = path.computeMetrics().first;
    final paint = Paint()
      ..color = Tp.limeDeep
      ..style = PaintingStyle.stroke
      ..strokeWidth = 6.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(metric.extractPath(0, metric.length * progress), paint);
  }

  @override
  bool shouldRepaint(_TickPainter old) => old.progress != progress;
}
