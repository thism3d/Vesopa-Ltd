/// Stock, on the till (2026-09-27).
///
/// "All the features must reflect to the till as well." The back office's
/// Stock Control documents -- stock takes, spot checks, wastage and
/// adjustments -- done at the counter or in the cellar on the till itself,
/// against the same server ledger (`/till/stock/...`):
///
///   * the product box lists products as soon as it is tapped;
///   * many products at once, a whole department or sub-department, or
///     every stock item (a case size, not non-stock) for a full count;
///   * a count is laid out by sub-department, with a heading for each;
///   * every line shows its case size and can change it there and then;
///   * quantities go in as cases, units, or both -- the ledger gets units;
///   * a count sheet, or the finished document, prints on the receipt
///     printer.
///
/// Nothing is kept on the till: Complete writes the document to the server
/// and applies it in one step, so the back office sees it the moment it is
/// done. Without the network the page says so and changes nothing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/staff_session.dart';
import '../data/stock_api.dart';
import '../data/till_permissions.dart';
import '../main.dart';
import '../printing/print_service.dart';
import '../printing/receipt_builder.dart';
import 'permission_gate.dart';
import 'printers_page.dart' show printerSettingsProvider;
import 'stock_widgets.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';

String _money(int minor) => NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

class StockPage extends ConsumerStatefulWidget {
  const StockPage({super.key});

  @override
  ConsumerState<StockPage> createState() => _StockPageState();
}

class _StockPageState extends ConsumerState<StockPage> {
  StockDocKind _kind = StockDocKind.stocktake;
  List<StockProduct> _products = const [];
  List<PackSize> _packs = const [];
  bool _loading = true;
  String? _error;
  bool _busy = false;

  /// Nobody at the till may use any of it (and no manager said yes).
  bool _locked = false;

  /// One document in progress per kind, so switching tab loses nothing.
  final Map<StockDocKind, List<StockLine>> _lines = {for (final k in StockDocKind.values) k: <StockLine>[]};
  final Map<StockDocKind, TextEditingController> _notes = {for (final k in StockDocKind.values) k: TextEditingController()};

  List<StockLine> get _doc => _lines[_kind]!;

  @override
  void initState() {
    super.initState();
    _load();
    WidgetsBinding.instance.addPostFrameCallback((_) => _gate());
  }

  /// On the way in: a count is a manager's; wastage has its own key. Somebody
  /// with only the wastage key lands on Wastage.
  Future<void> _gate() async {
    if (!mounted) return;
    final staff = ref.read(staffSessionProvider).staff;
    final perms = staff == null ? null : TillPermissions.parse(staff.permissions);
    if (perms == null || perms.can(TillPermission.isManager)) return;
    if (perms.can(TillPermission.wastage)) {
      setState(() => _kind = StockDocKind.wastage);
      return;
    }
    if (await allowed(context, ref, TillPermission.isManager)) return;
    if (mounted) setState(() => _locked = true);
  }

