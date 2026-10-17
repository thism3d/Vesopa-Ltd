import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/screen_profile.dart';
import '../data/ticket.dart';
import 'theme.dart';

/// Kitchen widgets (2026-10-17), along the top of the board.
///
/// The owner: "other necessary widgets for Kitchen, default off but can be
/// turned on", for a kitchen screen on a bigger panel. Each is a number a chef
/// or the pass would otherwise work out by counting cards:
///
///   clock    the time
///   open     orders still to cook on this board
///   late     orders past the red threshold
///   oldest   how long the oldest open order has waited
///   average  how long orders took, over the last hour
///   allday   what is still to make, item by item ("4 Burger, 3 Chips")
///   note     a line from the front ("86 salmon"), set on the till
///
/// All drawn from the board this screen already holds; nothing new is
/// fetched. Off by default, so a screen nobody has touched is unchanged.
class KitchenTileStrip extends StatelessWidget {
  const KitchenTileStrip({
    super.key,
    required this.tiles,
    required this.note,
    required this.open,
    required this.completed,
    required this.profile,
    required this.now,
  });

  /// The venue's chosen tiles, in order.
  final List<String> tiles;
  final String note;
  final List<Ticket> open;
  final List<Ticket> completed;
  final ScreenProfile profile;
  final DateTime now;

  /// The tiles this build draws, in their default order.
  static const supported = ['clock', 'open', 'late', 'oldest', 'average', 'allday', 'note'];

  static String _clockOf(Duration d) {
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    return m >= 60 ? '${d.inHours}h ${m % 60}m' : '${m}m ${s.toString().padLeft(2, '0')}s';
  }

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    final shown = [
      for (final id in tiles)
        if (supported.contains(id) && (id != 'note' || note.trim().isNotEmpty)) id,
    ];
    if (shown.isEmpty) return const SizedBox.shrink();

    final late = open.where((t) => TicketAge.of(t.age(now), profile) == TicketAge.late).length;
    Duration? oldest;
    for (final t in open) {
      final a = t.age(now);
      if (oldest == null || a > oldest) oldest = a;
    }
    final recent = <Duration>[
      for (final t in completed)
        if (t.completedAtFor(profile.stations) case final done?)
          if (now.difference(done) <= const Duration(hours: 1)) done.difference(t.placedAt),
    ];
    final average = recent.isEmpty
        ? null
        : Duration(seconds: recent.fold<int>(0, (a, d) => a + d.inSeconds) ~/ recent.length);

    final allDay = <String, double>{};
    for (final t in open) {
      for (final l in t.linesFor(profile.stations)) {
        if (l.isModifier || l.made) continue;
        allDay[l.name] = (allDay[l.name] ?? 0) + l.quantity;
      }
    }
    final allDayText = (allDay.entries.toList()..sort((a, b) => b.value.compareTo(a.value)))
        .take(6)
        .map((e) => '${e.value == e.value.roundToDouble() ? e.value.toInt() : e.value} ${e.key}')
        .join('  ·  ');

    Widget tile(String id) => switch (id) {
      'clock' => _Tile(label: 'Time', value: DateFormat('HH:mm').format(now)),
      'open' => _Tile(label: 'Open orders', value: '${open.length}'),
      'late' => _Tile(
          label: 'Late',
          value: '$late',
          colour: late > 0 ? Kds.late : null,
        ),
      'oldest' => _Tile(
          label: 'Oldest',
          value: oldest == null ? '-' : _clockOf(oldest),
          colour: oldest != null && oldest >= profile.late ? Kds.late : null,
        ),
      'average' => _Tile(
          label: 'Average (last hour)',
          value: average == null ? '-' : _clockOf(average),
        ),
      'allday' => _Tile(label: 'All day', value: allDayText.isEmpty ? 'Nothing waiting' : allDayText, wide: true),
      'note' => _Tile(label: 'From the front', value: note.trim(), wide: true, colour: Kds.warn),
      _ => const SizedBox.shrink(),
    };

    return Container(
      color: skin.surface,
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      child: Row(
        children: [
          for (final id in shown)
            Expanded(
              flex: id == 'allday' || id == 'note' ? 3 : 1,
              child: Padding(padding: const EdgeInsets.all(3), child: tile(id)),
            ),
        ],
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.label, required this.value, this.colour, this.wide = false});

  final String label;
  final String value;
  final Color? colour;
  final bool wide;

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    final accent = colour;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: accent == null ? skin.canvas : accent.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: accent ?? skin.inkMuted.withValues(alpha: 0.25), width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label.toUpperCase(),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11, letterSpacing: 1.2, fontWeight: FontWeight.w700, color: skin.inkMuted),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            maxLines: wide ? 2 : 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: wide ? 18 : 26,
              fontWeight: FontWeight.w800,
              color: accent ?? skin.ink,
              height: 1.1,
            ),
          ),
        ],
      ),
    );
  }
}
