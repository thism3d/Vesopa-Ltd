/// Paying: a tip if the venue offers them, then the phone is turned to the
/// customer and they tap -- or the venue's card machine, or cash. The bill is
/// settled on the server's confirmation only.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/constants.dart';
import '../../data/api.dart';
import '../../data/bill_math.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../../payments/payment_service.dart';
import '../../counter/data/lite_state.dart';
import '../pay_motion.dart';
import '../theme.dart';

class PaySheet extends ConsumerStatefulWidget {
  const PaySheet({super.key, required this.bill, required this.amountMinor, this.items = const {}});
  final Bill bill;
  final int amountMinor;
  final Map<String, int> items;
  @override
  ConsumerState<PaySheet> createState() => _PaySheetState();
}

class _PaySheetState extends ConsumerState<PaySheet> {
  double _tipPercent = 0;
  PayStep? _step;
  PaymentOutcome? _outcome;
  bool _closesBill = false;
  bool _cash = false;
  String _via = 'tap';

  int get _tip => tipPercent(widget.amountMinor, _tipPercent);

  Future<void> _card(String via) async {
    _via = via;
    final s = ref.read(tapProvider);
    final payments = ref.read(paymentsProvider);
    if (via == 'tap') {
      final why = await payments.whyUnavailable();
      if (why != null) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(why)));
        return;
      }
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
      via: via,
      onStep: (st) => mounted ? setState(() => _step = st) : null,
    );
    if (!mounted) return;
    setState(() {
      _outcome = outcome;
      _step = null;
    });
    if (outcome.paid) {
      HapticFeedback.heavyImpact();
      _settle(via, outcome.paymentId!, reference: outcome.paymentId);
    }
  }

  void _settle(String kind, String id, {String? reference}) {
    final s = ref.read(tapProvider);
    _closesBill = (s.bills[widget.bill.id]?.dueMinor ?? 0) - widget.amountMinor <= 0;
    ref.read(tapProvider.notifier).addTender(
          widget.bill.id,
          Tender(id: id, amountMinor: widget.amountMinor, tipMinor: kind == 'cash' ? 0 : _tip, kind: kind, at: DateTime.now(),
              clerk: s.clerk?.name ?? '', reference: reference),
          items: widget.items,
        );
  }

  Future<void> _receipt() async {
    final email = await showDialog<String>(
      context: context,
      builder: (c) {
        final ctl = TextEditingController();
        return AlertDialog(
          title: const Text('Email a receipt'),
          content: TextField(controller: ctl, keyboardType: TextInputType.emailAddress, autofocus: true, decoration: const InputDecoration(labelText: 'Email address')),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('Send')),
          ],
        );
      },
    );
    if (email == null || email.isEmpty || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    if (ref.read(tapProvider).demo) {
      messenger.showSnackBar(SnackBar(content: Text('Demo: a receipt would go to $email')));
      return;
    }
    try {
      // The sale is the bill's own id; give the outbox a moment to deliver it.
      await Future<void>.delayed(const Duration(seconds: 2));
      await ref.read(apiProvider).emailReceipt(widget.bill.id, email);
      messenger.showSnackBar(SnackBar(content: Text('Receipt sent to $email')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final config = ref.watch(tapProvider.select((s) => s.config));
    final tip = _cash ? 0 : _tip;
    final total = widget.amountMinor + tip;
    final outcome = _outcome;

    if (outcome?.paid == true || _cash) {
      return _Result(
        icon: Icons.check_circle_rounded,
        colour: Tp.lime,
        title: _cash ? 'Cash ${money(widget.amountMinor)}' : 'Paid ${money(total)}',
        body: tip > 0 ? 'Including a ${money(tip)} tip. Thank you!' : 'Thank you!',
        action: FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Done')),
        secondary: _closesBill && config.receiptEmail
            ? OutlinedButton.icon(onPressed: _receipt, icon: const Icon(Icons.receipt_rounded), label: const Text('Email a receipt'))
            : null,
      );
    }

    // The card's turn: the same full-screen prompt as the counter's, on the
    // device's whole height (an iPad's sheet would otherwise sit in the middle).
    if (_step != null) {
      return SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.92,
        child: TapPrompt(amountMinor: total, step: _step!, onMachine: _via == 'machine'),
      );
    }
    if (_step != null) {
      final label = switch (_step!) {
        PayStep.preparing => 'Getting ready…',
        PayStep.activating => 'Setting up Tap to Pay on this phone…',
        PayStep.linking => 'Linking the venue\'s account…',
        PayStep.waitingForCard => 'Hold the card or phone near the top of this phone',
        PayStep.onMachine => 'Follow the card machine',
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
          if (config.tips) ...[
            const SizedBox(height: 16),
            Text('Add a tip?', style: t.titleSmall),
            const SizedBox(height: 8),
            Row(children: [
              for (final p in [0.0, ...config.tipPercents])
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
          ],
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
          // The venue's way for this device first (an iPad: the card machine,
          // as Apple offers Tap to Pay on iPhone only), the other beside it.
          Builder(builder: (context) {
            final via = cardVia(ref.watch(liteSettingsProvider), config, tablet: MediaQuery.sizeOf(context).shortestSide >= 600);
            return via == 'tap'
                ? FilledButton.icon(onPressed: () => _card('tap'), icon: const Icon(Icons.contactless_rounded), label: const Text('Tap to Pay on this device'))
                : FilledButton.icon(onPressed: () => _card('machine'), icon: const Icon(Icons.point_of_sale_rounded), label: const Text('Pay on the card machine'));
          }),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: Builder(builder: (context) {
                final tap = cardVia(ref.watch(liteSettingsProvider), config, tablet: MediaQuery.sizeOf(context).shortestSide >= 600) == 'tap';
                return OutlinedButton.icon(
                  onPressed: () => _card(tap ? 'machine' : 'tap'),
                  icon: Icon(tap ? Icons.point_of_sale_rounded : Icons.contactless_rounded),
                  label: Text(tap ? 'Card machine' : 'Tap to Pay'),
                );
              }),
            ),
            if (config.allowCash) ...[
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () {
                    _settle('cash', DateTime.now().microsecondsSinceEpoch.toString());
                    setState(() => _cash = true);
                  },
                  icon: const Icon(Icons.payments_rounded),
                  label: const Text('Cash'),
                ),
              ),
            ],
          ]),
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
