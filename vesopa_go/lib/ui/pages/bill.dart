/// Bills: every open one, and one bill to split and pay at the table.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/bill_math.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';
import 'order.dart';
import 'member_sheet.dart';
import 'pay_sheet.dart';

class BillsPage extends ConsumerWidget {
  const BillsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bills = ref.watch(tapProvider.select((s) => s.bills.values.toList()));
    final t = Theme.of(context).textTheme;
    if (bills.isEmpty) return Center(child: Text('No open bills', style: t.bodyLarge));
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: bills.length,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (_, i) {
        final b = bills[i];
        return Card(
          child: ListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            title: Text(b.name, style: t.titleMedium),
            subtitle: Text('${b.lines.length} items · ${b.clerk}${b.heldBy != null ? ' · on ${b.heldBy}' : ''}'),
            trailing: Money(b.dueMinor, style: t.titleMedium),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => BillPage(billId: b.id))),
          ),
        );
      },
    );
  }
}

class BillPage extends ConsumerWidget {
  const BillPage({super.key, required this.billId});
  final String billId;

  Future<void> _pay(BuildContext context, WidgetRef ref, Bill bill, int amount, {Map<String, int> items = const {}}) async {
    final paid = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      // Wide enough on an iPad to read across the counter.
      constraints: const BoxConstraints(maxWidth: 760),
      builder: (_) => PaySheet(bill: bill, amountMinor: amount, items: items),
    );
    if (paid == true && context.mounted && ref.read(tapProvider).bills[bill.id] == null) Navigator.of(context).pop();
  }

  Future<void> _splitEqually(BuildContext context, WidgetRef ref, Bill bill) async {
    final ways = await showDialog<int>(
      context: context,
      builder: (c) => SimpleDialog(title: const Text('Split equally between'), children: [
        for (var n = 2; n <= 8; n++) SimpleDialogOption(onPressed: () => Navigator.pop(c, n), child: Text('$n people')),
      ]),
    );
    if (ways == null || !context.mounted) return;
    final shares = splitEqually(bill.dueMinor, ways);
    await _pay(context, ref, bill, shares.first);
  }

  Future<void> _splitBySeat(BuildContext context, WidgetRef ref, Bill bill) async {
    final shares = splitBySeat(bill, bill.covers);
    final seat = await showDialog<int>(
      context: context,
      builder: (c) => SimpleDialog(title: const Text('Who is paying?'), children: [
        for (final e in shares.entries)
          SimpleDialogOption(onPressed: () => Navigator.pop(c, e.key), child: Row(children: [Text('Seat ${e.key}'), const Spacer(), Money(e.value)])),
      ]),
    );
    if (seat == null || !context.mounted) return;
    await _pay(context, ref, bill, shares[seat]!);
  }

  Future<void> _splitByItem(BuildContext context, WidgetRef ref, Bill bill) async {
    final picked = await showModalBottomSheet<Map<String, int>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _ItemPicker(bill: bill),
    );
    if (picked == null || picked.isEmpty || !context.mounted) return;
    await _pay(context, ref, bill, priceOfItems(bill, picked), items: picked);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bill = ref.watch(tapProvider.select((s) => s.bills[billId]));
    if (bill == null) return Scaffold(appBar: AppBar(), body: const Center(child: Text('Paid and closed')));
    final t = Theme.of(context).textTheme;
    Widget row(String label, int minor, {TextStyle? style}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(children: [Text(label, style: style), const Spacer(), Money(minor, style: style)]),
        );
    return Scaffold(
      appBar: AppBar(title: Text(bill.name), actions: [
        IconButton(
          tooltip: 'Add items',
          icon: const Icon(Icons.add_shopping_cart_rounded),
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => OrderPage(billId: bill.id))),
        ),
      ]),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        for (final l in bill.lines)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(children: [
              SizedBox(width: 32, child: Text('${l.quantity}×', style: t.bodyMedium)),
              Expanded(child: Text(l.product.name + (l.paidQuantity > 0 ? '  (${l.paidQuantity} paid)' : ''), style: t.bodyLarge)),
              Money(l.totalMinor, style: t.bodyLarge),
            ]),
          ),
        const Divider(height: 28),
        row('Subtotal', bill.subtotalMinor),
        if (bill.member != null)
          Row(children: [
            Expanded(child: Text('${bill.member!.name}${bill.memberDiscountMinor > 0 ? ' (member discount)' : ''}')),
            if (bill.memberDiscountMinor > 0) Money(-bill.memberDiscountMinor),
            IconButton(
              tooltip: 'Take the member off',
              icon: const Icon(Icons.close_rounded, size: 18),
              onPressed: () => ref.read(tapProvider.notifier).setMember(bill.id, null),
            ),
          ]),
        if (bill.voucherMinor > 0) row('Voucher ${bill.voucherCode}', -bill.voucherMinor),
        row('Service charge', bill.serviceMinor),
        Wrap(spacing: 6, children: [
          for (final p in ref.watch(tapProvider.select((s) => s.config.servicePercents)))
            ChoiceChip(
              label: Text(p == 0 ? 'None' : '${p.toStringAsFixed(p % 1 == 0 ? 0 : 1)}%'),
              selected: bill.serviceChargePercent == p,
              onSelected: (_) => ref.read(tapProvider.notifier).setServiceCharge(bill.id, p),
            ),
        ]),
        const SizedBox(height: 6),
        if (bill.paidMinor > 0) row('Paid so far', -bill.paidMinor),
        row('To pay', bill.dueMinor, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w900)),
        const SizedBox(height: 24),
        FilledButton.icon(
          icon: const Icon(Icons.contactless_rounded),
          label: Text('Take ${money(bill.dueMinor)}'),
          onPressed: bill.dueMinor <= 0 ? null : () => _pay(context, ref, bill, bill.dueMinor),
        ),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(
            child: OutlinedButton.icon(
              icon: const Icon(Icons.card_membership_rounded),
              label: Text(bill.member == null ? 'Member' : 'Change member'),
              onPressed: () => showModalBottomSheet<bool>(
                context: context,
                isScrollControlled: true,
                showDragHandle: true,
                builder: (_) => MemberSheet(billId: bill.id),
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: OutlinedButton.icon(
              icon: const Icon(Icons.confirmation_number_rounded),
              label: const Text('Voucher'),
              onPressed: bill.voucherCode != null ? null : () => askVoucher(context, ref, bill),
            ),
          ),
        ]),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: OutlinedButton(onPressed: () => _splitEqually(context, ref, bill), child: const Text('Split equally'))),
          const SizedBox(width: 10),
          Expanded(child: OutlinedButton(onPressed: () => _splitByItem(context, ref, bill), child: const Text('By item'))),
        ]),
        if (bill.covers > 1) ...[
          const SizedBox(height: 10),
          OutlinedButton(onPressed: () => _splitBySeat(context, ref, bill), child: const Text('By seat')),
        ],
      ]),
    );
  }
}

