/// Charging something else for one line.
///
/// A price override, not a discount, and the difference is what the reports say
/// afterwards: a discount records "this cost £4.00 and £1.00 came off", an
/// override records "this cost £3.00". A venue price-matching a competitor, or
/// honouring a shelf label that turned out to be wrong, means the second — and
/// putting it through as a discount would show in the discount column all week
/// and be queried at the end of the month.
///
/// The dialog states the old price and the new one side by side, and says what
/// the line will come to, because that is the number the clerk is about to read
/// out. Overriding to £7.00 on a line of three is £21.00, and a clerk who has
/// only seen "7.00" on the keypad has been given the wrong figure to say.
library;

import 'package:flutter/material.dart';

import '../data/local/database.dart';
import 'widgets/basket_panel.dart' show money;
import 'widgets/on_screen_keyboard.dart';

/// Asks what to charge for [line]. Returns the new unit price in pence, or null.
Future<int?> showPriceOverride(BuildContext context, OrderLine line) =>
    showDialog<int>(
      context: context,
      builder: (_) => _PriceOverrideDialog(line: line),
    );

class _PriceOverrideDialog extends StatefulWidget {
  const _PriceOverrideDialog({required this.line});

  final OrderLine line;

  @override
  State<_PriceOverrideDialog> createState() => _PriceOverrideDialogState();
}

class _PriceOverrideDialogState extends State<_PriceOverrideDialog> {
  final _amount = TextEditingController();

  @override
  void initState() {
    super.initState();
    _amount.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  /// What is typed, in pence, or null when it is not a price yet.
  ///
  /// Pounds in the box because that is what a shelf label says and what the
  /// customer is arguing about. Everything below the box is pence, as it is
  /// everywhere else in the till.
  int? get _minor {
    final text = _amount.text.trim();
    if (text.isEmpty) return null;
    final pounds = double.tryParse(text);
    if (pounds == null || pounds < 0) return null;
    return (pounds * 100).round();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final line = widget.line;
    final next = _minor;

    return AlertDialog(
      title: const Text('Price override'),
      // Scrollable, so it survives the shortest till anybody runs this on. The
      // same shape as _FieldDialog on the sale screen, and for the same reason
      // its comment gives: a keyboard plus a field plus a total is taller than
      // a 768px panel has to spare once the dialog's own chrome is counted.
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                line.name,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Now ${money(line.unitPriceMinor)} each',
                style: TextStyle(color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _amount,
                autofocus: true,
                // Ours is the input method. A hardware keyboard still types into
                // it; this only stops Windows sliding its own touch keyboard
                // over the top of the one below.
                keyboardType: TextInputType.none,
                decoration: const InputDecoration(
                  labelText: 'New price each',
                  prefixText: '£ ',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              // What the line will actually come to. The figure the clerk reads
              // out, which is not the figure they typed whenever the quantity is
              // more than one.
              if (next != null)
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          line.quantity == 1
                              ? 'This line becomes'
                              : '${_qty(line.quantity)} × ${money(next)} becomes',
                        ),
                      ),
                      Text(
                        money((next * line.quantity).round()),
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 18,
                        ),
                      ),
                    ],
                  ),
                ),
              if (next == 0)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    // Allowed, and worth saying out loud. A comped item goes on
                    // at nothing so the kitchen still makes it and the stock
                    // still moves — but nobody should set it to zero by accident.
                    'This line will be free.',
                    style: TextStyle(color: scheme.error),
                  ),
                ),
              const SizedBox(height: 6),
              OnScreenKeyboard(
                controller: _amount,
                mode: PosKeyboardMode.decimal,
                submitLabel: 'Set price',
                onSubmit: next == null
                    ? null
                    : () => Navigator.pop(context, next),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: next == null ? null : () => Navigator.pop(context, next),
          child: const Text('Set price'),
        ),
      ],
    );
  }
}

String _qty(double q) =>
    q % 1 == 0 ? q.toStringAsFixed(0) : q.toStringAsFixed(2);
