/// Type an amount: the raffle, a deposit, the thing not on the menu. It goes
/// on the sale like any item, so it is paid, reported and refunded the same.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../data/lite_state.dart';
import 'pay_page.dart';

class QuickSalePage extends ConsumerStatefulWidget {
  const QuickSalePage({super.key, this.onAdded});

  /// Back to the sale screen after "Add to sale".
  final VoidCallback? onAdded;
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
        if (_minor < 100000) _minor *= 100;
      } else if (_minor < 1000000) {
        _minor = _minor * 10 + int.parse(k);
      }
    });
  }

  String _add() {
    final id = ref.read(currentSaleProvider.notifier).add(
          Product(id: 'quick', name: 'Quick sale', priceMinor: _minor, category: 'quick'),
        );
    setState(() => _minor = 0);
    return id;
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
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
                          height: 60,
                          child: Material(
                            color: Theme.of(context).colorScheme.surfaceContainer,
                            borderRadius: BorderRadius.circular(16),
                            child: InkWell(
                              key: ValueKey('qs-$k'),
                              borderRadius: BorderRadius.circular(16),
                              onTap: () => _press(k),
                              child: Center(child: Text(k, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700))),
                            ),
                          ),
                        ),
                      ),
                    ),
                ]),
              const SizedBox(height: 12),
              Row(children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _minor == 0
                        ? null
                        : () {
                            _add();
                            widget.onAdded?.call();
                          },
                    child: const Text('Add to sale'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    key: const ValueKey('qs-charge'),
                    onPressed: _minor == 0
                        ? null
                        : () {
                            final id = _add();
                            Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PayPage(billId: id)));
                          },
                    child: Text(_minor == 0 ? 'Charge' : 'Charge ${money(_minor)}'),
                  ),
                ),
              ]),
            ]),
          ),
        ),
      ),
    );
  }
}
