/// The floor: the back office designer's plan, as the till draws it, with a
/// list for small phones. Every table's state is one colour.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../fit_text.dart';
import '../theme.dart';
import 'floor_editor.dart';
import 'order.dart';
import 'scan_sheet.dart';

class TablesPage extends ConsumerStatefulWidget {
  const TablesPage({super.key});
  @override
  ConsumerState<TablesPage> createState() => _TablesPageState();
}

class _TablesPageState extends ConsumerState<TablesPage> {
  static const _viewKey = 'go_floor_view';
  String? _area;

  /// This device's own choice of plan or list, once made; else the venue's.
  bool? _plan;

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      final v = p.getString(_viewKey);
      if (v != null && mounted) setState(() => _plan = v == 'plan');
    }).catchError((Object _) {});
  }

  void _setView(bool plan) {
    setState(() => _plan = plan);
    SharedPreferences.getInstance().then((p) => p.setString(_viewKey, plan ? 'plan' : 'list')).catchError((Object _) => false);
  }

  Future<void> _open(TableInfo table) async {
    HapticFeedback.selectionClick();
    final s = ref.read(tapProvider);
    var bill = s.billForTable(table.id);
    if (bill == null) {
      final covers = await _askCovers(table);
      if (covers == null || !mounted) return;
      bill = ref.read(tapProvider.notifier).openTable(table, covers: covers);
    } else if (bill.heldBy != null) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text('${table.name} is open on ${bill!.heldBy}'),
          content: const Text('Take it over here? It moves to this device, and the till can no longer settle it.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Take over')),
          ],
        ),
      );
      if (ok != true || !mounted) return;
      if (!await ref.read(tapProvider.notifier).claim(bill.id)) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(ref.read(tapProvider).message ?? 'Could not take the table over.')));
        }
        return;
      }
      if (!mounted) return;
    }
    await Navigator.of(context).push(PageRouteBuilder<void>(
      transitionDuration: const Duration(milliseconds: 260),
      pageBuilder: (_, _, _) => OrderPage(billId: bill!.id),
      transitionsBuilder: (_, a, _, child) => FadeTransition(
        opacity: a,
        child: SlideTransition(position: Tween(begin: const Offset(0.04, 0), end: Offset.zero).animate(CurvedAnimation(parent: a, curve: Curves.easeOutCubic)), child: child),
      ),
    ));
  }

  /// A table's QR (or its NFC tag's text): a link with `table=7`, `t=7` or a
  /// trailing number, or the number on its own.
  Future<void> _scan() async {
    final code = await scanCode(context, title: 'Scan the table', hint: 'Point at the QR code on the table');
    if (code == null || !mounted) return;
    final tables = ref.read(tapProvider).tables;
    final m = RegExp(r'(?:table|t)[=/](\d+)', caseSensitive: false).firstMatch(code) ?? RegExp(r'(\d+)\D*$').firstMatch(code);
    final n = m == null ? null : int.tryParse(m.group(1)!);
    final table = tables.where((t) => t.number == n || t.id == code || t.id == 'table-$n').firstOrNull;
    if (table == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('That code is not one of this venue\'s tables.')));
      return;
    }
    setState(() => _area = table.area);
    await _open(table);
  }

  Future<int?> _askCovers(TableInfo table) => showModalBottomSheet<int>(
        context: context,
        showDragHandle: true,
        builder: (c) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('How many at ${table.name}?', style: Theme.of(c).textTheme.titleLarge),
              const SizedBox(height: 16),
              Wrap(spacing: 10, runSpacing: 10, children: [
                for (var n = 1; n <= math.max(10, table.seats); n++)
                  SizedBox(width: 64, height: 56, child: OutlinedButton(onPressed: () => Navigator.pop(c, n), child: Text('$n'))),
              ]),
            ]),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final go = s.config.go;
    final plan = _plan ?? (MediaQuery.sizeOf(context).shortestSide < 600 ? false : go.floorPlan);
    final areas = {for (final t in s.tables) t.area}.toList();
    final area = (_area != null && areas.contains(_area)) ? _area : (areas.isEmpty ? null : areas.first);
    final tables = s.tables.where((t) => t.area == area).toList();
    final t = Theme.of(context).textTheme;
    if (s.tables.isEmpty) {
      return Center(child: Padding(
        padding: const EdgeInsets.all(32),
        child: Text('No tables yet. Draw the floor plan in the back office and it appears here.', textAlign: TextAlign.center, style: t.bodyLarge),
      ));
    }
    // A phone shows round buttons coloured by state, a glance at the room
    // (owner, 2026-10-28); a bigger screen the plan or named tiles.
    final phone = MediaQuery.sizeOf(context).shortestSide < 600;
    final counts = <TableState, int>{};
    for (final table in tables) {
      counts.update(s.tableState(table.id), (n) => n + 1, ifAbsent: () => 1);
    }
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
        child: Row(children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                for (final a in areas)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(label: Text(a), selected: a == area, onSelected: (_) => setState(() => _area = a)),
                  ),
              ]),
            ),
          ),
          if (phone)
            IconButton(
              tooltip: plan ? 'Round buttons' : 'Floor plan',
              onPressed: () => _setView(!plan),
              icon: Icon(plan ? Icons.bubble_chart_rounded : Icons.grid_view_rounded),
            )
          else
            SegmentedButton<bool>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(value: true, icon: Icon(Icons.grid_view_rounded), label: Text('Plan')),
                ButtonSegment(value: false, icon: Icon(Icons.view_list_rounded), label: Text('List')),
              ],
              selected: {plan},
              onSelectionChanged: (v) => _setView(v.first),
            ),
          // A manager can move tables, as on the till's floor editor.
          if (s.clerk?.can(TillPermission.isManager) ?? false) ...[
            SizedBox(width: phone ? 0 : 8),
            IconButton.outlined(
              tooltip: 'Arrange tables',
              onPressed: area == null ? null : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FloorEditorPage(area: area))),
              icon: const Icon(Icons.edit_location_alt_rounded),
            ),
          ],
          if (go.scanTableQr) ...[
            SizedBox(width: phone ? 4 : 8),
            IconButton.outlined(tooltip: 'Scan table QR', onPressed: _scan, icon: const Icon(Icons.qr_code_scanner_rounded)),
          ],
        ]),
      ),
      Expanded(
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 220),
          child: plan
              ? _FloorPlan(key: ValueKey('plan-$area'), tables: tables, onOpen: _open)
              : phone
                  ? _TableDots(key: ValueKey('dots-$area'), tables: tables, onOpen: _open)
                  : _TableList(key: ValueKey('list-$area'), tables: tables, onOpen: _open),
        ),
      ),
      // What the room is doing, at a glance.
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
        child: Wrap(spacing: 16, runSpacing: 6, children: [
          for (final st in TableState.values)
            if ((counts[st] ?? 0) > 0)
              Row(mainAxisSize: MainAxisSize.min, children: [
                Container(width: 12, height: 12, decoration: BoxDecoration(color: Tp.stateColour(st), borderRadius: BorderRadius.circular(3))),
                const SizedBox(width: 6),
                Text('${Tp.stateName(st)} ${counts[st]}', style: t.bodySmall),
              ]),
        ]),
      ),
    ]);
  }
}