  @override
  void dispose() {
    for (final c in _notes.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = ref.read(stockApiProvider);
      final results = await Future.wait([api.products(), api.packSizes()]);
      if (!mounted) return;
      setState(() {
        _products = results[0] as List<StockProduct>;
        _packs = results[1] as List<PackSize>;
        _loading = false;
        // Lines keep what was typed but take the product's fresh details.
        for (final lines in _lines.values) {
          for (var i = 0; i < lines.length; i++) {
            final fresh = _products.where((p) => p.pluId == lines[i].product.pluId).firstOrNull;
            if (fresh != null) lines[i] = _carry(lines[i], fresh);
          }
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '$e';
      });
    }
  }

  StockLine _carry(StockLine old, StockProduct fresh) => StockLine(fresh)
    ..cases = fresh.hasCase ? old.cases : ''
    ..units = fresh.hasCase || old.cases.trim().isEmpty
        ? old.units
        : fmtQty(joinQty(old.cases, old.units, old.product.packUnits) ?? 0)
    ..reason = old.reason
    ..takeOff = old.takeOff;

  void _add(Iterable<StockProduct> products) {
    final on = {for (final l in _doc) l.product.pluId};
    var added = 0;
    var already = 0;
    for (final p in products) {
      if (on.contains(p.pluId)) {
        already++;
        continue;
      }
      _doc.add(StockLine(p));
      on.add(p.pluId);
      added++;
    }
    if (_kind.counting) sortForCount(_doc);
    setState(() {});
    if (added + already > 1) {
      PosMessenger.info(context, 'Added $added product${added == 1 ? '' : 's'}${already > 0 ? ' · $already already on it' : ''}.');
    }
  }

  Future<void> _changeCase(StockLine line, int? packId) async {
    try {
      await ref.read(stockApiProvider).patchProduct(line.product.id, {'pack_size_id': packId});
      await _load();
      if (!mounted) return;
      final now = _products.where((p) => p.pluId == line.product.pluId).firstOrNull;
      PosMessenger.success(context, '${line.product.name}: case size ${packId == null ? 'removed' : 'now ${now?.packName ?? ''}'}.');
    } catch (e) {
      if (mounted) PosMessenger.error(context, '$e');
    }
  }

  Future<void> _complete() async {
    // Practice never moves real stock, as practice never books a real sale.
    if (ref.read(staffSessionProvider).staff?.training ?? false) {
      return PosMessenger.error(context, 'Not in training mode. Stock takes, wastage and adjustments change the real stock, so practice cannot complete one.');
    }
    if (_doc.isEmpty) return PosMessenger.error(context, 'Add at least one product.');
    final missing = _doc.where((l) => l.quantity == null).toList();
    if (missing.isNotEmpty) {
      return PosMessenger.error(context, '${missing.first.product.name}: give a ${_kind.counting ? 'count' : 'quantity'}.');
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Complete this ${_kind.title.toLowerCase()}?'),
        content: Text(_kind.counting
            ? 'Set the count of ${_doc.length} product${_doc.length == 1 ? '' : 's'} to what you typed? The difference goes on the stock ledger.'
            : 'Apply this ${_kind.title.toLowerCase()} to the stock ledger? ${_doc.length} product${_doc.length == 1 ? '' : 's'} will move.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(key: const Key('stock-confirm'), onPressed: () => Navigator.pop(context, true), child: const Text('Complete')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _busy = true);
    try {
      final r = await ref.read(stockApiProvider).createDoc(kind: _kind, lines: _doc, notes: _notes[_kind]!.text);
      if (!mounted) return;
      final printed = List<StockLine>.of(_doc);
      setState(() {
        _doc.clear();
        _notes[_kind]!.clear();
      });
      PosMessenger.success(context, r['completed'] == true ? '${_kind.title} completed and applied to stock.' : '${_kind.title} saved.');
      _offerPrint(printed);
      await _load();
    } catch (e) {
      if (mounted) PosMessenger.error(context, '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _offerPrint(List<StockLine> done) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Print a copy?'),
        content: const Text('A record of what was completed, on the receipt printer.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('No')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Print')),
        ],
      ),
    );
    if (yes == true) await _print(done, blank: false);
  }

