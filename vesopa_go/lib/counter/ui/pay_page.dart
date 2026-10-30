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
import 'package:vesopa_go/ui/pages/member_sheet.dart';

import 'receipt_print.dart';
import 'receipt_view.dart';
import 'sale_panel.dart' show discountBill;
import 'tender_dialogs.dart';
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
    ref.read(tapProvider.notifier).addTender(bill.id, tender, items: _splitItems);
    _splitItems = const {};
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
  /// Items picked with Split bill by item: the next tender pays for them.
  Map<String, int> _splitItems = const {};

  /// Split bill, as the till's: by item (pick what this person is paying
  /// for; the next payment settles those items) or equally. The share goes
  /// on the pad.
  Future<int?> _split() async {
    final bill = _bill;
    if (bill == null) return null;
    final picked = await showDialog<(int, Map<String, int>)>(context: context, builder: (_) => _SplitDialog(bill: bill));
    if (picked == null) return null;
    final (amount, items) = picked;
    setState(() => _splitItems = items);
    return amount;
  }

  Future<void> _gratuity() async {
    final bill = _bill;
    final config = ref.read(tapProvider).config;
    if (bill == null) return;
    final tip = await askGratuity(context,
        onMinor: bill.dueMinor, percents: config.tipPercents.isEmpty ? const [5, 10, 12.5, 15, 20] : config.tipPercents, current: _presetTip);
    if (tip != null && mounted) setState(() => _presetTip = tip);
  }

  Future<void> _points(Bill bill) async {
    final member = bill.member;
    if (member == null) return;
    final taken = await askPoints(context, ref, member: member, dueMinor: bill.dueMinor, billId: bill.id);
    if (taken == null || taken <= 0 || !mounted) return;
    _sendFirst(bill);
    _take(Tender(id: 'points-${DateTime.now().microsecondsSinceEpoch}', amountMinor: taken, kind: 'points', at: DateTime.now(), clerk: ref.read(tapProvider).clerk?.name ?? '', reference: 'points'));
  }

  /// A gift card or a deposit towards the bill, as the till takes them.
  Future<void> _codeTender(String kind) async {
    final bill = _bill;
    if (bill == null) return;
    final taken = await askCodeTender(context, ref, kind: kind, dueMinor: bill.dueMinor, billId: bill.id);
    if (taken == null || taken <= 0 || !mounted) return;
    _sendFirst(bill);
    _take(Tender(
      id: '$kind-${DateTime.now().microsecondsSinceEpoch}',
      amountMinor: taken,
      kind: kind,
      at: DateTime.now(),
      clerk: ref.read(tapProvider).clerk?.name ?? '',
      reference: kind,
    ));
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
        giftCard: () => _codeTender('giftcard'),
        deposit: () => _codeTender('deposit'),
        // The member's points towards the bill, as the till's Points key.
        points: bill.member == null ? null : () => _points(bill),
        discount: () => discountBill(context, ref, bill),
        customer: () => attachCustomer(context, ref, bill.id),
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

/// The till's Split the bill: by item (tick what is being paid for, how many
/// of each) or equally (how many ways). Answers the amount and the items.
class _SplitDialog extends StatefulWidget {
  const _SplitDialog({required this.bill});
  final Bill bill;
  @override
  State<_SplitDialog> createState() => _SplitDialogState();
}

class _SplitDialogState extends State<_SplitDialog> {
  bool _byItem = true;
  final _picked = <String, int>{};
  int _ways = 2;

  List<BillLine> get _open => [for (final l in widget.bill.lines) if (l.unpaidQuantity > 0) l];

  int get _itemsTotal => _open.fold<int>(0, (s, l) => s + l.unitMinor * (_picked[l.id] ?? 0));

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final due = widget.bill.dueMinor;
    final share = splitEqually(due, _ways);
    return AlertDialog(
      title: Row(children: [
        const Expanded(child: Text('Split the bill')),
        Text('${money(due)} left', style: t.bodyMedium),
      ]),
      content: SizedBox(
        width: 480,
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SegmentedButton<bool>(
            segments: const [
              ButtonSegment(value: true, icon: Icon(Icons.checklist_rounded), label: Text('By item')),
              ButtonSegment(value: false, icon: Icon(Icons.pie_chart_outline_rounded), label: Text('Equally')),
            ],
            selected: {_byItem},
            onSelectionChanged: (v) => setState(() => _byItem = v.first),
          ),
          const SizedBox(height: 12),
          if (_byItem)
            Flexible(
              child: ListView(shrinkWrap: true, children: [
                for (final l in _open)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Checkbox(
                      value: (_picked[l.id] ?? 0) > 0,
                      onChanged: (v) => setState(() => v == true ? _picked[l.id] = l.unpaidQuantity : _picked.remove(l.id)),
                    ),
                    title: Text(l.product.name),
                    subtitle: Text('${money(l.unitMinor)} each'),
                    trailing: l.unpaidQuantity > 1
                        ? Row(mainAxisSize: MainAxisSize.min, children: [
                            IconButton(
                              onPressed: (_picked[l.id] ?? 0) > 0 ? () => setState(() => _picked[l.id] = _picked[l.id]! - 1) : null,
                              icon: const Icon(Icons.remove_circle_outline),
                            ),
                            Text('${_picked[l.id] ?? 0}/${l.unpaidQuantity}'),
                            IconButton(
                              onPressed: (_picked[l.id] ?? 0) < l.unpaidQuantity ? () => setState(() => _picked[l.id] = (_picked[l.id] ?? 0) + 1) : null,
                              icon: const Icon(Icons.add_circle_outline),
                            ),
                          ])
                        : Text(money(l.unitMinor)),
                  ),
              ]),
            )
          else
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (var n = 2; n <= 10; n++) ChoiceChip(label: Text('$n ways'), selected: _ways == n, onSelected: (_) => setState(() => _ways = n)),
            ]),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: context.goRaised, borderRadius: BorderRadius.circular(12)),
            child: Row(children: [
              Expanded(child: Text(_byItem ? 'This person pays' : 'Each pays', style: t.bodyMedium)),
              Text(_byItem ? money(_itemsTotal) : share.map(money).toSet().join(' or '),
                  style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800, fontFeatures: Tp.tabular)),
            ]),
          ),
        ]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: _byItem && _itemsTotal <= 0
              ? null
              : () => Navigator.pop(context, _byItem ? (_itemsTotal.clamp(1, due), Map<String, int>.of(_picked)) : (share.first, const <String, int>{})),
          child: const Text('Done'),
        ),
      ],
    );
  }
}