/// What a table's tile says under its name: its bill, or its seats.
String tableDetail(Bill? bill, TableInfo table) {
  if (bill == null) return '${table.seats} seats';
  final parts = [if (bill.covers > 0) '${bill.covers} ${bill.covers == 1 ? 'cover' : 'covers'}', if (bill.clerk.trim().isNotEmpty) bill.clerk.trim()];
  return parts.join(' · ');
}

class _FloorPlan extends ConsumerWidget {
  const _FloorPlan({super.key, required this.tables, required this.onOpen});
  final List<TableInfo> tables;
  final ValueChanged<TableInfo> onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    // A plan saved before positions existed has every table at 0,0: lay those
    // out in rows rather than in one pile.
    final placed = tables.any((t) => t.x != 0 || t.y != 0);
    final boxes = <(TableInfo, Rect)>[];
    for (var i = 0; i < tables.length; i++) {
      final tb = tables[i];
      final r = placed
          ? Rect.fromLTWH(tb.x.toDouble(), tb.y.toDouble(), tb.width.toDouble(), tb.height.toDouble())
          : Rect.fromLTWH((i % 6) * 3.0, (i ~/ 6) * 3.0, 2.6, 2.6);
      boxes.add((tb, r));
    }
    final minX = boxes.map((b) => b.$2.left).reduce(math.min);
    final minY = boxes.map((b) => b.$2.top).reduce(math.min);
    final maxX = boxes.map((b) => b.$2.right).reduce(math.max);
    final maxY = boxes.map((b) => b.$2.bottom).reduce(math.max);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: DecoratedBox(
        decoration: BoxDecoration(color: Tp.inkCard, borderRadius: BorderRadius.circular(16), border: Border.all(color: Tp.inkLine)),
        child: LayoutBuilder(builder: (context, box) {
          const pad = 16.0;
          final cell = math.min((box.maxWidth - pad * 2) / (maxX - minX), (box.maxHeight - pad * 2) / (maxY - minY));
          final offX = (box.maxWidth - (maxX - minX) * cell) / 2;
          final offY = (box.maxHeight - (maxY - minY) * cell) / 2;
          return Stack(children: [
            for (final (tb, r) in boxes)
              Positioned(
                left: offX + (r.left - minX) * cell + 3,
                top: offY + (r.top - minY) * cell + 3,
                width: r.width * cell - 6,
                height: r.height * cell - 6,
                child: _TableTile(table: tb, state: s.tableState(tb.id), bill: s.billForTable(tb.id), onTap: () => onOpen(tb)),
              ),
          ]);
        }),
      ),
    );
  }
}

