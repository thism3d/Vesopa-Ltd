/// Today's sales on this device, newest first: open one for its receipt, to
/// email it, or to refund it.
///
/// A refund needs a manager. A card sale is refunded to the card through
/// Dojo (Go's refund, which writes the venue's card log); a cash sale
/// from the drawer. Either way it goes to the back office as the till's own
/// refund event, so it is on the Z beside the voids, never taken off the
/// takings.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/payments/payment_service.dart';
import 'package:vesopa_go/ui/adaptive.dart';
import 'package:vesopa_go/ui/pages/card_machine_page.dart' show deviceMachine;
import 'package:vesopa_go/ui/pages/reasons.dart' show reasonsFor;
import 'package:vesopa_go/ui/theme.dart';

import '../data/journal.dart';
import 'card_pay_screen.dart';
import 'receipt_print.dart';
import 'receipt_view.dart';

class SalesPage extends ConsumerWidget {
  const SalesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sales = ref.watch(journalProvider.select((j) => j.sales));
    final t = Theme.of(context).textTheme;
    // A refund with no receipt on this device (another till's sale, an old
    // one): any amount on the card machine (Dojo RF-03) or from the drawer.
    final noReceipt = Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Align(
        alignment: Alignment.centerLeft,
        child: OutlinedButton.icon(
          key: const ValueKey('refund-no-receipt'),
          onPressed: () => _refundWithoutReceipt(context, ref),
          icon: const Icon(Icons.undo_rounded),
          label: const Text('Refund without a receipt'),
        ),
      ),
    );
    if (sales.isEmpty) {
      return Column(children: [
        noReceipt,
        Expanded(child: Center(child: Text('No sales yet today', style: t.titleMedium))),
      ]);
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: sales.length + 1,
      separatorBuilder: (_, i) => i == 0 ? const SizedBox.shrink() : const Divider(height: 1, indent: 16, endIndent: 16),
      itemBuilder: (context, row) {
        if (row == 0) return noReceipt;
        final i = row - 1;
        final s = sales[i];
        final card = s.payments.any((p) => p.isCard);
        return ListTile(
          leading: CircleAvatar(
            backgroundColor: Theme.of(context).colorScheme.surfaceContainer,
            child: Icon(card ? Icons.credit_card_rounded : Icons.payments_rounded, size: 20),
          ),
          title: Text('Receipt ${s.number} · ${hhmm(s.at)}'),
          subtitle: Text(
            '${s.lines.fold<int>(0, (n, l) => n + l.quantity)} items · ${s.clerk}${s.refunds.isEmpty ? '' : ' · refunded ${money(s.refundedMinor)}'}',
          ),
          trailing: Money(s.totalMinor, style: t.titleMedium?.copyWith(color: s.refundableMinor <= 0 ? Tp.danger : null)),
          onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => SaleDetailPage(saleId: s.id))),
        );
      },
    );
  }
}

Future<void> _refundWithoutReceipt(BuildContext context, WidgetRef ref) async {
  final manager = await askManager(context, ref, why: 'Refund without a receipt', permission: TillPermission.refund);
  if (manager == null || !context.mounted) return;
  final reasons = await reasonsFor(ref, 'refund');
  if (!context.mounted) return;
  final plan = await showModalBottomSheet<RefundPlan>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    builder: (_) => RefundSheet(reasons: reasons),
  );
  if (plan == null || !context.mounted) return;
  await runRefund(context, ref, plan, manager: manager);
}

