/// Type an amount and take it: a market stall, a raffle, a deposit, the odd
/// thing not on the menu. It is still a sale in the back office.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';
import 'pay_sheet.dart';

const _quickItem = Product(id: 'quick', name: 'Quick sale', priceMinor: 0, category: '');

class QuickSalePage extends ConsumerStatefulWidget {
  const QuickSalePage({super.key});
  @override
  ConsumerState<QuickSalePage> createState() => _QuickSalePageState();
}

class _QuickSalePageState extends ConsumerState<QuickSalePage> {
  int _minor = 0;

  void _press(String k) {
    HapticFeedback.selectionClick();
    setState(() {
      if (k == '⌫') {
        _minor ~/= 10;
      } else if (k == '00') {
        if (_minor < 1000000) _minor *= 100;
      } else if (_minor < 10000000) {
        _minor = _minor * 10 + int.parse(k);
      }
    });
  }

  Future<void> _charge() async {
    final notifier = ref.read(tapProvider.notifier);
    final bill = notifier.openTab('Quick sale');
    notifier.addLine(bill.id, Product(id: _quickItem.id, name: _quickItem.name, priceMinor: _minor, category: ''));
    final paid = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => PaySheet(bill: ref.read(tapProvider).bills[bill.id]!, amountMinor: _minor),
    );
    if (paid == true) setState(() => _minor = 0);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(children: [
        const Spacer(),
        Money(_minor, style: t.displayMedium?.copyWith(fontWeight: FontWeight.w900)),
        const Spacer(),
        for (final row in const [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['00', '0', '⌫']])
          Row(children: [
            for (final k in row)
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(5),
                  child: SizedBox(
                    height: 64,
                    child: OutlinedButton(onPressed: () => _press(k), child: Text(k, style: const TextStyle(fontSize: 24, fontFeatures: Tp.tabular))),
                  ),
                ),
              ),
          ]),
        const SizedBox(height: 10),
        FilledButton.icon(
          onPressed: _minor == 0 ? null : _charge,
          icon: const Icon(Icons.contactless_rounded),
          label: Text('Charge ${money(_minor)}'),
        ),
      ]),
    );
  }
}
