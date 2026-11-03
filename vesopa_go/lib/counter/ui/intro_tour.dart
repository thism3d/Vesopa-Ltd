/// The welcome screen's tour (owner, 2026-11-03): small films of what Go does,
/// drawn live rather than played from video so they are sharp at any size --
/// a phone held upright, an iPad on its side, a handheld terminal.
///
///   1. Tap to Pay       a card meets the top of the phone, rings, approved
///   2. QR Pay           the bill's code draws itself, a phone scans it, paid
///   3. Card machine     the amount goes to the handheld, the receipt prints
///   4. Tables, kitchen  a table lights up and its ticket flies to the kitchen
///   5. Venue network    the till at the centre, devices joined to it, packets
///   6. Back office      the day's takings counting up, bars rising
///
/// Each scene is one CustomPainter over a clock that runs 0..1 per scene. The
/// tour turns by itself at the end of each scene, follows a finger, waits
/// while held, and a tap plays the scene again. With "reduce motion" asked
/// for, every scene shows its last frame and nothing moves.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:vesopa_go/ui/theme.dart';

const Curve _emph = Cubic(0.2, 0.0, 0.0, 1.0);
const _sceneLength = Duration(milliseconds: 5200);

class IntroScene {
  const IntroScene(this.title, this.line, this.painter);
  final String title;
  final String line;
  final CustomPainter Function(double t) painter;
}

final introScenes = <IntroScene>[
  IntroScene('Tap to Pay on iPhone', 'Cards, Apple Pay and Google Pay on the phone in your hand. No card machine needed.', (t) => _TapToPay(t)),
  IntroScene('QR Pay', 'The bill on the customer\'s own phone, every item listed. Paid in seconds, closed by itself.', (t) => _QrPay(t)),
  IntroScene('The venue\'s card machine', 'Send the amount to the Dojo or Teya machine from any device, tips and split bills too.', (t) => _CardMachine(t)),
  IntroScene('Tables and the kitchen', 'Seat a table, take the order, and the ticket is in the kitchen before you turn round.', (t) => _Tables(t)),
  IntroScene('One with your tills', 'Go, the tills and the kitchen talk over the venue network, even when the internet drops.', (t) => _Network(t)),
  IntroScene('Live in the back office', 'Every sale, every member of staff and the whole menu, the moment it happens.', (t) => _BackOffice(t)),
];

/// The tour: the scene, its words, and the dots.
class IntroTour extends StatefulWidget {
  const IntroTour({super.key, required this.sceneSize, this.textAlign = TextAlign.center, this.compact = false});

  /// The square the films are drawn in.
  final double sceneSize;
  final TextAlign textAlign;
  final bool compact;

  @override
  State<IntroTour> createState() => _IntroTourState();
}

class _IntroTourState extends State<IntroTour> with SingleTickerProviderStateMixin {
  late final AnimationController _clock = AnimationController(vsync: this, duration: _sceneLength);
  final _pages = PageController();
  int _page = 0;
  bool _still = false;

