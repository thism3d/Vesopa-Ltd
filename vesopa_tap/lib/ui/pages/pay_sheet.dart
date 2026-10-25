/// Paying: a tip if they want one, then the phone is turned to the customer
/// and they tap. The bill is settled on the server's confirmation only.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/constants.dart';
import '../../data/bill_math.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../../payments/payment_service.dart';
import '../theme.dart';

class PaySheet extends ConsumerStatefulWidget {
  const PaySheet({super.key, required this.bill, required this.amountMinor, this.items = const {}, this.allowCash = true});
  final Bill bill;
  final int amountMinor;
  final Map<String, int> items;
  final bool allowCash;
  @override
  ConsumerState<PaySheet> createState() => _PaySheetState();
}

class _PaySheetState extends ConsumerState<PaySheet> {
  double _tipPercent = 0;
  PayStep? _step;
  PaymentOutcome? _outcome;

  int get _tip => tipPercent(widget.amountMinor, _tipPercent);

  Future<void> _tap() async {
    final s = ref.read(tapProvider);
    final payments = ref.read(paymentsProvider);
    final why = await payments.whyUnavailable();
    if (why != null) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(why)));
      return;
    }
    setState(() {
      _step = PayStep.preparing;
      _outcome = null;
    });
    final outcome = await payments.take(
      amountMinor: widget.amountMinor,
      tipMinor: _tip,
      billRef: widget.bill.id,
      clerk: s.clerk?.name,
      onStep: (st) => mounted ? setState(() => _step = st) : null,
    );
    if (!mounted) return;
    setState(() {
      _outcome = outcome;
      _step = null;
    });
    if (outcome.paid) {
      HapticFeedback.heavyImpact();
      _settle('tap', outcome.paymentId!);
    }
  }

  void _settle(String kind, String id) {
    final s = ref.read(tapProvider);
    ref.read(tapProvider.notifier).addTender(
          widget.bill.id,
          Tender(id: id, amountMinor: widget.amountMinor, tipMinor: _tip, kind: kind, at: DateTime.now(), clerk: s.clerk?.name ?? ''),
          items: widget.items,
        );
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final total = widget.amountMinor + _tip;
    final outcome = _outcome;

    if (outcome?.paid == true) {
      return _Result(
        icon: Icons.check_circle_rounded,
        colour: Tp.lime,
        title: 'Paid ${money(total)}',
        body: _tip > 0 ? 'Including a ${money(_tip)} tip. Thank you!' : 'Thank you!',
        action: FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Done')),
        secondary: OutlinedButton.icon(
          onPressed: () => ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Receipt by email or text: docs/PLAN.md phase 4'))),
          icon: const Icon(Icons.receipt_rounded),
          label: const Text('Send a receipt'),
        ),
      );
    }

    if (_step != null) {
      final label = switch (_step!) {
        PayStep.preparing => 'Getting ready…',
        PayStep.activating => 'Setting up Tap to Pay on this phone…',
        PayStep.linking => 'Linking the venue\'s account…',
        PayStep.waitingForCard => 'Hold the card or phone near the top of this phone',
        PayStep.confirming => 'Confirming with Dojo…',
        PayStep.done => 'Done',
      };
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Money(total, style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900)),
            const SizedBox(height: 28),
            _Pulse(active: _step == PayStep.waitingForCard),
            const SizedBox(height: 28),
            Text(label, textAlign: TextAlign.center, style: t.titleMedium),
            if (total > contactlessLimitMinor && _step == PayStep.waitingForCard)
              Padding(padding: const EdgeInsets.only(top: 8), child: Text('Over £100: the card will ask for its PIN on this screen.', style: t.bodySmall)),
          ]),
        ),
      );
    }

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(widget.bill.name, style: t.titleMedium),
          Money(total, style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900)),
          const SizedBox(height: 16),
          Text('Add a tip?', style: t.titleSmall),
          const SizedBox(height: 8),
          Row(children: [
            for (final p in const [0.0, 10.0, 12.5, 15.0])
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: ChoiceChip(
                    label: SizedBox(width: double.infinity, child: Text(p == 0 ? 'No tip' : '${p % 1 == 0 ? p.toInt() : p}%', textAlign: TextAlign.center)),
                    selected: _tipPercent == p,
                    onSelected: (_) => setState(() => _tipPercent = p),
                  ),
                ),
              ),
          ]),
          if (outcome != null) ...[
            const SizedBox(height: 16),
            Text(
              switch (outcome.result) {
                PayResult.declined => 'Declined${outcome.message != null ? ': ${outcome.message}' : ''}. Try another card.',
                PayResult.cancelled => 'Cancelled. Nothing was taken.',
                PayResult.uncertain => outcome.message ?? 'Not sure yet.',
                PayResult.unavailable => outcome.message ?? 'Tap to Pay is not available.',
                PayResult.paid => '',
              },
              style: t.bodyMedium?.copyWith(color: outcome.result == PayResult.uncertain ? Tp.amber : Tp.danger),
            ),
          ],
          const SizedBox(height: 20),
          FilledButton.icon(onPressed: _tap, icon: const Icon(Icons.contactless_rounded), label: const Text('Tap to pay on this phone')),
          if (widget.allowCash) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: () {
                _settle('cash', DateTime.now().microsecondsSinceEpoch.toString());
                Navigator.pop(context, true);
              },
              icon: const Icon(Icons.payments_rounded),
              label: const Text('Cash'),
            ),
          ],
        ]),
      ),
    );
  }
}

class _Result extends StatelessWidget {
  const _Result({required this.icon, required this.colour, required this.title, required this.body, required this.action, this.secondary});
  final IconData icon;
  final Color colour;
  final String title;
  final String body;
  final Widget action;
  final Widget? secondary;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Icon(icon, size: 88, color: colour),
          const SizedBox(height: 12),
          Text(title, textAlign: TextAlign.center, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w900)),
          const SizedBox(height: 6),
          Text(body, textAlign: TextAlign.center, style: t.bodyLarge),
          const SizedBox(height: 24),
          action,
          if (secondary != null) ...[const SizedBox(height: 10), secondary!],
        ]),
      ),
    );
  }
}

/// The contactless waves, breathing while the phone waits for a card.
class _Pulse extends StatefulWidget {
  const _Pulse({required this.active});
  final bool active;
  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.of(context).disableAnimations || !widget.active;
    return SizedBox.square(
      dimension: 160,
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, _) => Stack(alignment: Alignment.center, children: [
          if (!still)
            for (final d in const [0.0, 0.5])
              Opacity(
                opacity: (1 - ((_c.value + d) % 1)).clamp(0, 1),
                child: Container(
                  width: 80 + 80 * ((_c.value + d) % 1),
                  height: 80 + 80 * ((_c.value + d) % 1),
                  decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Tp.lime, width: 3)),
                ),
              ),
          const TapMark(size: 84),
        ]),
      ),
    );
  }
}
