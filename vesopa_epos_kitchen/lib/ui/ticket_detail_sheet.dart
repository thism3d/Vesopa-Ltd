import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/kitchen_session.dart';
import '../data/providers.dart';
import '../data/ticket.dart';
import '../printing/kitchen_print.dart';
import 'theme.dart';

/// The whole ticket, including the parts the card leaves off.
///
/// The card shows a chef what to cook. This shows everything else: the lines
/// that went to other stations, who has bumped what and when, the order the
/// till knows this as, and the actions that are too rare to earn a key on the
/// board — rush, print, and recall-while-still-open.
///
/// Reached from the Details key, which is the left of the two on an open card.
Future<void> showTicketDetail(
  BuildContext context,
  WidgetRef ref,
  Ticket ticket,
) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Kds.canvas,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (_) => _TicketDetailSheet(ticketId: ticket.id),
  );
}

class _TicketDetailSheet extends ConsumerWidget {
  const _TicketDetailSheet({required this.ticketId});

  /// The id rather than the ticket.
  ///
  /// The sheet stays open while the board keeps moving underneath it — a poll
  /// lands, another screen bumps the fryer's half — and a sheet holding a
  /// snapshot would quietly go stale in front of somebody who is about to act
  /// on it.
  final String ticketId;

  static final _clock = DateFormat('HH:mm:ss');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.watch(ticketBoardProvider);
    final session = ref.watch(kitchenSessionProvider).value;
    final profile = session?.screen;

    Ticket? found;
    for (final candidate in board.tickets) {
      if (candidate.id == ticketId) found = candidate;
    }

    // Gone from the board entirely — aged out of the recall window while the
    // sheet was open. Saying so is the honest answer.
    if (found == null || profile == null || session == null) {
      return const SizedBox(
        height: 160,
        child: Center(child: Text('That order is no longer on the board.')),
      );
    }
    final ticket = found;