  @override
  void initState() {
    super.initState();
    _clock.addStatusListener((s) {
      if (s == AnimationStatus.completed && mounted && _pages.hasClients) {
        _pages.nextPage(duration: const Duration(milliseconds: 700), curve: _emph);
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _still = MediaQuery.of(context).disableAnimations;
      if (_still) {
        _clock.value = 1;
      } else {
        _clock.forward(from: 0);
      }
    });
  }

  @override
  void dispose() {
    _clock.dispose();
    _pages.dispose();
    super.dispose();
  }

  void _turned(int i) {
    setState(() => _page = i);
    HapticFeedback.selectionClick();
    if (!_still) _clock.forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final align = widget.textAlign == TextAlign.center ? CrossAxisAlignment.center : CrossAxisAlignment.start;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: align, children: [
      SizedBox(
        height: widget.sceneSize + (widget.compact ? 104 : 132),
        child: Listener(
          onPointerDown: (_) => _clock.stop(),
          onPointerUp: (_) {
            if (!_still && !_clock.isAnimating && _clock.value < 1) _clock.forward();
          },
          child: PageView.builder(
            controller: _pages,
            onPageChanged: (i) => _turned(i % introScenes.length),
            itemBuilder: (context, i) {
              final scene = introScenes[i % introScenes.length];
              final mine = i % introScenes.length == _page;
              return AnimatedBuilder(
                animation: Listenable.merge([_clock, _pages]),
                builder: (context, _) {
                  final offset = _pages.hasClients && _pages.position.haveDimensions ? (_pages.page! - i) : (i == 0 ? 0.0 : 1.0);
                  final away = offset.abs().clamp(0.0, 1.0);
                  return Opacity(
                    opacity: 1 - away * 0.8,
                    child: Transform.translate(
                      offset: Offset(offset * -40, 0),
                      child: Column(crossAxisAlignment: align, children: [
                        GestureDetector(
                          // A tap plays the scene again.
                          onTap: _still ? null : () => _clock.forward(from: 0),
                          child: Center(
                            child: SizedBox.square(
                              dimension: widget.sceneSize,
                              child: CustomPaint(painter: scene.painter(mine ? _clock.value : 1)),
                            ),
                          ),
                        ),
                        SizedBox(height: widget.compact ? 10 : 16),
                        // The words get what is left, and trim rather than
                        // spill on a small phone or with large text.
                        Expanded(
                          child: ClipRect(
                            child: Column(crossAxisAlignment: align, children: [
                              Text(scene.title, textAlign: widget.textAlign, maxLines: 1, overflow: TextOverflow.ellipsis,
                                  style: (widget.compact ? t.titleLarge : t.headlineSmall)?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.4)),
                              const SizedBox(height: 6),
                              Flexible(
                                child: Text(scene.line, textAlign: widget.textAlign, maxLines: widget.compact ? 2 : 3, overflow: TextOverflow.ellipsis,
                                    style: t.bodyMedium?.copyWith(color: t.bodySmall?.color, height: 1.35)),
                              ),
                            ]),
                          ),
                        ),
                      ]),
                    ),
                  );
                },
              );
            },
          ),
        ),
      ),
      const SizedBox(height: 10),
      Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 0; i < introScenes.length; i++)
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () {
              final now = _pages.page?.round() ?? 0;
              final base = now - now % introScenes.length;
              _pages.animateToPage(base + i, duration: const Duration(milliseconds: 600), curve: _emph);
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 10),
              child: AnimatedBuilder(
                animation: _clock,
                builder: (_, _) => Container(
                  width: i == _page ? 28 : 7,
                  height: 7,
                  decoration: BoxDecoration(color: Tp.muted.withValues(alpha: 0.35), borderRadius: BorderRadius.circular(4)),
                  alignment: Alignment.centerLeft,
                  // The current dot fills as its scene plays.
                  child: i == _page
                      ? FractionallySizedBox(
                          widthFactor: _clock.value.clamp(0.08, 1.0),
                          child: Container(decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(4))),
                        )
                      : null,
                ),
              ),
            ),
          ),
      ]),
    ]);
  }
}

/// "Continue with Vesopa" in the manner of "Sign in with Google": a light
/// button with the Vesopa mark at its start, the words beside it.
class VesopaSignInButton extends StatefulWidget {
  const VesopaSignInButton({super.key, required this.onPressed, this.busy = false, this.label = 'Continue with Vesopa'});
  final VoidCallback? onPressed;
  final bool busy;
  final String label;

  @override
  State<VesopaSignInButton> createState() => _VesopaSignInButtonState();
}

class _VesopaSignInButtonState extends State<VesopaSignInButton> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final on = widget.onPressed != null && !widget.busy;
    return Semantics(
      button: true,
      label: widget.label,
      child: GestureDetector(
        onTapDown: on ? (_) => setState(() => _down = true) : null,
        onTapCancel: () => setState(() => _down = false),
        onTapUp: on
            ? (_) {
                setState(() => _down = false);
                HapticFeedback.lightImpact();
                widget.onPressed!();
              }
            : null,
        child: AnimatedScale(
          scale: _down ? 0.97 : 1,
          duration: const Duration(milliseconds: 120),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            height: 58,
            decoration: BoxDecoration(
              color: on ? Colors.white : Colors.white.withValues(alpha: 0.7),
              borderRadius: BorderRadius.circular(16),
              boxShadow: [
                if (on) BoxShadow(color: Tp.lime.withValues(alpha: _down ? 0.15 : 0.28), blurRadius: _down ? 10 : 26, offset: const Offset(0, 8), spreadRadius: -6),
              ],
            ),
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Row(children: [
              // The mark in its own tile, as Google's G sits in its square.
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: Tp.ink, borderRadius: BorderRadius.circular(11)),
                alignment: Alignment.center,
                child: widget.busy
                    ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2.2, color: Tp.lime))
                    : const CustomPaint(size: Size(26, 26), painter: VesopaMarkPainter()),
              ),
              Expanded(
                child: Text(widget.busy ? 'Opening Vesopa…' : widget.label,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Color(0xFF111111), fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: -0.1)),
              ),
              const SizedBox(width: 40),
            ]),
          ),
        ),
      ),
    );
  }
}

