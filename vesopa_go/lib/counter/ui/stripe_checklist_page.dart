/// The Stripe checklist: every case a card payment can end in, run on the
/// venue's Stripe test reader, as the Dojo checklist runs Dojo's accreditation
/// cases (owner, 2026-11-07: "payment failed retry and other steps ... like
/// Dojo checklist"). Sandbox only: each case hands the simulated reader one of
/// Stripe's test cards (server: stripe_client.js TEST_CARDS).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart' show money;
import '../../data/session.dart';
import '../../payments/payment_service.dart';
import '../../payments/stripe_tap.dart';
import '../../ui/theme.dart';

/// One case: what the reader is handed, and what the till must make of it.
class StripeCase {
  const StripeCase(this.id, this.title, this.detail, this.card, this.expect, {this.cancel = false});
  final String id;
  final String title;
  final String detail;

  /// The test card the reader is handed; null hands it nothing.
  final String? card;
  final PayResult expect;

  /// The clerk cancels while the reader waits for the card.
  final bool cancel;
}

const stripeCases = [
  StripeCase('S1', 'Approved', 'A good card: the sale is paid.', 'approved', PayResult.paid),
  StripeCase('S2', 'Declined', 'The bank says no: nothing is taken, the clerk can try again.', 'declined', PayResult.declined),
  StripeCase('S3', 'Insufficient funds', 'Declined for lack of funds: nothing is taken.', 'insufficient_funds', PayResult.declined),
  StripeCase('S4', 'Expired card', 'Declined as expired: nothing is taken.', 'expired', PayResult.declined),
  StripeCase('S5', 'Cancelled by the clerk', 'Cancel while the reader waits: the payment is called off.', null, PayResult.cancelled, cancel: true),
];

class StripeChecklistPage extends ConsumerStatefulWidget {
  const StripeChecklistPage({super.key});
  @override
  ConsumerState<StripeChecklistPage> createState() => _StripeChecklistPageState();
}

class _StripeChecklistPageState extends ConsumerState<StripeChecklistPage> {
  final _results = <String, PaymentOutcome>{};
  String? _running;

  Future<void> _run(StripeCase c) async {
    final pay = ref.read(paymentsProvider);
    if (pay is! StripeTapToPay) return;
    setState(() => _running = c.id);
    final control = PayControl();
    if (c.cancel) Future<void>.delayed(const Duration(seconds: 3), control.cancel);
    final outcome = await pay.take(
      amountMinor: 100 + stripeCases.indexOf(c),
      via: 'machine',
      billRef: 'checklist-${c.id}-${DateTime.now().millisecondsSinceEpoch}',
      control: control,
      testCard: c.card ?? 'none',
    );
    if (!mounted) return;
    setState(() {
      _results[c.id] = outcome;
      _running = null;
    });
  }

  Future<void> _runAll() async {
    for (final c in stripeCases) {
      if (!mounted) return;
      await _run(c);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final passed = stripeCases.where((c) => _results[c.id]?.result == c.expect).length;
    return Scaffold(
      appBar: AppBar(title: const Text('Stripe checklist')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Each case takes a small test payment on the Stripe test reader. No real money moves.',
            style: t.bodyMedium?.copyWith(color: context.goMuted)),
        const SizedBox(height: 8),
        Row(children: [
          Text('$passed of ${stripeCases.length} passed', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
          const Spacer(),
          FilledButton.icon(
            onPressed: _running == null ? _runAll : null,
            icon: const Icon(Icons.play_arrow_rounded),
            label: const Text('Run all'),
          ),
        ]),
        const SizedBox(height: 8),
        for (final c in stripeCases)
          Card(
            child: ListTile(
              leading: _running == c.id
                  ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : Icon(
                      _results[c.id] == null
                          ? Icons.radio_button_unchecked_rounded
                          : (_results[c.id]!.result == c.expect ? Icons.check_circle_rounded : Icons.cancel_rounded),
                      color: _results[c.id] == null ? context.goMuted : (_results[c.id]!.result == c.expect ? Tp.green : Tp.danger),
                    ),
              title: Text('${c.id} · ${c.title}', style: const TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(_results[c.id] == null
                  ? c.detail
                  : '${c.detail}\nGot: ${_results[c.id]!.result.name}${_results[c.id]!.message == null ? '' : ' (${_results[c.id]!.message})'} · ${money(100 + stripeCases.indexOf(c))}'),
              isThreeLine: _results[c.id] != null,
              trailing: TextButton(onPressed: _running == null ? () => _run(c) : null, child: const Text('Run')),
            ),
          ),
      ]),
    );
  }
}
