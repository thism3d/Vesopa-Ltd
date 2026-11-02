/// A card payment, as the Windows till shows it (vesopa_epos
/// card_payment_dialog.dart; owner, 2026-11-02: "in the Windows till Dojo
/// payment shows 5 different interactive steps and failed and other issues
/// dialogues"). The amount on a band across the top with the device and
/// Dojo's partner ids; one instruction at a time in the largest type, behind
/// a card graphic that moves the way the customer should; the five steps as a
/// rail (Starting, Present card, Enter PIN, Processing, Complete); and when it
/// ends, the same screen turns into its result with what can be done next.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

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
      PayStep.confirming => (step: CardStep.processing, detail: 'Authorising with the bank'),
      PayStep.done => (step: CardStep.done, detail: 'Payment approved'),
    };

/// What the clerk can do once a payment has not gone through.
typedef CardResultAction = ({IconData icon, String label, VoidCallback onPressed, bool primary});

class CardPayScreen extends StatelessWidget {
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
  });

  final int amountMinor;

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

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final r = result?.result;
    final failed = r != null && r != PayResult.paid;
    final (title, words, colour) = switch (r) {
      PayResult.declined => ('Payment declined', result?.message ?? 'The bank said no. No money has been taken. Try again, or pay another way.', Tp.danger),
      PayResult.cancelled => ('Payment cancelled', 'Nothing was taken.', const Color(0xFFF0A23B)),
      PayResult.uncertain => ('Payment not confirmed', result?.message ?? 'Dojo has not answered yet. Check the payment before taking it again.', const Color(0xFFF0A23B)),
      PayResult.unavailable => ('Payment failed', result?.message ?? 'Card payments are not available on this device.', Tp.danger),
      PayResult.paid => ('Payment approved', 'Thank you.', Tp.lime),
      null => (step.label, detail ?? '', Colors.white),
    };
    return Scaffold(
      backgroundColor: context.goDeep,
      body: SafeArea(
        child: Column(children: [
          // The amount, always in view.
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 24),
            color: Tp.lime.withValues(alpha: 0.12),
            child: Column(children: [
              Text(heading.toUpperCase(), style: t.labelLarge?.copyWith(letterSpacing: 1.4, color: context.goMuted)),
              const SizedBox(height: 4),
              Text(money(amountMinor), style: const TextStyle(fontSize: 48, fontWeight: FontWeight.w900, color: Colors.white, fontFeatures: Tp.tabular)),
              if ((device ?? '').isNotEmpty)
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(Icons.point_of_sale_rounded, size: 15, color: context.goMuted),
                  const SizedBox(width: 6),
                  Flexible(child: Text(device!, overflow: TextOverflow.ellipsis, style: t.bodySmall?.copyWith(color: context.goMuted))),
                ]),
              if ((partner ?? '').isNotEmpty) Text(partner!, style: t.bodySmall?.copyWith(color: context.goMuted)),
              if (test)
                Container(
                  margin: const EdgeInsets.only(top: 8),
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                  decoration: BoxDecoration(color: const Color(0xFFFFF3CD), borderRadius: BorderRadius.circular(99)),
                  child: const Text('TEST PAYMENT · no card is read', style: TextStyle(color: Color(0xFF7A5B00), fontWeight: FontWeight.w700, fontSize: 12)),
                ),
            ]),
          ),
          Expanded(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 560),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    if (r == null && step == CardStep.present && !machine)
                      // Tap to Pay: where to hold the card, on this device's own shape.
                      FittedBox(fit: BoxFit.scaleDown, child: HoldHere(tablet: MediaQuery.sizeOf(context).shortestSide >= 600))
                    else
                      _StageArt(step: r == PayResult.paid ? CardStep.done : step, result: r),
                    const SizedBox(height: 26),
                    // A change of instruction slides in, to be noticed across a counter.
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 260),
                      transitionBuilder: (child, a) => FadeTransition(
                        opacity: a,
                        child: SlideTransition(position: Tween(begin: const Offset(0, 0.12), end: Offset.zero).animate(a), child: child),
                      ),
                      child: Column(key: ValueKey('${step.name}|$title|$words'), children: [
                        Text(title, textAlign: TextAlign.center, style: t.headlineMedium?.copyWith(fontWeight: FontWeight.w800, color: colour)),
                        const SizedBox(height: 10),
                        Text(words, textAlign: TextAlign.center, style: t.titleMedium?.copyWith(color: context.goMuted)),
                      ]),
                    ),
                    if ((resultNote ?? '').isNotEmpty) ...[
                      const SizedBox(height: 16),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                        decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.06), borderRadius: BorderRadius.circular(10)),
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          Icon(Icons.info_outline_rounded, size: 18, color: context.goMuted),
                          const SizedBox(width: 8),
                          Flexible(child: Text(resultNote!)),
                        ]),
                      ),
                    ],
                    const SizedBox(height: 30),
                    // Shrinks to fit on a small phone; full size on an iPad.
                    if (!failed) FittedBox(fit: BoxFit.scaleDown, child: _StepRail(step: r == PayResult.paid ? CardStep.done : step)),
                  ]),
                ),
              ),
            ),
          ),
          if (failed && actions.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
              child: Wrap(alignment: WrapAlignment.center, spacing: 12, runSpacing: 12, children: [
                for (final a in actions)
                  SizedBox(
                    height: 56,
                    child: a.primary
                        ? FilledButton.icon(onPressed: a.onPressed, icon: Icon(a.icon), label: Text(a.label))
                        : OutlinedButton.icon(onPressed: a.onPressed, icon: Icon(a.icon), label: Text(a.label)),
                  ),
              ]),
            ),
        ]),
      ),
    );
  }
}