/// The Vesopa "V" in its ring, drawn: lime V, white ring with a gap and dot.
class VesopaMarkPainter extends CustomPainter {
  const VesopaMarkPainter();
  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    final c = size.center(Offset.zero);
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = s * 0.09
      ..strokeCap = StrokeCap.round
      ..color = Colors.white;
    canvas.drawArc(Rect.fromCircle(center: c, radius: s * 0.42), -math.pi * 0.32, math.pi * 1.86, false, ring);
    canvas.drawCircle(c + Offset(math.cos(-math.pi * 0.4), math.sin(-math.pi * 0.4)) * s * 0.42, s * 0.06, Paint()..color = Tp.lime);
    final v = Path()
      ..moveTo(c.dx - s * 0.30, c.dy - s * 0.20)
      ..lineTo(c.dx - s * 0.12, c.dy - s * 0.20)
      ..lineTo(c.dx + s * 0.01, c.dy + s * 0.10)
      ..lineTo(c.dx + s * 0.14, c.dy - s * 0.20)
      ..lineTo(c.dx + s * 0.30, c.dy - s * 0.20)
      ..lineTo(c.dx + s * 0.06, c.dy + s * 0.27)
      ..lineTo(c.dx - s * 0.04, c.dy + s * 0.27)
      ..close();
    canvas.drawPath(v, Paint()..color = Tp.lime);
  }

  @override
  bool shouldRepaint(VesopaMarkPainter old) => false;
}

// ---- drawing helpers ---------------------------------------------------------

double _seg(double t, double a, double b) => ((t - a) / (b - a)).clamp(0.0, 1.0);
double _ease(double x) => _emph.transform(x.clamp(0.0, 1.0));
double _back(double x) => Curves.easeOutBack.transform(x.clamp(0.0, 1.0));

void _text(Canvas canvas, String s, Offset at, double size, Color colour,
    {FontWeight weight = FontWeight.w700, TextAlign align = TextAlign.center, double opacity = 1}) {
  if (opacity <= 0) return;
  final tp = TextPainter(
    text: TextSpan(text: s, style: TextStyle(fontSize: size, color: colour.withValues(alpha: colour.a * opacity), fontWeight: weight, letterSpacing: -0.2)),
    textDirection: TextDirection.ltr,
    textAlign: align,
  )..layout();
  final dx = align == TextAlign.center ? at.dx - tp.width / 2 : align == TextAlign.right ? at.dx - tp.width : at.dx;
  tp.paint(canvas, Offset(dx, at.dy - tp.height / 2));
}

RRect _rr(Rect r, double radius) => RRect.fromRectAndRadius(r, Radius.circular(radius));

/// A phone: body, screen, and the island. Returns the screen's rectangle.
Rect _phone(Canvas canvas, Rect body, {Color screen = const Color(0xFF0E0F0C)}) {
  final r = body.width * 0.16;
  canvas.drawRRect(_rr(body.shift(const Offset(0, 10)), r), Paint()..color = Colors.black.withValues(alpha: 0.35)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 18));
  canvas.drawRRect(_rr(body, r), Paint()..color = const Color(0xFF2A2C27));
  final inner = body.deflate(body.width * 0.045);
  canvas.drawRRect(_rr(inner, r * 0.82), Paint()..color = screen);
  canvas.drawRRect(
    _rr(Rect.fromCenter(center: Offset(inner.center.dx, inner.top + inner.height * 0.045), width: inner.width * 0.32, height: inner.height * 0.035), 20),
    Paint()..color = Colors.black,
  );
  return inner;
}

void _tick(Canvas canvas, Offset c, double r, double p, {Color colour = Tp.green}) {
  if (p <= 0) return;
  canvas.drawCircle(c, r * _back(p), Paint()..color = colour);
  final path = Path()
    ..moveTo(c.dx - r * 0.42, c.dy + r * 0.02)
    ..lineTo(c.dx - r * 0.1, c.dy + r * 0.32)
    ..lineTo(c.dx + r * 0.46, c.dy - r * 0.3);
  final m = path.computeMetrics().first;
  canvas.drawPath(
    m.extractPath(0, m.length * _seg(p, 0.35, 1)),
    Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = r * 0.16
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = Colors.white,
  );
}

void _glow(Canvas canvas, Size size, double strength) {
  final c = size.center(Offset.zero);
  canvas.drawCircle(
    c,
    size.shortestSide * 0.48,
    Paint()
      ..shader = RadialGradient(colors: [Tp.lime.withValues(alpha: 0.16 * strength), Tp.lime.withValues(alpha: 0)])
          .createShader(Rect.fromCircle(center: c, radius: size.shortestSide * 0.48)),
  );
}

// ---- 1. Tap to Pay -----------------------------------------------------------------

class _TapToPay extends CustomPainter {
  _TapToPay(this.t);
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    _glow(canvas, size, 0.6 + 0.4 * _seg(t, 0.45, 0.6));
    final phone = Rect.fromCenter(center: Offset(size.width * 0.42, size.height * 0.56), width: s * 0.40, height: s * 0.80);
    final screen = _phone(canvas, phone);

