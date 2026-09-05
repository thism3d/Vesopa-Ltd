/// Orders that came in from customers' phones, and what a clerk does with them.
///
/// WHY ACCEPTING IS THE WHOLE FEATURE
///
/// Everything up to this point is a customer tapping pictures on their own
/// phone. None of it is a sale, none of it has been priced onto a bill, and
/// nothing has printed. Accept is the moment it becomes real: the lines are
/// rung onto the table's bill exactly as if a clerk had keyed them, and from
/// there they print, they show on the customer display, they appear in the
/// day's takings, and they are settled at the counter like everything else.
///
/// That is deliberately the only way in. Writing customer taps straight into
/// the sales tables would put unaccepted, mistaken and duplicate orders into a
/// venue's Z-read, and there is no status column that makes that safe.
///
/// WHAT HAPPENS WHEN IT GOES WRONG
///
/// Three things can, and each has to be survivable at a counter mid-service:
///
///   * **The table has gone.** Renamed is fine — the order carries the table's
///     id, not its name. Deleted is not, and then the clerk is told rather than
///     the food being put on a bill nobody will find.
///   * **A product has gone.** Rung as far as it can be, and the clerk is told
///     exactly which line could not be added, by name. Silently dropping it
///     would send somebody a meal missing its side.
///   * **The terminal beside this one got there first.** The server refuses the
///     second acceptance, so the second clerk is told rather than the kitchen
///     getting two tickets.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/dinein_orders.dart';
import 'theme.dart';
import 'widgets/basket_panel.dart' show money;
import 'widgets/pos_message.dart';
import '../data/order_alerts.dart';
import 'dinein_actions.dart';

/// Open the list of what customers have sent in.
Future<void> showDineInOrders(BuildContext context) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (_) => const DineInSheet(),
);

class DineInSheet extends ConsumerStatefulWidget {
  const DineInSheet({super.key});

  @override
  ConsumerState<DineInSheet> createState() => _DineInSheetState();
}

class _DineInSheetState extends ConsumerState<DineInSheet> {
  /// The order currently being acted on, so its buttons can go quiet without
  /// freezing the rest of the list — a busy kitchen may be accepting one order
  /// while another is still arriving.
  int? _busy;

