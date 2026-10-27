/// The sale so far: its lines, the discount, the total. A sheet from View
/// Sale on a phone; a column of its own beside the menu on a tablet.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/pages/note_sheet.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../data/lite_state.dart';
import 'receipt_view.dart' show askManager;

class SalePanel extends ConsumerStatefulWidget {
  const SalePanel({super.key, this.onPay, this.inSheet = false});

  /// Pay, from the tablet's column (the phone pays from its bottom bar).
  final VoidCallback? onPay;
  final bool inSheet;
  @override
  ConsumerState<SalePanel> createState() => _SalePanelState();
}

class _SalePanelState extends ConsumerState<SalePanel> {
  String? _open;

  /// Lines picked by a long press, for one action on all of them.
  final _picked = <String>{};

  void _remove(Bill bill, BillLine l) {
    if (l.sent || l.paidQuantity > 0) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Sent to the kitchen: void it from the table with a reason.')));
      return;
    }
    ref.read(tapProvider.notifier).changeQuantity(bill.id, l.id, -l.quantity);
    HapticFeedback.mediumImpact();
  }

  Future<void> _edit(Bill bill, BillLine l) async {
    if (l.sent) return;
    final note = await askNote(context, ref, title: l.product.name, initial: l.note);
    if (note != null) ref.read(tapProvider.notifier).setNote(bill.id, l.id, note);
  }

  @override
  Widget build(BuildContext context) {
    final id = ref.watch(currentSaleProvider);
    final bill = ref.watch(tapProvider.select((s) => id == null ? null : s.bills[id]));
    final t = Theme.of(context).textTheme;
    final dim = t.bodySmall?.color;
    final session = ref.read(tapProvider.notifier);

    if (bill == null || bill.lines.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.shopping_basket_outlined, size: 48, color: dim),
              const SizedBox(height: 12),
              Text('Nothing on this sale yet', style: t.titleMedium),
              const SizedBox(height: 4),
              Text('Tap an item to ring it up.', style: t.bodySmall),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
          child: Row(
            children: [
              Expanded(
                child: Text('This sale', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
              ),
              TextButton.icon(
                onPressed: bill.paidMinor > 0 ? null : () => _discount(bill),
                icon: const Icon(Icons.percent_rounded, size: 18),
                label: const Text('Discount'),
              ),
              IconButton(
                tooltip: 'Clear the sale',
                onPressed: bill.paidMinor > 0 || bill.lines.any((l) => l.sent) ? null : () => _clear(),
                icon: const Icon(Icons.delete_outline_rounded),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: ListView.separated(
            itemCount: bill.lines.length,
            separatorBuilder: (_, _) => const Divider(height: 1, indent: 16, endIndent: 16),
            itemBuilder: (context, i) {
              final l = bill.lines[bill.lines.length - 1 - i];
              final open = _open == l.id;
              final picked = _picked.contains(l.id);
              final detail = [for (final c in l.choices) c.name, if (l.note.isNotEmpty) l.note].join(' · ');
              final editable = !l.sent && l.paidQuantity == 0;
              return Dismissible(
                key: ValueKey('line-${l.id}'),
                direction: editable ? DismissDirection.horizontal : DismissDirection.none,
                // Right: one more. Left: off the sale. Neither leaves the row
                // swiped away; the bill itself changes underneath.
                confirmDismiss: (dir) async {
                  if (dir == DismissDirection.startToEnd) {
                    session.changeQuantity(bill.id, l.id, 1);
                    HapticFeedback.selectionClick();
                  } else {
                    _remove(bill, l);
                  }
                  return false;
                },
                background: Container(
                  color: Tp.green.withValues(alpha: 0.85),
                  alignment: Alignment.centerLeft,
                  padding: const EdgeInsets.only(left: 20),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.add_rounded, color: Colors.white),
                      SizedBox(width: 6),
                      Text(
                        'One more',
                        style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
                      ),
                    ],
                  ),
                ),
                secondaryBackground: Container(
                  color: Tp.danger.withValues(alpha: 0.9),
                  alignment: Alignment.centerRight,
                  padding: const EdgeInsets.only(right: 20),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        'Remove',
                        style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
                      ),
                      SizedBox(width: 6),
                      Icon(Icons.delete_outline_rounded, color: Colors.white),
                    ],
                  ),
                ),
                child: Material(
                  color: picked ? Tp.lime.withValues(alpha: 0.14) : Colors.transparent,
                  child: InkWell(
                    onTap: _picked.isNotEmpty
                        ? () => setState(() => picked ? _picked.remove(l.id) : _picked.add(l.id))
                        : () => setState(() => _open = open ? null : l.id),
                    onLongPress: editable ? () => setState(() => picked ? _picked.remove(l.id) : _picked.add(l.id)) : null,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              SizedBox(
                                width: 32,
                                child: Text(
                                  '${l.quantity}×',
                                  style: t.titleSmall?.copyWith(fontFeatures: Tp.tabular, color: dim),
                                ),
                              ),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(l.product.name, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                                    if (detail.isNotEmpty) Text(detail, style: t.bodySmall),
                                    if (l.product.allergens.isNotEmpty)
                                      Text('Allergens: ${l.product.allergens.join(', ')}', style: t.bodySmall?.copyWith(color: Tp.amber)),
                                  ],
                                ),
                              ),
                              Money(l.totalMinor, style: t.titleSmall),
                            ],
                          ),
                          if (open && !l.sent && l.paidQuantity == 0)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.end,
                                children: [
                                  IconButton.filledTonal(
                                    tooltip: l.quantity == 1 ? 'Remove' : 'One fewer',
                                    onPressed: () => session.changeQuantity(bill.id, l.id, -1),
                                    icon: Icon(l.quantity == 1 ? Icons.delete_outline_rounded : Icons.remove_rounded),
                                  ),
                                  const SizedBox(width: 8),
                                  IconButton.filledTonal(
                                    tooltip: 'One more',
                                    onPressed: () => session.changeQuantity(bill.id, l.id, 1),
                                    icon: const Icon(Icons.add_rounded),
                                  ),
                                  const SizedBox(width: 8),
                                  IconButton.filledTonal(tooltip: 'Note', onPressed: () => _edit(bill, l), icon: const Icon(Icons.edit_note_rounded)),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        // A long press picked lines: one action for all of them.
        AnimatedSize(
          duration: const Duration(milliseconds: 200),
          child: _picked.isEmpty
              ? const SizedBox(width: double.infinity)
              : Padding(
                  padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
                  child: Row(
                    children: [
                      Text('${_picked.length} picked', style: t.titleSmall),
                      const Spacer(),
                      TextButton(onPressed: () => setState(_picked.clear), child: const Text('Cancel')),
                      FilledButton.tonalIcon(
                        onPressed: () {
                          for (final l in [...bill.lines]) {
                            if (_picked.contains(l.id)) _remove(bill, l);
                          }
                          setState(_picked.clear);
                        },
                        icon: const Icon(Icons.delete_outline_rounded),
                        label: const Text('Remove'),
                      ),
                    ],
                  ),
                ),
        ),
        const Divider(height: 1),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
          child: Column(
            children: [
              if (bill.discountMinor > 0) ...[
                _Row('Subtotal', bill.subtotalMinor),
                // Each mix & match deal by name, as the till lists them.
                for (final d in bill.dealsApplied.deals) _Row(d.times > 1 ? '${d.name} ×${d.times}' : d.name, -d.savingMinor),
                if (bill.discountMinor - bill.dealMinor > 0)
                  _Row(bill.discountReason.isEmpty ? 'Discount' : 'Discount (${bill.discountReason})', -(bill.discountMinor - bill.dealMinor)),
              ],
              if (bill.paidMinor > 0) _Row('Paid so far', -bill.paidMinor),
              _Row(bill.paidMinor > 0 ? 'Left to pay' : 'Total', bill.dueMinor, bold: true),
            ],
          ),
        ),
        if (widget.onPay != null)
          Padding(
            padding: const EdgeInsets.all(16),
            child: FilledButton(key: const ValueKey('panel-pay'), onPressed: widget.onPay, child: Text('Pay ${money(bill.dueMinor)}')),
          )
        else
          const SizedBox(height: 16),
      ],
    );
  }

  void _clear() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Clear this sale?'),
        content: const Text('Everything on it comes off. Nothing has been taken.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Clear')),
        ],
      ),
    );
    if (ok != true) return;
    ref.read(currentSaleProvider.notifier).clear();
    if (widget.inSheet && mounted) Navigator.pop(context);
  }

  Future<void> _discount(Bill bill) async {
    // The till's discount key: without it, a manager's PIN.
    final allowedBy = await askManager(context, ref, why: 'Discount', permission: TillPermission.discount);
    if (allowedBy == null || !mounted) return;
    final clerk = ref.read(tapProvider).clerk?.name ?? '';
    final picked = await showModalBottomSheet<(double, int)>(
      context: context,
      showDragHandle: true,
      builder: (c) => _DiscountSheet(bill: bill),
    );
    if (picked == null) return;
    final (percent, fixed) = picked;
    final label = percent > 0 ? '${percent % 1 == 0 ? percent.toInt() : percent}%' : (fixed > 0 ? money(fixed) : '');
    ref.read(tapProvider.notifier).setDiscount(bill.id, percent: percent, fixedMinor: fixed, reason: label.isEmpty ? '' : '$label by $clerk');
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.minor, {this.bold = false});
  final String label;
  final int minor;
  final bool bold;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final style = bold ? t.titleLarge?.copyWith(fontWeight: FontWeight.w900) : t.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(child: Text(label, style: style)),
          Money(minor, style: style),
        ],
      ),
    );
  }
}

