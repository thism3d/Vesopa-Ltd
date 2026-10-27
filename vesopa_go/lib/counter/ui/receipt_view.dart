/// A sale as its receipt reads, on screen; and emailing it, as the back
/// office's own receipt PDF.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../data/journal.dart';

String hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
String ddmmyy(DateTime d) => '${d.day.toString().padLeft(2, '0')}/${d.month.toString().padLeft(2, '0')}/${d.year % 100}';

String payKind(String kind) => switch (kind) {
      'cash' => 'Cash',
      'machine' => 'Card (card machine)',
      _ => 'Card',
    };

class ReceiptView extends ConsumerWidget {
  const ReceiptView({super.key, required this.sale});
  final SaleRecord sale;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final venue = ref.watch(tapProvider.select((s) => s.venue?.name ?? ''));
    final t = Theme.of(context).textTheme;
    final dim = t.bodySmall?.color;
    Widget row(String label, int minor, {bool bold = false, Color? colour}) {
      final style = (bold ? t.titleMedium?.copyWith(fontWeight: FontWeight.w900) : t.bodyMedium)?.copyWith(color: colour);
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [Expanded(child: Text(label, style: style)), Money(minor, style: style)]),
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(venue, textAlign: TextAlign.center, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 2),
          Text('Receipt ${sale.number} · ${ddmmyy(sale.at)} ${hhmm(sale.at)} · ${sale.clerk}', textAlign: TextAlign.center, style: t.bodySmall),
          const Divider(height: 24),
          for (final l in sale.lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(width: 30, child: Text('${l.quantity}×', style: t.bodyMedium?.copyWith(color: dim, fontFeatures: Tp.tabular))),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(l.name, style: t.bodyMedium),
                    if (l.detail.isNotEmpty) Text(l.detail, style: t.bodySmall),
                  ]),
                ),
                Money(l.totalMinor, style: t.bodyMedium),
              ]),
            ),
          const Divider(height: 24),
          if (sale.discountMinor > 0) ...[row('Subtotal', sale.subtotalMinor), row('Discount', -sale.discountMinor)],
          row('Total', sale.totalMinor, bold: true),
          const SizedBox(height: 6),
          for (final p in sale.payments) row(payKind(p.kind), p.amountMinor + p.tipMinor),
          if (sale.changeMinor > 0) row('Change', sale.changeMinor),
          if (sale.tipsMinor > 0) row('Of which tip', sale.tipsMinor),
          for (final r in sale.refunds) row('Refunded ${hhmm(r.at)} (${r.kind}): ${r.reason}', -r.amountMinor, colour: Tp.danger),
        ]),
      ),
    );
  }
}

/// Ask for an address and email the receipt. The sale reaches the back
/// office through the outbox, so a moment's wait first.
Future<void> emailReceipt(BuildContext context, WidgetRef ref, String saleId) async {
  final email = await showDialog<String>(
    context: context,
    builder: (c) {
      final ctl = TextEditingController();
      return AlertDialog(
        title: const Text('Email the receipt'),
        content: TextField(
          controller: ctl,
          keyboardType: TextInputType.emailAddress,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Email address'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('Send')),
        ],
      );
    },
  );
  if (email == null || !email.contains('@') || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  if (ref.read(tapProvider).demo) {
    messenger.showSnackBar(SnackBar(content: Text('Demo: the receipt would go to $email')));
    return;
  }
  try {
    await Future<void>.delayed(const Duration(seconds: 2));
    await ref.read(apiProvider).emailReceipt(saleId, email);
    messenger.showSnackBar(SnackBar(content: Text('Receipt sent to $email')));
  } on TapApiError catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
  }
}

/// A manager's PIN, for a refund or the End of day. Returns their name.
Future<String?> askManager(BuildContext context, WidgetRef ref, {required String why}) async {
  final s = ref.read(tapProvider);
  final g = (s.clerk?.group ?? '').toLowerCase();
  if (RegExp('manager|supervisor|owner|admin').hasMatch(g)) return s.clerk!.name;
  final pin = await showDialog<String>(
    context: context,
    builder: (c) {
      final ctl = TextEditingController();
      return AlertDialog(
        title: Text(why),
        content: TextField(
          controller: ctl,
          autofocus: true,
          obscureText: true,
          keyboardType: TextInputType.number,
          maxLength: 6,
          decoration: const InputDecoration(labelText: 'A manager\'s PIN', counterText: ''),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('OK')),
        ],
      );
    },
  );
  if (pin == null) return null;
  final manager = ref.read(tapProvider.notifier).managerByPin(pin);
  if (manager == null && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('That is not a manager\'s PIN')));
  }
  return manager?.name;
}
