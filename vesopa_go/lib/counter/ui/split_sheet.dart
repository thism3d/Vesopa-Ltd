/// Splitting a bill on Go, as the till does it (vesopa_epos split_bill_sheet)
/// and as Newbridge does (owner, 2026-11-07): items drain from the pool into
/// shares, one item moves back with minus or onto a share with plus, equal
/// shares are cards of [1/N] each item, a share can be a set amount, shares
/// carry names, and each has its own bill (with a QR code to pay it) and its
/// own Pay now. The back office's "Splitting a bill" options decide the rest.
///
/// The money: an item share costs its items at the bill's own rate
/// (bill_math.dart priceOfItems), and the last share is whatever the bill
/// still owes, so the shares always add up to the bill to the penny.
library;

import 'package:flutter/material.dart';

import '../../data/bill_math.dart';
import '../../data/go_options.dart';
import '../../data/models.dart';
import '../../ui/theme.dart';

enum GoSplitMethod { items, equally, amount }

/// One share: who, which items (units by line), or a set amount.
class GoShare {
  GoShare({this.name = '', Map<String, int>? items, this.amountMinor}) : items = items ?? {};
  String name;
  final Map<String, int> items;

  /// A set amount (equally, by amount); null for an item share.
  int? amountMinor;

  String labelOf(int index) => name.trim().isEmpty ? 'Share ${index + 1}' : name.trim();
}

/// What the clerk built, kept on the pay page so the next share is ready.
class GoSplitPlan {
  GoSplitPlan({this.method = GoSplitMethod.items, this.ways = 2});
  GoSplitMethod method;
  int ways;
  final List<GoShare> shares = [];
  final Set<int> paid = {};

  /// Each share's money, adding up to what the bill still owes.
  List<int> amounts(Bill bill) {
    final due = bill.dueMinor;
    switch (method) {
      case GoSplitMethod.equally:
        return splitEqually(due, ways);
      case GoSplitMethod.amount:
        final out = <int>[];
        var left = due;
        for (final s in shares) {
          final a = (s.amountMinor ?? 0).clamp(0, left);
          out.add(a);
          left -= a;
        }
        if (left > 0) out.add(left);
        return out;
      case GoSplitMethod.items:
        final out = [for (final s in shares) priceOfItems(bill, s.items)];
        final pooled = _poolCount(bill) > 0;
        if (out.isNotEmpty && !pooled) {
          // The last share takes what the bill still owes, so rounding at the
          // bill's rate can never leave a penny over or short.
          final before = out.take(out.length - 1).fold<int>(0, (a, b) => a + b);
          out[out.length - 1] = (due - before).clamp(0, due);
        } else if (pooled) {
          // What is still in the pool is a share of its own.
          out.add((due - out.fold<int>(0, (a, b) => a + b)).clamp(0, due));
        }
        return out;
    }
  }

  int count(Bill bill) => amounts(bill).length;

  int allocated(String lineId) => shares.fold<int>(0, (s, x) => s + (x.items[lineId] ?? 0));

  int _poolCount(Bill bill) =>
      bill.lines.fold<int>(0, (s, l) => s + (l.unpaidQuantity - allocated(l.id)).clamp(0, l.unpaidQuantity));

  String labelOf(int index) {
    if (index < shares.length) return shares[index].labelOf(index);
    return method == GoSplitMethod.items ? 'The rest' : 'Share ${index + 1}';
  }

  /// The items a share pays for ({} for an amount share): marked paid on the bill.
  Map<String, int> itemsOf(int index) =>
      method == GoSplitMethod.items && index < shares.length ? Map.of(shares[index].items) : const {};
}

/// What the sheet hands back: the plan, and the share to pay now (if any).
typedef GoSplitResult = ({GoSplitPlan plan, int? pay, int? print});

class GoSplitSheet extends StatefulWidget {
  const GoSplitSheet({super.key, required this.bill, required this.options, required this.plan});
  final Bill bill;
  final GoOptions options;
  final GoSplitPlan plan;

  @override
  State<GoSplitSheet> createState() => _GoSplitSheetState();
}

class _GoSplitSheetState extends State<GoSplitSheet> {
  GoSplitPlan get _p => widget.plan;
  Bill get _bill => widget.bill;

  /// Units picked in the pool, by line.
  final Map<String, int> _picked = {};

  bool get _locked => _p.paid.isNotEmpty;

  List<BillLine> get _open => [for (final l in _bill.lines) if (l.unpaidQuantity > 0) l];

  int _left(BillLine l) => l.unpaidQuantity - _p.allocated(l.id);

  void _pick(BillLine l) => setState(() {
        final n = (_picked[l.id] ?? 0) + 1;
        if (n > _left(l)) {
          _picked.remove(l.id);
        } else {
          _picked[l.id] = n;
        }
      });

  void _splitOff() => setState(() {
        _p.shares.add(GoShare(items: Map.of(_picked)));
        _picked.clear();
      });

