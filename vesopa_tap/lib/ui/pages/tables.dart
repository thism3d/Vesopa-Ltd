/// The floor: every table, its state in one colour, by area.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../data/session.dart';
import '../theme.dart';
import 'order.dart';

class TablesPage extends ConsumerStatefulWidget {
  const TablesPage({super.key});
  @override
  ConsumerState<TablesPage> createState() => _TablesPageState();
}

class _TablesPageState extends ConsumerState<TablesPage> {
  String? _area;

  Future<void> _open(TableInfo table) async {
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
          content: const Text('Take it over here? It moves to this phone, and the till can no longer settle it.'),
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
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => OrderPage(billId: bill!.id)));
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
                for (var n = 1; n <= 10; n++)
                  SizedBox(width: 64, height: 56, child: OutlinedButton(onPressed: () => Navigator.pop(c, n), child: Text('$n'))),
              ]),
            ]),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final areas = {for (final t in s.tables) t.area}.toList();
    final area = _area ?? (areas.isEmpty ? null : areas.first);
    final tables = s.tables.where((t) => t.area == area).toList();
    final t = Theme.of(context).textTheme;
    if (s.tables.isEmpty) {
      return Center(child: Padding(
        padding: const EdgeInsets.all(32),
        child: Text('No tables yet. Draw the floor plan in the back office and it appears here.', textAlign: TextAlign.center, style: t.bodyLarge),
      ));
    }
    return Column(children: [
      SizedBox(
        height: 56,
        child: ListView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          children: [
            for (final a in areas)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                child: ChoiceChip(label: Text(a), selected: a == area, onSelected: (_) => setState(() => _area = a)),
              ),
          ],
        ),
      ),
      Expanded(
        child: GridView.builder(
          padding: const EdgeInsets.all(16),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 180, mainAxisSpacing: 12, crossAxisSpacing: 12, childAspectRatio: 1.05),
          itemCount: tables.length,
          itemBuilder: (_, i) {
            final table = tables[i];
            final state = s.tableState(table.id);
            final bill = s.billForTable(table.id);
            final colour = Tp.stateColour(state);
            return Card(
              child: InkWell(
                borderRadius: BorderRadius.circular(Tp.radius),
                onTap: () => _open(table),
                child: Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(Tp.radius),
                    border: Border(left: BorderSide(color: colour, width: 6)),
                  ),
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(table.name, style: t.titleLarge),
                    const SizedBox(height: 4),
                    Text(Tp.stateName(state), style: t.bodyMedium?.copyWith(color: colour, fontWeight: FontWeight.w700)),
                    const Spacer(),
                    if (bill != null) ...[
                      Money(bill.dueMinor, style: t.titleMedium),
                      Text('${bill.covers} covers · ${bill.clerk}', style: t.bodySmall),
                    ] else
                      Text('${table.seats} seats', style: t.bodySmall),
                  ]),
                ),
              ),
            );
          },
        ),
      ),
    ]);
  }
}