class SaleDetailPage extends ConsumerWidget {
  const SaleDetailPage({super.key, required this.saleId});
  final String saleId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sale = ref.watch(journalProvider.select((j) => j.sales.where((s) => s.id == saleId).firstOrNull));
    if (sale == null) return Scaffold(appBar: AppBar(), body: const Center(child: Text('This sale was closed by an End of day.')));
    return Scaffold(
      appBar: AppBar(title: Text('Receipt ${sale.number}')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: ListView(padding: const EdgeInsets.all(16), children: [
              ReceiptView(sale: sale),
              const SizedBox(height: 16),
              FilledButton.icon(onPressed: () => printReceipt(context, ref, sale), icon: const Icon(Icons.print_rounded), label: const Text('Print the receipt')),
              const SizedBox(height: 8),
              OutlinedButton.icon(onPressed: () => emailReceipt(context, ref, sale.id), icon: const Icon(Icons.email_rounded), label: const Text('Email the receipt')),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                key: const ValueKey('refund'),
                onPressed: sale.refundableMinor <= 0 ? null : () => _refund(context, ref, sale),
                icon: const Icon(Icons.undo_rounded),
                label: Text(sale.refundableMinor <= 0 ? 'Refunded in full' : 'Refund'),
              ),
            ]),
          ),
        ),
      ),
    );
  }

  Future<void> _refund(BuildContext context, WidgetRef ref, SaleRecord sale) async {
    final manager = await askManager(context, ref, why: 'Refund receipt ${sale.number}', permission: TillPermission.refund);
    if (manager == null || !context.mounted) return;
    final reasons = await reasonsFor(ref, 'refund');
    if (!context.mounted) return;
    final plan = await showModalBottomSheet<RefundPlan>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (_) => RefundSheet(sale: sale, reasons: reasons),
    );
    if (plan == null || !context.mounted) return;
    await runRefund(context, ref, plan, sale: sale, manager: manager);
  }
}

/// How money goes back: the till's three routes (vesopa_epos
/// dojo_refund.dart DojoRefundRoute), plus the drawer.
enum RefundRoute {
  toCard('Back to the card', 'No card needed. Full or part, to the card that paid.', Icons.credit_card_rounded),
  machine('On the card machine', 'The customer presents their card on the machine.', Icons.point_of_sale_rounded),
  cash('Cash from the drawer', 'Hand the money back from the till drawer.', Icons.payments_rounded);

  const RefundRoute(this.label, this.detail, this.icon);
  final String label;
  final String detail;
  final IconData icon;
}

/// What the manager chose on the refund sheet.
class RefundPlan {
  const RefundPlan({required this.amountMinor, required this.reason, required this.route, this.items = ''});
  final int amountMinor;
  final String reason;
  final RefundRoute route;

  /// "2× Burger, 1× Chips" when refunded by item; empty for an amount.
  final String items;
}

/// The routes open for [sale]: back to the card only for a card payment
/// Dojo or Teya can find; the card machine always (any amount, RF-03).
List<RefundRoute> refundRoutesFor(SaleRecord? sale) {
  final ref = sale?.cardPayment?.reference ?? '';
  final online = ref.isNotEmpty && !ref.startsWith('manual:') && !ref.startsWith('test:');
  return [if (online) RefundRoute.toCard, RefundRoute.machine, RefundRoute.cash];
}