  @override
  Widget build(BuildContext context) {
    final orders = ref.watch(dineInOrdersProvider).value ?? const <DineInOrder>[];
    final waiting = orders.where((o) => o.isWaiting).toList();
    final working = orders.where((o) => !o.isWaiting).toList();

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.72,
      maxChildSize: 0.94,
      builder: (context, scroll) => ListView(
        controller: scroll,
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        children: [
          Row(
            children: [
              const Icon(Icons.qr_code_2, size: 22),
              const SizedBox(width: 10),
              const Expanded(
                child: Text(
                  'Orders from tables',
                  style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
                ),
              ),
              IconButton(
                tooltip: 'Check again',
                onPressed: () => unawaited(
                  ref.read(dineInOrdersProvider.notifier).refresh(),
                ),
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
          const SizedBox(height: 6),

          if (orders.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 48),
              child: Column(
                children: [
                  Icon(Icons.check_circle_outline, size: 40),
                  SizedBox(height: 12),
                  Text(
                    'Nothing waiting.',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                  ),
                  SizedBox(height: 4),
                  Text(
                    'Orders customers send from the code on their table arrive '
                    'here, and this screen opens on its own when one does.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13),
                  ),
                ],
              ),
            ),

          for (final order in waiting)
            _OrderCard(
              order: order,
              busy: _busy == order.id,
              onAccept: () => unawaited(_accept(order)),
              onRefuse: () => unawaited(_refuse(order)),
            ),

          if (working.isNotEmpty) ...[
            const SizedBox(height: 20),
            const Text(
              'In the kitchen',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            for (final order in working)
              _OrderCard(
                order: order,
                busy: _busy == order.id,
                onReady: order.status == 'accepted'
                    ? () => unawaited(_move(order, 'ready'))
                    : null,
                onServed: () => unawaited(_move(order, 'served')),
              ),
          ],
        ],
      ),
    );
  }

  /// Ring the order onto the table's bill, then tell the server it was taken.
  ///
  /// The work itself is in `dinein_actions.dart`, because the notification does
  /// exactly the same thing and two copies of it would be two copies of the
  /// ordering that makes it safe — with the second one getting it wrong.
  Future<void> _accept(DineInOrder order) async {
    setState(() => _busy = order.id);
    try {
      await acceptAndSay(context, ref, order);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _refuse(DineInOrder order) async {
    setState(() => _busy = order.id);
    try {
      await refuseWithReason(context, ref, order);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _move(DineInOrder order, String action) async {
    setState(() => _busy = order.id);
    try {
      final moved =
          await ref.read(dineInOrdersProvider.notifier).move(order.id, action);
      if (!moved) _say('That order has already moved on.', error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  void _say(String message, {bool error = false}) {
    if (!mounted) return;
    if (error) {
      PosMessenger.error(context, message);
    } else {
      PosMessenger.success(context, message);
    }
  }
}

class _OrderCard extends StatelessWidget {
  const _OrderCard({
    required this.order,
    required this.busy,
    this.onAccept,
    this.onRefuse,
    this.onReady,
    this.onServed,
  });

  final DineInOrder order;
  final bool busy;
  final VoidCallback? onAccept;
  final VoidCallback? onRefuse;
  final VoidCallback? onReady;
  final VoidCallback? onServed;

  @override
  Widget build(BuildContext context) {
    final waited = DateTime.now().difference(order.placedAt);

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    order.tableLabel.isEmpty ? 'A table' : order.tableLabel,
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                // How long they have been sitting there. The one number that
                // decides which of three waiting orders is dealt with first.
                Text(
                  _waited(waited),
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: waited.inMinutes >= 5 ? Pos.red : null,
                  ),
                ),
              ],
            ),
            if (order.customerName != null || order.customerPhone != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  [
                    ?order.customerName,
                    ?order.customerPhone,
                  ].join('  ·  '),
                  style: const TextStyle(fontSize: 12.5),
                ),
              ),
            const SizedBox(height: 10),

            for (final line in order.lines)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 34,
                      child: Text(
                        '${line.qty} ×',
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(line.name),
                          if (line.note != null)
                            Text(
                              line.note!,
                              style: const TextStyle(
                                fontSize: 12.5,
                                fontStyle: FontStyle.italic,
                              ),
                            ),
                        ],
                      ),
                    ),
                    Text(money(line.totalMinor)),
                  ],
                ),
              ),

            if (order.note != null) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.sticky_note_2_outlined, size: 16),
                    const SizedBox(width: 8),
                    Expanded(child: Text(order.note!)),
                  ],
                ),
              ),
            ],

            const Divider(height: 20),
            Row(
              children: [
                Text(
                  money(order.totalMinor),
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const Spacer(),
                if (busy)
                  const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else ...[
                  if (onRefuse != null)
                    TextButton(
                      onPressed: onRefuse,
                      child: const Text('Cannot take it'),
                    ),
                  if (onAccept != null) ...[
                    const SizedBox(width: 8),
                    FilledButton.icon(
                      onPressed: onAccept,
                      icon: const Icon(Icons.check, size: 18),
                      label: const Text('Accept'),
                    ),
                  ],
                  if (onReady != null)
                    FilledButton.tonal(
                      onPressed: onReady,
                      child: const Text('Ready'),
                    ),
                  if (onServed != null) ...[
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: onServed,
                      child: const Text('Served'),
                    ),
                  ],
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  static String _waited(Duration age) {
    if (age.inMinutes < 1) return 'just now';
    if (age.inMinutes < 60) return '${age.inMinutes} min ago';
    return '${age.inHours} h ago';
  }
}

/// The badge on the till's bar: how many are waiting.
///
/// Draws nothing at all when there is nothing waiting, exactly as the print and
/// sync badges do. A permanent zero on a bar is a permanent piece of noise, and
/// this one has to be noticeable when it does appear.
class DineInBadge extends ConsumerWidget {
  const DineInBadge({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Off unless this terminal asked for a count on the bar. The default is
    // notifications, which say the same thing better — see
    // `data/order_alerts.dart`.
    if (!ref.watch(orderAlertsProvider).showsBadge) {
      return const SizedBox.shrink();
    }
    final waiting = ref.watch(dineInWaitingCountProvider);
    if (waiting == 0) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Material(
        color: Pos.amber,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => unawaited(showDineInOrders(context)),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.qr_code_2, size: 16, color: Colors.black),
                const SizedBox(width: 6),
                Text(
                  waiting == 1 ? '1 order' : '$waiting orders',
                  style: const TextStyle(
                    color: Colors.black,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
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
