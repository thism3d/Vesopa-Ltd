import 'dart:math' as math;

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
/// The tally did not go away, it moved: consecutive taps rewrite one cash
/// payment rather than stacking up several, so a twenty and then a five is a
/// single £25 line reading "1 x £20, 1 x £5". That line is now shown in the
/// Tendered column of the payment board rather than under these keys — the
/// customer's side of the transaction belongs with the money, and this panel
/// went back to being what it is for, which is pictures.
///
/// The pictures size themselves to whatever room the board gives them (see
/// [_arrange]) rather than sitting at a fixed 132×70. That is the whole point of
/// the v1.3.3.0 layout: the function keys below were halved specifically so
/// these could be big enough to recognise, and a strip that ignored the room it
/// was handed would have thrown that away.
///
/// The set comes from the back office (see cash_denominations), so a venue can
/// swap the artwork or change what a key is worth without a new build.
class CashNotesPanel extends StatelessWidget {
  const CashNotesPanel({
    super.key,
    required this.denominations,
    required this.tally,
    required this.onTakeNote,
    required this.onUndo,
  });

  final List<CashDenomination> denominations;

  /// The notes taken so far on this bill, for the badges.
  final CashTally tally;

  /// Take one of this note, now.
  final void Function(int valueMinor) onTakeNote;

  /// Hand it all back: undoes the cash payment these keys built.
  final VoidCallback onUndo;

  /// Roughly a real banknote's proportions, so the picture is never distorted.
  static const _ratio = 1.9;

  @override
  Widget build(BuildContext context) {
    if (denominations.isEmpty) return const SizedBox.shrink();

    final pay = PayPalette.of(context);
    final taken = tally.totalMinor;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'CASH — TAP A NOTE TO TAKE IT',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 14,
                  letterSpacing: 2,
                  fontWeight: FontWeight.w500,
                  color: pay.inkMuted,
                ),
              ),
            ),
            // The way back out of a mis-tap, and the only control here now that
            // the keys commit on their own.
            if (tally.isNotEmpty)
              Material(
                color: Colors.transparent,
                borderRadius: BorderRadius.circular(8),
                child: InkWell(
                  onTap: onUndo,
                  borderRadius: BorderRadius.circular(8),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    child: Text(
                      'Hand back ${_money(taken)}',
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color: pay.dangerInk,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 10),
        Expanded(
          child: LayoutBuilder(
            builder: (context, box) {
              final layout = _arrange(
                count: denominations.length,
                width: box.maxWidth,
                height: box.maxHeight,
              );

              // Wrap rather than scroll: a key a clerk has to scroll to find is
              // a key that gets missed while a customer is waiting.
              //
              // Centred, because the strip is usually limited by width rather
              // than height — three notes at a proper 1.9:1 run out of column
              // before they run out of board — and the slack that leaves reads
              // as a hole when it is all dumped underneath them.
              return Align(
                alignment: Alignment.center,
                child: Wrap(
                  spacing: layout.gap,
                  runSpacing: layout.gap,
                  alignment: WrapAlignment.center,
                  children: [
                    for (final d in denominations)
                      SizedBox(
                        width: layout.width,
                        height: layout.height,
                        child: _NoteKey(
                          denomination: d,
                          count: tally.counts[d.valueMinor] ?? 0,
                          onTap: () => onTakeNote(d.valueMinor),
                        ),
                      ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  /// The biggest the notes can be drawn in [width] × [height].
  ///
  /// Tries every row count and keeps whichever draws the largest note. One row
  /// is not automatically best: five denominations across a 840px column gives
  /// notes 160px wide and 84 tall, where two rows of three gives 270 × 142 —
  /// nearly twice the picture, in the same box. Since the whole reason these
  /// keys are pictures is that a picture is recognised faster than a label,
  /// bigger wins over tidier.
  static _NoteLayout _arrange({
    required int count,
    required double width,
    required double height,
  }) {
    const gap = 14.0;
    var best = const _NoteLayout(width: 0, height: 0, gap: gap);

    for (var rows = 1; rows <= count; rows++) {
      final columns = (count / rows).ceil();
      final cellWidth = (width - gap * (columns - 1)) / columns;
      final cellHeight = (height - gap * (rows - 1)) / rows;
      if (cellWidth <= 0 || cellHeight <= 0) continue;

      // Fit the note inside the cell without distorting it.
      final noteHeight = math.min(cellHeight, cellWidth / _ratio);
      if (noteHeight > best.height) {
        best = _NoteLayout(
          width: noteHeight * _ratio,
          height: noteHeight,
          gap: gap,
        );
      }
    }

    // A box too small for any sensible arrangement still has to draw keys the
    // clerk can hit, so it falls back to one row across whatever there is.
    if (best.height <= 0) {
      final cellWidth = (width - gap * (count - 1)) / count;
      final noteHeight = math.max(28.0, math.min(height, cellWidth / _ratio));
      return _NoteLayout(
        width: noteHeight * _ratio,
        height: noteHeight,
        gap: gap,
      );
    }
    return best;
  }
}

/// The size one note is drawn at, and the space between them.
class _NoteLayout {
  const _NoteLayout({
    required this.width,
    required this.height,
    required this.gap,
  });

  final double width;
  final double height;
  final double gap;
}

/// One note. Shows the artwork when there is any, and how many have been
/// counted in as a badge — the count is the whole point, so it is not hidden in
/// a list somewhere else.
class _NoteKey extends StatelessWidget {
  const _NoteKey({
    required this.denomination,
    required this.count,
    required this.onTap,
  });

  final CashDenomination denomination;
  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final pay = PayPalette.of(context);
    final url = denomination.imageUrl;

    return Semantics(
      button: true,
      label: '${denomination.label}, $count counted',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(
                    color: count > 0 ? Pos.brand : pay.softLine,
                    width: count > 0 ? 3 : 1,
                  ),
                  color: pay.panel,
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
                  top: -8,
                  right: -8,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color: Pos.brand,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: pay.canvas, width: 2),
                    ),
                    child: Text(
                      '×$count',
                      style: const TextStyle(
                        color: Pos.onBrand,
                        fontSize: 15,
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
    final pay = PayPalette.of(context);
    return Container(
      alignment: Alignment.center,
      color: pay.softFill,
      child: FittedBox(
        fit: BoxFit.scaleDown,
        child: Padding(
          padding: const EdgeInsets.all(8),
          child: Text(
            denomination.label,
            style: TextStyle(
              fontSize: 34,
              fontWeight: FontWeight.w800,
              color: pay.ink,
            ),
          ),
        ),
      ),
    );
  }
}

String _money(int minor) => minor % 100 == 0
    ? '£${minor ~/ 100}'
    : '£${(minor / 100).toStringAsFixed(2)}';