class _TableTile extends StatelessWidget {
  const _TableTile({required this.table, required this.state, required this.bill, required this.onTap});
  final TableInfo table;
  final TableState state;
  final Bill? bill;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colour = Tp.stateColour(state);
    final free = state == TableState.free;
    final shape = table.round ? const CircleBorder() : RoundedRectangleBorder(borderRadius: BorderRadius.circular(14));
    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOut,
      decoration: ShapeDecoration(
        color: free ? Tp.inkRaised : colour.withValues(alpha: 0.16),
        shape: table.round
            ? CircleBorder(side: BorderSide(color: colour, width: 2))
            : RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: colour, width: 2)),
      ),
      child: Material(
        type: MaterialType.transparency,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(table.name, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                Text(Tp.stateName(state), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: colour)),
                if (bill != null) Money(bill!.dueMinor, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                Text(tableDetail(bill, table), style: const TextStyle(fontSize: 11, color: Tp.muted)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _TableList extends ConsumerWidget {
  const _TableList({super.key, required this.tables, required this.onOpen});
  final List<TableInfo> tables;
  final ValueChanged<TableInfo> onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    final t = Theme.of(context).textTheme;
    return GridView.builder(
      padding: const EdgeInsets.all(16),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 200, mainAxisSpacing: 12, crossAxisSpacing: 12, childAspectRatio: 1.15),
      itemCount: tables.length,
      itemBuilder: (_, i) {
        final table = tables[i];
        final state = s.tableState(table.id);
        final bill = s.billForTable(table.id);
        final colour = Tp.stateColour(state);
        return Card(
          child: InkWell(
            borderRadius: BorderRadius.circular(Tp.radius),
            onTap: () => onOpen(table),
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Container(width: 10, height: 10, decoration: BoxDecoration(color: colour, shape: BoxShape.circle)),
                  const SizedBox(width: 8),
                  Expanded(child: Text(table.name, style: t.titleLarge, overflow: TextOverflow.ellipsis)),
                ]),
                const SizedBox(height: 4),
                Text(Tp.stateName(state), style: t.bodyMedium?.copyWith(color: colour, fontWeight: FontWeight.w700)),
                const Spacer(),
                if (bill != null) Money(bill.dueMinor, style: t.titleMedium),
                Text(tableDetail(bill, table), style: t.bodySmall),
              ]),
            ),
          ),
        );
      },
    );
  }
}

/// A phone's tables: a round button per table, filled with its state's
/// colour so the room reads at a glance, the table's number in it and what
/// it owes under it.
class _TableDots extends ConsumerWidget {
  const _TableDots({super.key, required this.tables, required this.onOpen});
  final List<TableInfo> tables;
  final ValueChanged<TableInfo> onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    return GridView.builder(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 96, mainAxisSpacing: 14, crossAxisSpacing: 10, childAspectRatio: 0.78),
      itemCount: tables.length,
      itemBuilder: (_, i) {
        final table = tables[i];
        final state = s.tableState(table.id);
        final bill = s.billForTable(table.id);
        final colour = Tp.stateColour(state);
        final free = state == TableState.free;
        final short = (table.number ?? 0) > 0 ? '${table.number}' : table.name;
        return Semantics(
          button: true,
          label: '${table.name}, ${Tp.stateName(state)}',
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: () => onOpen(table),
            child: Column(children: [
              AspectRatio(
                aspectRatio: 1,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 300),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: free ? Tp.inkRaised : colour,
                    border: Border.all(color: colour, width: 2.5),
                    boxShadow: free ? null : [BoxShadow(color: colour.withValues(alpha: 0.35), blurRadius: 12)],
                  ),
                  alignment: Alignment.center,
                  child: Padding(
                    padding: const EdgeInsets.all(6),
                    child: FitText(short,
                        maxLines: 1,
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: free ? Colors.white : Tp.ink)),
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Text(bill != null ? money(bill.dueMinor) : Tp.stateName(state),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, fontFeatures: Tp.tabular, color: bill != null ? null : colour)),
            ]),
          ),
        );
      },
    );
  }
}
