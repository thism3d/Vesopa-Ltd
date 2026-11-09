/// A card payment, as the Windows till shows it (vesopa_epos
/// card_payment_dialog.dart; owner, 2026-11-02: "in the Windows till Dojo
/// payment shows 5 different interactive steps and failed and other issues
/// dialogues"). The amount on a band across the top with the device and
/// Dojo's partner ids; one instruction at a time in the largest type, behind
/// a card graphic that moves the way the customer should; the five steps as a
/// rail (Starting, Present card, Enter PIN, Processing, Complete); and when it
/// ends, the same screen turns into its result with what can be done next.
///
/// MOTION (owner, 2026-11-03: "properly transition smoothly … every frame …
/// as Apple's video showed"). Nothing on this screen jumps: each change of
/// step morphs the stage (fade and scale on Apple's emphasised curve), the
/// glow behind it shifts colour, the rail's line fills to the new step, the
/// result draws itself in (a tick that strokes on, a shake for a decline),
/// and the buttons rise one after another. Every animation runs off a ticker,
/// so it is drawn on every frame the display gives (120 Hz on ProMotion).
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/models.dart';
import '../../payments/payment_service.dart';
import '../../ui/theme.dart';

/// The steps a card sale walks through, as the customer meets them.
enum CardStep {
  starting('Starting'),
  present('Present card'),
  pin('Enter PIN'),
  processing('Processing'),
  done('Complete');

  const CardStep(this.label);
  final String label;
}

/// Go's own progress as one of the till's steps, with the words for it.
({CardStep step, String detail}) cardStepOf(PayStep s, {required bool machine}) => switch (s) {
  PayStep.preparing => (step: CardStep.starting, detail: 'Setting up the payment'),
  PayStep.activating => (step: CardStep.starting, detail: 'Getting Tap to Pay ready on this device'),
  PayStep.linking => (step: CardStep.starting, detail: "Linking the venue's Dojo account"),
  PayStep.waitingForCard => (step: CardStep.present, detail: 'Ask the customer to hold their card or phone at the top of this device'),
  PayStep.onMachine => (step: CardStep.present, detail: 'Ask the customer to tap, insert or swipe on the card machine'),
  PayStep.pin => (step: CardStep.pin, detail: 'The customer is entering their PIN'),
  PayStep.signature => (step: CardStep.processing, detail: "Compare the customer's signature with the one on their card"),
  PayStep.cancelling => (step: CardStep.processing, detail: 'Cancelling on the card machine…'),
  PayStep.confirming => (step: CardStep.processing, detail: 'Authorising with the bank'),
  PayStep.done => (step: CardStep.done, detail: 'Payment approved'),
};

/// What the clerk can do once a payment has not gone through.
typedef CardResultAction = ({IconData icon, String label, VoidCallback onPressed, bool primary});

/// Apple's emphasised ease: quick to move, long to settle.
const Curve kEmphasised = Cubic(0.2, 0.0, 0.0, 1.0);
const _amber = Color(0xFFF0A23B);

class CardPayScreen extends StatefulWidget {
  const CardPayScreen({
    super.key,
    required this.amountMinor,
    required this.heading,
    this.step = CardStep.starting,
    this.detail,
    this.device,
    this.partner,
    this.result,
    this.resultNote,
    this.actions = const [],
    this.test = false,
    this.machine = false,
    this.online,
    this.onCancel,
    this.cancelling = false,
    this.onTurnToCustomer,
    this.topInset = 0,
    this.facing = false,
  });

  /// Turned round to the customer. The card in the hold-here picture then
  /// still comes to the phone's real top edge, where the reader is: on the
  /// customer's side (owner, 2026-11-08).
  final bool facing;

  final int amountMinor;

  /// Room above the amount band. Turned round to the customer, the top of
  /// this screen is the clerk's edge, where the Turn back key sits; without
  /// this the key covered the amount (owner, 2026-11-07).
  final double topInset;

  /// The clerk's Cancel while the payment runs (Dojo: cancel from the till);
  /// null hides it, e.g. once the bank is deciding.
  final VoidCallback? onCancel;

  /// A cancel has been sent and the machine has not said yet.
  final bool cancelling;

  /// Tap to Pay: turn this screen round for the customer to read and tap.
  final VoidCallback? onTurnToCustomer;

