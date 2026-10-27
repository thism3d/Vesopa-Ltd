/// Paying, as TouchPoint Lite does it: what's to pay at the top, cash with
/// quick notes (£5 £10 £20 £50) and the exact amount, card, and back to the
/// sale. Card is read by this device (a phone's Tap to Pay or a Dojo
/// handheld) or the venue's card machine, through Go's payments,
/// and counts only once Dojo says Captured.
///
/// A note smaller than the bill is taken as part-payment and the rest stays
/// to pay, so a round of £22.28 can be a £20 note and a card.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/payments/payment_service.dart';
import 'package:vesopa_go/ui/pay_motion.dart';
import 'package:vesopa_go/ui/sounds.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../data/journal.dart';
import '../data/lite_state.dart';
import 'receipt_print.dart';
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
  String _via = 'tap';
  int _tip = 0;

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
    // Filed before the tender closes the bill, so the record has the change.
    final rec = closes
        ? ref.read(journalProvider.notifier).record(paid, categoryNames: categoryNames(ref.read(tapProvider)), changeMinor: change)
        : null;
    ref.read(tapProvider.notifier).addTender(bill.id, tender);
    if (rec != null) {
      ref.read(currentSaleProvider.notifier).finished();
      final go = ref.read(tapProvider).config.go;
      GoSounds.play(go, GoSound.approved);
      setState(() => _done = rec);
      // The venue prints every receipt (back office): once the tick is up.
      if (go.printReceiptAuto) WidgetsBinding.instance.addPostFrameCallback((_) => mounted ? printReceipt(context, ref, rec) : null);
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
    _via = via;
    final payments = ref.read(paymentsProvider);
    if (via == 'tap') {
      final why = await payments.whyUnavailable();
      if (why != null) {
        if (mounted) setState(() => _problem = '$why Use the card machine, or take cash.');
        return;
      }
    }
    // The venue's tip (back office), chosen by the customer on a screen of
    // their own, before the card.
    final config = ref.read(tapProvider).config;
    var tip = 0;
    if (config.tips && config.go.customerTip && config.tipPercents.isNotEmpty) {
      if (!mounted) return;
      final chosen = await askTip(context, dueMinor: bill.dueMinor, percents: config.tipPercents);
      if (chosen == null || !mounted) return;
      tip = chosen;
    }
    _sendFirst(bill);
    setState(() {
      _busy = true;
      _problem = null;
      _cardAmount = bill.dueMinor;
      _tip = tip;
      _step = PayStep.preparing;
    });
    final outcome = await payments.take(
      amountMinor: _cardAmount,
      tipMinor: tip,
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
        tipMinor: _tip,
        kind: via,
        at: DateTime.now(),
        clerk: ref.read(tapProvider).clerk?.name ?? '',
        reference: outcome.paymentId,
      ));
    } else {
      if (outcome.result == PayResult.declined) GoSounds.play(ref.read(tapProvider).config.go, GoSound.declined);
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
    if (_step != null) return TapPrompt(amountMinor: _cardAmount + _tip, step: _step!, onMachine: _via == 'machine');

    final bill = ref.watch(tapProvider.select((s) => s.bills[widget.billId]));
    final settings = ref.watch(liteSettingsProvider);
    final allowCash = ref.watch(tapProvider.select((s) => s.config.allowCash));
    final t = Theme.of(context).textTheme;
    if (bill == null) {
      return Scaffold(appBar: AppBar(), body: const Center(child: Text('This sale is closed.')));
    }
    final due = bill.dueMinor;
    final via = cardVia(settings, ref.watch(tapProvider).config, tablet: MediaQuery.sizeOf(context).shortestSide >= 600);
    final other = via == 'tap' ? 'machine' : 'tap';

    final wide = MediaQuery.sizeOf(context).width >= 900;
    final tenders = ConstrainedBox(
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
              _PayButton(key: const ValueKey('pay-card'), icon: Icons.contactless_rounded, label: 'Pay by Card', minor: due, onTap: () => _card(via)),
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
          );
    return Scaffold(
      appBar: AppBar(title: const Text('Pay')),
      body: SafeArea(
        child: wide
            // As the till's payment page: the bill as it will print on the
            // left, the ways to pay on the right.
            ? Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Expanded(child: _BillColumn(bill: bill)),
                const VerticalDivider(width: 1),
                SizedBox(width: 520, child: Center(child: tenders)),
              ])
            : Center(child: tenders),
      ),
    );
  }
}

