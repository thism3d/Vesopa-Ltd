/// Signed in: how this device is used. Beside the venue's tills it can be a
/// till (EPOS), a Vesopa Kitchen screen or a customer display (owner,
/// 2026-11-04: the three belong on this first screen, not one step later, and
/// "design the page with graphics and animations and colors"); without tills,
/// it is a till on its own. A device the back office has set (Devices ›
/// Vesopa Go devices) opens in that mode whatever is picked here.
///
/// Each choice carries a small motion picture of what the device will do:
/// a card tapped on a till, tickets landing on a kitchen board, a bill
/// building on a customer's screen, an amount typed on a phone. The glows
/// behind the page drift in the three colours. The cards rise one after
/// another and give a little under the finger. Everything runs off one
/// ticker and holds a still frame when Reduce Motion is on.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../../modes/device_mode.dart';
import '../theme.dart';

const _orange = Color(0xFFFF9F0A); // Apple's system orange
const _blue = Color(0xFF0A84FF); // Apple's system blue
const _grey = Color(0xFF8E8E93);
const _ease = Cubic(0.2, 0, 0, 1);

enum _Scene { epos, kitchen, display, own }

class SetupPage extends ConsumerStatefulWidget {
  const SetupPage({super.key});
  @override
  ConsumerState<SetupPage> createState() => _SetupPageState();
}

class _SetupPageState extends ConsumerState<SetupPage> with TickerProviderStateMixin {
  late final AnimationController _loop = AnimationController(vsync: this, duration: const Duration(milliseconds: 3600))..repeat();
  late final AnimationController _enter = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))..forward();
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.of(context).disableAnimations) {
      _loop
        ..stop()
        ..value = 0.82;
      _enter.value = 1;
    }
  }

  @override
  void dispose() {
    _loop.dispose();
    _enter.dispose();
    super.dispose();
  }

  Future<void> _pick(VenueMode mode, DeviceMode? device) async {
    if (_busy) return;
    _busy = true;
    HapticFeedback.selectionClick();
    try {
      if (device != null) await ref.read(deviceModeProvider.notifier).choose(device);
      await ref.read(tapProvider.notifier).chooseMode(mode);
    } finally {
      _busy = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final venue = ref.watch(tapProvider.select((s) => s.venue));
    final t = Theme.of(context).textTheme;
    final size = MediaQuery.sizeOf(context);
    final kind = size.shortestSide >= 600 ? 'iPad' : 'phone';
    final wide = size.width >= 820;

    Widget rise(int i, Widget child) {
      final a = CurvedAnimation(parent: _enter, curve: Interval((0.12 * i).clamp(0, 0.6), (0.12 * i + 0.45).clamp(0, 1), curve: _ease));
      return FadeTransition(
        opacity: a,
        child: SlideTransition(position: Tween(begin: const Offset(0, 0.12), end: Offset.zero).animate(a), child: child),
      );
    }

    final epos = _ModeCard(
      key: const ValueKey('setup-epos'),
      scene: _Scene.epos,
      tint: Tp.lime,
      loop: _loop,
      tall: wide,
      title: 'EPOS',
      body: 'Take orders and payments: the same tables, bills and menu as your tills.',
      onTap: () => _pick(VenueMode.connected, DeviceMode.epos),
    );
    final kitchen = _ModeCard(
      key: const ValueKey('setup-kitchen'),
      scene: _Scene.kitchen,
      tint: _orange,
      loop: _loop,
      tall: wide,
      title: 'Vesopa Kitchen',
      body: 'The kitchen\'s tickets from every till, to cook and mark done.',
      onTap: () => _pick(VenueMode.connected, DeviceMode.kitchen),
    );
    final display = _ModeCard(
      key: const ValueKey('setup-display'),
      scene: _Scene.display,
      tint: _blue,
      loop: _loop,
      tall: wide,
      title: 'Customer display',
      body: 'Faces the customer: their bill as it is rung up, how to pay, and your adverts.',
      onTap: () => _pick(VenueMode.connected, DeviceMode.display),
    );
    final own = _ModeCard(
      key: const ValueKey('setup-own'),
      scene: _Scene.own,
      tint: _grey,
      loop: _loop,
      title: 'On its own',
      body: 'No tills needed: a simple menu or a typed amount, and card payments on the $kind. Every sale is in your back office.',
      onTap: () => _pick(VenueMode.standalone, null),
    );
    Widget label(String s) => Padding(
          padding: const EdgeInsets.only(bottom: 10, left: 4),
          child: Text(s, style: t.labelMedium?.copyWith(letterSpacing: 1.2, color: Colors.white60)),
        );

    return Theme(
      data: Tp.theme(Brightness.dark, font: Theme.of(context).textTheme.bodyMedium?.fontFamily),
      child: Builder(builder: (context) {
        final t = Theme.of(context).textTheme;
        return Scaffold(
          backgroundColor: const Color(0xFF0B0E0A),
          body: Stack(children: [
            // Three soft glows that drift slowly, in the three modes' colours.
            Positioned.fill(child: AnimatedBuilder(animation: _loop, builder: (_, _) => CustomPaint(painter: _Glow(_loop.value)))),
            SafeArea(
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1080),
                  child: ListView(
                    padding: EdgeInsets.symmetric(horizontal: wide ? 40 : 20, vertical: wide ? 40 : 24),
                    children: [
                      rise(0, Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('Signed in to ${venue?.name ?? 'your venue'}', style: t.titleMedium?.copyWith(color: Tp.lime)),
                        const SizedBox(height: 6),
                        Text('How will this $kind be used?',
                            style: t.headlineLarge?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -0.5, color: Colors.white)),
                        const SizedBox(height: 8),
                        Text('Pick one. A manager can change it later in Settings, or set it for this device in the back office.',
                            style: t.bodyLarge?.copyWith(color: Colors.white70)),
                      ])),
                      SizedBox(height: wide ? 32 : 24),
                      rise(1, label('BESIDE YOUR TILLS')),
                      if (wide)
                        IntrinsicHeight(
                          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                            Expanded(child: rise(1, epos)),
                            const SizedBox(width: 16),
                            Expanded(child: rise(2, kitchen)),
                            const SizedBox(width: 16),
                            Expanded(child: rise(3, display)),
                          ]),
                        )
                      else ...[
                        rise(1, epos),
                        const SizedBox(height: 12),
                        rise(2, kitchen),
                        const SizedBox(height: 12),
                        rise(3, display),
                      ],
                      const SizedBox(height: 28),
                      rise(4, label('NO TILLS')),
                      rise(4, own),
                      const SizedBox(height: 28),
                      rise(5, Center(
                        child: TextButton(
                          onPressed: () => ref.read(tapProvider.notifier).forgetPhone(),
                          child: const Text('Not this venue? Sign out'),
                        ),
                      )),
                    ],
                  ),
                ),
              ),
            ),
          ]),
        );
      }),
    );
  }
}

