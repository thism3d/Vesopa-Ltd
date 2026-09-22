import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../data/local/database.dart';
import '../../data/mix_match_engine.dart';
import '../theme.dart';

String money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// The running bill: lines on top, totals pinned to the bottom.
class BasketPanel extends StatelessWidget {
  const BasketPanel({
    super.key,
    required this.lines,
    required this.order,
    this.deals = MixMatchResult.none,
    this.onRemoveLine,
    this.onTapLine,
    this.footer,
  });

  final List<OrderLine> lines;
  final Order? order;
  final MixMatchResult deals;
  final void Function(OrderLine line)? onRemoveLine;
  final void Function(OrderLine line)? onTapLine;

  /// Extra content below the totals — the numeric keypad on the payment screen.
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final order = this.order;

    // A share of the width rather than a fixed 300px: a hardcoded width
    // overflows the row on a small tablet.
    final width = MediaQuery.sizeOf(context).width.clamp(600.0, 1600.0) * 0.22;

    return Container(
      width: width,
      color: theme.posSurface,
      child: Column(
        children: [
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: theme.posLine)),
              ),
              child: lines.isEmpty
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.receipt_long,
                            size: 36,
                            color: theme.disabledColor,
                          ),
                          const SizedBox(height: 10),
                          Text(
                            'No items',
                            style: TextStyle(color: theme.hintColor),
                          ),
                        ],
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: lines.length,
                      itemBuilder: (context, i) {
                        final line = lines[i];
                        final total =
                            (line.unitPriceMinor * line.quantity).round() -
                                line.lineDiscountMinor;
                        final hasNote = line.notes?.isNotEmpty ?? false;
                        final hasDiscount = line.lineDiscountMinor > 0;

                        // Tap to open the line editor (quantity, discount,
                        // note, remove). Long-press still removes, for speed.
                        return InkWell(
                          onTap: onTapLine == null
                              ? null
                              : () => onTapLine!(line),
                          onLongPress: onRemoveLine == null
                              ? null
                              : () => onRemoveLine!(line),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 9,
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        line.name,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(fontSize: 15),
                                      ),
                                    ),
                                    Text(
                                      '${line.quantity.toStringAsFixed(line.quantity % 1 == 0 ? 0 : 2)}x - ',
                                      style: const TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.bold,
                                      ),
                                    ),
                                    Text(
                                      money(total),
                                      style: const TextStyle(fontSize: 13),
                                    ),
                                  ],
                                ),
                                // Per-line discount and note are shown, so the
                                // clerk (and customer) can see what was applied
                                // rather than it being invisible.
                                if (hasDiscount || hasNote)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 3),
                                    child: Row(
                                      children: [
                                        if (hasDiscount) ...[
                                          const Icon(Icons.percent,
                                              size: 12, color: Pos.green),
                                          const SizedBox(width: 3),
                                          Text(
                                            '-${money(line.lineDiscountMinor)}',
                                            style: const TextStyle(
                                              fontSize: 11.5,
                                              color: Pos.green,
                                            ),
                                          ),
                                          const SizedBox(width: 10),
                                        ],
                                        if (hasNote)
                                          Expanded(
                                            child: Text(
                                              line.notes!,
                                              overflow: TextOverflow.ellipsis,
                                              style: TextStyle(
                                                fontSize: 11.5,
                                                fontStyle: FontStyle.italic,
                                                color:
                                                    Theme.of(context).hintColor,
                                              ),
                                            ),
                                          ),
                                      ],
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ),

          // Deals that fired, named. A saving the customer cannot see is a
          // saving they will not trust.
          for (final deal in deals.deals)
            Container(
              width: double.infinity,
              color: Pos.green.withValues(alpha: 0.14),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              child: Row(
                children: [
                  const Icon(Icons.local_offer, size: 14, color: Pos.green),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      deal.times > 1
                          ? '${deal.name} ×${deal.times}'
                          : deal.name,
                      style: const TextStyle(fontSize: 12.5),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Text(
                    '-${money(deal.savingMinor)}',
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: Pos.green,
                    ),
                  ),
                ],
              ),
            ),

          _TotalRow(label: 'Subtotal', value: money(order?.subtotalMinor ?? 0)),
          _TotalRow(
            label: 'Discount',
            value: '- ${money(order?.discountMinor ?? 0)}',
          ),
          _TotalRow(
            label: 'Total',
            value: money(order?.totalMinor ?? 0),
            emphasised: true,
          ),
          ?footer,
        ],
      ),
    );
  }
}

class _TotalRow extends StatelessWidget {
  const _TotalRow({
    required this.label,
    required this.value,
    this.emphasised = false,
  });

  final String label;
  final String value;
  final bool emphasised;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = TextStyle(
      fontSize: emphasised ? 24 : 14,
      fontWeight: emphasised ? FontWeight.bold : FontWeight.normal,
    );

    return Container(
      color: theme.posTotals,
      padding: EdgeInsets.symmetric(
        horizontal: 12,
        vertical: emphasised ? 10 : 8,
      ),
      margin: const EdgeInsets.only(bottom: 1),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          // The label yields space; the amount never shrinks or truncates — a
          // half-rendered total is worse than a clipped word.
          Flexible(
            child: Text(label, overflow: TextOverflow.ellipsis, style: style),
          ),
          const SizedBox(width: 8),
          Text(value, style: style),
        ],
      ),
    );
  }
}