    // The screen: the amount, then "Hold here", then Approved.
    final approved = _seg(t, 0.58, 0.72);
    _text(canvas, 'TAP TO PAY', Offset(screen.center.dx, screen.top + screen.height * 0.16), s * 0.028, Tp.muted, opacity: 1 - approved);
    _text(canvas, '£24.50', Offset(screen.center.dx, screen.top + screen.height * 0.26), s * 0.07, Colors.white, weight: FontWeight.w900);
    final hold = Offset(screen.center.dx, screen.top + screen.height * 0.58);
    // The reader's target, breathing until the card arrives.
    final breathe = 0.5 + 0.5 * math.sin(t * math.pi * 8);
    canvas.drawCircle(hold, s * (0.075 + 0.006 * breathe) * (1 - approved), Paint()..color = Tp.lime.withValues(alpha: 0.18));
    canvas.drawCircle(hold, s * 0.05 * (1 - approved), Paint()..color = Tp.lime.withValues(alpha: 0.9));
    final wave = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = s * 0.008;
    // Rings leave the phone while the card is near.
    final near = _seg(t, 0.25, 0.4) * (1 - _seg(t, 0.62, 0.7));
    for (var k = 0; k < 3; k++) {
      final p = (t * 3 + k / 3) % 1;
      wave.color = Tp.lime.withValues(alpha: (1 - p) * 0.8 * near);
      canvas.drawArc(Rect.fromCircle(center: Offset(screen.center.dx, phone.top), radius: s * (0.06 + p * 0.16)), math.pi * 1.1, math.pi * 0.8, false, wave);
    }
    _tick(canvas, Offset(screen.center.dx, screen.top + screen.height * 0.58), s * 0.075, approved);
    _text(canvas, 'Approved', Offset(screen.center.dx, screen.top + screen.height * 0.75), s * 0.042, Colors.white, opacity: approved);
    _text(canvas, 'Visa ···· 4242', Offset(screen.center.dx, screen.top + screen.height * 0.83), s * 0.026, Tp.muted, opacity: approved);

    // The card: in from the right, over the top of the phone, held, away.
    final inP = _ease(_seg(t, 0.06, 0.32));
    final outP = _ease(_seg(t, 0.7, 0.9));
    final cardC = Offset.lerp(Offset(size.width * 1.1, size.height * 0.08), Offset(phone.center.dx + s * 0.06, phone.top - s * 0.02), inP)! +
        Offset(s * 0.5 * outP, -s * 0.2 * outP);
    canvas.save();
    canvas.translate(cardC.dx, cardC.dy);
    canvas.rotate(-0.35 + 0.25 * inP - 0.2 * outP);
    final card = Rect.fromCenter(center: Offset.zero, width: s * 0.36, height: s * 0.226);
    canvas.drawRRect(_rr(card.shift(const Offset(0, 8)), s * 0.03), Paint()..color = Colors.black.withValues(alpha: 0.35)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 12));
    canvas.drawRRect(_rr(card, s * 0.03), Paint()
      ..shader = const LinearGradient(colors: [Color(0xFFB8D82A), Color(0xFF6E8A0E)], begin: Alignment.topLeft, end: Alignment.bottomRight).createShader(card));
    canvas.drawRRect(_rr(Rect.fromLTWH(card.left + s * 0.035, card.top + s * 0.06, s * 0.05, s * 0.038), s * 0.008), Paint()..color = const Color(0xFFE8D27A));
    _text(canvas, '···· 4242', Offset(card.left + s * 0.035, card.bottom - s * 0.045), s * 0.026, Tp.onLime, align: TextAlign.left);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_TapToPay old) => old.t != t;
}

// ---- 2. QR Pay -----------------------------------------------------------------------

class _QrPay extends CustomPainter {
  _QrPay(this.t);
  final double t;

  static final _cells = List<bool>.generate(21 * 21, (i) {
    final x = i % 21, y = i ~/ 21;
    bool finder(int fx, int fy) {
      final dx = x - fx, dy = y - fy;
      if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
      return dx == 0 || dy == 0 || dx == 6 || dy == 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
    }
    if (finder(0, 0) || finder(14, 0) || finder(0, 14)) return true;
    if ((x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12)) return false;
    return ((x * 7 + y * 13 + x * y) % 5) < 2;
  });

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    _glow(canvas, size, 0.7);
    // The bill on the tablet: lines, then the code drawing itself.
    final tab = Rect.fromCenter(center: Offset(size.width * 0.4, size.height * 0.48), width: s * 0.62, height: s * 0.76);
    final screen = _phone(canvas, tab, screen: const Color(0xFFF6F7F0));
    _text(canvas, 'Scan to pay', Offset(screen.center.dx, screen.top + screen.height * 0.1), s * 0.034, Tp.ink, weight: FontWeight.w800);
    final q = Rect.fromCenter(center: Offset(screen.center.dx, screen.top + screen.height * 0.47), width: screen.width * 0.66, height: screen.width * 0.66);
    final cell = q.width / 21;
    final drawn = _seg(t, 0.05, 0.38);
    final ink = Paint()..color = Tp.ink;
    for (var i = 0; i < _cells.length; i++) {
      if (!_cells[i]) continue;
      final x = i % 21, y = i ~/ 21;
      // Diagonal sweep: each cell pops in as the wave passes it.
      final when = (x + y) / 40;
      final p = _seg(drawn, when * 0.85, when * 0.85 + 0.15);
      if (p <= 0) continue;
      final r = Rect.fromLTWH(q.left + x * cell, q.top + y * cell, cell, cell).deflate(cell * 0.5 * (1 - _back(p)));
      canvas.drawRect(r, ink);
    }
    _text(canvas, '£38.20', Offset(screen.center.dx, screen.top + screen.height * 0.83), s * 0.05, Tp.ink, weight: FontWeight.w900);
    final paid = _seg(t, 0.68, 0.8);
    if (paid > 0) {
      canvas.drawRRect(_rr(screen, s * 0.05), Paint()..color = Tp.green.withValues(alpha: 0.92 * paid));
      _tick(canvas, screen.center - Offset(0, s * 0.05), s * 0.09, _seg(t, 0.7, 0.84), colour: Colors.white.withValues(alpha: 0.25));
      _text(canvas, 'Paid', screen.center + Offset(0, s * 0.1), s * 0.06, Colors.white, weight: FontWeight.w900, opacity: paid);
    }

