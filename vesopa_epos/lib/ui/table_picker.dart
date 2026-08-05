import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/floor_repository.dart';
import '../data/local/database.dart';
import '../main.dart';
import 'tables_page.dart' show parkedOrdersProvider;
import 'theme.dart';
import 'widgets/basket_panel.dart' show money;

/// Pick a table to save the current sale onto, from the actual floor plan
/// rather than a blind number entry. This is the picker a waiter reaches for at
/// the pass, so what's free has to be readable at a glance.
///
/// A booked table is no longer a dead end: tapping one returns its number just
/// like a free one, and the caller adds to the bill already sitting there. A
/// table that ordered a round at 8pm and another green tea at 8:20 is one bill,
/// not two, and the clerk should not have to remember to recall it from the
/// tables screen first.
///
/// Whether the table is occupied is deliberately *not* returned — the caller
/// re-reads it from the database. The picker's view comes from a stream that
/// can be a frame stale, and on a floor with several terminals the answer must
/// come from the same place the merge is about to act on.
///
/// Returns the chosen table number, or null if cancelled. Falls back to a plain
/// number entry when no floor plan has been drawn, so a venue that never laid
/// out its rooms can still save to a table.
Future<int?> showTablePicker(BuildContext context, WidgetRef ref) {
  return showDialog<int>(
    context: context,
    builder: (_) => const _TablePickerDialog(),
  );
}

class _TablePickerDialog extends ConsumerWidget {
  const _TablePickerDialog();

  /// Matches the designer's grid unit, same as the tables page, so a table
  /// drawn at (5,3) lands where the manager expects it.
  static const _grid = 40.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final parked = ref.watch(parkedOrdersProvider).value ?? const <Order>[];
    final byTable = {
      for (final o in parked)
        if (o.tableNumber != null) o.tableNumber!: o,
    };
    final plan = ref.watch(floorPlanProvider);

