/// Paying, as TouchPoint Lite does it: what's to pay at the top, cash with
/// quick notes (£5 £10 £20 £50) and the exact amount, card, and back to the
/// sale. Card is read by this device (a phone's Tap to Pay or a Dojo
/// handheld) or the venue's card machine, through vesopa_tap's payments,
/// and counts only once Dojo says Captured.
///
/// A note smaller than the bill is taken as part-payment and the rest stays
/// to pay, so a round of £22.28 can be a £20 note and a card.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_tap/config/constants.dart' show contactlessLimitMinor;
import 'package:vesopa_tap/data/models.dart';
import 'package:vesopa_tap/data/session.dart';
import 'package:vesopa_tap/payments/payment_service.dart';
import 'package:vesopa_tap/ui/theme.dart';

import '../data/journal.dart';
import '../data/lite_state.dart';
import 'receipt_view.dart';

class PayPage extends ConsumerStatefulWidget {
  const PayPage({super.key, required this.billId});
  final String billId;
  @override
  ConsumerState<PayPage> createState() => _PayPageState();
}

class _PayPageState extends ConsumerState<PayPage> {
  PayStep? _step;
  int _cardAmount = 0;
  String? _problem;
  SaleRecord? _done;
  bool _busy = false;

  Bill? get _bill => ref.read(tapProvider).bills[widget.billId];

  /// The first money in sends anything with a kitchen or bar station to it.
  void _sendFirst(Bill bill) {
    if (bill.hasUnsent) ref.read(tapProvider.notifier).send(bill.id);
  }

  /// Take [tender] towards the bill; on the last penny, file the sale.
  void _take(Tender tender, {int change = 0}) {
    final bill = _bill!;
    final closes = bill.dueMinor - tender.amountMinor <= 0;
    final paid = bill.copyWith(tenders: [...bill.tenders, tender]);
    ref.read(tapProvider.notifier).addTender(bill.id, tender);
    if (closes) {
      final rec = ref.read(journalProvider.notifier).record(paid, categoryNames: categoryNames(ref.read(tapProvider)), changeMinor: change);
      ref.read(currentSaleProvider.notifier).finished();
      HapticFeedback.heavyImpact();
      setState(() => _done = rec);
    } else {
      setState(() {});
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${money(tender.amountMinor)} taken. ${money(_bill!.dueMinor)} left to pay.')));
    }
  }

  void _cash(int tendered) {
    final bill = _bill;
    if (bill == null) return;
    _sendFirst(bill);
    final due = bill.dueMinor;
    final amount = tendered < due ? tendered : due;
    _take(
      Tender(id: 'cash-${DateTime.now().microsecondsSinceEpoch}', amountMinor: amount, kind: 'cash', at: DateTime.now(), clerk: ref.read(tapProvider).clerk?.name ?? ''),
      change: tendered > due ? tendered - due : 0,
    );
  }

  Future<void> _card(String via) async {
    final bill = _bill;
    if (bill == null || _busy) return;
    final payments = ref.read(paymentsProvider);
    if (via == 'tap') {
      final why = await payments.whyUnavailable();
      if (why != null) {
        if (mounted) setState(() => _problem = '$why Use the card machine, or take cash.');
        return;
      }
    }
    _sendFirst(bill);
    setState(() {
      _busy = true;
      _problem = null;
      _cardAmount = bill.dueMinor;
      _step = PayStep.preparing;
    });
    final outcome = await payments.take(
      amountMinor: _cardAmount,
      tipMinor: 0,
      billRef: bill.id,
      clerk: ref.read(tapProvider).clerk?.name,
      via: via,
      onStep: (st) => mounted ? setState(() => _step = st) : null,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = null;
    });
    if (outcome.paid) {
      _take(Tender(
        id: outcome.paymentId!,
        amountMinor: _cardAmount,
        kind: via,
        at: DateTime.now(),
        clerk: ref.read(tapProvider).clerk?.name ?? '',
        reference: outcome.paymentId,
      ));
    } else {
      setState(() => _problem = switch (outcome.result) {
            PayResult.declined => 'Declined${outcome.message != null ? ': ${outcome.message}' : ''}. Try another card.',
            PayResult.cancelled => 'Cancelled. Nothing was taken.',
            PayResult.uncertain => outcome.message ?? 'No answer from Dojo yet. Check the payment before taking it again.',
            PayResult.unavailable => outcome.message ?? 'Card payments are not available on this device.',
            PayResult.paid => null,
          });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_done != null) return _Approved(sale: _done!);
    if (_step != null) return _CardScreen(amountMinor: _cardAmount, step: _step!);

    final bill = ref.watch(tapProvider.select((s) => s.bills[widget.billId]));
    final settings = ref.watch(liteSettingsProvider);
    final allowCash = ref.watch(tapProvider.select((s) => s.config.allowCash));
    final t = Theme.of(context).textTheme;
    if (bill == null) {
      return Scaffold(appBar: AppBar(), body: const Center(child: Text('This sale is closed.')));
    }
    final due = bill.dueMinor;
    final other = settings.cardVia == 'tap' ? 'machine' : 'tap';