/// Carry out [plan]: on the card (Dojo or Teya, or the Pocket that took it),
/// on the venue's card machine (followed like a sale: prompts, signature,
/// cancel), or from the drawer. Then the till's refund event, for the Z.
Future<bool> runRefund(BuildContext context, WidgetRef ref, RefundPlan plan, {SaleRecord? sale, required String manager}) async {
  final messenger = ScaffoldMessenger.of(context);
  final s = ref.read(tapProvider);
  final api = ref.read(apiProvider);
  final card = sale?.cardPayment;
  final reason = plan.items.isEmpty ? plan.reason : '${plan.reason}: ${plan.items}';
  switch (plan.route) {
    case RefundRoute.toCard:
      if (!s.demo) {
        final reference = card!.reference!;
        try {
          if (reference.startsWith('pocket:')) {
            final pay = ref.read(paymentsProvider);
            if (pay is! DojoTapToPay || !await pay.refundOnPocket(plan.amountMinor)) {
              messenger.showSnackBar(const SnackBar(content: Text('The Dojo app did not refund it. Nothing went back.')));
              return false;
            }
          } else {
            await api.refund(reference, amountMinor: plan.amountMinor, approvedBy: manager, reason: reason);
            ref.read(tapProvider.notifier).refunded(reference, (sale?.refundedMinor ?? 0) + plan.amountMinor);
          }
        } on TapApiError catch (e) {
          messenger.showSnackBar(SnackBar(content: Text('The refund did not go through: ${e.message}')));
          return false;
        }
      }
    case RefundRoute.machine:
      final linkedTo = card != null && (card.kind == 'machine' || card.kind == 'tap') && !(card.reference ?? '').contains(':') ? card.reference : null;
      final outcome = await Navigator.of(context).push<PaymentOutcome>(MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => MachineRefundPage(amountMinor: plan.amountMinor, reason: reason, approvedBy: manager, paymentId: linkedTo, billRef: sale?.id),
      ));
      if (outcome == null || !outcome.paid) return false;
      if (linkedTo != null) ref.read(tapProvider.notifier).refunded(linkedTo, (sale?.refundedMinor ?? 0) + plan.amountMinor);
    case RefundRoute.cash:
      break;
  }
  final kind = plan.route == RefundRoute.cash ? 'cash' : 'card';
  final refund = Refund(id: const Uuid().v4(), amountMinor: plan.amountMinor, kind: kind, reason: reason, by: manager, at: DateTime.now());
  if (sale != null) ref.read(journalProvider.notifier).addRefund(sale.id, refund);
  // The till's own refund event (vesopa_server /till/events), for the Z.
  await ref.read(tapProvider.notifier).queue('/till/events', {
    'id': refund.id,
    'office': s.venue?.office,
    'kind': 'refund',
    'amount_minor': plan.amountMinor,
    'note': sale == null ? 'No receipt (${plan.route.name})' : 'Receipt ${sale.number} (${plan.route.name})',
    'reason': reason,
    'staff_name': manager,
    'terminal': ref.read(tapProvider.notifier).terminalName,
    'order_id': ?sale?.id,
    'at': refund.at.toUtc().toIso8601String(),
  });
  messenger.showSnackBar(SnackBar(
    content: Text(switch (plan.route) {
      RefundRoute.toCard => '${money(plan.amountMinor)} refunded to the card',
      RefundRoute.machine => '${money(plan.amountMinor)} refunded on the card machine',
      RefundRoute.cash => 'Give the customer ${money(plan.amountMinor)} from the drawer',
    }),
  ));
  return true;
}

/// The refund sheet: by item or by amount, the route, and the venue's reason.
class RefundSheet extends StatefulWidget {
  const RefundSheet({super.key, this.sale, required this.reasons});

  /// Null for a refund with no receipt: any amount, on the machine or in cash.
  final SaleRecord? sale;
  final List<String> reasons;
  @override
  State<RefundSheet> createState() => _RefundSheetState();
}

class _RefundSheetState extends State<RefundSheet> {
  late final _amount = TextEditingController(text: widget.sale == null ? '' : (widget.sale!.refundableMinor / 100).toStringAsFixed(2));
  late String _reason = widget.reasons.isEmpty ? 'Refund' : widget.reasons.first;
  late final List<RefundRoute> _routes = refundRoutesFor(widget.sale);
  late RefundRoute _route = widget.sale?.cardPayment == null ? RefundRoute.cash : _routes.first;
  bool _byItem = false;
  late final List<int> _qty = List.filled(widget.sale?.lines.length ?? 0, 0);