    // The customer's phone comes up, scans, and pays.
    final up = _ease(_seg(t, 0.32, 0.5)) * (1 - _ease(_seg(t, 0.82, 0.96)));
    final phone = Rect.fromCenter(
      center: Offset(size.width * 0.74, size.height * (1.25 - 0.55 * up)),
      width: s * 0.28,
      height: s * 0.56,
    );
    final ps = _phone(canvas, phone);
    final scan = _seg(t, 0.48, 0.66);
    final frame = Rect.fromCenter(center: ps.center - Offset(0, ps.height * 0.08), width: ps.width * 0.7, height: ps.width * 0.7);
    final corner = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = s * 0.008
      ..color = Tp.lime;
    for (final o in [frame.topLeft, frame.topRight, frame.bottomLeft, frame.bottomRight]) {
      final sx = o.dx < frame.center.dx ? 1.0 : -1.0, sy = o.dy < frame.center.dy ? 1.0 : -1.0;
      canvas.drawLine(o, o + Offset(sx * frame.width * 0.25, 0), corner);
      canvas.drawLine(o, o + Offset(0, sy * frame.height * 0.25), corner);
    }
    if (scan > 0 && scan < 1) {
      final y = frame.top + frame.height * (0.5 + 0.5 * math.sin(scan * math.pi * 4));
      canvas.drawLine(Offset(frame.left, y), Offset(frame.right, y), corner..color = Tp.lime.withValues(alpha: 0.8));
    }
    final pay = _seg(t, 0.6, 0.7);
    canvas.drawRRect(
      _rr(Rect.fromCenter(center: Offset(ps.center.dx, ps.bottom - ps.height * 0.14), width: ps.width * 0.8, height: ps.height * 0.1), s * 0.02),
      Paint()..color = Color.lerp(Tp.lime, Tp.green, pay)!,
    );
    _text(canvas, pay > 0.5 ? 'Paid' : 'Pay', Offset(ps.center.dx, ps.bottom - ps.height * 0.14), s * 0.026, Tp.onLime, weight: FontWeight.w800);
  }

  @override
  bool shouldRepaint(_QrPay old) => old.t != t;
}

// ---- 3. Card machine ------------------------------------------------------------------

class _CardMachine extends CustomPainter {
  _CardMachine(this.t);
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    _glow(canvas, size, 0.6);
    // Go on the left sends the amount; the handheld on the right takes it.
    final go = Rect.fromCenter(center: Offset(size.width * 0.26, size.height * 0.55), width: s * 0.3, height: s * 0.6);
    final gs = _phone(canvas, go);
    _text(canvas, 'Card machine', Offset(gs.center.dx, gs.top + gs.height * 0.14), s * 0.024, Tp.muted);
    _text(canvas, '£16.80', Offset(gs.center.dx, gs.top + gs.height * 0.3), s * 0.05, Colors.white, weight: FontWeight.w900);
    final sent = _seg(t, 0.14, 0.38);
    canvas.drawRRect(
      _rr(Rect.fromCenter(center: Offset(gs.center.dx, gs.bottom - gs.height * 0.15), width: gs.width * 0.78, height: gs.height * 0.1), s * 0.02),
      Paint()..color = sent > 0 ? Tp.lime.withValues(alpha: 0.5 + 0.5 * (1 - sent)) : Tp.lime,
    );
    _text(canvas, sent > 0 ? 'Sent' : 'Send', Offset(gs.center.dx, gs.bottom - gs.height * 0.15), s * 0.024, Tp.onLime, weight: FontWeight.w800);

