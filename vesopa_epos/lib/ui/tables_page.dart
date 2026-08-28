import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/floor_repository.dart';
import '../data/local/database.dart';
import '../data/terminal_service.dart';
import '../main.dart';
import 'payment_page.dart';
import 'placeholder_page.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';
import 'widgets/basket_panel.dart' show money;

final parkedOrdersProvider = StreamProvider<List<Order>>(
  (ref) => ref.watch(tableRepositoryProvider).watchParked(),
);

/// Table plan. A table with a bill on it shows the running total; an empty one
/// is free.
class TablesPage extends ConsumerWidget {
  const TablesPage({
    super.key,
    required this.currentOrderId,
    required this.onRecall,
  });

  final String currentOrderId;

  /// Called with the recalled order so the shell can switch to it.
  final void Function(String orderId) onRecall;

  /// Matches the designer's grid unit, so a table drawn at (5,3) lands at (5,3)
  /// here.
  static const _grid = 40.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final parked = ref.watch(parkedOrdersProvider).value ?? const <Order>[];
    // Keyed by room *and* number, because a number alone is not a table: the
    // floor plan lets a venue have a Table 1 on the Main Floor and a Table 1 on
    // the Terrace, and keying by number put one bill on both of them.
    final byRoomTable = <(int, int), Order>{
      for (final o in parked)
        if (o.tableNumber != null && o.roomId != null)
          (o.roomId!, o.tableNumber!): o,
    };

    // Bills parked before the room was recorded, and bills from the plain
    // number entry that has no plan to place them on. They fall back to
    // matching on number alone — the old behaviour, which is right for the
    // one-room venue that is the only place it can still be ambiguous.
    final byNumberOnly = <int, Order>{
      for (final o in parked)
        if (o.tableNumber != null && o.roomId == null) o.tableNumber!: o,
    };

    Order? orderFor(int? roomId, int number) =>
        (roomId == null ? null : byRoomTable[(roomId, number)]) ??
        byNumberOnly[number];
    final plan = ref.watch(floorPlanProvider);