class _ItemPicker extends StatefulWidget {
  const _ItemPicker({required this.bill});
  final Bill bill;
  @override
  State<_ItemPicker> createState() => _ItemPickerState();
}

class _ItemPickerState extends State<_ItemPicker> {
  final _picked = <String, int>{};

  @override
  Widget build(BuildContext context) {
    final lines = widget.bill.lines.where((l) => l.unpaidQuantity > 0).toList();
    final total = priceOfItems(widget.bill, _picked);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('What are they paying for?', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Flexible(
            child: ListView(shrinkWrap: true, children: [
              for (final l in lines)
                ListTile(
                  title: Text(l.product.name),
                  subtitle: Text('${l.unpaidQuantity} left · ${money(l.unitMinor)} each'),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    IconButton(
                      icon: const Icon(Icons.remove_circle_outline),
                      onPressed: (_picked[l.id] ?? 0) == 0 ? null : () => setState(() => _picked[l.id] = _picked[l.id]! - 1),
                    ),
                    Text('${_picked[l.id] ?? 0}', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                    IconButton(
                      icon: const Icon(Icons.add_circle_outline),
                      onPressed: (_picked[l.id] ?? 0) >= l.unpaidQuantity ? null : () => setState(() => _picked[l.id] = (_picked[l.id] ?? 0) + 1),
                    ),
                  ]),
                ),
            ]),
          ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: total == 0 ? null : () => Navigator.pop(context, Map.of(_picked)..removeWhere((_, v) => v == 0)),
            child: Text('Pay ${money(total)}'),
          ),
        ]),
      ),
    );
  }
}