class _ModeCard extends StatefulWidget {
  const _ModeCard({
    super.key,
    required this.scene,
    required this.tint,
    required this.loop,
    required this.title,
    required this.body,
    required this.onTap,
    this.tall = false,
  });
  final _Scene scene;
  final Color tint;
  final Animation<double> loop;
  final String title;
  final String body;
  final VoidCallback onTap;
  final bool tall;

  @override
  State<_ModeCard> createState() => _ModeCardState();
}

class _ModeCardState extends State<_ModeCard> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final tint = widget.tint;
    final art = Container(
      height: widget.tall ? 150 : 96,
      width: widget.tall ? double.infinity : 120,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(16),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [tint.withValues(alpha: 0.28), tint.withValues(alpha: 0.06)],
        ),
      ),
      child: AnimatedBuilder(
        animation: widget.loop,
        builder: (_, _) => CustomPaint(painter: _ScenePainter(widget.scene, widget.loop.value, tint)),
      ),
    );
    final words = Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text(widget.title, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800, color: Colors.white)),
      const SizedBox(height: 4),
      Text(widget.body, style: t.bodyMedium?.copyWith(color: Colors.white70)),
    ]);
    return Semantics(
      button: true,
      label: '${widget.title}. ${widget.body}',
      excludeSemantics: true,
      child: AnimatedScale(
        scale: _down ? 0.97 : 1,
        duration: const Duration(milliseconds: 140),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          decoration: BoxDecoration(
            color: const Color(0xFF151A13),
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: _down ? tint : tint.withValues(alpha: 0.35), width: _down ? 2 : 1),
            boxShadow: [BoxShadow(color: tint.withValues(alpha: _down ? 0.3 : 0.08), blurRadius: _down ? 28 : 24, spreadRadius: -6, offset: const Offset(0, 6))],
          ),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              borderRadius: BorderRadius.circular(22),
              splashColor: tint.withValues(alpha: 0.18),
              onTap: widget.onTap,
              onHighlightChanged: (v) => setState(() => _down = v),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: widget.tall
                    ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        art,
                        const SizedBox(height: 16),
                        words,
                        const Spacer(),
                        const SizedBox(height: 12),
                        Align(alignment: Alignment.bottomRight, child: Icon(Icons.arrow_forward_rounded, color: tint)),
                      ])
                    : Row(children: [
                        art,
                        const SizedBox(width: 16),
                        Expanded(child: words),
                        Icon(Icons.chevron_right_rounded, color: tint),
                      ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The page's drifting glows.
class _Glow extends CustomPainter {
  _Glow(this.t);
  final double t;

  @override
  void paint(Canvas canvas, Size size) {
    final a = t * 2 * math.pi;
    void glow(Color c, double x, double y, double r) {
      final centre = Offset(size.width * x, size.height * y);
      canvas.drawCircle(
        centre,
        r,
        Paint()..shader = RadialGradient(colors: [c.withValues(alpha: 0.16), c.withValues(alpha: 0)]).createShader(Rect.fromCircle(center: centre, radius: r)),
      );
    }

    final r = math.max(size.width, size.height) * 0.45;
    glow(Tp.lime, 0.15 + 0.05 * math.sin(a), 0.12 + 0.04 * math.cos(a), r);
    glow(_orange, 0.85 + 0.05 * math.cos(a), 0.35 + 0.05 * math.sin(a), r * 0.8);
    glow(_blue, 0.4 + 0.06 * math.sin(a + 1), 0.95 + 0.03 * math.cos(a), r * 0.9);
  }

  @override
  bool shouldRepaint(_Glow old) => old.t != t;
}

/// The small motion pictures, drawn in a box of any size.
class _ScenePainter extends CustomPainter {
  _ScenePainter(this.scene, this.t, this.tint);
  final _Scene scene;
  final double t;
  final Color tint;

  /// 0..1 across [a]..[b] of the loop, eased.
  double _span(double a, double b) => _ease.transform(((t - a) / (b - a)).clamp(0.0, 1.0));

  RRect _rr(double l, double tp, double w, double h, double r) => RRect.fromRectAndRadius(Rect.fromLTWH(l, tp, w, h), Radius.circular(r));

  @override
  void paint(Canvas canvas, Size s) {
    final u = math.min(s.width / 1.6, s.height);
    final o = Offset((s.width - u * 1.6) / 2, (s.height - u) / 2);
    canvas.save();
    canvas.translate(o.dx, o.dy);
    switch (scene) {
      case _Scene.epos:
        _epos(canvas, u);
      case _Scene.kitchen:
        _kitchen(canvas, u);
      case _Scene.display:
        _display(canvas, u);
      case _Scene.own:
        _own(canvas, u);
    }
    canvas.restore();
  }

  Paint get _ink => Paint()..color = Colors.white.withValues(alpha: 0.9);
  Paint get _dim => Paint()..color = Colors.white.withValues(alpha: 0.18);

  /// A till screen; a card comes in, tapped with rings, then a tick.
  void _epos(Canvas c, double u) {
    final screen = _rr(u * 0.18, u * 0.16, u * 0.62, u * 0.68, u * 0.07);
    c.drawRRect(screen, Paint()..color = Colors.black.withValues(alpha: 0.55));
    c.drawRRect(screen, Paint()
      ..color = tint
      ..style = PaintingStyle.stroke
      ..strokeWidth = u * 0.02);
    for (var i = 0; i < 3; i++) {
      c.drawRRect(_rr(u * 0.26, u * (0.26 + i * 0.11), u * 0.3, u * 0.06, u * 0.02), _dim);
    }
    final pay = _span(0.55, 0.75);
    c.drawRRect(_rr(u * 0.26, u * 0.62, u * 0.46, u * 0.12, u * 0.03), Paint()..color = Color.lerp(_dim.color, tint, pay)!);
    // The card slides in from the right and taps.
    final inn = _span(0.05, 0.35) - _span(0.85, 1.0);
    final cx = u * (1.55 - 0.45 * inn);
    final card = _rr(cx - u * 0.22, u * 0.32, u * 0.44, u * 0.28, u * 0.04);
    c.drawRRect(card, Paint()..color = tint);
    c.drawRRect(_rr(cx - u * 0.17, u * 0.4, u * 0.1, u * 0.07, u * 0.015), Paint()..color = Colors.black.withValues(alpha: 0.35));
    // Rings from the tap.
    final ring = _span(0.35, 0.7);
    if (ring > 0 && ring < 1) {
      for (var i = 0; i < 2; i++) {
        final p = (ring - i * 0.25).clamp(0.0, 1.0);
        c.drawCircle(Offset(cx, u * 0.46), u * (0.15 + 0.35 * p), Paint()
          ..color = tint.withValues(alpha: (1 - p) * 0.6)
          ..style = PaintingStyle.stroke
          ..strokeWidth = u * 0.015);
      }
    }
    _tick(c, Offset(u * 0.49, u * 0.68), u * 0.05, _span(0.72, 0.82));
  }

  /// A kitchen board: tickets land one by one; the oldest is ticked and goes.
  void _kitchen(Canvas c, double u) {
    for (var i = 0; i < 3; i++) {
      final land = _span(0.08 + i * 0.16, 0.3 + i * 0.16);
      final done = i == 0 ? _span(0.72, 0.9) : 0.0;
      final x = u * (0.12 + i * 0.47);
      final y = u * (0.16 - 0.5 * (1 - land)) - u * 0.25 * done;
      final alpha = land * (1 - done);
      if (alpha <= 0) continue;
      final ticket = _rr(x, y, u * 0.42, u * 0.66, u * 0.05);
      c.drawRRect(ticket, Paint()..color = Colors.black.withValues(alpha: 0.55 * alpha));
      final head = i == 0 ? Color.lerp(tint, const Color(0xFFFF453A), _span(0.4, 0.6))! : tint;
      c.drawRRect(_rr(x, y, u * 0.42, u * 0.14, u * 0.05), Paint()..color = head.withValues(alpha: alpha));
      for (var l = 0; l < 3; l++) {
        c.drawRRect(_rr(x + u * 0.06, y + u * (0.22 + l * 0.12), u * (0.3 - l * 0.06), u * 0.05, u * 0.02),
            Paint()..color = Colors.white.withValues(alpha: 0.6 * alpha));
      }
      if (i == 0) _tick(c, Offset(x + u * 0.21, y + u * 0.56), u * 0.05, _span(0.62, 0.72));
    }
  }

  /// A customer's screen: the bill's lines appear and the total counts up.
  void _display(Canvas c, double u) {
    final screen = _rr(u * 0.1, u * 0.1, u * 1.4, u * 0.72, u * 0.06);
    c.drawRRect(screen, Paint()..color = Colors.black.withValues(alpha: 0.55));
    c.drawRRect(screen, Paint()
      ..color = tint
      ..style = PaintingStyle.stroke
      ..strokeWidth = u * 0.02);
    c.drawRRect(_rr(u * 0.7, u * 0.82, u * 0.2, u * 0.08, u * 0.02), Paint()..color = tint.withValues(alpha: 0.6));
    // An advert panel on the right, its colour slowly turning.
    c.drawRRect(_rr(u * 0.92, u * 0.18, u * 0.5, u * 0.56, u * 0.04),
        Paint()..color = HSVColor.fromAHSV(0.55, (t * 360) % 360, 0.55, 0.9).toColor());
    for (var i = 0; i < 4; i++) {
      final show = _span(0.08 + i * 0.13, 0.2 + i * 0.13);
      if (show <= 0) continue;
      final y = u * (0.2 + i * 0.1) + u * 0.04 * (1 - show);
      c.drawRRect(_rr(u * 0.2, y, u * 0.42 * show, u * 0.05, u * 0.02), Paint()..color = Colors.white.withValues(alpha: 0.75 * show));
      c.drawRRect(_rr(u * 0.68, y, u * 0.14 * show, u * 0.05, u * 0.02), Paint()..color = Colors.white.withValues(alpha: 0.4 * show));
    }
    final total = _span(0.6, 0.8);
    c.drawRRect(_rr(u * 0.2, u * 0.62, u * 0.62 * total, u * 0.08, u * 0.03), Paint()..color = tint);
  }

  /// A phone: an amount is typed key by key, then paid.
  void _own(Canvas c, double u) {
    final phone = _rr(u * 0.55, u * 0.06, u * 0.5, u * 0.88, u * 0.08);
    c.drawRRect(phone, Paint()..color = Colors.black.withValues(alpha: 0.55));
    c.drawRRect(phone, Paint()
      ..color = tint
      ..style = PaintingStyle.stroke
      ..strokeWidth = u * 0.02);
    final typed = (t * 5).floor().clamp(0, 4);
    c.drawRRect(_rr(u * 0.62, u * 0.16, u * 0.36 * (typed / 4), u * 0.08, u * 0.02), _ink);
    for (var r = 0; r < 3; r++) {
      for (var k = 0; k < 3; k++) {
        final n = r * 3 + k;
        final lit = n == (t * 9 * 2).floor() % 9;
        c.drawCircle(Offset(u * (0.68 + k * 0.12), u * (0.4 + r * 0.14)), u * 0.04,
            Paint()..color = lit ? Tp.lime : Colors.white.withValues(alpha: 0.25));
      }
    }
  }

  void _tick(Canvas c, Offset at, double r, double p) {
    if (p <= 0) return;
    c.drawCircle(at, r * 1.4 * p, Paint()..color = Tp.lime);
    final path = Path()
      ..moveTo(at.dx - r * 0.6, at.dy)
      ..lineTo(at.dx - r * 0.15, at.dy + r * 0.45)
      ..lineTo(at.dx + r * 0.65, at.dy - r * 0.45);
    final metric = path.computeMetrics().first;
    c.drawPath(metric.extractPath(0, metric.length * p), Paint()
      ..color = Colors.black
      ..style = PaintingStyle.stroke
      ..strokeWidth = r * 0.3
      ..strokeCap = StrokeCap.round);
  }

  @override
  bool shouldRepaint(_ScenePainter old) => old.t != t || old.scene != scene;
}