  int get _itemsMinor {
    var total = 0;
    final lines = widget.sale?.lines ?? const <SoldLine>[];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].quantity > 0) total += (lines[i].totalMinor * _qty[i] / lines[i].quantity).round();
    }
    return total;
  }

  String get _itemsWords {
    final lines = widget.sale?.lines ?? const <SoldLine>[];
    return [for (var i = 0; i < lines.length; i++) if (_qty[i] > 0) '${_qty[i]}× ${lines[i].name}'].join(', ');
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final sale = widget.sale;
    final max = sale?.refundableMinor ?? 1000000;
    final typed = ((double.tryParse(_amount.text.trim()) ?? 0) * 100).round();
    final v = _byItem ? _itemsMinor.clamp(0, max) : typed;
    final ok = v > 0 && v <= max;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(sale == null ? 'Refund without a receipt' : 'Refund receipt ${sale.number}', style: t.titleLarge),
          if (sale != null) Text('Up to ${money(max)} can go back', style: t.bodySmall),
          const SizedBox(height: 16),
          if (sale != null && sale.lines.isNotEmpty)
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: false, label: Text('An amount'), icon: Icon(Icons.edit_rounded)),
                ButtonSegment(value: true, label: Text('By item'), icon: Icon(Icons.checklist_rounded)),
              ],
              selected: {_byItem},
              onSelectionChanged: (s) => setState(() => _byItem = s.first),
            ),
          const SizedBox(height: 12),
          if (_byItem)
            for (var i = 0; i < sale!.lines.length; i++)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(sale.lines[i].name),
                subtitle: Text('${sale.lines[i].quantity} sold · ${money(sale.lines[i].totalMinor)}'),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  IconButton(
                    tooltip: 'One fewer',
                    onPressed: _qty[i] == 0 ? null : () => setState(() => _qty[i]--),
                    icon: const Icon(Icons.remove_circle_outline_rounded),
                  ),
                  SizedBox(width: 24, child: Text('${_qty[i]}', textAlign: TextAlign.center, style: t.titleMedium)),
                  IconButton(
                    tooltip: 'One more',
                    onPressed: _qty[i] >= sale.lines[i].quantity ? null : () => setState(() => _qty[i]++),
                    icon: const Icon(Icons.add_circle_outline_rounded),
                  ),
                ]),
              )
          else
            TextField(
              controller: _amount,
              autofocus: sale == null,
              onChanged: (_) => setState(() {}),
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(labelText: sale == null ? 'Amount' : 'Amount (up to ${money(max)})', prefixText: '£ '),
            ),
          const SizedBox(height: 18),
          Text('How it goes back', style: t.titleSmall),
          const SizedBox(height: 6),
          RadioGroup<RefundRoute>(
            groupValue: _route,
            onChanged: (x) => setState(() => _route = x ?? _route),
            child: Column(children: [
              for (final r in _routes)
                Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: RadioListTile<RefundRoute>(
                    value: r,
                    secondary: Icon(r.icon),
                    title: Text(r.label),
                    subtitle: Text(r == RefundRoute.machine && sale?.cardPayment == null
                        ? 'Any amount: the customer presents a card on the machine. A manager has approved it.'
                        : r.detail),
                  ),
                ),
            ]),
          ),
          const SizedBox(height: 10),
          Text('Why', style: t.titleSmall),
          const SizedBox(height: 6),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final r in widget.reasons) ChoiceChip(label: Text(r), selected: _reason == r, onSelected: (_) => setState(() => _reason = r)),
          ]),
          const SizedBox(height: 18),
          FilledButton(
            key: const ValueKey('refund-go'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            onPressed: ok
                ? () => Navigator.pop(context, RefundPlan(amountMinor: v, reason: _reason, route: _route, items: _byItem ? _itemsWords : ''))
                : null,
            child: Text(ok ? 'Refund ${money(v)}' : 'Refund'),
          ),
        ]),
      ),
    );
  }
}

/// A refund on the venue's card machine, shown as a card payment is: the
/// machine's prompts as steps, the clerk's signature check, and Cancel.
class MachineRefundPage extends ConsumerStatefulWidget {
  const MachineRefundPage({super.key, required this.amountMinor, required this.reason, required this.approvedBy, this.paymentId, this.billRef});
  final int amountMinor;
  final String reason;
  final String approvedBy;
  final String? paymentId;
  final String? billRef;
  @override
  ConsumerState<MachineRefundPage> createState() => _MachineRefundPageState();
}