  /// A count sheet (blank figures) or a record of a document.
  Future<void> _print(List<StockLine> lines, {required bool blank}) async {
    if (lines.isEmpty) return PosMessenger.error(context, 'Nothing to print yet.');
    final bySection = <String, List<({String label, String value})>>{};
    for (final l in lines) {
      final q = l.quantity;
      bySection.putIfAbsent(l.product.shelf, () => []).add((
        label: '${l.product.name}${l.product.hasCase ? ' (${l.product.caseLabel})' : ''}',
        value: blank ? '______' : (q == null ? '' : qtyWords(q, l.product.packUnits)),
      ));
    }
    try {
      final printers = await ref.read(printerSettingsProvider.future);
      final branding = ref.read(brandingProvider);
      final service = PrintService(
        await ReceiptBuilder.create(paperWidthMm: printers.receiptWidthMm),
        PrinterSetup(
          printers: printers,
          shopName: branding.venueName.isNotEmpty ? branding.venueName : ref.read(sessionProvider).venueName,
          footer: branding.footerMessage,
          logo: null,
        ),
      );
      await service.printStockSheet(
        title: blank ? '${_kind.title} count sheet' : _kind.title,
        subtitle: ref.read(servedByProvider),
        sections: [for (final e in bySection.entries) (heading: e.key, rows: e.value)],
        footer: [if (!blank) '${lines.length} line${lines.length == 1 ? '' : 's'} · applied to stock'],
      );
      if (mounted) PosMessenger.success(context, 'Printed.');
    } catch (e) {
      if (mounted) PosMessenger.error(context, 'Could not print: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            Text('Stock', style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(width: 16),
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: SegmentedButton<StockDocKind>(
                  key: const Key('stock-kinds'),
                  segments: [for (final k in StockDocKind.values) ButtonSegment(value: k, label: Text(k.title))],
                  selected: {_kind},
                  onSelectionChanged: (s) => _switchTo(s.first),
                ),
              ),
            ),
            IconButton(tooltip: 'Refresh', onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh)),
          ]),
          const SizedBox(height: 12),
          Expanded(child: _body(theme)),
        ],
      ),
    );
  }

  Future<void> _switchTo(StockDocKind kind) async {
    // Wastage has its own till permission; the rest are a manager's.
    final need = kind == StockDocKind.wastage ? TillPermission.wastage : TillPermission.isManager;
    if (!await allowed(context, ref, need)) return;
    setState(() => _kind = kind);
  }

  Widget _body(ThemeData theme) {
    if (_locked) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.lock_outline, size: 48),
          const SizedBox(height: 8),
          const Text('Stock needs a manager, or the wastage key for Wastage.'),
          const SizedBox(height: 12),
          FilledButton(onPressed: () { setState(() => _locked = false); _gate(); }, child: const Text('Ask a manager')),
        ]),
      );
    }
    if (_loading && _products.isEmpty) return const Center(child: CircularProgressIndicator());
    if (_error != null && _products.isEmpty) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.cloud_off, size: 48),
          const SizedBox(height: 8),
          Text(_error!, textAlign: TextAlign.center),
          const SizedBox(height: 12),
          FilledButton(onPressed: _load, child: const Text('Try again')),
        ]),
      );
    }
    final lines = _doc;
    final value = lines.fold<double>(0, (a, l) {
      final q = l.quantity ?? 0;
      final moved = _kind.counting ? q - (l.product.stock ?? 0) : q;
      return a + moved * l.product.unitCostMinor;
    });
    final depts = {for (final p in _products) if (!_kind.counting || p.stockItem) p.department}.toList()..sort();
    final shelves = {for (final p in _products) if (p.group != null && (!_kind.counting || p.stockItem)) p.shelf}.toList()..sort();

    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
        SizedBox(
          width: 420,
          child: ProductFinder(
            products: _products,
            exclude: {for (final l in lines) l.product.pluId},
            stockFirst: _kind.counting,
            onPick: (p) => _add([p]),
          ),
        ),
        FilledButton.icon(
          key: const Key('stock-choose'),
          onPressed: () async {
            final chosen = await showProductChooser(
              context,
              products: _products,
              exclude: {for (final l in lines) l.product.pluId},
              stockOnly: _kind.counting,
              title: 'Add to ${_kind.title.toLowerCase()}',
            );
            if (chosen.isNotEmpty) _add(chosen);
          },
          icon: const Icon(Icons.checklist),
          label: const Text('Choose products'),
        ),
        if (_kind.counting) ...[
          OutlinedButton(
            key: const Key('stock-add-all'),
            onPressed: () {
              final items = _products.where((p) => p.stockItem).toList();
              if (items.isEmpty) {
                return PosMessenger.error(context, 'No stock items yet — give products a case size first.');
              }
              _add(items);
            },
            child: const Text('Add all stock items'),
          ),
          _AddGroup(label: 'Add a department', options: depts, onPick: (d) => _add(_products.where((p) => p.department == d && p.stockItem))),
          _AddGroup(label: 'Add a sub-department', options: shelves, onPick: (s) => _add(_products.where((p) => p.shelf == s && p.stockItem))),
        ],
      ]),
      const SizedBox(height: 8),
      TextField(
        controller: _notes[_kind],
        decoration: InputDecoration(
          labelText: 'Notes',
          hintText: _kind.counting ? 'Sunday count, cellar only…' : 'What happened',
          isDense: true,
          border: const OutlineInputBorder(),
        ),
      ),
      const SizedBox(height: 8),
      Expanded(
        child: lines.isEmpty
            ? Center(
                child: Text(
                  _kind.counting
                      ? 'Tap the box above to add products, or add a department, a sub-department or every stock item.'
                      : 'Tap the box above to add what was ${_kind == StockDocKind.wastage ? 'wasted' : 'found or lost'}.',
                  textAlign: TextAlign.center,
                ),
              )
            : _lineList(theme, lines),
      ),
      const Divider(),
      Row(children: [
        Text('${lines.length} line${lines.length == 1 ? '' : 's'} · ${_kind == StockDocKind.wastage ? 'cost' : 'value'} ${_money(value.abs().round())}'),
        const Spacer(),
        if (_kind.counting)
          OutlinedButton.icon(
            key: const Key('stock-print-sheet'),
            onPressed: lines.isEmpty ? null : () => _print(lines, blank: true),
            icon: const Icon(Icons.print),
            label: const Text('Print count sheet'),
          ),
        const SizedBox(width: 8),
        if (lines.isNotEmpty)
          TextButton(onPressed: () => setState(lines.clear), child: const Text('Clear')),
        const SizedBox(width: 8),
        FilledButton(
          key: const Key('stock-complete'),
          onPressed: _busy || lines.isEmpty ? null : _complete,
          child: Text(_busy ? 'Saving…' : 'Complete'),
        ),
      ]),
    ]);
  }

  Widget _lineList(ThemeData theme, List<StockLine> lines) {
    final children = <Widget>[];
    String? lastShelf;
    for (final line in lines) {
      if (_kind.counting && line.product.shelf != lastShelf) {
        lastShelf = line.product.shelf;
        final n = lines.where((l) => l.product.shelf == lastShelf).length;
        children.add(Container(
          key: Key('shelf-$lastShelf'),
          color: theme.colorScheme.surfaceContainerHighest,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Text('${lastShelf.toUpperCase()}   $n line${n == 1 ? '' : 's'}',
              style: theme.textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w700)),
        ));
      }
      children.add(_LineRow(
        key: ValueKey('line-${_kind.key}-${line.product.pluId}'),
        kind: _kind,
        line: line,
        packs: _packs,
        onChanged: () => setState(() {}),
        onCase: (id) => _changeCase(line, id),
        onRemove: () => setState(() => lines.remove(line)),
      ));
    }
    return ListView(key: const Key('stock-lines'), children: children);
  }
}