    return Padding(
      padding: const EdgeInsets.all(16),
      child: plan.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) =>
            Center(child: Text('Could not load the floor plan.\n$e')),
        data: (rooms) {
          final withTables = rooms.where((r) => r.tables.isNotEmpty).toList();

          // No plan drawn yet: say so, rather than showing an invented grid of
          // tables that do not exist in the venue.
          if (withTables.isEmpty) {
            return const PlaceholderPage(
              title: 'Tables',
              icon: Icons.grid_view,
              description:
                  'No floor plan has been drawn yet. Lay out your rooms and '
                  'tables in the back office and they will appear here.',
              points: [
                'Drag tables into position on a room plan',
                'Set seats, size and shape per table',
                'Occupied tables show their running total',
              ],
            );
          }

          return DefaultTabController(
            length: withTables.length,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text(
                      'Tables',
                      style: TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const Spacer(),
                    // Whether the room on screen is the whole venue's or just
                    // this terminal's. Stated rather than left to be inferred:
                    // a plan that has silently stopped hearing from the other
                    // till looks exactly like a quiet night, and a clerk who
                    // reads it as one will seat a party on an occupied table.
                    const _SharedPlanChip(),
                    const SizedBox(width: 8),
                    IconButton(
                      tooltip: 'Refresh plan',
                      icon: const Icon(Icons.refresh),
                      onPressed: () => ref.invalidate(floorPlanProvider),
                    ),
                  ],
                ),
                if (withTables.length > 1)
                  TabBar(
                    isScrollable: true,
                    tabAlignment: TabAlignment.start,
                    tabs: [for (final room in withTables) Tab(text: room.name)],
                  ),
                Expanded(
                  child: TabBarView(
                    children: [
                      for (final room in withTables)
                        _RoomPlan(
                          room: room,
                          orderFor: (number) => orderFor(room.id, number),
                          // The room comes from the plan the table was
                          // tapped on: a number alone is ambiguous once two
                          // rooms each have a Table 1.
                          onTap: (number, order) =>
                              _onTap(context, ref, number, order, room.id),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _onTap(
    BuildContext context,
    WidgetRef ref,
    int number,
    Order? order,
    int? roomId,
  ) async {
    final tables = ref.read(tableRepositoryProvider);

    if (order == null) {
      // Empty table: park the sale currently on the till against it.
      final lines = await ref
          .read(orderRepositoryProvider)
          .watchLines(currentOrderId)
          .first;
      if (lines.isEmpty) {
        if (!context.mounted) return;
        PosMessenger.error(context, 'Ring up some items first.');
        return;
      }
      await tables.park(currentOrderId, number, roomId: roomId);
      if (!context.mounted) return;
      PosMessenger.success(context, 'Saved to table $number.');
      return;
    }

    if (!context.mounted) return;
    // Somebody else's, mirrored here so the room draws whole. Named on the
    // sheet rather than refused silently -- a clerk who can see the table and
    // cannot open it needs to be told which terminal to go to, or that they can
    // take it.
    final held = order.heldBy;
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(
                'Table $number — ${money(order.totalMinor)}',
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
              subtitle: held == null ? null : Text('Open on $held'),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.open_in_new),
              title: const Text('Recall to till'),
              onTap: () => Navigator.pop(context, 'recall'),
            ),
            ListTile(
              leading: const Icon(Icons.swap_horiz),
              title: const Text('Transfer to another table'),
              onTap: () => Navigator.pop(context, 'transfer'),
            ),
            ListTile(
              leading: const Icon(Icons.call_split),
              title: const Text('Split bill'),
              onTap: () => Navigator.pop(context, 'split'),
            ),
          ],
        ),
      ),
    );

    if (action == null || !context.mounted) return;

    // A bill another terminal is holding has to be taken over before anything
    // here can act on it. Two tills editing one check is the one state neither
    // of them could reconcile, and two tills *settling* one check is money
    // taken twice.
    if (held != null) {
      try {
        await ref.read(billSyncProvider).claim(order.id);
      } on TerminalUnavailable catch (e) {
        if (context.mounted) PosMessenger.error(context, e.message);
        return;
      }
      if (!context.mounted) return;
    }

    switch (action) {
      case 'recall':
        // onRecall (the shell) performs the recall and switches to the bill.
        onRecall(order.id);
      case 'transfer':
        final to = await _askNumber(context, 'Transfer to table');
        if (to == null) return;
        try {
          await tables.transfer(order.id, to);
        } on StateError catch (e) {
          if (!context.mounted) return;
          PosMessenger.error(context, e.message);
        }
      case 'split':
        if (!context.mounted) return;
        await _splitDialog(context, ref, order);
    }
  }

  /// Split this table's bill evenly and go straight to taking the money.
  ///
  /// The bill itself is left completely alone — one check, one set of items,
  /// one audit trail. What is divided is the *payment*: the tender screen opens
  /// with N shares, takes each person's money in turn, and only settles the
  /// order once every share is covered. The previous version tried to carve the
  /// check itself into N new orders and destroyed it doing so.
  Future<void> _splitDialog(
    BuildContext context,
    WidgetRef ref,
    Order order,
  ) async {
    final ways = await _askNumber(context, 'Split evenly how many ways?');
    if (ways == null || !context.mounted) return;

    if (ways < 2) {
      PosMessenger.error(context, 'Need at least two ways to split.');
      return;
    }

    // Recall first: the bill has to be the live one on the till so that
    // settling it — and the receipt that follows — lands on the right order.
    await ref.read(tableRepositoryProvider).recall(order.id);
    onRecall(order.id);

    if (!context.mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PaymentPage(
          orderId: order.id,
          initialSplitWays: ways,
          onSettled: () {},
        ),
      ),
    );
  }

  Future<int?> _askNumber(BuildContext context, String title) {
    final controller = TextEditingController();
    return showDialog<int>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.number,
          autofocus: true,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.pop(context, int.tryParse(controller.text.trim())),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }
}

/// Renders one room exactly as it was laid out in the back office. The plan
/// scales to fit the terminal, so the same layout reads correctly on a phone,
/// a tablet and a desktop till.
class _RoomPlan extends StatelessWidget {
  const _RoomPlan({
    required this.room,
    required this.orderFor,
    required this.onTap,
  });

