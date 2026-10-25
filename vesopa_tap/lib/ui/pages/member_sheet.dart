/// A Vesopa Loyalty member on the bill: scan the code their app shows, or
/// type the number on their card. Their standing discount applies at once
/// and the sale earns them points, by the till's own rules.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../data/api.dart';
import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';

class MemberSheet extends ConsumerStatefulWidget {
  const MemberSheet({super.key, required this.billId});
  final String billId;
  @override
  ConsumerState<MemberSheet> createState() => _MemberSheetState();
}

class _MemberSheetState extends ConsumerState<MemberSheet> {
  final _number = TextEditingController();
  bool _scan = false;
  bool _busy = false;
  String? _error;
  Member? _found;

  Future<void> _look(String number) async {
    final n = number.trim();
    if (n.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _scan = false;
    });
    try {
      final m = ref.read(tapProvider).demo
          ? Member(id: 9, name: 'Jo Member', number: n, pointsBalance: 120, discountType: 'percent', discountValue: 10, earns: true, pointsPerPound: 1)
          : await ref.read(apiProvider).member(n);
      HapticFeedback.mediumImpact();
      setState(() => _found = m);
    } on TapApiError catch (e) {
      setState(() => _error = e.status == 404 ? 'No member holds that card.' : e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final m = _found;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Member', style: t.titleLarge),
          const SizedBox(height: 12),
          if (m != null) ...[
            Card(
              child: ListTile(
                leading: const Icon(Icons.card_membership_rounded, color: Tp.lime, size: 32),
                title: Text(m.name, style: t.titleMedium),
                subtitle: Text([
                  if (m.number.isNotEmpty) m.number,
                  '${m.pointsBalance.toStringAsFixed(m.pointsBalance % 1 == 0 ? 0 : 2)} points',
                  if (m.discountType == 'percent') '${m.discountValue}% off',
                  if (m.discountType == 'amount') '${money(m.discountValue)} off',
                ].join(' · ')),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () {
                ref.read(tapProvider.notifier).setMember(widget.billId, m);
                Navigator.pop(context, true);
              },
              child: const Text('Put on the bill'),
            ),
          ] else if (_scan)
            ClipRRect(
              borderRadius: BorderRadius.circular(Tp.radius),
              child: SizedBox(
                height: 280,
                child: MobileScanner(
                  onDetect: (capture) {
                    final raw = capture.barcodes.map((b) => b.rawValue).whereType<String>().firstOrNull;
                    if (raw != null) _look(raw);
                  },
                ),
              ),
            )
          else ...[
            TextField(
              controller: _number,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Card or member number'),
              onSubmitted: _look,
            ),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: () => setState(() => _scan = true), icon: const Icon(Icons.qr_code_scanner_rounded), label: const Text('Scan their app'))),
              const SizedBox(width: 10),
              Expanded(child: FilledButton(onPressed: _busy ? null : () => _look(_number.text), child: Text(_busy ? 'Looking…' : 'Find'))),
            ]),
          ],
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_error!, style: t.bodyMedium?.copyWith(color: Tp.danger))),
        ]),
      ),
    );
  }
}

/// A voucher code, checked by the back office against this bill.
Future<void> askVoucher(BuildContext context, WidgetRef ref, Bill bill) async {
  final ctl = TextEditingController();
  final code = await showDialog<String>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('Voucher'),
      content: TextField(controller: ctl, textCapitalization: TextCapitalization.characters, autofocus: true, decoration: const InputDecoration(labelText: 'Voucher code')),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim().toUpperCase()), child: const Text('Check')),
      ],
    ),
  );
  if (code == null || code.isEmpty || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  if (ref.read(tapProvider).demo) {
    ref.read(tapProvider.notifier).setVoucher(bill.id, code, 500);
    messenger.showSnackBar(const SnackBar(content: Text('Demo voucher: £5.00 off')));
    return;
  }
  try {
    final r = await ref.read(apiProvider).checkVoucher(code, bill.subtotalMinor);
    if (r['valid'] != true) {
      final why = (r['reasons'] as List? ?? const []).join(', ');
      messenger.showSnackBar(SnackBar(content: Text(why.isEmpty ? 'That voucher cannot be used.' : why)));
      return;
    }
    final off = (r['discount_minor'] as num?)?.toInt() ?? 0;
    ref.read(tapProvider.notifier).setVoucher(bill.id, code, off);
    messenger.showSnackBar(SnackBar(content: Text('${money(off)} off with $code')));
  } on TapApiError catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.message)));
  }
}
