/// Taking an order: the menu by category, the bill underneath, Send.
///
/// What PocketTouch does, and what it does not:
///   * options the dish needs are asked before it goes on (cooking, side)
///   * allergens on every dish, and a note on any line
///   * by-seat ordering, so the bill can be split by seat later
///   * out of stock is greyed out and cannot be rung up
///   * a sent line can only come off with a void (the till's rule)
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';
import 'bill.dart';

class OrderPage extends ConsumerStatefulWidget {
  const OrderPage({super.key, required this.billId});
  final String billId;
  @override
  ConsumerState<OrderPage> createState() => _OrderPageState();
}

class _OrderPageState extends ConsumerState<OrderPage> {
  String? _category;
  int _seat = 0;

  Future<void> _add(Product p) async {
    if (p.outOfStock) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${p.name} is out of stock')));
      return;
    }
    final choices = <Choice>[];
    for (final g in p.options) {
      final c = await showModalBottomSheet<Choice>(
        context: context,
        showDragHandle: true,
        builder: (ctx) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('${p.name}: ${g.name}', style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: 8),
            for (final ch in g.choices)
              ListTile(
                title: Text(ch.name),
                trailing: ch.priceMinor > 0 ? Text('+${money(ch.priceMinor)}') : null,
                onTap: () => Navigator.pop(ctx, ch),
              ),
            const SizedBox(height: 12),
          ]),
        ),
      );
      if (c == null) return; // cancelled: nothing goes on half-chosen
      choices.add(c);
    }
    HapticFeedback.lightImpact();
    ref.read(tapProvider.notifier).addLine(widget.billId, p, choices: choices, seat: _seat);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final bill = s.bills[widget.billId];
    if (bill == null) {
      return Scaffold(appBar: AppBar(), body: const Center(child: Text('This bill is closed.')));
    }
    final cat = _category ?? (s.categories.isEmpty ? null : s.categories.first.id);
    final products = s.products.where((p) => p.category == cat).toList();
    final t = Theme.of(context).textTheme;
    final unsent = bill.lines.where((l) => !l.sent).length;

    return Scaffold(
      appBar: AppBar(
        title: Text(bill.name),
        actions: [
          if (bill.covers > 0)
            PopupMenuButton<int>(
              tooltip: 'Seat',
              initialValue: _seat,
              onSelected: (v) => setState(() => _seat = v),
              itemBuilder: (_) => [
                const PopupMenuItem(value: 0, child: Text('Whole table')),
                for (var i = 1; i <= bill.covers; i++) PopupMenuItem(value: i, child: Text('Seat $i')),
              ],
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Chip(avatar: const Icon(Icons.event_seat_rounded, size: 18), label: Text(_seat == 0 ? 'Table' : 'Seat $_seat')),
              ),
            ),
        ],
      ),
      body: Column(children: [
        SizedBox(
          height: 56,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            children: [
              for (final c in s.categories)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                  child: ChoiceChip(
                    label: Text(c.name),
                    selected: c.id == cat,
                    avatar: CircleAvatar(backgroundColor: Color(c.colour), radius: 6),
                    onSelected: (_) => setState(() => _category = c.id),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          flex: 3,
          child: GridView.builder(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 200, mainAxisSpacing: 10, crossAxisSpacing: 10, childAspectRatio: 1.6),
            itemCount: products.length,
            itemBuilder: (_, i) {
              final p = products[i];
              final colour = Color(s.categories.firstWhere((c) => c.id == p.category, orElse: () => s.categories.first).colour);
              return Opacity(
                opacity: p.outOfStock ? 0.4 : 1,
                child: Card(
                  child: InkWell(
                    borderRadius: BorderRadius.circular(Tp.radius),
                    onTap: () => _add(p),
                    child: Container(
                      decoration: BoxDecoration(borderRadius: BorderRadius.circular(Tp.radius), border: Border(top: BorderSide(color: colour, width: 4))),
                      padding: const EdgeInsets.all(12),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(p.name, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700), maxLines: 2, overflow: TextOverflow.ellipsis),
                        const Spacer(),
                        Row(children: [
                          Expanded(child: Money(p.priceMinor, style: t.bodyMedium)),
                          if (p.allergens.isNotEmpty) const Icon(Icons.warning_amber_rounded, size: 16, color: Tp.amber),
                          if (p.outOfStock) Padding(padding: const EdgeInsets.only(left: 4), child: Text('Out', style: t.bodySmall?.copyWith(color: Tp.danger))),
                        ]),
                      ]),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        const Divider(height: 1),
        Expanded(
          flex: 2,
          child: bill.lines.isEmpty
              ? Center(child: Text('Tap a dish to add it', style: t.bodyMedium))
              : ListView(children: [
                  for (final l in bill.lines.reversed)
                    ListTile(
                      dense: true,
                      leading: CircleAvatar(
                        radius: 14,
                        backgroundColor: l.sent ? Tp.lime.withValues(alpha: 0.2) : Tp.amber.withValues(alpha: 0.25),
                        child: Text('${l.quantity}', style: const TextStyle(fontWeight: FontWeight.w800)),
                      ),
                      title: Text(l.product.name),
                      subtitle: Text([
                        ...l.choices.map((c) => c.name),
                        if (l.seat > 0) 'Seat ${l.seat}',
                        if (l.product.allergens.isNotEmpty) 'Contains ${l.product.allergens.join(', ')}',
                        if (l.sent) 'Sent',
                      ].join(' · ')),
                      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                        if (!l.sent) IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => ref.read(tapProvider.notifier).changeQuantity(bill.id, l.id, -1)),
                        Money(l.totalMinor, style: t.bodyMedium),
                      ]),
                    ),
                ]),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Row(children: [
              Expanded(
                child: OutlinedButton(
                  key: const ValueKey('open-bill'),
                  style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 12)),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => BillPage(billId: bill.id))),
                  child: FittedBox(child: Text('Bill ${money(bill.dueMinor)}', style: const TextStyle(fontFeatures: Tp.tabular))),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: unsent == 0
                      ? null
                      // The button itself says "All sent", with a buzz: a message
                      // here would sit over the Bill button the clerk reaches for next.
                      : () {
                          ref.read(tapProvider.notifier).send(bill.id);
                          HapticFeedback.mediumImpact();
                        },
                  child: Text(unsent == 0 ? 'All sent' : 'Send $unsent'),
                ),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}