/// A discount on the whole sale: a quick percentage, or an amount off.
class _DiscountSheet extends StatefulWidget {
  const _DiscountSheet({required this.bill});
  final Bill bill;
  @override
  State<_DiscountSheet> createState() => _DiscountSheetState();
}

class _DiscountSheetState extends State<_DiscountSheet> {
  final _amount = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final b = widget.bill;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Discount the sale', style: t.titleLarge),
            Text('On ${money(b.subtotalMinor)}', style: t.bodySmall),
            const SizedBox(height: 16),
            Row(
              children: [
                for (final p in const [10.0, 20.0, 25.0, 50.0])
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: OutlinedButton(onPressed: () => Navigator.pop(context, (p, 0)), child: Text('${p.toInt()}%')),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Or an amount off', prefixText: '£ '),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () {
                final v = double.tryParse(_amount.text.trim());
                if (v == null || v <= 0) return;
                Navigator.pop(context, (0.0, (v * 100).round().clamp(0, b.subtotalMinor)));
              },
              child: const Text('Take it off'),
            ),
            if (b.manualDiscountMinor > 0) ...[
              const SizedBox(height: 8),
              TextButton(onPressed: () => Navigator.pop(context, (0.0, 0)), child: const Text('Remove the discount')),
            ],
          ],
        ),
      ),
    );
  }
}
