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
import 'package:vesopa_go/data/bill_math.dart';
import 'package:vesopa_go/ui/pages/customers_page.dart';
import 'package:vesopa_go/ui/pages/member_sheet.dart';

import 'receipt_print.dart';
import 'receipt_view.dart';
import 'sale_panel.dart' show discountBill;
import 'till_pay_board.dart';

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

  /// A gratuity chosen with the Gratuity key, for the next card.
  int _presetTip = 0;

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

  Future<void> _card(String via, {int? amount}) async {
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
    var tip = _presetTip;
    if (tip == 0 && config.tips && config.go.customerTip && config.tipPercents.isNotEmpty) {
      if (!mounted) return;
      final chosen = await askTip(context, dueMinor: bill.dueMinor, percents: config.tipPercents);
      if (chosen == null || !mounted) return;
      tip = chosen;
    }
    _sendFirst(bill);
    setState(() {
      _busy = true;
      _problem = null;
      _cardAmount = (amount ?? bill.dueMinor).clamp(1, bill.dueMinor);
      _tip = tip;
      _presetTip = 0;
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

  /// A card taken on a machine Go is not connected to (the till's Manual
  /// card): recorded as card, after the clerk confirms it went through.
  Future<void> _manualCard(int amount) async {
    final bill = _bill;
    if (bill == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Card ${money(amount)} on another machine?'),
        content: const Text('Only when the card machine has printed an approved slip for it.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('It was approved')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    _sendFirst(bill);
    final id = 'manual-${DateTime.now().microsecondsSinceEpoch}';
    _take(Tender(id: id, amountMinor: amount, kind: 'machine', at: DateTime.now(), clerk: ref.read(tapProvider).clerk?.name ?? '', reference: 'manual:$id'));
  }

  /// Split bill: how many ways; each share goes on the pad.
  Future<int?> _split() async {
    final bill = _bill;
    if (bill == null) return null;
    final ways = await showDialog<int>(
      context: context,
      builder: (c) => SimpleDialog(title: const Text('Split equally between'), children: [
        Wrap(alignment: WrapAlignment.center, spacing: 8, runSpacing: 8, children: [
          for (var n = 2; n <= 10; n++) OutlinedButton(onPressed: () => Navigator.pop(c, n), child: Text('$n')),
        ]),
      ]),
    );
    if (ways == null) return null;
    final shares = splitEqually(bill.dueMinor, ways);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$ways ways: ${shares.map(money).toSet().join(' or ')} each. Take each share in turn.')));
    }
    return shares.first;
  }

  Future<void> _gratuity() async {
    final bill = _bill;
    final config = ref.read(tapProvider).config;
    if (bill == null) return;
    final tip = await askTip(context, dueMinor: bill.dueMinor, percents: config.tipPercents.isEmpty ? const [10, 12.5, 15] : config.tipPercents);
    if (tip != null && mounted) setState(() => _presetTip = tip);
  }

  @override
  Widget build(BuildContext context) {
    if (_done != null) return _Approved(sale: _done!);
    // The customer's screens stay dark whatever the appearance.
    if (_step != null) return Theme(data: Tp.theme(Brightness.dark), child: TapPrompt(amountMinor: _cardAmount + _tip, step: _step!, onMachine: _via == 'machine'));

    final bill = ref.watch(tapProvider.select((s) => s.bills[widget.billId]));
    final settings = ref.watch(liteSettingsProvider);
    final config = ref.watch(tapProvider.select((s) => s.config));
    if (bill == null) {
      return Scaffold(appBar: AppBar(), body: const Center(child: Text('This sale is closed.')));
    }
    final via = cardVia(settings, config, tablet: MediaQuery.sizeOf(context).shortestSide >= 600);
    final teya = config.teya.enabled;
    final other = via == 'tap' ? 'machine' : 'tap';
    final notes = CashNote.listFrom(config.cashNotes);
    final board = TillPayBoard(
      bill: bill,
      allowCash: config.allowCash,
      notes: notes.isNotEmpty ? notes : [for (final n in settings.cashButtons) CashNote(valueMinor: n, label: money(n))],
      problem: _problem,
      tipMinor: _presetTip,
      actions: PayActions(
        cash: _cash,
        card: (amount) => _card(via, amount: amount),
        cardLabel: 'Card',
        otherCard: teya ? null : (amount) => _card(other, amount: amount),
        otherCardLabel: other == 'machine' ? 'Card machine' : 'Tap to Pay',
        manualCard: _manualCard,
        split: _split,
        voucher: () => askVoucher(context, ref, bill),
        points: bill.member == null
            ? null
            : () => showModalBottomSheet<void>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => MemberSheet(billId: bill.id)),
        discount: () => discountBill(context, ref, bill),
        customer: () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => Scaffold(appBar: AppBar(title: const Text('Customer')), body: CustomersPage(billId: bill.id)),
            )),
        gratuity: _gratuity,
        printBill: () => printBill(context, ref, bill),
      ),
    );
    // The till's two tabs: paying, and the bill as it will print.
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        // The till's payment board: a black canvas in Night, stone in Day.
        backgroundColor: PayPalette.of(context).canvas,
        appBar: AppBar(
          backgroundColor: PayPalette.of(context).canvas,
          title: const Text('Payment'),
          bottom: const TabBar(tabs: [Tab(text: 'Pay'), Tab(text: 'Check')]),
        ),
        body: SafeArea(
          child: TabBarView(children: [
            board,
            Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 560), child: _BillColumn(bill: bill))),
          ]),
        ),
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
      color: context.goCard,
      child: ListView(padding: const EdgeInsets.all(24), children: [
        Text(bill.name, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
        Text([if (bill.covers > 0) '${bill.covers} covers', if (bill.clerk.trim().isNotEmpty) bill.clerk].join(' · '), style: t.bodySmall),
        const Divider(height: 28),
        for (final l in bill.lines)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 36, child: Text('${l.quantity}×', style: t.titleSmall?.copyWith(color: context.goLimeInk, fontFeatures: Tp.tabular))),
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
      pageBuilder: (_, _, _) => Theme(data: Tp.theme(Brightness.dark), child: _TipScreen(dueMinor: dueMinor, percents: percents)),
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
      backgroundColor: context.goDeep,
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Add a tip?', textAlign: TextAlign.center, style: t.displaySmall?.copyWith(fontWeight: FontWeight.w900, color: Colors.white)),
                const SizedBox(height: 8),
                Text('Your bill is ${money(dueMinor)}', textAlign: TextAlign.center, style: t.titleLarge?.copyWith(color: context.goMuted)),
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
                    style: t.displayMedium?.copyWith(fontWeight: FontWeight.w900, color: context.goLimeInk, fontFeatures: Tp.tabular)),
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
                // Short and plain (owner, 2026-10-28), under the two keys.
                const SizedBox(height: 8),
                Center(
                  child: TextButton(
                    onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
                    child: const Text('No thanks'),
                  ),
                ),
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
