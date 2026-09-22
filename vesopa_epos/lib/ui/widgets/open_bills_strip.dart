import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/local/database.dart';
import '../tables_page.dart' show parkedOrdersProvider;
import '../theme.dart';
import 'basket_panel.dart' show money;

/// Every bill currently in play — this one, plus each booked table.
///
/// This *is* the till's top bar. It was written into the sale page as a fixed
/// strip, which was right until the bars became something a venue lays out for
/// itself: a venue that programs its own top bar and cannot put this back has
/// silently lost the ability to serve two parties at once, and would find that
/// out at the counter rather than in the office.
///
/// So it lives here, drawn by two callers and no more:
///
///   * the built-in top bar, which is this and nothing else;
///   * a programmed bar's `open_bills` key, which is this inside one cell —
///     any width, any colour, anywhere on the bar.
///
/// It scrolls sideways rather than wrapping or shrinking. A venue with nine
/// tables open and a narrow key gets a strip it can push along, not nine chips
/// too small to read the number on.
class OpenBillsStrip extends ConsumerWidget {
  const OpenBillsStrip({
    super.key,
    required this.currentOrderId,
    required this.currentOrder,
    required this.onSwitch,
    this.padding = const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
  });

  final String currentOrderId;
  final Order? currentOrder;
  final void Function(String orderId) onSwitch;

  /// Room around the chips. The built-in bar owns its whole strip and can
  /// afford it; a key on a programmed bar is already inside a cell with padding
  /// of its own, and passes almost none.
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final booked = ref.watch(parkedOrdersProvider).value ?? const <Order>[];

    // The current bill is shown first when it is not itself one of the booked
    // tables (i.e. a fresh walk-in, or a table just recalled onto the till).
    final currentIsBooked = booked.any((o) => o.id == currentOrderId);

    return ListView(
      scrollDirection: Axis.horizontal,
      padding: padding,
      children: [
        if (!currentIsBooked)
          OrderChip(
            label: currentOrder?.tableNumber != null
                ? 'Table ${currentOrder!.tableNumber}'
                : 'Current',
            total: currentOrder?.totalMinor ?? 0,
            active: true,
            onTap: () {},
          ),
        for (final o in booked)
          OrderChip(
            label: 'Table ${o.tableNumber}',
            total: o.totalMinor,
            active: o.id == currentOrderId,
            onTap: () => onSwitch(o.id),
          ),
      ],
    );
  }
}

/// One bill on the strip: what it is, and what is on it.
class OrderChip extends StatelessWidget {
  const OrderChip({
    super.key,
    required this.label,
    required this.total,
    required this.active,
    required this.onTap,
  });

  final String label;
  final int total;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Material(
        color: active ? Pos.brand : Theme.of(context).posIdle,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: active ? null : onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: active
                        ? Pos.onBrand
                        : Theme.of(context).colorScheme.onSurface,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  money(total),
                  style: TextStyle(
                    fontSize: 13,
                    color: active
                        ? Pos.onBrand.withValues(alpha: 0.7)
                        : Theme.of(context).hintColor,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