  final FloorRoom room;
  /// The bill sitting on one of this room's tables, if any. A function rather
  /// than a map because the answer depends on the room as well as the number.
  final Order? Function(int number) orderFor;
  final void Function(int number, Order? order) onTap;

  @override
  Widget build(BuildContext context) {
    // How far the plan extends, so it can be scaled to the space available.
    var maxX = 1;
    var maxY = 1;
    for (final t in room.tables) {
      maxX = t.x + t.width > maxX ? t.x + t.width : maxX;
      maxY = t.y + t.height > maxY ? t.y + t.height : maxY;
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        const grid = TablesPage._grid;

        // Fit the plan on both axes so a wide or tall room never runs off the
        // edge and hides its last tables. Height can be unbounded (inside a
        // scroll view); when it is, fall back to fitting on width alone.
        final availW = constraints.maxWidth;
        final availH = constraints.maxHeight;
        final scaleW = availW / (maxX * grid);
        final hasBoundedHeight = availH.isFinite;
        final scaleH = hasBoundedHeight ? availH / (maxY * grid) : scaleW;
        final scale = (scaleW < scaleH ? scaleW : scaleH)
            .clamp(0.3, 1.6)
            .toDouble();
        final unit = grid * scale;

        final planW = maxX * unit;
        final planH = maxY * unit;

        return SingleChildScrollView(
          scrollDirection: Axis.vertical,
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SizedBox(
              width: planW < availW ? availW : planW,
              height: planH + 16,
              child: Stack(
                children: [
                  for (final table in room.tables)
                    Positioned(
                      left: table.x * unit,
                      top: table.y * unit,
                      width: table.width * unit - 6,
                      height: table.height * unit - 6,
                      child: _TableShape(
                        table: table,
                        order: orderFor(table.number),
                        onTap: () => onTap(table.number, orderFor(table.number)),
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _TableShape extends StatelessWidget {
  const _TableShape({
    required this.table,
    required this.order,
    required this.onTap,
  });

  final FloorTable table;
  final Order? order;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final occupied = order != null;
    final radius = table.isCircle
        ? BorderRadius.circular(400)
        : BorderRadius.circular(8);

    // The tile colour first, then every piece of text on it derived from that
    // colour. Doing it the other way round is how the total ended up hardcoded
    // to white on the brand lime, at 1.7:1 — the number was there, but a clerk
    // glancing at the floor plan could not read it.
    final surface = occupied ? Pos.brand : Theme.of(context).posIdle;
    final ink = occupied
        ? Pos.inkOn(surface)
        : Theme.of(context).colorScheme.onSurface;

    return Material(
      // An idle table used a fixed light-grey even in dark mode, so its
      // near-white number was invisible on it. Both now come from the theme.
      color: surface,
      borderRadius: radius,
      child: InkWell(
        borderRadius: radius,
        onTap: onTap,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                table.label?.isNotEmpty == true
                    ? table.label!
                    : '${table.number}',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: ink,
                ),
              ),
              if (occupied)
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
    );
  }
}


/// Says whether the table plan is the venue's or only this terminal's.
///
/// Draws nothing at all on a till that is not sharing -- a venue with one
/// terminal has never had another till's tables to miss, and a chip explaining
/// that would be chrome answering a question nobody asked.
class _SharedPlanChip extends ConsumerWidget {
  const _SharedPlanChip();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(billSyncStatusProvider).value;
    if (status == null || !status.sharing) return const SizedBox.shrink();

    final scheme = Theme.of(context).colorScheme;
    final stale = status.stale;
    return Tooltip(
      message: stale
          ? 'This till cannot reach the others right now. Tables opened or '
                'settled elsewhere since will not be shown.'
          : 'Every terminal in this venue is showing the same tables.',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: stale ? scheme.errorContainer : scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              stale ? Icons.cloud_off : Icons.devices,
              size: 15,
              color: stale ? scheme.onErrorContainer : scheme.onSurfaceVariant,
            ),
            const SizedBox(width: 6),
            Text(
              stale ? 'Not in step' : 'All tills',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color:
                    stale ? scheme.onErrorContainer : scheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