    final term = Rect.fromCenter(center: Offset(size.width * 0.7, size.height * 0.58), width: s * 0.34, height: s * 0.6);
    // The amount flying across.
    if (sent > 0 && sent < 1) {
      final from = Offset(gs.center.dx, gs.top + gs.height * 0.3), to = Offset(term.center.dx, term.top + term.height * 0.22);
      final mid = Offset((from.dx + to.dx) / 2, math.min(from.dy, to.dy) - s * 0.14);
      final p = _ease(sent);
      final a = Offset.lerp(Offset.lerp(from, mid, p)!, Offset.lerp(mid, to, p)!, p)!;
      canvas.drawCircle(a, s * 0.03, Paint()..color = Tp.lime);
      _text(canvas, '£', a, s * 0.03, Tp.onLime, weight: FontWeight.w900);
    }

    // The receipt rises out of the top once approved.
    final printed = _ease(_seg(t, 0.68, 0.92));
    final paper = Rect.fromLTWH(term.left + term.width * 0.16, term.top - s * 0.26 * printed, term.width * 0.68, s * 0.26 * printed + s * 0.02);
    canvas.drawRect(paper, Paint()..color = const Color(0xFFF6F7F0));
    for (var k = 0; k < 6; k++) {
      final y = paper.top + s * 0.03 + k * s * 0.035;
      if (y > term.top - s * 0.01) break;
      canvas.drawLine(Offset(paper.left + s * 0.02, y), Offset(paper.right - s * (k.isEven ? 0.02 : 0.07), y), Paint()..color = const Color(0xFFBBBDB2)..strokeWidth = s * 0.006);
    }
    canvas.drawRRect(_rr(term.shift(const Offset(0, 10)), s * 0.05), Paint()..color = Colors.black.withValues(alpha: 0.35)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 16));
    canvas.drawRRect(_rr(term, s * 0.05), Paint()..color = const Color(0xFF222420));
    final ts = Rect.fromLTWH(term.left + term.width * 0.1, term.top + term.height * 0.08, term.width * 0.8, term.height * 0.3);
    canvas.drawRRect(_rr(ts, s * 0.02), Paint()..color = const Color(0xFF0E0F0C));
    final arrived = _seg(t, 0.36, 0.42);
    final approved = _seg(t, 0.6, 0.7);
    _text(canvas, approved > 0 ? 'APPROVED' : 'PRESENT CARD', Offset(ts.center.dx, ts.top + ts.height * 0.3), s * 0.022,
        approved > 0 ? Tp.green : Tp.muted, opacity: arrived);
    _text(canvas, '£16.80', Offset(ts.center.dx, ts.top + ts.height * 0.66), s * 0.048, Colors.white, weight: FontWeight.w900, opacity: arrived);
    // Keys, one pressed in turn while the PIN goes in.
    final keyW = term.width * 0.2, keyH = term.height * 0.085;
    for (var r = 0; r < 4; r++) {
      for (var col = 0; col < 3; col++) {
        final k = r * 3 + col;
        final rect = Rect.fromLTWH(term.left + term.width * 0.14 + col * keyW * 1.25, term.top + term.height * 0.45 + r * keyH * 1.25, keyW, keyH);
        final pressed = _seg(t, 0.42, 0.6) > 0 && _seg(t, 0.42, 0.6) < 1 && ((t * 40).floor() % 12) == k;
        canvas.drawRRect(_rr(rect, s * 0.012), Paint()..color = pressed ? Tp.lime : const Color(0xFF34372F));
      }
    }
  }

  @override
  bool shouldRepaint(_CardMachine old) => old.t != t;
}

// ---- 4. Tables and the kitchen ---------------------------------------------------------