    final mine = profile.stations;
    final notMine = ticket.lines.where((l) => !l.isFor(mine)).toList();

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.72,
      maxChildSize: 0.94,
      minChildSize: 0.4,
      builder: (context, scrollController) => Column(
        children: [
          const SizedBox(height: 10),
          Container(
            width: 44,
            height: 4,
            decoration: BoxDecoration(
              color: Kds.inkMuted.withValues(alpha: 0.35),
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Expanded(
            child: ListView(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
              children: [
                Text(
                  ticket.destination,
                  style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  [
                    if (ticket.roomName != null) ticket.roomName!,
                    ticket.kind.label,
                    if (ticket.ticketNo != null) 'Order ${ticket.ticketNo}',
                    if (ticket.staffName != null) ticket.staffName!,
                    if (ticket.covers != null) '${ticket.covers} covers',
                  ].join(' · '),
                  style: const TextStyle(color: Kds.inkMuted, fontSize: 14.5),
                ),

                const SizedBox(height: 16),
                _Panel(
                  title: 'On this screen',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final line in ticket.linesFor(mine))
                        _DetailLine(line: line, labelFor: session.labelFor),
                    ],
                  ),
                ),

                // The rest of the order. Not on the card, because the card is
                // for cooking and this is not this station's food — but a chef
                // plating up needs to know what is coming from elsewhere, and
                // "where is the rest of it?" is otherwise a walk across the
                // kitchen.
                if (notMine.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  _Panel(
                    title: 'Elsewhere on this order',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (final line in notMine)
                          _DetailLine(
                            line: line,
                            labelFor: session.labelFor,
                            dimmed: true,
                          ),
                      ],
                    ),
                  ),
                ],

                if (ticket.note != null) ...[
                  const SizedBox(height: 12),
                  _Panel(
                    title: 'Note on the order',
                    child: Text(
                      ticket.note!,
                      style: const TextStyle(
                        color: Kds.modifier,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],

                const SizedBox(height: 12),
                _Panel(
                  title: 'Progress',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final station in ticket.stations)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            children: [
                              Icon(
                                station.done
                                    ? Icons.check_circle
                                    : Icons.radio_button_unchecked,
                                size: 19,
                                color: station.done ? Kds.done : Kds.inkMuted,
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  session.labelFor(station.station),
                                  style: const TextStyle(fontSize: 15.5),
                                ),
                              ),
                              Text(
                                station.done && station.doneAt != null
                                    ? '${_clock.format(station.doneAt!)}'
                                          '${station.doneBy == null ? '' : ' · ${station.doneBy}'}'
                                    : 'Waiting',
                                style: const TextStyle(
                                  color: Kds.inkMuted,
                                  fontSize: 13.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      const Divider(height: 18),
                      Row(
                        children: [
                          const Expanded(child: Text('Placed')),
                          Text(
                            _clock.format(ticket.placedAt),
                            style: const TextStyle(color: Kds.inkMuted),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 16),
                _Actions(ticket: ticket, session: session),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Actions extends ConsumerWidget {
  const _Actions({required this.ticket, required this.session});

  final Ticket ticket;
  final KitchenSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(ticketBoardProvider.notifier);
    final profile = ref.watch(kitchenSessionProvider).value!.screen;
    final open = ticket.isOpenFor(profile.stations);

    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        OutlinedButton.icon(
          onPressed: () => notifier.rush(ticket, !ticket.rushed),
          icon: Icon(ticket.rushed ? Icons.bolt : Icons.bolt_outlined),
          label: Text(ticket.rushed ? 'Stop rushing' : 'Rush this order'),
        ),
        OutlinedButton.icon(
          // The header's printer key prints the whole board; this prints one
          // ticket. Both exist for the same moment — the screen has to be
          // abandoned, and the food still has to be cooked.
          onPressed: () => printTickets(
            context,
            tickets: [ticket],
            profile: profile,
            labelFor: session.labelFor,
            venueName: session.officeName,
            heading: 'Ticket',
          ),
          icon: const Icon(Icons.print_outlined),
          label: const Text('Print this ticket'),
        ),
        if (open)
          FilledButton.icon(
            onPressed: () {
              notifier.bump(ticket);
              Navigator.of(context).pop();
            },
            icon: const Icon(Icons.check),
            label: const Text('Done'),
          )
        else
          FilledButton.icon(
            onPressed: () {
              notifier.recall(ticket);
              Navigator.of(context).pop();
            },
            icon: const Icon(Icons.undo),
            label: const Text('Recall order'),
          ),
      ],
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
      decoration: BoxDecoration(
        color: Kds.card,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.8,
              color: Kds.inkMuted,
            ),
          ),
          const SizedBox(height: 8),
          child,
        ],
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  const _DetailLine({
    required this.line,
    required this.labelFor,
    this.dimmed = false,
  });

  final TicketLine line;
  final String Function(String station) labelFor;

  /// Somebody else's food: shown, but not competing for attention with the
  /// lines this screen is responsible for.
  final bool dimmed;

  @override
  Widget build(BuildContext context) {
    final colour = dimmed ? Kds.inkMuted : Kds.ink;

    // An answer about the dish above it, drawn as a typed note is. Same
    // treatment as the board card, so the detail view and the ticket a chef is
    // looking at do not describe the same order two different ways.
    if (line.isModifier) {
      return Padding(
        padding: const EdgeInsets.only(left: 38, top: 1, bottom: 4),
        child: Text(
          line.name,
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w600,
            color: dimmed
                ? Kds.modifier.withValues(alpha: 0.6)
                : Kds.modifier,
          ),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 28,
                child: Text(
                  line.quantityLabel,
                  textAlign: TextAlign.right,
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: colour,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  line.name,
                  style: TextStyle(fontSize: 16, color: colour),
                ),
              ),
              Text(
                line.stations.map(labelFor).join(', '),
                style: const TextStyle(fontSize: 12.5, color: Kds.inkMuted),
              ),
            ],
          ),
          if (line.note != null)
            Padding(
              padding: const EdgeInsets.only(left: 38, top: 1),
              child: Text(
                line.note!,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: dimmed
                      ? Kds.modifier.withValues(alpha: 0.6)
                      : Kds.modifier,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