  /// On the venue's card machine rather than this device's own reader.
  final bool machine;

  /// "Tap to Pay", "Card machine": above the amount.
  final String heading;
  final CardStep step;
  final String? detail;

  /// This device, or the card machine, under the amount.
  final String? device;

  /// "Software house SL942X04 · Reseller …", as every till payment shows.
  final String? partner;

  /// Set once the payment has finished without being paid.
  final PaymentOutcome? result;

  /// What a status check found, under the result.
  final String? resultNote;
  final List<CardResultAction> actions;

  /// A pretend payment at a test venue.
  final bool test;

  /// Whether the back office answers, for the live line under the rail; null
  /// leaves the line out.
  final bool? online;

  @override
  State<CardPayScreen> createState() => _CardPayScreenState();
}

class _CardPayScreenState extends State<CardPayScreen> {
  @override
  void didUpdateWidget(CardPayScreen old) {
    super.didUpdateWidget(old);
    // A light tick in the hand at each new step; a firm one at the end.
    final r = widget.result?.result;
    if (r != null && r != old.result?.result) {
      r == PayResult.paid ? HapticFeedback.heavyImpact() : HapticFeedback.vibrate();
    } else if (widget.step != old.step) {
      widget.step == CardStep.done ? HapticFeedback.heavyImpact() : HapticFeedback.selectionClick();
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = widget;
    final t = Theme.of(context).textTheme;
    final r = w.result?.result;
    final failed = r != null && r != PayResult.paid;
    final paid = r == PayResult.paid || (r == null && w.step == CardStep.done);
    // The reason, when there is one: a blank one never leaves the clerk guessing.
    final said = (w.result?.message ?? '').trim().isEmpty ? null : w.result!.message!.trim();
    final (title, words, colour) = switch (r) {
      PayResult.declined => ('Payment declined', said ?? 'The bank said no. No money has been taken. Try again, or pay another way.', Tp.danger),
      PayResult.cancelled => ('Payment cancelled', said ?? 'Nothing was taken.', _amber),
      PayResult.uncertain => ('Payment not confirmed', said ?? 'The payment provider has not answered yet. Check the payment before taking it again.', _amber),
      PayResult.unavailable => ('Payment failed', said ?? 'Card payments are not available on this device.', Tp.danger),
      PayResult.paid => ('Payment approved', 'Thank you.', Tp.lime),
      null => (w.step.label, w.detail ?? '', w.step == CardStep.done ? Tp.lime : Colors.white),
    };
    final glow = failed ? colour : Tp.lime;
    final shownStep = paid ? CardStep.done : w.step;
    // What the stage shows; a new key morphs it.
    final stageKey = failed
        ? 'result-${r.name}'
        : paid
        ? 'done'
        : shownStep == CardStep.present && !w.machine
        ? 'hold'
        : 'step-${shownStep.name}';

    return Scaffold(
      backgroundColor: context.goDeep,
      body: TweenAnimationBuilder<Color?>(
        tween: ColorTween(end: glow),
        duration: const Duration(milliseconds: 700),
        curve: kEmphasised,
        builder: (context, g, child) => DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              center: const Alignment(0, -0.1),
              radius: 0.95,
              colors: [
                (g ?? glow).withValues(alpha: paid || failed ? 0.20 : 0.10),
                context.goDeep,
              ],
            ),
          ),
          child: child,
        ),
        child: SafeArea(
          child: Column(
            children: [
              if (w.topInset > 0) SizedBox(height: w.topInset),
              _AmountBand(
                heading: w.heading,
                amountMinor: w.amountMinor,
                device: w.device,
                partner: w.partner,
                test: w.test,
                tint: paid
                    ? Tp.lime
                    : failed
                    ? colour
                    : null,
              ),
              Expanded(
                child: Center(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 560),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // The hold-here picture is taller than the others: the space eases too.
                          AnimatedSize(
                            duration: const Duration(milliseconds: 560),
                            curve: kEmphasised,
                            child: AnimatedSwitcher(
                              duration: const Duration(milliseconds: 560),
                              reverseDuration: const Duration(milliseconds: 260),
                              switchInCurve: kEmphasised,
                              switchOutCurve: Curves.easeInCubic,
                              layoutBuilder: (current, previous) => Stack(alignment: Alignment.center, children: [...previous, ?current]),
                              transitionBuilder: (child, a) => FadeTransition(
                                opacity: a,
                                child: ScaleTransition(scale: Tween(begin: 0.86, end: 1.0).animate(a), child: child),
                              ),
                              child: KeyedSubtree(
                                key: ValueKey(stageKey),
                                child: stageKey == 'hold'
                                    ? FittedBox(
                                        fit: BoxFit.scaleDown,
                                        // The screen is turned half round for the customer, so the
                                        // picture turns back: its card meets the device's real top.
                                        child: RotatedBox(
                                          quarterTurns: w.facing ? 2 : 0,
                                          child: HoldHere(tablet: MediaQuery.sizeOf(context).shortestSide >= 600),
                                        ),
                                      )
                                    : _StageArt(step: shownStep, result: r),
                              ),
                            ),
                          ),
                          const SizedBox(height: 26),
                          // A change of instruction rises into place, to be noticed across a counter.
                          AnimatedSwitcher(
                            duration: const Duration(milliseconds: 420),
                            reverseDuration: const Duration(milliseconds: 180),
                            switchInCurve: kEmphasised,
                            switchOutCurve: Curves.easeIn,
                            layoutBuilder: (current, previous) => Stack(alignment: Alignment.topCenter, children: [...previous, ?current]),
                            transitionBuilder: (child, a) => FadeTransition(
                              opacity: a,
                              child: SlideTransition(
                                position: Tween(begin: const Offset(0, 0.18), end: Offset.zero).animate(a),
                                child: child,
                              ),
                            ),
                            child: Column(
                              key: ValueKey('${w.step.name}|$title|$words'),
                              children: [
                                Text(
                                  title,
                                  textAlign: TextAlign.center,
                                  style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w800, color: colour),
                                ),
                                const SizedBox(height: 10),
                                Text(
                                  words,
                                  textAlign: TextAlign.center,
                                  style: t.titleMedium?.copyWith(color: context.goMuted),
                                ),
                              ],
                            ),
                          ),
                          if ((w.resultNote ?? '').isNotEmpty) ...[
                            const SizedBox(height: 16),
                            _Rise(
                              delay: const Duration(milliseconds: 200),
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                                decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.06), borderRadius: BorderRadius.circular(10)),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(Icons.info_outline_rounded, size: 18, color: context.goMuted),
                                    const SizedBox(width: 8),
                                    Flexible(child: Text(w.resultNote!)),
                                  ],
                                ),
                              ),
                            ),
                          ],
                          const SizedBox(height: 30),
                          // Shrinks to fit on a small phone; full size on an iPad.
                          AnimatedSize(
                            duration: const Duration(milliseconds: 420),
                            curve: kEmphasised,
                            child: failed
                                ? const SizedBox(width: double.infinity)
                                : FittedBox(
                                    fit: BoxFit.scaleDown,
                                    child: _StepRail(step: shownStep),
                                  ),
                          ),
                          if (w.online != null && !failed && !paid) ...[const SizedBox(height: 18), _LiveLine(online: w.online!, machine: w.machine)],
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              // While it runs: the clerk can stop it, and on Tap to Pay turn
              // the screen to the customer. Plain and quiet, as Apple's own
              // payment sheets keep Cancel: never in the customer's way.
              if (!failed && !paid && (w.onCancel != null || w.onTurnToCustomer != null))
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
                  child: Wrap(
                    alignment: WrapAlignment.center,
                    spacing: 12,
                    runSpacing: 8,
                    children: [
                      if (w.onTurnToCustomer != null)
                        SizedBox(
                          height: 50,
                          child: OutlinedButton.icon(
                            key: const ValueKey('turn-to-customer'),
                            onPressed: w.onTurnToCustomer,
                            icon: const Icon(Icons.screen_rotation_alt_rounded),
                            label: const Text('Turn to customer'),
                          ),
                        ),
                      if (w.onCancel != null)
                        SizedBox(
                          height: 50,
                          child: TextButton.icon(
                            key: const ValueKey('cancel-payment'),
                            onPressed: w.cancelling ? null : w.onCancel,
                            style: TextButton.styleFrom(foregroundColor: Tp.danger),
                            icon: w.cancelling
                                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                                : const Icon(Icons.close_rounded),
                            label: Text(w.cancelling ? 'Cancelling…' : 'Cancel payment'),
                          ),
                        ),
                    ],
                  ),
                ),
              if (failed && w.actions.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                  child: Wrap(
                    alignment: WrapAlignment.center,
                    spacing: 12,
                    runSpacing: 12,
                    children: [
                      for (var i = 0; i < w.actions.length; i++)
                        _Rise(
                          // One after another, as the screen settles.
                          delay: Duration(milliseconds: 220 + 70 * i),
                          child: SizedBox(
                            height: 56,
                            child: w.actions[i].primary
                                ? FilledButton.icon(onPressed: w.actions[i].onPressed, icon: Icon(w.actions[i].icon), label: Text(w.actions[i].label))
                                : OutlinedButton.icon(onPressed: w.actions[i].onPressed, icon: Icon(w.actions[i].icon), label: Text(w.actions[i].label)),
                          ),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The amount, always in view; it takes the result's colour when it ends.
class _AmountBand extends StatelessWidget {
  const _AmountBand({required this.heading, required this.amountMinor, this.device, this.partner, this.test = false, this.tint});
  final String heading;
  final int amountMinor;
  final String? device;
  final String? partner;
  final bool test;
  final Color? tint;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 600),
      curve: kEmphasised,
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 24),
      color: (tint ?? Tp.lime).withValues(alpha: tint == null ? 0.12 : 0.22),
      child: Column(
        children: [
          Text(heading.toUpperCase(), style: t.labelLarge?.copyWith(letterSpacing: 1.4, color: context.goMuted)),
          const SizedBox(height: 4),
          AnimatedDefaultTextStyle(
            duration: const Duration(milliseconds: 600),
            curve: kEmphasised,
            // On the theme's own style, so the venue's font carries through.
            style: DefaultTextStyle.of(context).style.copyWith(
              fontSize: 48,
              fontWeight: FontWeight.w900,
              color: tint == Tp.lime ? Tp.lime : Colors.white,
              fontFeatures: Tp.tabular,
            ),
            child: Text(money(amountMinor)),
          ),
          if ((device ?? '').isNotEmpty)
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.point_of_sale_rounded, size: 15, color: context.goMuted),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    device!,
                    overflow: TextOverflow.ellipsis,
                    style: t.bodySmall?.copyWith(color: context.goMuted),
                  ),
                ),
              ],
            ),
          if ((partner ?? '').isNotEmpty) Text(partner!, style: t.bodySmall?.copyWith(color: context.goMuted)),
          if (test)
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
              decoration: BoxDecoration(color: const Color(0xFFFFF3CD), borderRadius: BorderRadius.circular(99)),
              child: const Text(
                'TEST PAYMENT · no card is read',
                style: TextStyle(color: Color(0xFF7A5B00), fontWeight: FontWeight.w700, fontSize: 12),
              ),
            ),
        ],
      ),
    );
  }
}