  void _addPicked(int i) => setState(() {
        for (final e in _picked.entries) {
          _p.shares[i].items[e.key] = (_p.shares[i].items[e.key] ?? 0) + e.value;
        }
        _picked.clear();
      });

  void _minus(int i, String lineId) => setState(() {
        final n = (_p.shares[i].items[lineId] ?? 0) - 1;
        if (n <= 0) {
          _p.shares[i].items.remove(lineId);
        } else {
          _p.shares[i].items[lineId] = n;
        }
        if (_p.shares[i].items.isEmpty) _p.shares.removeAt(i);
      });

  Future<void> _rename(int i) async {
    while (_p.shares.length <= i) {
      _p.shares.add(GoShare());
    }
    final field = TextEditingController(text: _p.shares[i].name);
    final name = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Who is share ${i + 1}?'),
        content: TextField(
          controller: field,
          autofocus: true,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(hintText: 'A name, such as Carys'),
          onSubmitted: (v) => Navigator.pop(c, v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, field.text), child: const Text('Save')),
        ],
      ),
    );
    if (name != null && mounted) setState(() => _p.shares[i].name = name.trim());
  }

  Future<void> _addAmount() async {
    final field = TextEditingController();
    final typed = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('How much does this person pay?'),
        content: TextField(
          controller: field,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(prefixText: '£ '),
          onSubmitted: (v) => Navigator.pop(c, v),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, field.text), child: const Text('Add')),
        ],
      ),
    );
    final m = RegExp(r'^\s*(\d+)(?:\.(\d{1,2}))?\s*$').firstMatch((typed ?? '').replaceAll('£', ''));
    if (m == null || !mounted) return;
    final minor = int.parse(m.group(1)!) * 100 + int.parse((m.group(2) ?? '0').padRight(2, '0'));
    final set = _p.shares.fold<int>(0, (s, x) => s + (x.amountMinor ?? 0));
    if (minor <= 0 || set + minor >= _bill.dueMinor) return;
    setState(() => _p.shares.add(GoShare(amountMinor: minor)));
  }

  void _method(GoSplitMethod m) => setState(() {
        _p.method = m;
        _p.shares.clear();
        _picked.clear();
      });

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final amounts = _p.amounts(_bill);
    final wide = MediaQuery.sizeOf(context).width >= 700;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Split the bill'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: Center(child: Text('${money(_bill.dueMinor)} to pay', style: t.titleSmall)),
          ),
        ],
      ),
      body: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: SegmentedButton<GoSplitMethod>(
            segments: [
              const ButtonSegment(value: GoSplitMethod.items, icon: Icon(Icons.checklist_rounded), label: Text('By item')),
              const ButtonSegment(value: GoSplitMethod.equally, icon: Icon(Icons.pie_chart_outline_rounded), label: Text('Equally')),
              if (widget.options.splitByAmount)
                const ButtonSegment(value: GoSplitMethod.amount, icon: Icon(Icons.payments_outlined), label: Text('By amount')),
            ],
            selected: {_p.method},
            onSelectionChanged: _locked ? null : (v) => _method(v.first),
          ),
        ),
        Expanded(
          child: switch (_p.method) {
            GoSplitMethod.items => wide
                ? Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    SizedBox(width: 320, child: _pool(t)),
                    Expanded(child: _cards(amounts)),
                  ])
                : ListView(children: [SizedBox(height: 320, child: _pool(t)), _cards(amounts, scroll: false)]),
            GoSplitMethod.equally => ListView(padding: const EdgeInsets.all(16), children: [
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (var n = 2; n <= 10; n++)
                    ChoiceChip(label: Text('$n ways'), selected: _p.ways == n, onSelected: _locked ? null : (_) => setState(() => _p.ways = n)),
                ]),
                const SizedBox(height: 12),
                _cards(amounts, scroll: false),
              ]),
            GoSplitMethod.amount => ListView(padding: const EdgeInsets.all(16), children: [
                Row(children: [
                  const Expanded(child: Text('A set amount for each person who pays one. What is left is the last share.')),
                  FilledButton.icon(onPressed: _locked ? null : _addAmount, icon: const Icon(Icons.add_rounded), label: const Text('Add an amount')),
                ]),
                const SizedBox(height: 12),
                _cards(amounts, scroll: false),
              ]),
          },
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: Wrap(spacing: 10, runSpacing: 8, alignment: WrapAlignment.end, children: [
              if (!_locked && (_p.shares.isNotEmpty))
                TextButton.icon(
                  onPressed: () => setState(() {
                    _p.shares.clear();
                    _picked.clear();
                  }),
                  icon: const Icon(Icons.undo_rounded),
                  label: const Text('Undo split'),
                ),
              if (widget.options.splitPrintAll && amounts.length >= 2)
                OutlinedButton.icon(
                  onPressed: () => Navigator.pop(context, (plan: _p, pay: null, print: -1)),
                  icon: const Icon(Icons.print_rounded),
                  label: Text('Print all ${amounts.length}'),
                ),
              FilledButton(onPressed: () => Navigator.pop(context, (plan: _p, pay: null, print: null)), child: const Text('Done')),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _pool(TextTheme t) => Card(
        margin: const EdgeInsets.fromLTRB(16, 0, 8, 8),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ListTile(title: const Text('Not split yet', style: TextStyle(fontWeight: FontWeight.w700)), dense: true, tileColor: context.goRaised),
          Expanded(
            child: ListView(children: [
              for (final l in _open)
                if (_left(l) > 0)
                  ListTile(
                    dense: true,
                    onTap: _locked ? null : () => _pick(l),
                    leading: Icon((_picked[l.id] ?? 0) > 0 ? Icons.check_circle_rounded : Icons.circle_outlined,
                        color: (_picked[l.id] ?? 0) > 0 ? context.goLimeInk : context.goMuted),
                    title: Text(l.product.name),
                    subtitle: _left(l) > 1 ? Text('${_picked[l.id] ?? 0} of ${_left(l)} picked · tap for one more') : null,
                    trailing: Text(money(l.unitMinor * _left(l))),
                  ),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.all(10),
            child: FilledButton.icon(
              onPressed: _picked.isEmpty || _locked ? null : _splitOff,
              icon: const Icon(Icons.call_split_rounded),
              label: Text(_picked.isEmpty ? 'Pick items to split off' : 'Split off ${_picked.values.fold<int>(0, (a, b) => a + b)}'),
            ),
          ),
        ]),
      );

  Widget _cards(List<int> amounts, {bool scroll = true}) {
    final cards = Wrap(spacing: 12, runSpacing: 12, children: [
      for (var i = 0; i < amounts.length; i++) _card(i, amounts[i], amounts.length),
    ]);
    if (amounts.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          _p.method == GoSplitMethod.amount ? 'Add the first amount.' : 'Pick items on the left and split them off.',
          textAlign: TextAlign.center,
          style: TextStyle(color: context.goMuted),
        ),
      );
    }
    return scroll ? SingleChildScrollView(padding: const EdgeInsets.fromLTRB(8, 0, 16, 8), child: cards) : cards;
  }

  Widget _card(int i, int amount, int count) {
    final paid = _p.paid.contains(i);
    final itemShare = _p.method == GoSplitMethod.items && i < _p.shares.length;
    final rest = _p.method == GoSplitMethod.items && i >= _p.shares.length;
    return SizedBox(
      width: 290,
      child: Card(
        margin: EdgeInsets.zero,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            dense: true,
            title: Text(_p.labelOf(i), style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            subtitle: Text(paid ? 'Paid' : (rest ? 'Whatever is left' : '${i + 1} of $count')),
            onTap: widget.options.splitNames && !rest ? () => _rename(i) : null,
            trailing: itemShare && _picked.isNotEmpty && !_locked
                ? IconButton(icon: Icon(Icons.add_circle_rounded, color: context.goLimeInk), tooltip: 'Add the picked items here', onPressed: () => _addPicked(i))
                : (_p.method == GoSplitMethod.amount && i < _p.shares.length && !_locked
                    ? IconButton(icon: const Icon(Icons.remove_circle_outline_rounded, color: Tp.danger), onPressed: () => setState(() => _p.shares.removeAt(i)))
                    : null),
          ),
          if (itemShare)
            for (final e in _p.shares[i].items.entries)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 8, 2),
                child: Row(children: [
                  Expanded(child: Text('${e.value} x ${_bill.lines.firstWhere((l) => l.id == e.key).product.name}')),
                  Text(money(_bill.lines.firstWhere((l) => l.id == e.key).unitMinor * e.value)),
                  if (!_locked)
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      icon: const Icon(Icons.remove_circle_outline_rounded, color: Tp.danger, size: 20),
                      tooltip: 'One back to the pool',
                      onPressed: () => _minus(i, e.key),
                    ),
                ]),
              ),
          if (_p.method == GoSplitMethod.equally)
            for (final l in _bill.lines)
              if (l.unpaidQuantity > 0)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 2),
                  child: Row(children: [
                    Text('[1/$count] ', style: TextStyle(color: context.goLimeInk, fontWeight: FontWeight.w700, fontSize: 12.5)),
                    Expanded(child: Text(l.product.name)),
                  ]),
                ),
          Container(
            color: context.goRaised,
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: Row(children: [
              const Expanded(child: Text('Total')),
              Text(money(amount), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
            child: Row(children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => Navigator.pop(context, (plan: _p, pay: null, print: i)),
                  icon: const Icon(Icons.print_rounded, size: 18),
                  label: const Text('Bill'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton.icon(
                  onPressed: paid || amount <= 0 ? null : () => Navigator.pop(context, (plan: _p, pay: i, print: null)),
                  icon: const Icon(Icons.payments_outlined, size: 18),
                  label: const Text('Pay now'),
                ),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}