/// The bill being paid, line by line, as the till shows it beside the tenders.
class _BillColumn extends StatelessWidget {
  const _BillColumn({required this.bill});
  final Bill bill;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return ColoredBox(
      color: Tp.inkCard,
      child: ListView(padding: const EdgeInsets.all(24), children: [
        Text(bill.name, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        Text([if (bill.covers > 0) '${bill.covers} covers', if (bill.clerk.trim().isNotEmpty) bill.clerk].join(' · '), style: t.bodySmall),
        const Divider(height: 28),
        for (final l in bill.lines)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 36, child: Text('${l.quantity}×', style: t.titleSmall?.copyWith(color: Tp.lime, fontFeatures: Tp.tabular))),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(l.product.name, style: t.titleSmall),
                  for (final c in l.choices) Text('+ ${c.name}', style: t.bodySmall),
                  if (l.note.isNotEmpty) Text(l.note, style: t.bodySmall?.copyWith(color: Tp.blue)),
                ]),
              ),
              Money(l.totalMinor, style: t.titleSmall),
            ]),
          ),
        const Divider(height: 28),
        if (bill.discountMinor > 0) ...[
          _Sum('Subtotal', bill.subtotalMinor),
          _Sum('Discount', -bill.discountMinor),
        ],
        for (final tender in bill.tenders) _Sum(tender.kind == 'cash' ? 'Cash' : 'Card', -tender.amountMinor),
        _Sum(bill.paidMinor > 0 ? 'Left to pay' : 'Total', bill.dueMinor, bold: true),
      ]),
    );
  }
}

class _Sum extends StatelessWidget {
  const _Sum(this.label, this.minor, {this.bold = false});
  final String label;
  final int minor;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final style = bold ? t.headlineSmall?.copyWith(fontWeight: FontWeight.w900) : t.bodyLarge;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [Expanded(child: Text(label, style: style)), Money(minor, style: style)]),
    );
  }
}

/// The customer's tip: a centred screen of their own, the venue's percentages
/// as big keys, and no tip as plainly as any of them. Answers the tip in
/// pence, or null if the clerk takes the device back.
Future<int?> askTip(BuildContext context, {required int dueMinor, required List<double> percents}) =>
    Navigator.of(context).push<int>(PageRouteBuilder(
      opaque: true,
      transitionDuration: const Duration(milliseconds: 300),
      pageBuilder: (_, _, _) => _TipScreen(dueMinor: dueMinor, percents: percents),
      transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
    ));

class _TipScreen extends StatelessWidget {
  const _TipScreen({required this.dueMinor, required this.percents});
  final int dueMinor;
  final List<double> percents;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    int tipOf(double p) => (dueMinor * p / 100).round();
    String pc(double p) => p % 1 == 0 ? p.toStringAsFixed(0) : p.toString();
    return Scaffold(
      backgroundColor: Tp.inkDeep,
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Add a tip?', textAlign: TextAlign.center, style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900, color: Colors.white)),
                const SizedBox(height: 8),
                Text('Your bill is ${money(dueMinor)}', textAlign: TextAlign.center, style: t.titleLarge?.copyWith(color: Tp.muted)),
                const SizedBox(height: 32),
                Wrap(alignment: WrapAlignment.center, spacing: 14, runSpacing: 14, children: [
                  for (final p in percents)
                    SizedBox(
                      width: 180,
                      height: 120,
                      child: FilledButton(
                        style: FilledButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20))),
                        onPressed: () => Navigator.pop(context, tipOf(p)),
                        child: Column(mainAxisSize: MainAxisSize.min, children: [
                          Text('${pc(p)}%', style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w900)),
                          Text(money(tipOf(p)), style: const TextStyle(fontSize: 16, fontFeatures: Tp.tabular)),
                        ]),
                      ),
                    ),
                ]),
                const SizedBox(height: 18),
                OutlinedButton(style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(64)), onPressed: () => Navigator.pop(context, 0), child: const Text('No tip')),
                const SizedBox(height: 28),
                TextButton(onPressed: () => Navigator.pop(context), child: const Text('Back to the clerk')),
              ]),
            ),
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
              const Center(child: ApprovedBurst()),
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
              // The customer's choice of receipt (back office: Customer
              // hand-over), as big keys they can press themselves.
              if (ref.watch(tapProvider.select((s) => s.config.go.customerReceiptChoice))) ...[
                const SizedBox(height: 28),
                Text('Would you like a receipt?', textAlign: TextAlign.center, style: t.titleLarge),
                const SizedBox(height: 12),
                Row(children: [
                  for (final (icon, label, onTap) in [
                    (Icons.print_rounded, 'Print', () => printReceipt(context, ref, sale)),
                    (Icons.email_rounded, 'Email', () => emailReceipt(context, ref, sale.id)),
                    (Icons.do_not_disturb_alt_rounded, 'No thanks', () async => Navigator.of(context).popUntil((r) => r.isFirst)),
                  ])
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 5),
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(88)),
                          onPressed: onTap,
                          child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(icon, size: 28), const SizedBox(height: 6), Text(label)]),
                        ),
                      ),
                    ),
                ]),
              ],
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
                    const SizedBox(height: 16),
                    Row(children: [
                      Expanded(
                        child: FilledButton.icon(
                          onPressed: () => printReceipt(c, ref, sale),
                          icon: const Icon(Icons.print_rounded),
                          label: const Text('Print'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: () => emailReceipt(c, ref, sale.id),
                          icon: const Icon(Icons.email_rounded),
                          label: const Text('Email'),
                        ),
                      ),
                    ]),
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
