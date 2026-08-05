import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// How the clerk expressed a discount.
enum DiscountMode { percent, amount }

/// A discount the clerk agreed, kept in both forms.
///
/// The percentage is carried alongside the cash value because "10% off" and
/// "£2.40 off" are the same money but not the same explanation — the receipt
/// and the Z report should be able to say which was actually given.
class DiscountChoice {
  const DiscountChoice({
    required this.mode,
    required this.value,
    required this.amountMinor,
  });

  final DiscountMode mode;

  /// Percent (10 = 10%) or pounds, matching [mode]. Kept as entered.
  final double value;

  /// What it comes to against the bill it was agreed on.
  final int amountMinor;

  /// "10% off" / "£2.50 off", for a snackbar or a receipt line.
  String get label => mode == DiscountMode.percent
      ? '${value.toStringAsFixed(value % 1 == 0 ? 0 : 1)}% off'
      : '${_money(amountMinor)} off';
}

/// Ask for a discount as either a percentage or a cash amount.
///
/// A till that only takes a cash figure makes the clerk do arithmetic in front
/// of the customer for "give them 10% off", and mental arithmetic at a counter
/// is where discounts go wrong. Both forms are offered, and whichever is chosen
/// the dialog shows the resulting money before it is applied.
///
/// [subtotalMinor] is what the percentage is taken from, and what any amount is
/// capped at — a discount can never exceed the bill.
Future<DiscountChoice?> showDiscountDialog(
  BuildContext context, {
  required int subtotalMinor,
  String title = 'Discount',
  DiscountChoice? current,
}) => showDialog<DiscountChoice>(
  context: context,
  builder: (_) => _DiscountDialog(
    subtotalMinor: subtotalMinor,
    title: title,
    current: current,
  ),
);

class _DiscountDialog extends StatefulWidget {
  const _DiscountDialog({
    required this.subtotalMinor,
    required this.title,
    this.current,
  });

  final int subtotalMinor;
  final String title;
  final DiscountChoice? current;

  @override
  State<_DiscountDialog> createState() => _DiscountDialogState();
}

class _DiscountDialogState extends State<_DiscountDialog> {
  late DiscountMode _mode = widget.current?.mode ?? DiscountMode.percent;
  late final _entry = TextEditingController(
    text: widget.current == null
        ? ''
        : widget.current!.value.toStringAsFixed(
            widget.current!.value % 1 == 0 ? 0 : 2,
          ),
  );

  /// The percentages a venue actually gives. Staff discount, a goodwill
  /// gesture, a manager's 50% — typing those every time is a tax on service.
  static const _presets = [5.0, 10.0, 15.0, 20.0, 25.0, 50.0];

  @override
  void dispose() {
    _entry.dispose();
    super.dispose();
  }

  double get _value => double.tryParse(_entry.text.trim()) ?? 0;

  /// What the entry comes to in money, clamped to the bill: a £20 discount on
  /// an £8 sale is £8 off, not £12 handed back.
  int get _amountMinor {
    final value = _value;
    if (value <= 0) return 0;
    final minor = _mode == DiscountMode.percent
        ? (widget.subtotalMinor * value / 100).round()
        : (value * 100).round();
    return minor.clamp(0, widget.subtotalMinor);
  }

  bool get _capped =>
      _value > 0 && _amountMinor >= widget.subtotalMinor && _mode == DiscountMode.amount;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final amount = _amountMinor;
    final percent = _mode == DiscountMode.percent;

    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 400,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'On ${_money(widget.subtotalMinor)}',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 12),

              SegmentedButton<DiscountMode>(
                segments: const [
                  ButtonSegment(
                    value: DiscountMode.percent,
                    icon: Icon(Icons.percent, size: 17),
                    label: Text('Percentage'),
                  ),
                  ButtonSegment(
                    value: DiscountMode.amount,
                    icon: Icon(Icons.currency_pound, size: 17),
                    label: Text('Amount'),
                  ),
                ],
                selected: {_mode},
                onSelectionChanged: (s) => setState(() {
                  _mode = s.first;
                  // The number means something different in each mode: "10"
                  // is a tenth off or a tenner off. Carrying it across would
                  // silently change the discount.
                  _entry.clear();
                }),
              ),
              const SizedBox(height: 16),

              TextField(
                controller: _entry,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: InputDecoration(
                  labelText: percent ? 'Percentage off' : 'Amount off',
                  prefixText: percent ? null : '£ ',
                  suffixText: percent ? '%' : null,
                  border: const OutlineInputBorder(),
                ),
                onChanged: (_) => setState(() {}),
                onSubmitted: (_) => _apply(),
              ),

              if (percent) ...[
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final preset in _presets)
                      ChoiceChip(
                        label: Text('${preset.toStringAsFixed(0)}%'),
                        selected: _value == preset,
                        onSelected: (_) => setState(
                          () => _entry.text = preset.toStringAsFixed(0),
                        ),
                      ),
                  ],
                ),
              ],

              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(13),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Column(
                  children: [
                    Row(
                      children: [
                        const Expanded(child: Text('Comes off the bill')),
                        Text(
                          '-${_money(amount)}',
                          style: const TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 17,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            'Bill after discount',
                            style: theme.textTheme.bodySmall,
                          ),
                        ),
                        Text(
                          _money(widget.subtotalMinor - amount),
                          style: theme.textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ],
                ),
              ),

              if (_capped) ...[
                const SizedBox(height: 10),
                Text(
                  'That is more than the bill, so it has been capped at '
                  '${_money(widget.subtotalMinor)}.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.error,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        // Clearing is a real action: a discount agreed and then withdrawn has
        // to be removable without abandoning the whole sale.
        if (widget.current != null)
          TextButton(
            onPressed: () => Navigator.pop(
              context,
              const DiscountChoice(
                mode: DiscountMode.amount,
                value: 0,
                amountMinor: 0,
              ),
            ),
            child: const Text('Remove'),
          ),
        FilledButton(
          onPressed: amount > 0 ? _apply : null,
          child: Text(amount > 0 ? 'Take ${_money(amount)} off' : 'Apply'),
        ),
      ],
    );
  }

  void _apply() {
    final amount = _amountMinor;
    if (amount <= 0) return;
    Navigator.pop(
      context,
      DiscountChoice(mode: _mode, value: _value, amountMinor: amount),
    );
  }
}
