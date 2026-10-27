/// The till's cash and stock keys (cash_drawer_sheets.dart, paid_out_sheet.dart,
/// wastage_sheet.dart, clock_sheet.dart), each behind its own permission:
///
///   No sale    opens the drawer through the receipt printer      can_no_sale
///   Paid out   money out of the drawer, and what for             can_expense
///   Paid in    money into the drawer (a float, change)           can_expense
///   Wastage    stock written off, with why                       can_wastage
///   Clock      in or out of a shift                              anyone
///
/// Each is filed with the back office as the till files it (/till/events,
/// /till/wastage, /till/clock).
library;

import 'dart:io' show Socket;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/theme.dart';

import 'receipt_print.dart' show receiptPrinter;
import 'receipt_view.dart' show askManager;

const _uuid = Uuid();

class CashPage extends ConsumerWidget {
  const CashPage({super.key});

  Future<void> _event(BuildContext context, WidgetRef ref, String kind, {int amountMinor = 0, String reason = ''}) async {
    final s = ref.read(tapProvider);
    final messenger = ScaffoldMessenger.of(context);
    if (s.demo) {
      messenger.showSnackBar(SnackBar(content: Text('Demo: $kind ${amountMinor > 0 ? money(amountMinor) : ''} not filed')));
      return;
    }
    try {
      await ref.read(apiProvider).post('/till/events', {
        'id': _uuid.v4(),
        'office': s.venue?.office,
        'kind': kind,
        'amount_minor': amountMinor,
        'reason': reason.isEmpty ? null : reason,
        'staff_name': s.clerk?.name,
        'terminal': ref.read(tapProvider.notifier).terminalName,
        'at': DateTime.now().toUtc().toIso8601String(),
      });
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// The drawer opens on the receipt printer's kick (ESC p), as the till's.
  Future<bool> _kick() async {
    if (kIsWeb) return false;
    final target = await receiptPrinter();
    if (target.isEmpty) return false;
    final parts = target.split(':');
    try {
      final s = await Socket.connect(parts.first, parts.length > 1 ? int.tryParse(parts[1]) ?? 9100 : 9100, timeout: const Duration(seconds: 3));
      s.add(const [0x1B, 0x70, 0x00, 0x19, 0xFA]);
      await s.flush();
      await s.close();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _noSale(BuildContext context, WidgetRef ref) async {
    if (await askManager(context, ref, why: 'No sale', permission: TillPermission.noSale) == null || !context.mounted) return;
    final opened = await _kick();
    if (!context.mounted) return;
    await _event(context, ref, 'no_sale');
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(opened ? 'Drawer open' : 'No sale filed. The drawer opens from the receipt printer: set one in Settings.')));
    }
  }

  Future<void> _money(BuildContext context, WidgetRef ref, {required bool out}) async {
    if (await askManager(context, ref, why: out ? 'Paid out' : 'Paid in', permission: TillPermission.expense) == null || !context.mounted) return;
    final amount = TextEditingController();
    final reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(out ? 'Paid out of the drawer' : 'Paid into the drawer'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: amount, autofocus: true, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount £')),
          const SizedBox(height: 10),
          TextField(controller: reason, decoration: InputDecoration(labelText: out ? 'What for (milk, window cleaner…)' : 'Why (float, change…)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('File it')),
        ],
      ),
    );
    final minor = ((double.tryParse(amount.text.trim()) ?? 0) * 100).round();
    if (ok != true || minor <= 0 || !context.mounted) return;
    if (out) await _kick();
    if (!context.mounted) return;
    await _event(context, ref, out ? 'expense' : 'paid_in', amountMinor: minor, reason: reason.text.trim());
    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${out ? 'Paid out' : 'Paid in'} ${money(minor)}')));
  }

  Future<void> _wastage(BuildContext context, WidgetRef ref) async {
    if (await askManager(context, ref, why: 'Wastage', permission: TillPermission.wastage) == null || !context.mounted) return;
    final s = ref.read(tapProvider);
    Product? product;
    var qty = 1;
    String reason = 'Spilled';
    final ok = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (c) => StatefulBuilder(
        builder: (c, set) => Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(c).bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Wastage', style: Theme.of(c).textTheme.titleLarge),
            const SizedBox(height: 12),
            Autocomplete<Product>(
              displayStringForOption: (p) => p.name,
              optionsBuilder: (v) => v.text.isEmpty ? const [] : s.products.where((p) => p.plu != null && p.name.toLowerCase().contains(v.text.toLowerCase())).take(12),
              onSelected: (p) => set(() => product = p),
              fieldViewBuilder: (c, ctl, focus, submit) => TextField(controller: ctl, focusNode: focus, decoration: const InputDecoration(labelText: 'Product')),
            ),
            const SizedBox(height: 12),
            Row(children: [
              const Text('How many'),
              const Spacer(),
              IconButton(onPressed: qty > 1 ? () => set(() => qty--) : null, icon: const Icon(Icons.remove_circle_outline)),
              Text('$qty', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
              IconButton(onPressed: () => set(() => qty++), icon: const Icon(Icons.add_circle_outline)),
            ]),
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final r in const ['Spilled', 'Dropped', 'Sent back', 'Out of date', 'Staff drink', 'Other'])
                ChoiceChip(label: Text(r), selected: reason == r, onSelected: (_) => set(() => reason = r)),
            ]),
            const SizedBox(height: 12),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Write it off')),
          ]),
        ),
      ),
    );
    final p = product;
    if (ok != true || p == null || !context.mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    if (s.demo) {
      messenger.showSnackBar(SnackBar(content: Text('Demo: $qty ${p.name} not written off')));
      return;
    }
    try {
      await ref.read(apiProvider).post('/till/wastage', {
        'id': _uuid.v4(),
        'office': s.venue?.office,
        'plu_id': p.plu,
        'quantity': qty,
        'reason': reason,
        'staff_name': s.clerk?.name,
        'terminal': ref.read(tapProvider.notifier).terminalName,
      });
      messenger.showSnackBar(SnackBar(content: Text('$qty ${p.name} written off ($reason)')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _clock(BuildContext context, WidgetRef ref) async {
    final s = ref.read(tapProvider);
    final clerk = s.clerk;
    if (clerk == null) return;
    final messenger = ScaffoldMessenger.of(context);
    if (s.demo) {
      messenger.showSnackBar(SnackBar(content: Text('Demo: ${clerk.name} clocked')));
      return;
    }
    try {
      final r = await ref.read(apiProvider).post('/till/clock', {'staff_id': clerk.id, 'terminal': ref.read(tapProvider.notifier).terminalName});
      messenger.showSnackBar(SnackBar(content: Text(r['state'] == 'out' ? '${clerk.name} clocked out' : '${clerk.name} clocked in')));
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final keys = <(IconData, String, String, Future<void> Function())>[
      (Icons.lock_open_rounded, 'No sale', 'Open the drawer', () => _noSale(context, ref)),
      (Icons.north_east_rounded, 'Paid out', 'Money out of the drawer', () => _money(context, ref, out: true)),
      (Icons.south_west_rounded, 'Paid in', 'Money into the drawer', () => _money(context, ref, out: false)),
      (Icons.delete_sweep_rounded, 'Wastage', 'Write stock off', () => _wastage(context, ref)),
      (Icons.schedule_rounded, 'Clock in / out', 'Your shift', () => _clock(context, ref)),
    ];
    return GridView(
      padding: const EdgeInsets.all(16),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 260, mainAxisSpacing: 14, crossAxisSpacing: 14, childAspectRatio: 1.35),
      children: [
        for (final (icon, title, sub, onTap) in keys)
          Card(
            child: InkWell(
              borderRadius: BorderRadius.circular(Tp.radius),
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Icon(icon, size: 32, color: Tp.lime),
                  const Spacer(),
                  Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
                  Text(sub, style: Theme.of(context).textTheme.bodySmall),
                ]),
              ),
            ),
          ),
      ],
    );
  }
}
