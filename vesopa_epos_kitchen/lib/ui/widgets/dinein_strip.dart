import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/dinein_orders.dart';
import '../../data/providers.dart';
import '../theme.dart';

/// QR orders waiting to be picked up, across the top of the board.
///
/// ABOVE the tickets, not among them, and deliberately a different shape.
///
/// A ticket on the board is work: it has been accepted, it is being cooked,
/// and every control on it is about progress. One of these is a DECISION —
/// nothing has been rung up, nothing has printed, and until somebody presses
/// a button the customer is sitting at a table watching a tracker that says
/// nothing has happened. Mixing the two would put a card that needs an answer
/// into a grid a chef has learned to work down without reading the headers.
///
/// It disappears entirely when there is nothing waiting. A venue with no QR
/// menu never sees it, and a kitchen mid-service is not shown an empty box
/// where four inches of board used to be.
class DineInStrip extends ConsumerWidget {
  const DineInStrip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inbox = ref.watch(dineInInboxProvider);
    if (inbox.orders.isEmpty) return const SizedBox.shrink();

    final labels = ref.watch(allergenLabelsProvider).value ?? const {};
    final skin = Kds.of(context);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        color: Kds.waitingBack,
        border: Border(bottom: BorderSide(color: skin.divider)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.qr_code_2, size: 20, color: Kds.waiting),
              const SizedBox(width: 8),
              Text(
                inbox.orders.length == 1
                    ? '1 order from a phone, waiting'
                    : '${inbox.orders.length} orders from phones, waiting',
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w800,
                  color: Kds.waiting,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          // Sideways rather than wrapping. However many arrive at once, the
          // board underneath keeps the height it had — a strip that grew to
          // three rows would push the tickets somebody is cooking off screen.
          SizedBox(
            height: 210,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: inbox.orders.length,
              separatorBuilder: (_, _) => const SizedBox(width: 10),
              itemBuilder: (context, i) => _OrderCard(
                order: inbox.orders[i],
                busy: inbox.busy.contains(inbox.orders[i].id),
                allergenLabels: labels,
                onAccept: () => _move(context, ref, inbox.orders[i], 'accepted'),
                onReject: () => _confirmReject(context, ref, inbox.orders[i]),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _move(
    BuildContext context,
    WidgetRef ref,
    DineInOrder order,
    String action,
  ) async {
    final problem = await ref
        .read(dineInInboxProvider.notifier)
        .move(order, action);
    if (problem == null || !context.mounted) return;
    // The commonest of these is "another till accepted this one first", which
    // is a normal Friday rather than a fault — so it is said in a bar at the
    // bottom, not in a dialog somebody has to dismiss with a pan in their hand.
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(problem)));
  }

  /// Rejecting is asked about; accepting is not.
  ///
  /// Accept is recoverable — the order is on the board and the till, and a
  /// mistake is visible for the rest of service. Reject tells a customer their
  /// food is not coming, and there is no button anywhere that undoes it.
  Future<void> _confirmReject(
    BuildContext context,
    WidgetRef ref,
    DineInOrder order,
  ) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: const Icon(Icons.block, size: 30, color: Kds.modifier),
        title: Text('Turn down ${order.tableLabel}?'),
        content: const Text(
          'The customer is told their order was not accepted, and it does not '
          'reach the till. There is no way to undo it — they would have to '
          'order again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Keep it'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Kds.modifier),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Turn it down'),
          ),
        ],
      ),
    );
    if (sure != true || !context.mounted) return;
    await _move(context, ref, order, 'rejected');
  }
}

class _OrderCard extends StatelessWidget {
  const _OrderCard({
    required this.order,
    required this.busy,
    required this.allergenLabels,
    required this.onAccept,
    required this.onReject,
  });

  final DineInOrder order;
  final bool busy;
  final Map<String, String> allergenLabels;
  final VoidCallback onAccept;
  final VoidCallback onReject;

  static const _unavailable = {
    'call': 'wants a call if anything is off',
    'refund': 'wants a refund if anything is off',
  };

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    final allergens = order.allAllergens;

    // The per-line answers that are NOT the default. "Remove it" needs no
    // saying — it is what happens anyway — and printing it on every card
    // would bury the two that actually ask something of somebody.
    final asks = {
      for (final line in order.lines) ?_unavailable[line.unavailableAction],
    };

    return Container(
      width: 320,
      decoration: BoxDecoration(
        color: skin.card,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Kds.waiting, width: 2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            decoration: const BoxDecoration(
              color: Kds.waiting,
              borderRadius: BorderRadius.vertical(top: Radius.circular(8)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    order.tableLabel.isEmpty ? 'No table' : order.tableLabel,
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w800,
                      color: Colors.white,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                Text(
                  '£${(order.totalMinor / 100).toStringAsFixed(2)}',
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                    color: Colors.white,
                  ),
                ),
              ],
            ),
          ),

          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
              child: ListView(
                padding: EdgeInsets.zero,
                children: [
                  if (order.customerName != null)
                    Text(
                      order.customerName!,
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        color: skin.inkMuted,
                      ),
                    ),
                  for (final dish in order.dishes) ...[
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        '${dish.qty} × ${dish.name}',
                        style: TextStyle(
                          fontSize: 15.5,
                          fontWeight: FontWeight.w700,
                          color: skin.ink,
                          height: 1.2,
                        ),
                      ),
                    ),
                    // Add-ons and the customer's own words, indented under the
                    // dish exactly as a modifier is on a ticket — the kitchen
                    // reads them the same way and should not have to learn a
                    // second layout for the same idea.
                    for (final on in order.addOnsFor(dish))
                      Padding(
                        padding: const EdgeInsets.only(left: 14),
                        child: Text(
                          on.name,
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                            color: Kds.modifier,
                            height: 1.25,
                          ),
                        ),
                      ),
                    if (dish.note != null)
                      Padding(
                        padding: const EdgeInsets.only(left: 14),
                        child: Text(
                          dish.note!,
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                            color: Kds.modifier,
                            height: 1.25,
                          ),
                        ),
                      ),
                  ],
                  if (order.note != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Text(
                        order.note!,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: Kds.modifier,
                        ),
                      ),
                    ),
                  if (allergens.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Wrap(
                        spacing: 5,
                        runSpacing: 4,
                        children: [
                          for (final code in allergens)
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 7,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: Kds.allergenBack,
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: Kds.allergen),
                              ),
                              child: Text(
                                allergenLabels[code] ?? code,
                                style: const TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w700,
                                  color: Kds.allergen,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  for (final ask in asks)
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Text(
                        ask,
                        style: TextStyle(
                          fontSize: 13,
                          fontStyle: FontStyle.italic,
                          color: skin.inkMuted,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),

          // Big, because the panel this runs on is a small one and the hand
          // pressing these has been holding a pan.
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: busy ? null : onReject,
                    style: OutlinedButton.styleFrom(
                      foregroundColor: Kds.modifier,
                      side: const BorderSide(color: Kds.modifier),
                      minimumSize: const Size.fromHeight(46),
                    ),
                    child: const Text('Turn down'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: FilledButton.icon(
                    onPressed: busy ? null : onAccept,
                    style: FilledButton.styleFrom(
                      backgroundColor: Kds.done,
                      minimumSize: const Size.fromHeight(46),
                    ),
                    icon: busy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.check, size: 20),
                    label: const Text(
                      'Accept',
                      style: TextStyle(fontWeight: FontWeight.w800),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