/// The card graphic: waiting stages pulse, settled ones hold still (a static
/// screen during a wait reads as a frozen till).
class _StageArt extends StatefulWidget {
  const _StageArt({required this.step, this.result});
  final CardStep step;
  final PayResult? result;

  @override
  State<_StageArt> createState() => _StageArtState();
}

class _StageArtState extends State<_StageArt> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final step = widget.step;
    const amber = Color(0xFFF0A23B);
    final (IconData icon, Color colour) = switch (widget.result) {
      PayResult.cancelled => (Icons.block_rounded, amber),
      PayResult.uncertain => (Icons.help_outline_rounded, amber),
      PayResult.declined || PayResult.unavailable => (Icons.error_outline_rounded, Tp.danger),
      _ => switch (step) {
          CardStep.done => (Icons.check_circle_rounded, Tp.lime),
          CardStep.pin => (Icons.dialpad_rounded, Tp.lime),
          CardStep.processing => (Icons.sync_rounded, Tp.lime),
          CardStep.present => (Icons.contactless_rounded, Tp.lime),
          CardStep.starting => (Icons.credit_card_rounded, Tp.lime),
        },
    };
    final animate = widget.result == null && step != CardStep.done;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final v = _c.value;
        return SizedBox(
          height: 180,
          child: Stack(alignment: Alignment.center, children: [
            Transform.scale(
              scale: animate ? 1 + v * 0.28 : 1,
              child: Container(
                width: 140,
                height: 140,
                decoration: BoxDecoration(shape: BoxShape.circle, color: colour.withValues(alpha: animate ? 0.10 * (1 - v) + 0.05 : 0.08)),
              ),
            ),
            Transform.scale(
              scale: animate ? 1 + v * 0.06 : 1,
              child: Container(
                width: 110,
                height: 110,
                decoration: BoxDecoration(shape: BoxShape.circle, color: colour.withValues(alpha: 0.16)),
                child: step == CardStep.processing && widget.result == null
                    ? Padding(padding: const EdgeInsets.all(28), child: CircularProgressIndicator(strokeWidth: 3.5, color: colour))
                    : Icon(icon, size: 56, color: colour),
              ),
            ),
          ]),
        );
      },
    );
  }
}

/// The five steps as dots on a rail, labelled, so the clerk can see how far
/// along the payment is.
class _StepRail extends StatelessWidget {
  const _StepRail({required this.step});
  final CardStep step;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final current = step.index;
    return Row(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (var i = 0; i < CardStep.values.length; i++) ...[
        if (i > 0)
          Container(
            width: 34,
            height: 2,
            margin: const EdgeInsets.only(top: 7, left: 3, right: 3),
            color: i <= current ? Tp.lime : Colors.white.withValues(alpha: 0.15),
          ),
        SizedBox(
          width: 64,
          child: Column(children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 300),
              width: i == current ? 16 : 11,
              height: i == current ? 16 : 11,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: i <= current ? Tp.lime : Colors.white.withValues(alpha: 0.15),
                border: i == current ? Border.all(color: Tp.lime.withValues(alpha: 0.3), width: 4) : null,
              ),
            ),
            const SizedBox(height: 6),
            Text(CardStep.values[i].label, textAlign: TextAlign.center, style: t.labelSmall?.copyWith(color: i <= current ? Colors.white : context.goMuted)),
          ]),
        ),
      ],
    ]);
  }
}

