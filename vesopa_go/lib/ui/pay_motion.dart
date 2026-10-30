/// The moments of a payment, in motion: the full-screen "tap here" prompt,
/// and the tick when Dojo says it is paid.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../config/constants.dart' show contactlessLimitMinor;
import '../data/models.dart';
import '../payments/payment_service.dart';
import 'theme.dart';

/// The card's turn. On this device: waves rolling out from where the card
/// goes (the top of an iPhone), the amount large. On the card machine: the
/// machine, and what it is doing.
class TapPrompt extends StatefulWidget {
  const TapPrompt({super.key, required this.amountMinor, required this.step, this.onMachine = false, this.onCancel});
  final int amountMinor;
  final PayStep step;
  final bool onMachine;
  final VoidCallback? onCancel;

  @override
  State<TapPrompt> createState() => _TapPromptState();
}

class _TapPromptState extends State<TapPrompt> with TickerProviderStateMixin {
  late final _waves = AnimationController(vsync: this, duration: const Duration(milliseconds: 2200));
  late final _enter = AnimationController(vsync: this, duration: const Duration(milliseconds: 450))..forward();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ambientMotion(context) && !_waves.isAnimating) _waves.repeat();
  }

  @override
  void dispose() {
    _waves.dispose();
    _enter.dispose();
    super.dispose();
  }

  String get _label => switch (widget.step) {
        PayStep.preparing => 'Getting ready…',
        PayStep.activating => 'Setting up card payments on this device…',
        PayStep.linking => 'Linking the venue\'s account…',
        PayStep.waitingForCard => 'Hold the card here',
        PayStep.onMachine => 'Follow the card machine',
        PayStep.confirming => 'Confirming with Dojo…',
        PayStep.done => 'Done',
      };

  @override
  Widget build(BuildContext context) {
    final waiting = widget.step == PayStep.waitingForCard || widget.step == PayStep.onMachine;
    final machine = widget.onMachine || widget.step == PayStep.onMachine;
    return Scaffold(
      backgroundColor: context.goDeep,
      body: SafeArea(
        child: FadeTransition(
          opacity: _enter,
          child: ScaleTransition(
            scale: Tween(begin: 0.96, end: 1.0).animate(CurvedAnimation(parent: _enter, curve: Curves.easeOutCubic)),
            // The whole width, so everything sits in the middle (it hugged
            // its widest line and drifted left; iPad, 2026-10-30).
            child: SizedBox(
              width: double.infinity,
              child: Column(crossAxisAlignment: CrossAxisAlignment.center, children: [
              const SizedBox(height: 12),
              if (!machine)
                // The card goes at the top of the device: point at it.
                AnimatedBuilder(
                  animation: _waves,
                  builder: (_, _) => Transform.translate(
                    offset: Offset(0, -6 * math.sin(_waves.value * 2 * math.pi)),
                    child: const Icon(Icons.keyboard_double_arrow_up_rounded, size: 40, color: Tp.lime),
                  ),
                ),
              const Spacer(),
              SizedBox(
                width: 260,
                height: 260,
                child: Stack(alignment: Alignment.center, children: [
                  if (waiting)
                    for (var i = 0; i < 3; i++)
                      AnimatedBuilder(
                        animation: _waves,
                        builder: (_, _) {
                          final p = (_waves.value + i / 3) % 1.0;
                          return Opacity(
                            opacity: (1 - p) * 0.8,
                            child: Container(
                              width: 110 + 150 * p,
                              height: 110 + 150 * p,
                              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Tp.lime, width: 3)),
                            ),
                          );
                        },
                      ),
                  Container(
                    width: 120,
                    height: 120,
                    decoration: const BoxDecoration(color: Tp.lime, shape: BoxShape.circle),
                    child: waiting
                        ? Icon(machine ? Icons.point_of_sale_rounded : Icons.contactless_rounded, size: 64, color: Tp.onLime)
                        : const Padding(padding: EdgeInsets.all(34), child: CircularProgressIndicator(strokeWidth: 5, color: Tp.onLime)),
                  ),
                ]),
              ),
              const SizedBox(height: 28),
              Text(money(widget.amountMinor), style: const TextStyle(fontSize: 64, fontWeight: FontWeight.w900, color: Colors.white, fontFeatures: Tp.tabular)),
              const SizedBox(height: 10),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 250),
                child: Text(_label, key: ValueKey(widget.step), style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: Colors.white)),
              ),
              if (widget.amountMinor > contactlessLimitMinor && widget.step == PayStep.waitingForCard)
                Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text('Over £100: the card will ask for its PIN.', style: TextStyle(color: context.goMuted)),
                ),
              const SizedBox(height: 10),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: Text('Visa · Mastercard · Maestro · Amex · Apple Pay · Google Pay',
                    textAlign: TextAlign.center, style: TextStyle(color: context.goMuted, fontSize: 13)),
              ),
              const Spacer(),
              if (widget.onCancel != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 20),
                  child: TextButton(onPressed: widget.onCancel, child: const Text('Cancel')),
                ),
            ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// The tick: a lime disc that springs in with a ring bursting out of it.
class ApprovedBurst extends StatefulWidget {
  const ApprovedBurst({super.key, this.size = 120});
  final double size;
  @override
  State<ApprovedBurst> createState() => _ApprovedBurstState();
}

class _ApprovedBurstState extends State<ApprovedBurst> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..forward();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.size;
    return SizedBox(
      width: s * 1.8,
      height: s * 1.8,
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, _) {
          final pop = Curves.elasticOut.transform(math.min(1, _c.value * 1.4));
          final ring = Curves.easeOut.transform(_c.value);
          return Stack(alignment: Alignment.center, children: [
            Opacity(
              opacity: (1 - ring).clamp(0, 1),
              child: Container(
                width: s * (1 + 0.8 * ring),
                height: s * (1 + 0.8 * ring),
                decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Tp.green, width: 4)),
              ),
            ),
            Transform.scale(
              scale: pop,
              child: Container(
                width: s,
                height: s,
                decoration: const BoxDecoration(color: Tp.green, shape: BoxShape.circle),
                child: Icon(Icons.check_rounded, size: s * 0.62, color: Colors.white),
              ),
            ),
          ]);
        },
      ),
    );
  }
}
