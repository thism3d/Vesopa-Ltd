import 'package:flutter/material.dart';

import '../../data/cash_tally.dart';
import '../../data/local/database.dart';
import '../theme.dart';

/// The note keys, as pictures of the actual notes.
///
/// A clerk taking cash is matching what is in their hand to what is on the
/// screen, and a picture of a £20 does that in a glance where a coloured box
/// reading "£20" does not. Tapping a note counts one of it in; the running
/// tally lives beside the bill so the customer can check it as they hand
/// things over.
///
/// The set comes from the back office (see cash_denominations), so a venue can
/// swap the artwork or change what a key is worth without a new build.
class CashNotesPanel extends StatelessWidget {
  const CashNotesPanel({
    super.key,
    required this.denominations,
    required this.tally,
    required this.dueMinor,
    required this.onAdd,
    required this.onClear,
    required this.onTake,
  });

  final List<CashDenomination> denominations;
  final CashTally tally;

  /// What is still owed — drives the change line and whether Take is offered.
  final int dueMinor;

  final void Function(int valueMinor) onAdd;
  final VoidCallback onClear;

  /// Commit the counted cash as a tender.
  final VoidCallback onTake;

  int get _changeMinor {
    final over = tally.totalMinor - dueMinor;
    return over > 0 ? over : 0;
  }

  @override
  Widget build(BuildContext context) {
    if (denominations.isEmpty) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final counted = tally.totalMinor;
    final short = dueMinor - counted;

    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.payments_outlined, size: 18, color: scheme.primary),
              const SizedBox(width: 8),
              Text(
                'Cash — tap each note as it is handed over',
                style: theme.textTheme.titleSmall
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
          const SizedBox(height: 10),

          // Notes wrap rather than scroll: a key a clerk has to scroll to find
          // is a key that gets missed while a customer is waiting.
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              for (final d in denominations)
                _NoteKey(
                  denomination: d,
                  count: tally.counts[d.valueMinor] ?? 0,
                  onTap: () => onAdd(d.valueMinor),
                ),
            ],
          ),

          if (tally.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: scheme.surface,
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: scheme.outlineVariant),
              ),
              child: Column(
                children: [
                  _row(
                    context,
                    'Counted',
                    _money(counted),
                    bold: true,
                  ),
                  if (short > 0)
                    _row(
                      context,
                      'Still to pay',
                      _money(short),
                      colour: scheme.error,
                    )
                  else if (_changeMinor > 0)
                    _row(
                      context,
                      'Change',
                      _money(_changeMinor),
                      bold: true,
                      colour: Pos.green,
                    ),
                ],
              ),
            ),
          ],

          const SizedBox(height: 12),
          // The way out and the way through, bottom right.
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton.icon(
                onPressed: tally.isEmpty ? null : onClear,
                icon: const Icon(Icons.backspace_outlined, size: 18),
                label: const Text('Clear'),
              ),
              const SizedBox(width: 8),
              FilledButton.icon(
                // Nothing counted, nothing to take. Short of the bill is fine —
                // part payment in cash is normal, and the balance stays owed.
                onPressed: tally.isEmpty ? null : onTake,
                icon: const Icon(Icons.check),
                label: Text(
                  tally.isEmpty ? 'Take cash' : 'Take ${_money(counted)}',
                ),
                style: FilledButton.styleFrom(
                  backgroundColor: Pos.brand,
                  foregroundColor: Pos.onBrand,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _row(
    BuildContext context,
    String label,
    String value, {
    bool bold = false,
    Color? colour,
  }) {
    final style = TextStyle(
      fontSize: bold ? 16 : 14,
      fontWeight: bold ? FontWeight.w700 : FontWeight.w500,
      color: colour,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(child: Text(label, style: style)),
          Text(value, style: style),
        ],
      ),
    );
  }
}

/// One note. Shows the artwork when there is any, and how many have been
/// counted in as a badge — the count is the whole point, so it is not hidden
/// in a list somewhere else.
class _NoteKey extends StatelessWidget {
  const _NoteKey({
    required this.denomination,
    required this.count,
    required this.onTap,
  });

  final CashDenomination denomination;
  final int count;
  final VoidCallback onTap;

  /// Roughly a real banknote's proportions, so the picture is not distorted.
  static const _width = 132.0;
  static const _height = 70.0;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final url = denomination.imageUrl;

    return Semantics(
      button: true,
      label: '${denomination.label}, $count counted',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(9),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Container(
                width: _width,
                height: _height,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(
                    color: count > 0 ? Pos.brand : scheme.outlineVariant,
                    width: count > 0 ? 2.5 : 1,
                  ),
                  color: scheme.surface,
                ),
                clipBehavior: Clip.antiAlias,
                child: (url == null || url.isEmpty)
                    ? _fallback(context)
                    : Image.network(
                        url,
                        fit: BoxFit.cover,
                        // A picture that will not load — a till on a dead
                        // network, a file removed in the back office — must
                        // never leave a blank key. The clerk still has to be
                        // able to take the money.
                        errorBuilder: (_, _, _) => _fallback(context),
                        loadingBuilder: (context, child, progress) =>
                            progress == null ? child : _fallback(context),
                      ),
              ),
              if (count > 0)
                Positioned(
                  top: -6,
                  right: -6,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: Pos.brand,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: scheme.surface, width: 2),
                    ),
                    child: Text(
                      '×$count',
                      style: const TextStyle(
                        color: Pos.onBrand,
                        fontSize: 13,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// The label on a plain card — what a key looks like with no artwork.
  Widget _fallback(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      alignment: Alignment.center,
      color: scheme.surfaceContainerHighest,
      child: Text(
        denomination.label,
        style: TextStyle(
          fontSize: 22,
          fontWeight: FontWeight.w800,
          color: scheme.onSurface,
        ),
      ),
    );
  }
}

String _money(int minor) => minor % 100 == 0
    ? '£${minor ~/ 100}'
    : '£${(minor / 100).toStringAsFixed(2)}';
