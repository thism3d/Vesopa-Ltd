import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import 'open_board.dart' show EmptyBoard;
import 'ticket_detail_sheet.dart';
import 'widgets/board_grid.dart';
import 'widgets/ticket_card.dart';

/// The recall window: what this screen has sent out, newest first.
///
/// Newest first because recall is nearly always about the order that has just
/// gone — somebody is standing at the pass saying "that was wrong" about a
/// plate they can still see. An oldest-first list would put the one order
/// nobody is asking about at the top.
///
/// How far back it goes is the screen profile's `recall_minutes`, an hour by
/// default. Past that a ticket is gone: the food has been eaten, and a board
/// carrying a day of history is a board somebody has to scroll.
class CompletedBoard extends ConsumerWidget {
  const CompletedBoard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.watch(ticketBoardProvider);
    final session = ref.watch(kitchenSessionProvider).value;
    final profile = session?.screen;
    if (profile == null || session == null) return const SizedBox.shrink();

    final tickets = board.completed(profile);

    if (tickets.isEmpty) {
      return EmptyBoard(
        icon: Icons.history,
        title: 'Nothing completed yet',
        message:
            'Orders you mark done appear here for '
            '${_window(profile.recallWindow)}, so one that went out wrong can '
            'be put straight back on the board.',
      );
    }

    return BoardGrid(
      itemCount: tickets.length,
      columns: profile.columns,
      // Roughly how tall each card will be, so the column packer can keep them
      // level. Header plus footer is worth about three lines.
      weightOf: (index) =>
          3 + tickets[index].linesFor(profile.stations).length.toDouble(),
      itemBuilder: (context, index) {
        final ticket = tickets[index];
        return TicketCard(
          key: ValueKey(ticket.id),
          ticket: ticket,
          profile: profile,
          now: board.now,
          labelFor: session.labelFor,
          onRecall: () => ref.read(ticketBoardProvider.notifier).recall(ticket),
          onDetails: () => showTicketDetail(context, ref, ticket),
        );
      },
    );
  }

  /// "an hour", "45 minutes", "2 hours" — a duration a chef would say out loud
  /// rather than "60 minutes".
  static String _window(Duration window) {
    if (window.inMinutes < 60) return '${window.inMinutes} minutes';
    if (window.inMinutes == 60) return 'an hour';
    if (window.inMinutes % 60 == 0) return '${window.inHours} hours';
    return '${window.inHours}h ${window.inMinutes.remainder(60)}m';
  }
}