/// Tap to Pay's "hold the card here" (owner, 2026-11-02: "show in iPhone and
/// iPad screen very attractively"): this device drawn as it is held, the
/// contactless waves rippling out of its top edge where the reader is, and a
/// card gliding in to meet them, again and again.
class HoldHere extends StatefulWidget {
  const HoldHere({super.key, required this.tablet});
  final bool tablet;

  @override
  State<HoldHere> createState() => _HoldHereState();
}

class _HoldHereState extends State<HoldHere> with TickerProviderStateMixin {
  late final AnimationController _card = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400))..repeat();
  late final AnimationController _waves = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))..repeat();

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
          // The card: in from above, rests on the reader, lifts away.
          final t = _card.value;
          final inT = Curves.easeOutCubic.transform((t / 0.45).clamp(0.0, 1.0));
          final outT = Curves.easeInCubic.transform(((t - 0.8) / 0.2).clamp(0.0, 1.0));
          final lift = (1 - inT) * 120 + outT * 120;
          final tilt = (1 - inT) * -0.22 + outT * -0.22;
          final resting = t > 0.45 && t < 0.8;
          return Stack(clipBehavior: Clip.none, children: [
            // The device.
            Positioned(
              left: (boxW - deviceW) / 2,
              top: deviceTop,
              child: Container(
                width: deviceW,
                height: deviceH,
                decoration: BoxDecoration(
                  color: const Color(0xFF15181B),
                  borderRadius: BorderRadius.circular(tablet ? 18 : 26),
                  border: Border.all(color: Colors.white.withValues(alpha: 0.28), width: 3),
                  boxShadow: [BoxShadow(color: Tp.lime.withValues(alpha: resting ? 0.35 : 0.12), blurRadius: resting ? 36 : 18)],
                ),
                child: Column(children: [
                  const SizedBox(height: 10),
                  Container(width: tablet ? 8 : 34, height: tablet ? 8 : 9, decoration: BoxDecoration(color: Colors.black, borderRadius: BorderRadius.circular(6))),
                  Expanded(
                    child: Center(
                      child: Icon(resting ? Icons.check_circle_rounded : Icons.contactless_rounded, size: tablet ? 46 : 42, color: resting ? Tp.lime : Colors.white.withValues(alpha: 0.75)),
                    ),
                  ),
                ]),
              ),
            ),
            // Waves from the reader at the top of the device.
            Positioned(
              left: 0,
              right: 0,
              top: deviceTop - 70,
              height: 80,
              child: CustomPaint(painter: _Waves(_waves.value, Tp.lime)),
            ),
            // The card.
            Positioned(
              left: (boxW - 168) / 2,
              top: deviceTop - 92 - lift,
              child: Opacity(
                opacity: (1 - outT).clamp(0.0, 1.0) * (0.35 + 0.65 * inT),
                child: Transform.rotate(
                  angle: tilt,
                  child: Container(
                    width: 168,
                    height: 104,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(12),
                      gradient: const LinearGradient(colors: [Color(0xFFC7E33A), Color(0xFF7F9A0E)], begin: Alignment.topLeft, end: Alignment.bottomRight),
                      boxShadow: const [BoxShadow(color: Color(0x66000000), blurRadius: 16, offset: Offset(0, 8))],
                    ),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Container(width: 26, height: 20, decoration: BoxDecoration(color: const Color(0xFFE8D27A), borderRadius: BorderRadius.circular(4))),
                        const Spacer(),
                        const Icon(Icons.contactless_rounded, size: 20, color: Color(0xFF10130A)),
                      ]),
                      const Spacer(),
                      Container(width: 96, height: 7, decoration: BoxDecoration(color: const Color(0x5510130A), borderRadius: BorderRadius.circular(4))),
                      const SizedBox(height: 6),
                      Container(width: 60, height: 7, decoration: BoxDecoration(color: const Color(0x3310130A), borderRadius: BorderRadius.circular(4))),
                    ]),
                  ),
                ),
              ),
            ),
          ]);
        },
      ),
    );
  }
}

/// Contactless arcs rippling up and out from the reader.
class _Waves extends CustomPainter {
  _Waves(this.t, this.colour);
  final double t;
  final Color colour;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = Offset(size.width / 2, size.height + 6);
    for (var i = 0; i < 3; i++) {
      final p = (t + i / 3) % 1.0;
      final r = 18 + p * 64;
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5
        ..strokeCap = StrokeCap.round
        ..color = colour.withValues(alpha: (1 - p) * 0.85);
      canvas.drawArc(Rect.fromCircle(center: centre, radius: r), math.pi * 1.22, math.pi * 0.56, false, paint);
    }
  }

  @override
  bool shouldRepaint(_Waves old) => old.t != t;
}
