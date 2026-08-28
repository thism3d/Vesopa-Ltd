import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/screen_profile.dart';
import '../data/ticket_board.dart';
import 'open_board.dart' show EmptyBoard;
import 'theme.dart';

/// Everything outstanding, added up by item.
///
/// **This is the one view a printer can never give you**, and it is why a
/// kitchen puts a screen up rather than a second spike. A board of eleven cards
/// says there are eleven orders. This says there are seven chicken burgers, and
/// that is the sentence a chef actually cooks from — one tray, one timer, seven
/// burgers, rather than seven trips to the fryer because the information was
/// spread across eleven pieces of paper.
///
/// Modifiers split a row deliberately. "4 × Crispy Chicken Burger" and "1 ×
/// Crispy Chicken Burger, no tomato" are two different jobs, and adding them
/// together would produce a total that is arithmetically right and operationally
/// useless.
class CountsBoard extends ConsumerWidget {
  const CountsBoard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final skin = Kds.of(context);
    final board = ref.watch(ticketBoardProvider);
    final session = ref.watch(kitchenSessionProvider).value;
    final profile = session?.screen;
    if (profile == null) return const SizedBox.shrink();

    final rows = board.counts(profile);

    if (rows.isEmpty) {
      return const EmptyBoard(
        icon: Icons.inventory_2_outlined,
        title: 'Nothing to prep',
        message:
            'This adds up everything still outstanding, so you can cook a '
            'batch instead of an order at a time. It fills up as orders come '
            'in.',
      );
    }

    final total = rows.fold<double>(0, (sum, row) => sum + row.quantity);

    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 20),
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              'Still to make',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w700,
              ),
            ),
            const Spacer(),
            Text(
              '${_number(total)} items across '
              '${board.open(profile).length} orders',
              style: TextStyle(color: skin.inkMuted, fontSize: 14),
            ),
          ],
        ),
        const SizedBox(height: 12),

        for (final row in rows)
          _CountRowTile(row: row, now: board.now, profile: profile),
      ],
    );
  }

  static String _number(double value) => value == value.roundToDouble()
      ? value.toStringAsFixed(0)
      : value.toString();
}

class _CountRowTile extends StatelessWidget {
  const _CountRowTile({
    required this.row,
    required this.now,
    required this.profile,
  });

  final CountRow row;
  final DateTime now;
  final ScreenProfile profile;

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    // The age of the *oldest* order this total is spread across, not an
    // average: a batch is as late as its latest customer, and averaging would
    // hide the one table that has been waiting twenty minutes behind four that
    // have just ordered.
    final age = now.difference(row.oldest);
    final colour = switch (TicketAge.of(age, profile)) {
      TicketAge.fresh => Kds.fresh,
      TicketAge.warn => Kds.warn,
      TicketAge.late => Kds.late,
    };

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: skin.card,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          // The number, big and on the left. A chef scanning this column is
          // looking for "what is there a lot of", and the number is the answer
          // — so it gets the position and the weight rather than the name.
          Container(
            width: 74,
            height: 66,
            decoration: BoxDecoration(
              color: colour,
              borderRadius: const BorderRadius.horizontal(
                left: Radius.circular(10),
              ),
            ),
            alignment: Alignment.center,
            child: Text(
              row.quantityLabel,
              style: TextStyle(
                fontSize: 27,
                fontWeight: FontWeight.w800,
                color: Kds.inkOn(colour),
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  row.name,
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (row.note != null)
                  Text(
                    row.note!,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: Kds.modifier,
                    ),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  row.tickets == 1 ? '1 order' : '${row.tickets} orders',
                  style: TextStyle(color: skin.inkMuted, fontSize: 13.5),
                ),
                Text(
                  'oldest ${_since(age)}',
                  style: TextStyle(
                    color: colour,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// "4m", "1h 12m". Rounded, because this is a prep list rather than a clock
  /// and a ticking second on every row is movement with nothing behind it.
  static String _since(Duration age) {
    if (age.isNegative || age.inMinutes < 1) return 'just now';
    if (age.inMinutes < 60) return '${age.inMinutes}m';
    return '${age.inHours}h ${age.inMinutes.remainder(60)}m';
  }
}
