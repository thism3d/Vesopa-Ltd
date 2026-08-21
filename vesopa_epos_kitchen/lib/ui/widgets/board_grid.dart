import 'package:flutter/material.dart';

/// A column-balanced grid of cards.
///
/// Tickets are not the same height — a two-item order and a ten-item order sit
/// side by side all service — and a `GridView` would either clip the tall one
/// or leave a hand's width of dead space under the short one. On a wall-mounted
/// panel that dead space is the difference between seeing eight orders and
/// seeing five.
///
/// So this lays the cards into columns and puts each new card into whichever
/// column is currently shortest. That is a greedy fit rather than an optimal
/// one, and greedy is the right choice here for a reason that has nothing to do
/// with packing: **it is stable**. A card added at the bottom never moves the
/// cards above it. An optimal packer would re-flow the whole board every time
/// an order arrived, and a chef would find the ticket they were reading
/// somewhere else.
///
/// The columns are estimated from a card's rendered height, which is not known
/// until it is laid out — so the estimate is the item count, which correlates
/// closely enough and needs no measurement pass.
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
  });

  final int itemCount;
  final IndexedWidgetBuilder itemBuilder;

  /// Pinned by the screen profile, or 0 to work it out from the width.
  final int columns;

  /// Roughly how tall item [index] will be, in arbitrary units. Defaults to 1
  /// each, which degrades this to a plain round-robin.
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
        final fits = ((usable + spacing) / (minColumnWidth + spacing)).floor();
        final count = columns > 0
            ? columns.clamp(1, maxColumns)
            : fits.clamp(1, maxColumns);

        // Cards, and how tall each column has got so far.
        final buckets = List.generate(count, (_) => <Widget>[]);
        final heights = List.filled(count, 0.0);

        for (var i = 0; i < itemCount; i++) {
          var shortest = 0;
          for (var c = 1; c < count; c++) {
            if (heights[c] < heights[shortest]) shortest = c;
          }
          buckets[shortest].add(itemBuilder(context, i));
          heights[shortest] += weightOf?.call(i) ?? 1;
        }

        return SingleChildScrollView(
          padding: padding,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var c = 0; c < count; c++) ...[
                if (c > 0) SizedBox(width: spacing),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final card in buckets[c])
                        Padding(
                          padding: EdgeInsets.only(bottom: spacing),
                          child: card,
                        ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}