class _AddGroup extends StatelessWidget {
  const _AddGroup({required this.label, required this.options, required this.onPick});
  final String label;
  final List<String> options;
  final ValueChanged<String> onPick;
  @override
  Widget build(BuildContext context) => PopupMenuButton<String>(
        key: Key('stock-$label'),
        onSelected: onPick,
        itemBuilder: (_) => [for (final o in options) PopupMenuItem(value: o, child: Text(o))],
        child: Chip(label: Text(label), avatar: const Icon(Icons.add, size: 18)),
      );
}

class _LineRow extends StatelessWidget {
  const _LineRow({
    super.key,
    required this.kind,
    required this.line,
    required this.packs,
    required this.onChanged,
    required this.onCase,
    required this.onRemove,
  });

  final StockDocKind kind;
  final StockLine line;
  final List<PackSize> packs;
  final VoidCallback onChanged;
  final ValueChanged<int?> onCase;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final p = line.product;
    final theme = Theme.of(context);
    final q = line.quantity;
    final expected = p.stock ?? 0;
    final diff = q == null ? null : q - expected;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: theme.dividerColor))),
      child: Row(children: [
        Expanded(
          flex: 3,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(p.name, style: const TextStyle(fontWeight: FontWeight.w700)),
            Text('PLU ${p.pluId}${kind.counting ? '' : ' · ${p.shelf}'}', style: theme.textTheme.bodySmall),
          ]),
        ),
        Expanded(flex: 2, child: CaseSizeDropdown(product: p, packs: packs, onChanged: onCase)),
        if (kind.counting)
          SizedBox(
            width: 110,
            child: Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Text(p.tracked ? fmtQty(expected) : 'Not tracked', key: Key('expected-${p.pluId}')),
              if (p.tracked && p.hasCase) Text(qtyWords(expected, p.packUnits), style: theme.textTheme.bodySmall),
            ]),
          ),
        const SizedBox(width: 12),
        if (kind.signed)
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: SegmentedButton<bool>(
              key: Key('sign-${p.pluId}'),
              showSelectedIcon: false,
              segments: const [ButtonSegment(value: false, label: Text('+')), ButtonSegment(value: true, label: Text('−'))],
              selected: {line.takeOff},
              onSelectionChanged: (s) {
                line.takeOff = s.first;
                onChanged();
              },
            ),
          ),
        CasesUnitsField(line: line, onChanged: onChanged),
        if (kind.counting)
          SizedBox(
            width: 80,
            child: Text(
              diff == null ? '' : '${diff > 0 ? '+' : ''}${fmtQty(diff)}',
              key: Key('diff-${p.pluId}'),
              textAlign: TextAlign.right,
              style: TextStyle(color: diff == null ? null : diffColour(diff), fontWeight: FontWeight.w700),
            ),
          ),
        if (kind.reason) ...[
          const SizedBox(width: 8),
          SizedBox(
            width: 160,
            child: TextFormField(
              initialValue: line.reason,
              decoration: const InputDecoration(labelText: 'Reason', isDense: true, border: OutlineInputBorder()),
              onChanged: (v) => line.reason = v,
            ),
          ),
        ],
        IconButton(tooltip: 'Remove', onPressed: onRemove, icon: const Icon(Icons.delete_outline, color: Pos.red)),
      ]),
    );
  }
}
