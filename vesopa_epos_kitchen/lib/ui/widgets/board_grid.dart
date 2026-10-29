import 'package:flutter/material.dart';

/// The board's cards, in rows (2026-10-29).
///
/// Pontardawe RFC: "can the kitchen screen all be in line … instead of just
/// placing in any gap". It used to drop each card into whichever column was
/// shortest, which packed the screen tightly but scattered the order: the next
/// ticket to cook could be anywhere. Now the cards read like a page -- oldest
/// first (a rushed one ahead of them), left to right, then the next row -- and
/// every row starts level. The cards in a row are drawn the same height, so
/// their Done buttons sit in one line across the screen.
///
/// The number across comes from the screen profile, or from the width: fewer,
/// larger cards when the board is zoomed (this screen's A+ / A-, Ctrl + / -, or
/// the size set in the back office).
class BoardGrid extends StatelessWidget {
  const BoardGrid({
    super.key,
    required this.itemCount,
    required this.itemBuilder,
    this.columns = 0,
    this.weightOf,
    this.minColumnWidth = 320,
    this.maxColumns = 6,
    this.spacing = 10,
    this.padding = const EdgeInsets.all(10),
    this.cardScale = 1,
  });

  /// How big the orders are drawn on this screen: A+ / A- (Ctrl + / Ctrl -).
  ///
  /// Pontardawe RFC, 2026-10-29: zooming the whole screen "just makes the
  /// screen bigger and smaller, the order boxes stay same size" -- a screen
  /// pinned to five across still drew five across, only with everything round
  /// them larger. This sizes the cards themselves: their text grows by this
  /// much, and they get wider, so fewer fit across (a pinned count shrinks in
  /// proportion), leaving the header and menus as they were.
  final double cardScale;

  final int itemCount;
  final IndexedWidgetBuilder itemBuilder;

  /// Pinned by the screen profile, or 0 to work it out from the width.
  final int columns;

  /// Roughly how tall item [index] will be. Unused since the board went to
  /// rows (each row is as tall as its tallest card); kept so callers compile.
  final double Function(int index)? weightOf;

  /// Below this, a card stops being readable across a kitchen. 320 fits an
  /// item name and a modifier without wrapping either.
  final double minColumnWidth;

  final int maxColumns;
  final double spacing;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final usable = constraints.maxWidth - padding.horizontal;
        final scale = cardScale.clamp(0.5, 3.0);
        final fits = ((usable + spacing) / (minColumnWidth * scale + spacing)).floor();
        final count = columns > 0
            ? (columns / scale).round().clamp(1, maxColumns)
            : fits.clamp(1, maxColumns);
        final media = MediaQuery.of(context);
        Widget sized(Widget card) => (scale - 1).abs() < 0.01
            ? card
            : MediaQuery(
                data: media.copyWith(textScaler: TextScaler.linear(scale)),
                child: card,
              );

        return SingleChildScrollView(
          padding: padding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var start = 0; start < itemCount; start += count)
                Padding(
                  padding: EdgeInsets.only(
                    bottom: start + count < itemCount ? spacing : 0,
                  ),
                  // As tall as the tallest card in the row, and every card
                  // stretched to it.
                  child: IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (var c = 0; c < count; c++) ...[
                          if (c > 0) SizedBox(width: spacing),
                          Expanded(
                            child: start + c < itemCount
                                ? sized(itemBuilder(context, start + c))
                                : const SizedBox.shrink(),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}
