/// Today's sales on this device, newest first: open one for its receipt, to
/// email it, or to refund it.
///
/// A refund needs a manager. A card sale is refunded to the card through
/// Dojo (vesopa_tap's refund, which writes the venue's card log); a cash sale
/// from the drawer. Either way it goes to the back office as the till's own
/// refund event, so it is on the Z beside the voids, never taken off the
/// takings.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import 'package:vesopa_tap/data/api.dart';
import 'package:vesopa_tap/data/models.dart';
import 'package:vesopa_tap/data/session.dart';
import 'package:vesopa_tap/ui/theme.dart';

import '../data/journal.dart';
import 'receipt_view.dart';

class SalesPage extends ConsumerWidget {
  const SalesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sales = ref.watch(journalProvider.select((j) => j.sales));
    final t = Theme.of(context).textTheme;
    if (sales.isEmpty) {
      return Center(child: Text('No sales yet today', style: t.titleMedium));
    }
    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: sales.length,
      separatorBuilder: (_, _) => const Divider(height: 1, indent: 16, endIndent: 16),
      itemBuilder: (context, i) {
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
              FilledButton.icon(onPressed: () => emailReceipt(context, ref, sale.id), icon: const Icon(Icons.email_rounded), label: const Text('Email the receipt')),
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
    final manager = await askManager(context, ref, why: 'Refund receipt ${sale.number}');
    if (manager == null || !context.mounted) return;
    final asked = await showModalBottomSheet<(int, String)>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _RefundSheet(sale: sale),
    );
    if (asked == null || !context.mounted) return;
    final (amount, reason) = asked;
    final messenger = ScaffoldMessenger.of(context);
    final s = ref.read(tapProvider);
    final card = sale.cardPayment;
    final kind = card == null ? 'cash' : 'card';

    if (card != null && !s.demo) {
      try {
        await ref.read(apiProvider).refund(card.reference!, amountMinor: amount, approvedBy: manager, reason: reason);
        ref.read(tapProvider.notifier).refunded(card.reference!, sale.refundedMinor + amount);
      } on TapApiError catch (e) {
        messenger.showSnackBar(SnackBar(content: Text('The refund did not go through: ${e.message}')));
        return;
      }
    }
    final refund = Refund(id: const Uuid().v4(), amountMinor: amount, kind: kind, reason: reason, by: manager, at: DateTime.now());
    ref.read(journalProvider.notifier).addRefund(sale.id, refund);
    // The till's own refund event (vesopa_server /till/events), for the Z.
    await ref.read(tapProvider.notifier).queue('/till/events', {
      'id': refund.id,
      'office': s.venue?.office,
      'kind': 'refund',
      'amount_minor': amount,
      'note': 'Receipt ${sale.number} ($kind)',
      'reason': reason,
      'staff_name': manager,
      'terminal': ref.read(tapProvider.notifier).terminalName,
      'order_id': sale.id,
      'at': refund.at.toUtc().toIso8601String(),
    });
    messenger.showSnackBar(SnackBar(
      content: Text(kind == 'card' ? '${money(amount)} refunded to the card' : 'Give the customer ${money(amount)} from the drawer'),
    ));
  }
}

class _RefundSheet extends StatefulWidget {
  const _RefundSheet({required this.sale});
  final SaleRecord sale;
  @override
  State<_RefundSheet> createState() => _RefundSheetState();
}

class _RefundSheetState extends State<_RefundSheet> {
  late final _amount = TextEditingController(text: (widget.sale.refundableMinor / 100).toStringAsFixed(2));
  String _reason = 'Customer complaint';
  static const _reasons = ['Customer complaint', 'Wrong item', 'Overcharged', 'Not served', 'Other'];

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final max = widget.sale.refundableMinor;
    final v = ((double.tryParse(_amount.text.trim()) ?? 0) * 100).round();
    final ok = v > 0 && v <= max;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Refund', style: t.titleLarge),
          Text(widget.sale.cardPayment == null ? 'From the cash drawer' : 'Back to the card it was paid with', style: t.bodySmall),
          const SizedBox(height: 16),
          TextField(
            controller: _amount,
            onChanged: (_) => setState(() {}),
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: 'Amount (up to ${money(max)})', prefixText: '£ '),
          ),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final r in _reasons) ChoiceChip(label: Text(r), selected: _reason == r, onSelected: (_) => setState(() => _reason = r)),
          ]),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: ok ? () => Navigator.pop(context, (v, _reason)) : null,
            child: Text(ok ? 'Refund ${money(v)}' : 'Refund'),
          ),
        ]),
      ),
    );
  }
}
