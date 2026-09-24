/// Counting cash into the drawer, and counting it back out.
///
/// Two sheets, one file, because they are the same act at opposite ends of a
/// shift and the venue asked for them together:
///
///   * **Float** — what is put in the drawer before trading. It has been on the
///     session and printed on the Z since sessions existed, and there has never
///     been a way to enter it. It was always zero, so "cash expected" was always
///     the takings rather than what should actually be in the drawer.
///   * **Cash declaration** — what is in the drawer at the end, counted before
///     the Z is run so the Z can say whether the till is up or down.
///
/// The declaration comes in two shapes and the venue chooses which, because
/// venues differ on how much they trust a fast close:
///
///   * `total` — one figure. Fast, and when the till is down there is nothing
///     to say where.
///   * `count`  — the denomination grid the venue already has. Slower, and a
///     miscount shows up as a wrong denomination rather than a wrong total.
///
/// Both use the till's own keyboard: a Windows terminal on a counter with no
/// keyboard behind it is the ordinary case, not the exception.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/cash_tally.dart';
import '../data/local/database.dart';
import '../data/till_settings.dart';
import '../main.dart';
import 'widgets/basket_panel.dart' show money;
import 'widgets/cash_notes_panel.dart';
import 'widgets/on_screen_keyboard.dart';

/// Ask what is being counted into the drawer, and record it.
///
/// Returns the float in pence when one was set, or null when the sheet was
/// dismissed.
Future<int?> showFloatSheet(BuildContext context, WidgetRef ref) async {
  final session = await ref.read(sessionRepositoryProvider).current();
  if (!context.mounted) return null;

  final minor = await showDialog<int>(
    context: context,
    builder: (_) => _CountSheet(
      title: 'Float',
      blurb: 'What is being put in the drawer to start the shift. It prints on '
          'the Z, and what the till expects to find at the end is counted from '
          'it.',
      confirmLabel: 'Set float',
      // Pre-filled, because the common case for pressing this twice is
      // correcting a typo rather than starting again.
      initialMinor: session.openingFloatMinor,
      // A float is a bag of change counted note by note, so the grid is offered
      // here whatever the venue chose for the end of the night.
      allowCount: true,
    ),
  );
  if (minor == null || !context.mounted) return null;

  await ref.read(sessionRepositoryProvider).setOpeningFloat(minor);
  return minor;
}

/// Ask what is in the drawer before a Z, in the shape the venue asked for.
///
/// Returns the counted amount in pence, or null when the clerk backed out —
/// which must abandon the Z, not run it: a declaration that was started and
/// cancelled is not a declaration of zero.
Future<int?> showCashDeclaration(
  BuildContext context,
  WidgetRef ref, {
  required CashDeclaration mode,
}) {
  if (!mode.asks) return Future.value(null);

  return showDialog<int>(
    context: context,
    builder: (_) => _CountSheet(
      title: 'Cash in the drawer',
      blurb: 'Count what is in the drawer now. The Z will say whether the till '
          'is up or down against it.',
      confirmLabel: 'Declare',
      initialMinor: 0,
      allowCount: mode == CashDeclaration.count,
      startOnCount: mode == CashDeclaration.count,
    ),
  );
}

/// A number, typed or counted.
class _CountSheet extends ConsumerStatefulWidget {
  const _CountSheet({
    required this.title,
    required this.blurb,
    required this.confirmLabel,
    required this.initialMinor,
    required this.allowCount,
    this.startOnCount = false,
  });

  final String title;
  final String blurb;
  final String confirmLabel;
  final int initialMinor;

  /// Whether the denomination grid is offered at all.
  final bool allowCount;

  /// Whether it opens on the grid rather than the keypad.
  final bool startOnCount;

  @override
  ConsumerState<_CountSheet> createState() => _CountSheetState();
}

class _CountSheetState extends ConsumerState<_CountSheet> {
  late final TextEditingController _typed;
  CashTally _tally = CashTally.empty;
  late bool _counting;

  @override
  void initState() {
    super.initState();
    _counting = widget.allowCount && widget.startOnCount;
    _typed = TextEditingController(
      text: widget.initialMinor == 0
          ? ''
          : (widget.initialMinor / 100).toStringAsFixed(2),
    );
    _typed.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _typed.dispose();
    super.dispose();
  }

  /// What has been counted, from whichever half is showing.
  int? get _minor {
    if (_counting) return _tally.totalMinor;
    final text = _typed.text.trim();
    if (text.isEmpty) return null;
    final pounds = double.tryParse(text);
    if (pounds == null || pounds < 0) return null;
    return (pounds * 100).round();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final denominations =
        ref.watch(cashDenominationsProvider).value ?? const <CashDenomination>[];
    final minor = _minor;

    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: _counting ? 620 : 400,
        // Scrollable for the reason _FieldDialog gives: a keyboard or a note
        // grid plus a running total is taller than a 768px panel has spare.
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                widget.blurb,
                style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 14),

              // Only offered when the venue's setting allows it. A single
              // toggle rather than two dialogs: somebody who starts typing and
              // then decides to count properly should not have to back out.
              if (widget.allowCount) ...[
                SegmentedButton<bool>(
                  segments: const [
                    ButtonSegment(
                      value: false,
                      icon: Icon(Icons.dialpad),
                      label: Text('Type a total'),
                    ),
                    ButtonSegment(
                      value: true,
                      icon: Icon(Icons.payments_outlined),
                      label: Text('Count it'),
                    ),
                  ],
                  selected: {_counting},
                  onSelectionChanged: (s) =>
                      setState(() => _counting = s.first),
                ),
                const SizedBox(height: 14),
              ],

              if (_counting)
                CashNotesPanel(
                  denominations: denominations,
                  tally: _tally,
                  onTakeNote: (valueMinor) =>
                      setState(() => _tally = _tally.add(valueMinor)),
                  onUndo: () => setState(() => _tally = _tally.clear()),
                )
              else
                TextField(
                  controller: _typed,
                  autofocus: true,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 26,
                    fontWeight: FontWeight.w700,
                  ),
                  // Ours is the input method — see _FieldDialog on the sale
                  // screen. This only stops Windows sliding its own touch
                  // keyboard over the one below.
                  keyboardType: TextInputType.none,
                  decoration: const InputDecoration(
                    prefixText: '£ ',
                    border: OutlineInputBorder(),
                  ),
                ),

              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Row(
                  children: [
                    const Expanded(child: Text('Counted')),
                    Text(
                      money(minor ?? 0),
                      style: const TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),

              if (!_counting) ...[
                const SizedBox(height: 10),
                OnScreenKeyboard(
                  controller: _typed,
                  mode: PosKeyboardMode.decimal,
                  submitLabel: widget.confirmLabel,
                  onSubmit: minor == null
                      ? null
                      : () => Navigator.pop(context, minor),
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
        FilledButton(
          // Zero is a real answer when counting — an empty drawer is a fact —
          // so only "nothing typed at all" is refused.
          onPressed:
              minor == null ? null : () => Navigator.pop(context, minor),
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}
