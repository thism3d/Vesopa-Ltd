/// The kitchen screen's Stock tab (2026-09-27).
///
/// What this station can still make, from the back office's ledger; Sold out
/// (the QR menu's own switch) one tap away; and wastage recorded where it
/// happens, by the case or the unit. Only this screen's dishes -- the ones
/// that print to its stations -- and the ingredients their recipes take, so
/// the grill does not scroll past the bar's bottles.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/kitchen_stock.dart';
import '../data/providers.dart';
import 'open_board.dart' show EmptyBoard;
import 'theme.dart';

class StockBoard extends ConsumerStatefulWidget {
  const StockBoard({super.key});
  @override
  ConsumerState<StockBoard> createState() => _StockBoardState();
}

class _StockBoardState extends ConsumerState<StockBoard> {
  bool _attentionOnly = true;
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final skin = Kds.of(context);
    final st = ref.watch(kitchenStockProvider);
    final stations = ref.watch(kitchenSessionProvider).value?.screen.stations ?? const <String>{};

    // This screen's dishes, and what goes into them.
    final mine = stations.isEmpty
        ? st.items
        : st.items.where((i) => i.routes.isEmpty ? false : i.routes.any(stations.contains)).toList();
    final ingredientNames = {for (final d in mine) for (final m in d.recipe) m.name.toLowerCase()};
    final relevant = {
      ...mine,
      ...st.items.where((i) => ingredientNames.contains(i.name.toLowerCase())),
    }.toList()
      ..sort((a, b) {
        int rank(KitchenStockItem i) => i.soldOut ? 0 : (i.canMake != null && i.canMake! <= 0) ? 1 : i.level == 'low' ? 2 : 3;
        final r = rank(a) - rank(b);
        return r != 0 ? r : a.name.toLowerCase().compareTo(b.name.toLowerCase());
      });
    final shown = relevant
        .where((i) => (!_attentionOnly || i.needsAttention) && (_q.isEmpty || i.name.toLowerCase().contains(_q.toLowerCase())))
        .toList();

    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
        child: Row(children: [
          Text('Stock', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(width: 16),
          SegmentedButton<bool>(
            key: const Key('stock-attention'),
            segments: const [ButtonSegment(value: true, label: Text('Needs attention')), ButtonSegment(value: false, label: Text('Everything'))],
            selected: {_attentionOnly},
            onSelectionChanged: (v) => setState(() => _attentionOnly = v.first),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 260,
            child: TextField(
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Find a dish', isDense: true, border: OutlineInputBorder()),
              onChanged: (v) => setState(() => _q = v.trim()),
            ),
          ),
          const Spacer(),
          if (st.error != null) Text(st.error!, style: TextStyle(color: Kds.late, fontSize: 13)),
          IconButton(tooltip: 'Refresh', onPressed: () => ref.read(kitchenStockProvider.notifier).refresh(), icon: const Icon(Icons.refresh)),
        ]),
      ),
      Expanded(
        child: !st.loaded
            ? const Center(child: CircularProgressIndicator())
            : shown.isEmpty
                ? EmptyBoard(
                    icon: Icons.inventory_2_outlined,
                    title: _attentionOnly ? 'Nothing running low' : 'No stock kept for this screen',
                    message: _attentionOnly
                        ? 'Dishes that are low, sold out or cannot be made show here. Switch to Everything to see the rest.'
                        : 'Give products a count in the back office (Stock Control) and they appear here.',
                  )
                : ListView.separated(
                    key: const Key('stock-list'),
                    padding: const EdgeInsets.fromLTRB(14, 6, 14, 20),
                    itemCount: shown.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 8),
                    itemBuilder: (_, i) => _StockRow(item: shown[i], skin: skin),
                  ),
      ),
    ]);
  }
}