    return Dialog(
      insetPadding: const EdgeInsets.all(16),
      child: SizedBox(
        width: 720,
        height: 560,
        child: plan.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => _NoPlanFallback(reason: 'Could not load the plan.'),
          data: (rooms) {
            final withTables = rooms.where((r) => r.tables.isNotEmpty).toList();

            // No plan drawn: don't dead-end the clerk — fall back to typing a
            // number, exactly what the old picker did.
            if (withTables.isEmpty) {
              return const _NoPlanFallback(
                reason: 'No floor plan has been drawn yet.',
              );
            }

            return DefaultTabController(
              length: withTables.length,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 8, 0),
                    child: Row(
                      children: [
                        const Text(
                          'Save to table',
                          style: TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const Spacer(),
                        IconButton(
                          tooltip: 'Close',
                          icon: const Icon(Icons.close),
                          onPressed: () => Navigator.pop(context),
                        ),
                      ],
                    ),
                  ),
                  const _Legend(),
                  if (withTables.length > 1)
                    TabBar(
                      isScrollable: true,
                      tabAlignment: TabAlignment.start,
                      tabs: [for (final r in withTables) Tab(text: r.name)],
                    ),
                  Expanded(
                    child: TabBarView(
                      children: [
                        for (final room in withTables)
                          _PickerRoomPlan(
                            room: room,
                            byTable: byTable,
                            onPick: (number) => Navigator.pop(context, number),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

/// Free vs booked, spelled out once at the top so the colours are not left to
/// guesswork.
class _Legend extends StatelessWidget {
  const _Legend();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Row(
        children: [
          _swatch(Theme.of(context).posIdle, 'Free', context),
          const SizedBox(width: 20),
          // Says what a tap will do, now that booked tables accept one.
          _swatch(Pos.brand, 'Booked — tap to add to the bill', context),
        ],
      ),
    );
  }

  Widget _swatch(Color color, String label, BuildContext context) {
    return Row(
      children: [
        Container(
          width: 16,
          height: 16,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(3),
            border: Border.all(color: Theme.of(context).posLine),
          ),
        ),
        const SizedBox(width: 6),
        Text(label, style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}

class _NoPlanFallback extends StatelessWidget {
  const _NoPlanFallback({required this.reason});

  final String reason;

  @override
  Widget build(BuildContext context) {
    final controller = TextEditingController();
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            reason,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 4),
          Text(
            'Enter a table number to save this sale.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          TextField(
            controller: controller,
            keyboardType: TextInputType.number,
            autofocus: true,
            textAlign: TextAlign.center,
            decoration: const InputDecoration(
              hintText: 'Table number',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (v) => Navigator.pop(context, int.tryParse(v.trim())),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('Cancel'),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: () => Navigator.pop(
                  context,
                  int.tryParse(controller.text.trim()),
                ),
                child: const Text('Save'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Renders one room's plan for picking. Same scaling as the tables page so the
/// two views read as the same floor.
class _PickerRoomPlan extends StatelessWidget {
  const _PickerRoomPlan({
    required this.room,
    required this.byTable,
    required this.onPick,
  });

  final FloorRoom room;
  final Map<int, Order> byTable;
  final void Function(int number) onPick;

  @override
  Widget build(BuildContext context) {
    var maxX = 1;
    var maxY = 1;
    for (final t in room.tables) {
      maxX = t.x + t.width > maxX ? t.x + t.width : maxX;
      maxY = t.y + t.height > maxY ? t.y + t.height : maxY;
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        const grid = _TablePickerDialog._grid;
        const pad = 12.0;
        final availW = constraints.maxWidth - pad * 2;
        final availH = constraints.maxHeight - pad * 2;

        // Fit the whole plan inside the dialog on BOTH axes — the previous
        // width-only scale let a wide or tall layout run past the edge and clip
        // the last tables. Scaling to the tighter of the two guarantees every
        // table is visible without needing to scroll.
        final scaleW = availW / (maxX * grid);
        final scaleH = availH / (maxY * grid);
        final scale = (scaleW < scaleH ? scaleW : scaleH)
            .clamp(0.3, 1.6)
            .toDouble();
        final unit = grid * scale;

        final planW = maxX * unit;
        final planH = maxY * unit;

        return Padding(
          padding: const EdgeInsets.all(pad),
          // Centre the fitted plan in the space; if a clamp still leaves it
          // larger than the dialog (a genuinely huge layout), scrolling both
          // ways is the safety net rather than a clip.
          child: SingleChildScrollView(
            scrollDirection: Axis.vertical,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SizedBox(
                width: planW < availW ? availW : planW,
                height: planH < availH ? availH : planH,
                child: Stack(
                  children: [
                    for (final table in room.tables)
                      Positioned(
                        left: table.x * unit,
                        top: table.y * unit,
                        width: table.width * unit - 6,
                        height: table.height * unit - 6,
                        child: _PickableTable(
                          table: table,
                          order: byTable[table.number],
                          onPick: () => onPick(table.number),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// A table on the picker. Free tables are tappable and carry seat count; a
/// booked table shows its running total, is dimmed, and rejects a tap with a
/// nudge rather than silently overwriting another party's bill.
class _PickableTable extends StatelessWidget {
  const _PickableTable({
    required this.table,
    required this.order,
    required this.onPick,
  });

  final FloorTable table;
  final Order? order;
  final VoidCallback onPick;

  @override
  Widget build(BuildContext context) {
    final booked = order != null;
    final radius = table.isCircle
        ? BorderRadius.circular(400)
        : BorderRadius.circular(8);

    final label = table.label?.isNotEmpty == true
        ? table.label!
        : '${table.number}';

    // Same rule as the floor plan in tables_page.dart: surface first, ink
    // derived from it. The two screens draw the same tile and had drifted into
    // disagreeing about what colour the total should be.
    final surface = booked ? Pos.brand : Theme.of(context).posIdle;
    final ink = booked
        ? Pos.inkOn(surface)
        : Theme.of(context).colorScheme.onSurface;

    return Opacity(
      opacity: booked ? 0.75 : 1,
      child: Material(
        color: surface,
        borderRadius: radius,
        child: InkWell(
          borderRadius: radius,
          // Booked tables are pickable too — the caller adds to the bill that
          // is already there rather than starting a second one on the same
          // table.
          onTap: onPick,
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    color: ink,
                  ),
                ),
                if (booked)
                  Text(
                    money(order!.totalMinor),
                    style: TextStyle(color: Pos.mutedInkOn(surface), fontSize: 13),
                  )
                else
                  Text(
                    '${table.seats} seats',
                    style: TextStyle(
                      color: Theme.of(context).hintColor,
                      fontSize: 11,
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
