import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import 'ticket_detail_sheet.dart';
import 'theme.dart';
import 'widgets/board_grid.dart';
import 'widgets/ticket_card.dart';

/// The board: everything this screen still has to cook.
///
/// A staggered grid rather than a uniform one, because tickets are not the same
/// height and a grid that pretends they are either clips a ten-item order or
/// leaves a hand's width of white space under a two-item one. On a wall-mounted
/// screen that white space is the difference between seeing eight orders and
/// seeing five.
class OpenBoard extends ConsumerWidget {
  const OpenBoard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.watch(ticketBoardProvider);
    final session = ref.watch(kitchenSessionProvider).value;
    final profile = session?.screen;

    if (profile == null) return const SizedBox.shrink();

    final tickets = board.open(profile);

    if (tickets.isEmpty) {
      return _EmptyBoard(
        icon: Icons.done_all,
        title: 'Nothing waiting',
        // Which board this is, because an empty grill screen and an empty
        // all-stations screen mean very different things and they look
        // identical.
        message: profile.stations.isEmpty
            ? 'Every order has been sent out. New ones appear here the moment '
                  'a till rings them up.'
            : 'Nothing outstanding for '
                  '${profile.stations.map(session!.labelFor).join(', ')}.',
      );
    }

    return BoardGrid(
      columns: profile.columns,
      itemCount: tickets.length,
      // Roughly how tall each card will be, so the column packer can keep the
      // columns level. Header plus footer is worth about three lines, and a
      // modifier adds one more.
      weightOf: (index) {
        final lines = tickets[index].linesFor(profile.stations);
        final notes = lines.where((l) => l.note != null).length;
        return 3 + lines.length + notes.toDouble();
      },
      itemBuilder: (context, index) {
        final ticket = tickets[index];
        return TicketCard(
          // Keyed by ticket so a card that moves up the board when the one
          // above it is bumped keeps its own pulse animation rather than
          // inheriting its neighbour's.
          key: ValueKey(ticket.id),
          ticket: ticket,
          profile: profile,
          now: board.now,
          labelFor: session!.labelFor,
          onBump: () => ref.read(ticketBoardProvider.notifier).bump(ticket),
          onRush: (rushed) =>
              ref.read(ticketBoardProvider.notifier).rush(ticket, rushed),
          onDetails: () => showTicketDetail(context, ref, ticket),
        );
      },
    );
  }
}

/// Shown when a board has nothing on it — which, on a good day, is most of it.
class _EmptyBoard extends StatelessWidget {
  const _EmptyBoard({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 56, color: Kds.inkMuted.withValues(alpha: 0.5)),
            const SizedBox(height: 14),
            Text(
              title,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                color: Kds.inkMuted,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: Kds.inkMuted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The same empty state, for the other two tabs.
class EmptyBoard extends StatelessWidget {
  const EmptyBoard({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) =>
      _EmptyBoard(icon: icon, title: title, message: message);
}