class _MachineRefundPageState extends ConsumerState<MachineRefundPage> {
  PayStep _step = PayStep.preparing;
  PaymentOutcome? _result;
  bool _cancelling = false;
  late final PayControl _control = PayControl(checkSignature: _checkSignature)
    ..onCancelRefused = () {
      if (!mounted) return;
      setState(() => _cancelling = false);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('The card is already in. Wait for the card machine to finish.')));
    };

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<bool> _checkSignature() async {
    final ok = await showAdaptiveDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (c) => AlertDialog.adaptive(
        title: const Text('Check the signature'),
        content: const Text("Compare the customer's signature on the card machine's slip with the one on the back of their card."),
        actions: [
          adaptiveAction(c, label: 'Decline', destructive: true, onPressed: () => Navigator.pop(c, false)),
          adaptiveAction(c, label: 'Accept', primary: true, onPressed: () => Navigator.pop(c, true)),
        ],
      ),
    );
    return ok ?? false;
  }

  Future<void> _run() async {
    final s = ref.read(tapProvider);
    PaymentOutcome outcome;
    if (s.demo) {
      for (final st in const [PayStep.onMachine, PayStep.pin, PayStep.confirming]) {
        if (!mounted) return;
        setState(() => _step = st);
        await Future<void>.delayed(const Duration(milliseconds: 900));
        if (_control.cancelRequested) break;
      }
      outcome = PaymentOutcome(_control.cancelRequested ? PayResult.cancelled : PayResult.paid, paymentId: 'demo');
    } else {
      final api = ref.read(apiProvider);
      final id = const Uuid().v4();
      try {
        await api.startMachineRefund(
          id: id,
          amountMinor: widget.amountMinor,
          approvedBy: widget.approvedBy,
          reason: widget.reason,
          paymentId: widget.paymentId,
          billRef: widget.billRef,
          terminalId: await deviceMachine(),
        );
        if (mounted) setState(() => _step = PayStep.onMachine);
        outcome = await followMachine(
          id: id,
          poll: () => api.machineRefund(id),
          cancel: () => api.cancelMachineRefund(id),
          answer: (ok) => api.answerRefundSignature(id, accepted: ok),
          onStep: (st) => mounted ? setState(() => _step = st) : null,
          control: _control,
        );
      } on TapApiError catch (e) {
        outcome = PaymentOutcome(PayResult.unavailable, message: e.message);
      }
    }
    if (!mounted) return;
    if (outcome.paid) {
      setState(() => _step = PayStep.done);
      await Future<void>.delayed(const Duration(milliseconds: 900));
      if (mounted) Navigator.pop(context, outcome);
      return;
    }
    setState(() {
      _result = outcome;
      _cancelling = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final mapped = cardStepOf(_step, machine: true);
    final r = _result;
    return Theme(
      data: Tp.theme(Brightness.dark, font: Theme.of(context).textTheme.bodyMedium?.fontFamily),
      child: CardPayScreen(
        amountMinor: widget.amountMinor,
        heading: widget.paymentId == null ? 'Refund on the card machine' : 'Refund to the card',
        step: mapped.step,
        detail: _step == PayStep.onMachine ? 'Ask the customer to present their card on the card machine' : mapped.detail,
        device: "The venue's card machine",
        machine: true,
        result: r == null ? null : (r.result == PayResult.declined ? PaymentOutcome(PayResult.declined, message: r.message == 'Declined' ? 'The refund was declined. Nothing went back.' : r.message) : r),
        actions: [
          if (r != null) (icon: Icons.close_rounded, label: 'Close', onPressed: () => Navigator.pop(context, r), primary: true),
        ],
        onCancel: r == null && const {PayStep.onMachine, PayStep.pin, PayStep.cancelling}.contains(_step)
            ? () {
                _control.cancel();
                setState(() => _cancelling = true);
              }
            : null,
        cancelling: _cancelling,
      ),
    );
  }
}
