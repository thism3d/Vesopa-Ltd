import 'package:flutter/material.dart';

import '../../data/cash_tally.dart';
import '../../data/local/database.dart';
import '../theme.dart';

/// The note keys, as pictures of the actual notes.
///
/// A clerk taking cash is matching what is in their hand to what is on the
/// screen, and a picture of a £20 does that in a glance where a coloured box
/// reading "£20" does not.
///
/// **Tapping a note takes it.** As of v1.3.2.0 these are quick-cash keys: a tap
/// on £20 puts £20 against the bill immediately, with no confirmation and no
/// second press. They used to *count* into a tally that a separate "Take cash"
/// button then committed, which meant the fastest tender on the counter needed
/// two deliberate actions and the second one was routinely forgotten with a
/// customer already walking away.
///
/// The tally did not go away, it moved underneath: consecutive taps rewrite one
/// cash payment rather than stacking up several, so a twenty and then a five is
/// a single £25 line reading "1 x £20, 1 x £5". The customer still watches the
/// count build up beside the bill, which is what the pictures were for.
///
/// The set comes from the back office (see cash_denominations), so a venue can
/// swap the artwork or change what a key is worth without a new build.
class CashNotesPanel extends StatelessWidget {
  const CashNotesPanel({
    super.key,
    required this.denominations,
    required this.tally,
    required this.dueMinor,
    required this.changeMinor,
    required this.onTakeNote,
    required this.onUndo,
  });

  final List<CashDenomination> denominations;

  /// The notes taken so far on this bill, for the badges and the summary.
  final CashTally tally;

  /// What is still owed *after* everything taken so far, including these notes.
  final int dueMinor;

  /// What is owed back, if the notes have overshot the bill.
  final int changeMinor;

  /// Take one of this note, now.
  final void Function(int valueMinor) onTakeNote;

  /// Hand it all back: undoes the cash payment these keys built.
  final VoidCallback onUndo;

  @override
  Widget build(BuildContext context) {
    if (denominations.isEmpty) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final taken = tally.totalMinor;

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
              Expanded(
                child: Text(
                  'Cash — tap a note to take it',
                  style: theme.textTheme.titleSmall
                      ?.copyWith(fontWeight: FontWeight.w700),
                ),
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
                  onTap: () => onTakeNote(d.valueMinor),
                ),
            ],
          ),

          // What the taps have actually done. Only once something has been
          // taken — an empty box under an untouched panel says nothing.
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
                  _row(context, 'Taken', _money(taken), bold: true),
                  if (dueMinor > 0)
                    _row(
                      context,
                      'Still to pay',
                      _money(dueMinor),
                      colour: scheme.error,
                    )
                  else if (changeMinor > 0)
                    _row(
                      context,
                      'Change',
                      _money(changeMinor),
                      bold: true,
                      colour: Pos.green,
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            // The way back out of a mis-tap, and the only control here now that
            // the keys commit on their own. Deliberately understated next to the
            // note pictures: undoing is the rare path.
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: onUndo,
                icon: const Icon(Icons.undo, size: 18),
                label: Text('Hand back ${_money(taken)}'),
              ),
            ),
          ],
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
                        // Warmed at launch by warmCashNoteImages, so on a till
                        // that has been running this resolves straight out of
                        // the image cache and the key is drawn on its first
                        // frame. What follows is for the first sync of a new
                        // terminal, and for artwork changed mid-shift.
                        //
                        // A picture that will not load — a till on a dead
                        // network, a file removed in the back office — must
                        // never leave a blank key. The clerk still has to be
                        // able to take the money.
                        errorBuilder: (_, _, _) => _fallback(context),
                        loadingBuilder: (context, child, progress) =>
                            progress == null ? child : _fallback(context),
                        // Fades in over the label rather than cutting to it.
                        // `wasSynchronouslyLoaded` is the precached case, which
                        // must not animate — a key fading in every time the
                        // payment screen opens would look like a fault.
                        frameBuilder:
                            (context, child, frame, wasSynchronouslyLoaded) =>
                                wasSynchronouslyLoaded
                                    ? child
                                    : AnimatedOpacity(
                                        opacity: frame == null ? 0 : 1,
                                        duration:
                                            const Duration(milliseconds: 180),
                                        child: child,
                                      ),
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