    return Scaffold(
      appBar: AppBar(title: const Text('Pay')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: ListView(padding: const EdgeInsets.fromLTRB(20, 4, 20, 20), children: [
              Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Expanded(child: Text('To pay', style: t.titleLarge)),
                Money(due, style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900)),
              ]),
              if (bill.paidMinor > 0)
                Align(alignment: Alignment.centerRight, child: Text('${money(bill.paidMinor)} already taken of ${money(bill.totalMinor)}', style: t.bodySmall)),
              if (allowCash) ...[
                const SizedBox(height: 24),
                _Heading(icon: Icons.payments_rounded, label: 'Cash'),
                Row(children: [
                  for (final n in settings.cashButtons)
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: OutlinedButton(
                          key: ValueKey('cash-$n'),
                          style: OutlinedButton.styleFrom(padding: EdgeInsets.zero),
                          onPressed: () => _cash(n),
                          child: Text('£${n ~/ 100}', style: const TextStyle(fontFeatures: Tp.tabular)),
                        ),
                      ),
                    ),
                ]),
                const SizedBox(height: 10),
                _PayButton(key: const ValueKey('pay-cash'), icon: Icons.payments_rounded, label: 'Pay by Cash', minor: due, onTap: () => _cash(due)),
              ],
              const SizedBox(height: 24),
              _Heading(icon: Icons.credit_card_rounded, label: 'Card'),
              _PayButton(key: const ValueKey('pay-card'), icon: Icons.contactless_rounded, label: 'Pay by Card', minor: due, onTap: () => _card(settings.cardVia)),
              Align(
                child: TextButton(
                  onPressed: () => _card(other),
                  child: Text(other == 'machine' ? 'Use the card machine instead' : 'Tap on this device instead'),
                ),
              ),
              if (_problem != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(_problem!, textAlign: TextAlign.center, style: t.bodyMedium?.copyWith(color: Tp.danger)),
                ),
              const SizedBox(height: 16),
              OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text('Back to Sale')),
            ]),
          ),
        ),
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(children: [
          Icon(icon, size: 18, color: Tp.lime),
          const SizedBox(width: 8),
          Text(label, style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800)),
        ]),
      );
}

/// A wide green key with the amount at its end, as TouchPoint's.
class _PayButton extends StatelessWidget {
  const _PayButton({super.key, required this.icon, required this.label, required this.minor, required this.onTap});
  final IconData icon;
  final String label;
  final int minor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => FilledButton(
        onPressed: onTap,
        child: Row(children: [
          Icon(icon),
          const SizedBox(width: 12),
          Expanded(child: Text(label)),
          Text(money(minor), style: const TextStyle(fontFeatures: Tp.tabular)),
        ]),
      );
}

/// The card's turn: a plain, bright screen with the amount and the waves,
/// so the customer knows where to tap.
class _CardScreen extends StatelessWidget {
  const _CardScreen({required this.amountMinor, required this.step});
  final int amountMinor;
  final PayStep step;

  @override
  Widget build(BuildContext context) {
    final label = switch (step) {
      PayStep.preparing => 'Getting ready…',
      PayStep.activating => 'Setting up card payments on this device…',
      PayStep.linking => 'Linking the venue\'s account…',
      PayStep.waitingForCard => 'Tap your payment card',
      PayStep.onMachine => 'Follow the card machine',
      PayStep.confirming => 'Confirming with Dojo…',
      PayStep.done => 'Done',
    };
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.contactless_outlined, size: 96, color: Tp.ink),
            const SizedBox(height: 24),
            Text(money(amountMinor), style: const TextStyle(fontSize: 48, fontWeight: FontWeight.w900, color: Tp.ink, fontFeatures: Tp.tabular)),
            const SizedBox(height: 16),
            Text(label, style: const TextStyle(fontSize: 18, color: Tp.ink)),
            if (amountMinor > contactlessLimitMinor && step == PayStep.waitingForCard)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('Over £100: the card will ask for its PIN.', style: TextStyle(color: Colors.black54)),
              ),
          ]),
        ),
      ),
    );
  }
}

class _Approved extends ConsumerWidget {
  const _Approved({required this.sale});
  final SaleRecord sale;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = Theme.of(context).textTheme;
    final cash = sale.payments.every((p) => !p.isCard);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: ListView(shrinkWrap: true, padding: const EdgeInsets.all(24), children: [
              const Icon(Icons.check_circle_rounded, size: 96, color: Color(0xFF2BB673)),
              const SizedBox(height: 12),
              Text(cash ? 'Paid' : 'Payment approved!', textAlign: TextAlign.center, style: t.headlineMedium),
              const SizedBox(height: 6),
              if (sale.changeMinor > 0) ...[
                Text('Change', textAlign: TextAlign.center, style: t.titleMedium),
                Text(money(sale.changeMinor),
                    key: const ValueKey('change'),
                    textAlign: TextAlign.center,
                    style: t.displayMedium?.copyWith(fontWeight: FontWeight.w900, color: Tp.lime, fontFeatures: Tp.tabular)),
              ] else
                Text('${money(sale.totalMinor)} · receipt ${sale.number}', textAlign: TextAlign.center, style: t.titleMedium),
              const SizedBox(height: 28),
              FilledButton(
                key: const ValueKey('new-sale'),
                onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
                child: const Text('New sale'),
              ),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                icon: const Icon(Icons.receipt_long_rounded),
                label: const Text('Receipt'),
                onPressed: () => showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  showDragHandle: true,
                  useSafeArea: true,
                  builder: (c) => ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), shrinkWrap: true, children: [
                    ReceiptView(sale: sale),
                    const SizedBox(height: 12),
                    FilledButton.icon(
                      onPressed: () => emailReceipt(c, ref, sale.id),
                      icon: const Icon(Icons.email_rounded),
                      label: const Text('Email it'),
                    ),
                  ]),
                ),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