class _Tables extends CustomPainter {
  _Tables(this.t);
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    _glow(canvas, size, 0.5);
    // The floor: six tables; table 4 is seated and ordered for.
    final floor = Rect.fromLTWH(size.width * 0.06, size.height * 0.18, size.width * 0.58, size.height * 0.64);
    canvas.drawRRect(_rr(floor, s * 0.04), Paint()..color = const Color(0xFF1A1B17));
    canvas.drawRRect(_rr(floor, s * 0.04), Paint()..style = PaintingStyle.stroke..color = const Color(0xFF33352E)..strokeWidth = 1.5);
    final seated = _seg(t, 0.08, 0.22);
    final ordered = _seg(t, 0.3, 0.4);
    final positions = [for (var r = 0; r < 2; r++) for (var c = 0; c < 3; c++) Offset(floor.left + floor.width * (0.2 + c * 0.3), floor.top + floor.height * (0.3 + r * 0.42))];
    for (var i = 0; i < positions.length; i++) {
      final active = i == 4;
      final colour = active
          ? Color.lerp(const Color(0xFF3A3D35), Color.lerp(Tp.blue, Tp.lime, ordered)!, seated)!
          : (i == 1 ? Tp.amber.withValues(alpha: 0.75) : const Color(0xFF3A3D35));
      final grow = active ? 1 + 0.12 * math.sin(_seg(t, 0.08, 0.22) * math.pi) : 1.0;
      final r = s * 0.065 * grow;
      for (var k = 0; k < 4; k++) {
        final a = k * math.pi / 2 + math.pi / 4;
        canvas.drawCircle(positions[i] + Offset(math.cos(a), math.sin(a)) * r * 1.45, s * 0.016, Paint()..color = colour.withValues(alpha: 0.6));
      }
      canvas.drawCircle(positions[i], r, Paint()..color = colour);
      _text(canvas, '${i + 1}', positions[i], s * 0.032, active && seated > 0.5 ? Tp.onLime : Colors.white, weight: FontWeight.w800);
    }
    // The ticket: out of table 4, across to the kitchen screen.
    final kitchen = Rect.fromLTWH(size.width * 0.7, size.height * 0.28, size.width * 0.26, size.height * 0.44);
    canvas.drawRRect(_rr(kitchen, s * 0.03), Paint()..color = const Color(0xFF222420));
    _text(canvas, 'KITCHEN', Offset(kitchen.center.dx, kitchen.top + s * 0.035), s * 0.022, Tp.muted);
    final fly = _ease(_seg(t, 0.4, 0.62));
    final landed = _seg(t, 0.6, 0.66);
    final ticketTo = Rect.fromLTWH(kitchen.left + kitchen.width * 0.1, kitchen.top + s * 0.07, kitchen.width * 0.8, kitchen.height * 0.55);
    if (fly > 0) {
      final start = Rect.fromCenter(center: positions[4], width: s * 0.06, height: s * 0.08);
      final r = Rect.lerp(start, ticketTo, fly)!;
      canvas.drawRRect(_rr(r, s * 0.012), Paint()..color = const Color(0xFFF6F7F0));
      final lines = ['Table 4', '2× Burger', '1× Fish & chips', '1× Salad'];
      for (var k = 0; k < lines.length; k++) {
        _text(canvas, lines[k], Offset(r.left + r.width * 0.08, r.top + r.height * (0.16 + k * 0.2)), s * 0.017 * r.width / ticketTo.width,
            k == 0 ? Tp.ink : const Color(0xFF444640), align: TextAlign.left, opacity: _seg(fly, 0.7, 1), weight: k == 0 ? FontWeight.w900 : FontWeight.w600);
      }
    }
    // The kitchen bumps it when it's ready.
    final ready = _seg(t, 0.78, 0.86);
    canvas.drawRRect(
      _rr(Rect.fromLTWH(kitchen.left + kitchen.width * 0.1, kitchen.bottom - s * 0.085, kitchen.width * 0.8, s * 0.06), s * 0.014),
      Paint()..color = Color.lerp(const Color(0xFF34372F), Tp.green, ready)!,
    );
    _text(canvas, ready > 0.5 ? 'Ready' : landed > 0 ? 'Cooking' : 'Waiting',
        Offset(kitchen.center.dx, kitchen.bottom - s * 0.055), s * 0.024, Colors.white, weight: FontWeight.w800);
  }

  @override
  bool shouldRepaint(_Tables old) => old.t != t;
}

// ---- 5. The venue network --------------------------------------------------------------

class _Network extends CustomPainter {
  _Network(this.t);
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    final c = size.center(Offset.zero);
    _glow(canvas, size, 0.8);
    // The till at the centre, the hotspot rings around it.
    final ring = Paint()..style = PaintingStyle.stroke..strokeWidth = s * 0.004;
    for (var k = 0; k < 3; k++) {
      final p = (t * 2 + k / 3) % 1;
      ring.color = Tp.lime.withValues(alpha: (1 - p) * 0.4);
      canvas.drawCircle(c, s * (0.12 + p * 0.3), ring);
    }
    final nodes = <(String, Offset)>[
      ('Go', c + Offset(-s * 0.34, -s * 0.24)),
      ('Go', c + Offset(s * 0.34, -s * 0.24)),
      ('Kitchen', c + Offset(-s * 0.36, s * 0.24)),
      ('Display', c + Offset(s * 0.36, s * 0.24)),
      ('Go', c + Offset(0, s * 0.38)),
    ];
    final line = Paint()..strokeWidth = s * 0.006..strokeCap = StrokeCap.round;
    for (var i = 0; i < nodes.length; i++) {
      final joined = _seg(t, 0.05 + i * 0.07, 0.15 + i * 0.07);
      final end = Offset.lerp(c, nodes[i].$2, joined)!;
      line.color = Tp.lime.withValues(alpha: 0.35);
      canvas.drawLine(c, end, line);
      if (joined < 1) continue;
      // Packets both ways, staggered per device.
      for (var k = 0; k < 2; k++) {
        final p = (t * 2.4 + i * 0.17 + k * 0.5) % 1;
        final a = k == 0 ? Offset.lerp(c, nodes[i].$2, p)! : Offset.lerp(nodes[i].$2, c, p)!;
        canvas.drawCircle(a, s * 0.012, Paint()..color = k == 0 ? Tp.lime : Colors.white);
      }
    }
    for (var i = 0; i < nodes.length; i++) {
      final on = _seg(t, 0.1 + i * 0.07, 0.18 + i * 0.07);
      if (on <= 0) continue;
      final n = nodes[i];
      final w = s * (n.$1 == 'Go' ? 0.13 : 0.2);
      final r = Rect.fromCenter(center: n.$2, width: w * _back(on), height: s * 0.09 * _back(on));
      canvas.drawRRect(_rr(r, s * 0.025), Paint()..color = const Color(0xFF26281F));
      canvas.drawRRect(_rr(r, s * 0.025), Paint()..style = PaintingStyle.stroke..strokeWidth = 1.5..color = Tp.lime.withValues(alpha: 0.6));
      _text(canvas, n.$1, n.$2, s * 0.03, Colors.white, opacity: on);
    }
    final till = Rect.fromCenter(center: c, width: s * 0.26, height: s * 0.16);
    canvas.drawRRect(_rr(till, s * 0.03), Paint()..color = Tp.lime);
    _text(canvas, 'Main till', c - Offset(0, s * 0.018), s * 0.034, Tp.onLime, weight: FontWeight.w900);
    _text(canvas, 'offline? still selling', c + Offset(0, s * 0.03), s * 0.02, Tp.onLime, opacity: _seg(t, 0.6, 0.7));
  }

  @override
  bool shouldRepaint(_Network old) => old.t != t;
}