class _StockRow extends ConsumerWidget {
  const _StockRow({required this.item, required this.skin});
  final KitchenStockItem item;
  final KdsSkin skin;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final left = item.canMake;
    final out = item.soldOut || (left != null && left <= 0);
    final colour = out ? Kds.late : item.level == 'low' ? Kds.warn : skin.inkMuted;
    return Container(
      key: Key('stock-row-${item.pluId}'),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(color: skin.card, borderRadius: BorderRadius.circular(10)),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(item.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
            if (item.recipe.isNotEmpty)
              Text(item.recipe.map((m) => m.label).join(' · '), style: TextStyle(fontSize: 13, color: skin.inkMuted)),
          ]),
        ),
        Text(
          item.soldOut ? 'Sold out' : left == null ? 'Not counted' : '${fmtQty(left)} left',
          key: Key('stock-left-${item.pluId}'),
          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: colour),
        ),
        const SizedBox(width: 16),
        if (item.onMenu)
          Row(mainAxisSize: MainAxisSize.min, children: [
            const Text('Sold out'),
            Switch(
              key: Key('sold-out-${item.pluId}'),
              value: item.soldOut,
              onChanged: (v) => _run(context, () => ref.read(kitchenStockProvider.notifier).setSoldOut(item, v),
                  v ? '${item.name} is sold out on the QR menu and kiosk.' : '${item.name} is back on.'),
            ),
          ]),
        const SizedBox(width: 8),
        OutlinedButton.icon(
          key: Key('waste-${item.pluId}'),
          onPressed: () async {
            final r = await showDialog<({double qty, String reason})>(context: context, builder: (_) => _WasteDialog(item: item));
            if (r == null || !context.mounted) return;
            await _run(context, () => ref.read(kitchenStockProvider.notifier).waste(item, r.qty, r.reason),
                '${fmtQty(r.qty)} ${item.name} recorded as wastage.');
          },
          icon: const Icon(Icons.delete_sweep_outlined),
          label: const Text('Waste'),
        ),
      ]),
    );
  }

  Future<void> _run(BuildContext context, Future<void> Function() action, String done) async {
    final messenger = ScaffoldMessenger.maybeOf(context);
    try {
      await action();
      messenger?.showSnackBar(SnackBar(content: Text(done)));
    } catch (e) {
      messenger?.showSnackBar(SnackBar(content: Text('$e'), backgroundColor: Kds.late));
    }
  }
}

class _WasteDialog extends StatefulWidget {
  const _WasteDialog({required this.item});
  final KitchenStockItem item;
  @override
  State<_WasteDialog> createState() => _WasteDialogState();
}

class _WasteDialogState extends State<_WasteDialog> {
  final _cases = TextEditingController();
  final _units = TextEditingController(text: '1');
  String _reason = 'Dropped';
  static const _reasons = ['Dropped', 'Burnt', 'Out of date', 'Sent back', 'Staff meal'];

  @override
  void dispose() {
    _cases.dispose();
    _units.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final total = joinQty(item.hasCase ? _cases.text : '', _units.text, item.packUnits);
    final digits = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))];
    return AlertDialog(
      title: Text('Waste ${item.name}'),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          if (item.hasCase) ...[
            Expanded(
              child: TextField(
                key: const Key('waste-cases'),
                controller: _cases,
                inputFormatters: digits,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(labelText: 'Cases (${item.packName} = ${fmtQty(item.packUnits!)})', border: const OutlineInputBorder()),
                onChanged: (_) => setState(() {}),
              ),
            ),
            const SizedBox(width: 10),
          ],
          Expanded(
            child: TextField(
              key: const Key('waste-units'),
              controller: _units,
              inputFormatters: digits,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Units', border: OutlineInputBorder()),
              onChanged: (_) => setState(() {}),
            ),
          ),
        ]),
        if (item.hasCase && total != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('= ${fmtQty(total)} units')),
        const SizedBox(height: 12),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final r in _reasons) ChoiceChip(label: Text(r), selected: _reason == r, onSelected: (_) => setState(() => _reason = r)),
        ]),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          key: const Key('waste-ok'),
          onPressed: total == null || total <= 0 ? null : () => Navigator.pop(context, (qty: total, reason: _reason)),
          child: const Text('Record wastage'),
        ),
      ],
    );
  }
}