/// Fades and rises into place after [delay].
class _Rise extends StatefulWidget {
  const _Rise({required this.child, this.delay = Duration.zero});
  final Widget child;
  final Duration delay;

  @override
  State<_Rise> createState() => _RiseState();
}

class _RiseState extends State<_Rise> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 520));

  @override
  void initState() {
    super.initState();
    Future<void>.delayed(widget.delay, () {
      if (mounted) _c.forward();
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final a = CurvedAnimation(parent: _c, curve: kEmphasised);
    return FadeTransition(
      opacity: a,
      child: SlideTransition(
        position: Tween(begin: const Offset(0, 0.4), end: Offset.zero).animate(a),
        child: widget.child,
      ),
    );
  }
}

/// The card graphic. Waiting stages breathe with ripples running out of
/// them; processing turns a sweep of light round the ring; approval strokes a
/// tick on with a burst; a decline shakes its head.
class _StageArt extends StatefulWidget {
  const _StageArt({required this.step, this.result});
  final CardStep step;
  final PayResult? result;

  @override
  State<_StageArt> createState() => _StageArtState();
}

class _StageArtState extends State<_StageArt> with TickerProviderStateMixin {
  /// Always running: the breath, the ripples and the processing sweep.
  late final AnimationController _loop = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400))..repeat();

  /// Once, when the stage arrives: the tick, the burst, the shake.
  late final AnimationController _enter = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..forward();

  @override
  void dispose() {
    _loop.dispose();
    _enter.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final step = widget.step;
    final res = widget.result;
    final (IconData icon, Color colour) = switch (res) {
      PayResult.cancelled => (Icons.block_rounded, _amber),
      PayResult.uncertain => (Icons.help_outline_rounded, _amber),
      PayResult.declined || PayResult.unavailable => (Icons.close_rounded, Tp.danger),
      _ => switch (step) {
        CardStep.done => (Icons.check_rounded, Tp.lime),
        CardStep.pin => (Icons.dialpad_rounded, Tp.lime),
        CardStep.processing => (Icons.sync_rounded, Tp.lime),
        CardStep.present => (Icons.contactless_rounded, Tp.lime),
        CardStep.starting => (Icons.credit_card_rounded, Tp.lime),
      },
    };
    final done = res == PayResult.paid || (res == null && step == CardStep.done);
    final failed = res != null && res != PayResult.paid;
    final waiting = !done && !failed;
    final processing = waiting && step == CardStep.processing;

    return SizedBox(
      width: 220,
      height: 200,
      child: AnimatedBuilder(
        animation: Listenable.merge([_loop, _enter]),
        builder: (context, _) {
          final loop = _loop.value;
          final enter = _enter.value;
          final breath = 0.5 + 0.5 * math.sin(loop * 2 * math.pi);
          // A spring into place: overshoots a touch and settles.
          final pop = Curves.elasticOut.transform(Curves.easeOut.transform(enter).clamp(0.0, 1.0));
          final scale = done || failed ? 0.6 + 0.4 * pop : 1 + breath * 0.04;
          // A decline's shake, dying away.
          final shake = res == PayResult.declined || res == PayResult.unavailable ? math.sin(enter * math.pi * 7) * (1 - enter) * 14 : 0.0;
          return Stack(
            alignment: Alignment.center,
            children: [
              CustomPaint(
                size: const Size(220, 200),
                painter: _Halo(colour: colour, loop: loop, enter: enter, ripples: waiting, sweep: processing, burst: done),
              ),
              Transform.translate(
                offset: Offset(shake, 0),
                child: Transform.scale(
                  scale: scale,
                  child: Container(
                    width: 112,
                    height: 112,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: colour.withValues(alpha: done || failed ? 0.22 : 0.16),
                      boxShadow: [
                        BoxShadow(
                          color: colour.withValues(alpha: 0.18 + 0.12 * breath),
                          blurRadius: 28 + 10 * breath,
                        ),
                      ],
                    ),
                    child: done ? CustomPaint(painter: _Tick(Curves.easeInOutCubic.transform(((enter - 0.15) / 0.55).clamp(0.0, 1.0)), colour)) : Icon(icon, size: 56, color: colour),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// What runs round the stage's circle: ripples while waiting, a sweep of
/// light while processing, a ring and sparks on approval.
class _Halo extends CustomPainter {
  _Halo({required this.colour, required this.loop, required this.enter, required this.ripples, required this.sweep, required this.burst});
  final Color colour;
  final double loop;
  final double enter;
  final bool ripples;
  final bool sweep;
  final bool burst;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    if (ripples) {
      for (var i = 0; i < 3; i++) {
        final p = (loop * 1.5 + i / 3) % 1.0;
        final eased = Curves.easeOutCubic.transform(p);
        canvas.drawCircle(
          c,
          58 + eased * 40,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2.5 * (1 - p) + 0.5
            ..color = colour.withValues(alpha: (1 - p) * 0.5),
        );
      }
    }
    if (sweep) {
      final rect = Rect.fromCircle(center: c, radius: 70);
      final angle = loop * 2 * math.pi * 2;
      canvas.drawArc(
        rect,
        angle,
        math.pi * 1.3,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 5
          ..strokeCap = StrokeCap.round
          ..shader = SweepGradient(startAngle: 0, endAngle: math.pi * 1.3, colors: [colour.withValues(alpha: 0), colour], transform: GradientRotation(angle)).createShader(rect),
      );
    }
    if (burst) {
      final p = Curves.easeOutCubic.transform(enter);
      canvas.drawCircle(
        c,
        56 + p * 46,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 4 * (1 - p)
          ..color = colour.withValues(alpha: (1 - p) * 0.8),
      );
      for (var i = 0; i < 12; i++) {
        final a = i / 12 * 2 * math.pi + 0.26;
        final r = 62 + p * (i.isEven ? 40 : 30);
        canvas.drawCircle(c + Offset(math.cos(a), math.sin(a)) * r, 3.2 * (1 - p), Paint()..color = colour.withValues(alpha: 1 - p));
      }
    }
  }

  @override
  bool shouldRepaint(_Halo o) => o.loop != loop || o.enter != enter || o.colour != colour || o.ripples != ripples || o.sweep != sweep || o.burst != burst;
}

/// A tick that strokes itself on, [p] from 0 to 1.
class _Tick extends CustomPainter {
  _Tick(this.p, this.colour);
  final double p;
  final Color colour;

  @override
  void paint(Canvas canvas, Size size) {
    if (p <= 0) return;
    final s = size.width;
    final path = Path()
      ..moveTo(s * 0.29, s * 0.52)
      ..lineTo(s * 0.44, s * 0.66)
      ..lineTo(s * 0.72, s * 0.37);
    final metric = path.computeMetrics().first;
    canvas.drawPath(
      metric.extractPath(0, metric.length * p),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = s * 0.085
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = colour,
    );
  }

  @override
  bool shouldRepaint(_Tick o) => o.p != p || o.colour != colour;
}

/// The five steps as dots on a rail, labelled, so the clerk can see how far
/// along the payment is. The line fills smoothly to the new step, the dot
/// springs up, and the current one keeps a soft pulse.
class _StepRail extends StatefulWidget {
  const _StepRail({required this.step});
  final CardStep step;

  @override
  State<_StepRail> createState() => _StepRailState();
}

class _StepRailState extends State<_StepRail> with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..repeat();

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  static const _dot = 64.0;
  static const _gap = 40.0;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final n = CardStep.values.length;
    final width = n * _dot + (n - 1) * _gap;
    final dim = Colors.white.withValues(alpha: 0.15);
    return TweenAnimationBuilder<double>(
      tween: Tween(end: widget.step.index.toDouble()),
      duration: const Duration(milliseconds: 650),
      curve: kEmphasised,
      builder: (context, progress, _) => SizedBox(
        width: width,
        child: Stack(
          children: [
            // The rail behind the dots, and its filled part.
            Positioned(
              left: _dot / 2,
              right: _dot / 2,
              top: 7,
              child: Container(height: 2, color: dim),
            ),
            Positioned(
              left: _dot / 2,
              top: 7,
              child: Container(height: 2, width: (width - _dot) * (progress / (n - 1)), color: Tp.lime),
            ),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var i = 0; i < n; i++) ...[
                  if (i > 0) const SizedBox(width: _gap),
                  SizedBox(
                    width: _dot,
                    child: Column(
                      children: [
                        SizedBox(
                          height: 16,
                          child: Stack(
                            alignment: Alignment.center,
                            clipBehavior: Clip.none,
                            children: [
                              if (i == widget.step.index)
                                AnimatedBuilder(
                                  animation: _pulse,
                                  builder: (_, _) => Container(
                                    width: 16 + 14 * _pulse.value,
                                    height: 16 + 14 * _pulse.value,
                                    decoration: BoxDecoration(
                                      shape: BoxShape.circle,
                                      color: Tp.lime.withValues(alpha: 0.35 * (1 - _pulse.value)),
                                    ),
                                  ),
                                ),
                              AnimatedScale(
                                duration: const Duration(milliseconds: 450),
                                curve: Curves.easeOutBack,
                                scale: i == widget.step.index ? 1.0 : 0.7,
                                child: AnimatedContainer(
                                  duration: const Duration(milliseconds: 450),
                                  curve: kEmphasised,
                                  width: 16,
                                  height: 16,
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    color: progress >= i - 0.05 ? Tp.lime : const Color(0xFF2A2F33),
                                    border: Border.all(color: progress >= i - 0.05 ? Tp.lime : dim, width: 2),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 6),
                        AnimatedDefaultTextStyle(
                          duration: const Duration(milliseconds: 400),
                          style: (t.labelSmall ?? const TextStyle()).copyWith(
                            color: i <= widget.step.index ? Colors.white : context.goMuted,
                            fontWeight: i == widget.step.index ? FontWeight.w800 : FontWeight.w500,
                          ),
                          child: Text(CardStep.values[i].label, textAlign: TextAlign.center),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// The links a payment needs, live under the rail: the back office, and this
/// device's reader or the card machine.
class _LiveLine extends StatefulWidget {
  const _LiveLine({required this.online, required this.machine});
  final bool online;
  final bool machine;

  @override
  State<_LiveLine> createState() => _LiveLineState();
}

class _LiveLineState extends State<_LiveLine> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1800))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Widget _link(IconData icon, String label, bool ok, double phase) {
    final colour = ok ? Tp.lime : _amber;
    final pulse = 0.5 + 0.5 * math.sin((_c.value + phase) * 2 * math.pi);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: colour,
            boxShadow: [
              BoxShadow(
                color: colour.withValues(alpha: 0.6 * pulse),
                blurRadius: 8 * pulse + 2,
              ),
            ],
          ),
        ),
        const SizedBox(width: 6),
        Icon(icon, size: 15, color: context.goMuted),
        const SizedBox(width: 4),
        Text(label, style: TextStyle(fontSize: 12.5, color: context.goMuted)),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _c,
    builder: (context, _) => Wrap(
      alignment: WrapAlignment.center,
      spacing: 18,
      runSpacing: 6,
      children: [
        _link(Icons.cloud_done_rounded, widget.online ? 'Back office' : 'Back office offline', widget.online, 0),
        _link(widget.machine ? Icons.point_of_sale_rounded : Icons.contactless_rounded, widget.machine ? 'Card machine' : 'Reader on', true, 0.33),
        _link(Icons.lock_rounded, 'Encrypted', true, 0.66),
      ],
    ),
  );
}

/// Tap to Pay's "hold the card here" (owner, 2026-11-02: "show in iPhone and
/// iPad screen very attractively"): this device drawn as it is held, the
/// contactless waves rippling out of its top edge where the reader is, and a
/// card gliding in to meet them, again and again. One timeline drives it all,
/// so the card's shadow, the device's glow, the waves and the tick on its
/// screen move together with the card rather than switching on and off.
class HoldHere extends StatefulWidget {
  const HoldHere({super.key, required this.tablet});
  final bool tablet;

  @override
  State<HoldHere> createState() => _HoldHereState();
}

class _HoldHereState extends State<HoldHere> with TickerProviderStateMixin {
  late final AnimationController _card = AnimationController(vsync: this, duration: const Duration(milliseconds: 3000))..repeat();
  late final AnimationController _waves = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500))..repeat();

  @override
  void dispose() {
    _card.dispose();
    _waves.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tablet = widget.tablet;
    // The device as it is held: an iPhone upright, an iPad on its side.
    final deviceW = tablet ? 230.0 : 128.0;
    final deviceH = tablet ? 168.0 : 236.0;
    const boxW = 360.0;
    // Room above the device for the card to come in from.
    final boxH = tablet ? 300.0 : 360.0;
    final deviceTop = boxH - deviceH - 6;
    return SizedBox(
      width: boxW,
      height: boxH,
      child: AnimatedBuilder(
        animation: Listenable.merge([_card, _waves]),
        builder: (context, _) {
          // In from above (0–0.4), held on the reader (0.4–0.72), lifted away
          // (0.72–0.92), a beat of nothing, again.
          final t = _card.value;
          final inT = kEmphasised.transform((t / 0.4).clamp(0.0, 1.0));
          final outT = Curves.easeInOutCubic.transform(((t - 0.72) / 0.2).clamp(0.0, 1.0));
          final away = (1 - inT) + outT;
          final lift = away * 130;
          // How close the card is to the reader, 0 far to 1 touching.
          final near = (1 - away).clamp(0.0, 1.0);
          // The read: the device's tick strokes on while the card rests.
          final read = Curves.easeOutCubic.transform(((t - 0.46) / 0.18).clamp(0.0, 1.0)) * (1 - outT);
          return Stack(
            clipBehavior: Clip.none,
            children: [
              // The device.
              Positioned(
                left: (boxW - deviceW) / 2,
                top: deviceTop,
                child: Container(
                  width: deviceW,
                  height: deviceH,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF1C2024), Color(0xFF0F1214)]),
                    borderRadius: BorderRadius.circular(tablet ? 18 : 26),
                    border: Border.all(color: Color.lerp(Colors.white.withValues(alpha: 0.28), Tp.lime, read * 0.8)!, width: 3),
                    boxShadow: [
                      BoxShadow(
                        color: Tp.lime.withValues(alpha: 0.10 + 0.32 * near),
                        blurRadius: 16 + 26 * near,
                      ),
                    ],
                  ),
                  child: Column(
                    children: [
                      const SizedBox(height: 10),
                      Container(
                        width: tablet ? 8 : 34,
                        height: tablet ? 8 : 9,
                        decoration: BoxDecoration(color: Colors.black, borderRadius: BorderRadius.circular(6)),
                      ),
                      Expanded(
                        child: Center(
                          child: SizedBox(
                            width: 64,
                            height: 64,
                            child: Stack(
                              alignment: Alignment.center,
                              children: [
                                Opacity(
                                  opacity: 1 - read,
                                  child: Icon(Icons.contactless_rounded, size: tablet ? 46 : 42, color: Colors.white.withValues(alpha: 0.75)),
                                ),
                                Opacity(
                                  opacity: read,
                                  child: Transform.scale(
                                    scale: 0.7 + 0.3 * read,
                                    child: Container(
                                      width: 56,
                                      height: 56,
                                      decoration: BoxDecoration(shape: BoxShape.circle, color: Tp.lime.withValues(alpha: 0.2)),
                                      child: CustomPaint(painter: _Tick(read, Tp.lime)),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              // Waves from the reader at the top of the device, stronger as the card nears.
              Positioned(
                left: 0,
                right: 0,
                top: deviceTop - 70,
                height: 80,
                child: CustomPaint(painter: _Waves(_waves.value, Tp.lime, 0.45 + 0.55 * near)),
              ),
              // The card: tipped back in perspective as it comes, flat on the reader.
              Positioned(
                left: (boxW - 168) / 2,
                top: deviceTop - 92 - lift,
                child: Opacity(
                  opacity: (1 - outT * 0.9).clamp(0.0, 1.0) * (0.25 + 0.75 * inT),
                  child: Transform(
                    alignment: Alignment.bottomCenter,
                    transform: Matrix4.identity()
                      ..setEntry(3, 2, 0.0016)
                      ..rotateX(away * 0.7)
                      ..rotateZ(away * -0.16),
                    child: Container(
                      width: 168,
                      height: 104,
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(12),
                        gradient: LinearGradient(colors: const [Color(0xFFD4EC4A), Color(0xFFA5C715), Color(0xFF6E8A0E)], begin: Alignment(-1 + near * 0.6, -1), end: const Alignment(1, 1)),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withValues(alpha: 0.25 + 0.2 * near),
                            blurRadius: 10 + 22 * away.clamp(0.0, 1.0),
                            offset: Offset(0, 4 + 18 * away.clamp(0.0, 1.0)),
                          ),
                        ],
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Container(
                                width: 26,
                                height: 20,
                                decoration: BoxDecoration(color: const Color(0xFFE8D27A), borderRadius: BorderRadius.circular(4)),
                              ),
                              const Spacer(),
                              const Icon(Icons.contactless_rounded, size: 20, color: Color(0xFF10130A)),
                            ],
                          ),
                          const Spacer(),
                          Container(
                            width: 96,
                            height: 7,
                            decoration: BoxDecoration(color: const Color(0x5510130A), borderRadius: BorderRadius.circular(4)),
                          ),
                          const SizedBox(height: 6),
                          Container(
                            width: 60,
                            height: 7,
                            decoration: BoxDecoration(color: const Color(0x3310130A), borderRadius: BorderRadius.circular(4)),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Contactless arcs rippling up and out from the reader.
class _Waves extends CustomPainter {
  _Waves(this.t, this.colour, this.strength);
  final double t;
  final Color colour;
  final double strength;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = Offset(size.width / 2, size.height + 6);
    for (var i = 0; i < 3; i++) {
      final p = (t + i / 3) % 1.0;
      final r = 18 + Curves.easeOutCubic.transform(p) * 64;
      // Fade in at the start as well as out at the end, so no arc pops.
      final alpha = math.sin(p * math.pi) * 0.9 * strength;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5 - 2 * p
        ..strokeCap = StrokeCap.round
        ..color = colour.withValues(alpha: alpha);
      canvas.drawArc(Rect.fromCircle(center: centre, radius: r), math.pi * 1.22, math.pi * 0.56, false, paint);
    }
  }

  @override
  bool shouldRepaint(_Waves old) => old.t != t || old.strength != strength;
}