// ---- 6. The back office ----------------------------------------------------------------

class _BackOffice extends CustomPainter {
  _BackOffice(this.t);
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    _glow(canvas, size, 0.6);
    final board = Rect.fromCenter(center: size.center(Offset.zero), width: s * 0.9, height: s * 0.7);
    canvas.drawRRect(_rr(board.shift(const Offset(0, 10)), s * 0.04), Paint()..color = Colors.black.withValues(alpha: 0.35)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 18));
    canvas.drawRRect(_rr(board, s * 0.04), Paint()..color = const Color(0xFF1C1D19));
    _text(canvas, 'TODAY', Offset(board.left + s * 0.05, board.top + s * 0.06), s * 0.024, Tp.muted, align: TextAlign.left);
    final takings = (2486.5 * _ease(_seg(t, 0.05, 0.6))).toStringAsFixed(2);
    _text(canvas, '£$takings', Offset(board.left + s * 0.05, board.top + s * 0.13), s * 0.07, Colors.white, align: TextAlign.left, weight: FontWeight.w900);
    final up = _seg(t, 0.55, 0.65);
    canvas.drawRRect(
      _rr(Rect.fromLTWH(board.right - s * 0.2, board.top + s * 0.1, s * 0.15 * up, s * 0.06), s * 0.03),
      Paint()..color = Tp.green.withValues(alpha: 0.25),
    );
    _text(canvas, '+18%', Offset(board.right - s * 0.125, board.top + s * 0.13), s * 0.026, Tp.green, opacity: up);
    // The hours' bars, rising one after another, the last one live.
    const heights = [0.25, 0.42, 0.38, 0.6, 0.82, 0.7, 0.95, 0.55];
    final chart = Rect.fromLTWH(board.left + s * 0.05, board.top + s * 0.24, board.width - s * 0.1, board.height - s * 0.32);
    final w = chart.width / heights.length;
    for (var i = 0; i < heights.length; i++) {
      final p = _back(_seg(t, 0.1 + i * 0.05, 0.3 + i * 0.05));
      final live = i == heights.length - 1 ? 0.06 * math.sin(t * math.pi * 6) : 0.0;
      final h = chart.height * (heights[i] + live) * p;
      final bar = Rect.fromLTWH(chart.left + i * w + w * 0.18, chart.bottom - h, w * 0.64, h);
      canvas.drawRRect(_rr(bar, s * 0.012), Paint()..color = i == heights.length - 1 ? Tp.lime : Tp.lime.withValues(alpha: 0.45));
    }
    // A sale landing: a chip slides in at the top right.
    final sale = _ease(_seg(t, 0.72, 0.84)) * (1 - _seg(t, 0.95, 1));
    if (sale > 0) {
      final chip = Rect.fromLTWH(board.right - s * 0.42 * sale, board.bottom - s * 0.02 - s * 0.07, s * 0.38, s * 0.065);
      canvas.drawRRect(_rr(chip, s * 0.03), Paint()..color = const Color(0xFF2B2D26));
      canvas.drawCircle(Offset(chip.left + s * 0.035, chip.center.dy), s * 0.012, Paint()..color = Tp.green);
      _text(canvas, 'Sale £12.40 · Table 4', Offset(chip.left + s * 0.06, chip.center.dy), s * 0.022, Colors.white, align: TextAlign.left);
    }
  }

  @override
  bool shouldRepaint(_BackOffice old) => old.t != t;
}
