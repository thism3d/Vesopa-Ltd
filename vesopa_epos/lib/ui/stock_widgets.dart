/// The pieces the till's Stock and Products pages share (2026-09-27): the
/// product finder that lists as soon as it is tapped, the chooser that takes
/// many products at once, and the cases-and-units boxes.
///
/// Each answers one of Dylan's notes, on the till as in the back office:
///
///   * "I currently have to press ENTER on the add a product box for the
///     products to show" -> [ProductFinder] lists on focus and narrows as you
///     type; tap a row and it is added.
///   * "select multiple products at the same time or add by sub-department or
///     department" -> [showProductChooser].
///   * "add QTYs by either case size QTY or unit QTY" -> [CasesUnitsField].
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/stock_api.dart';
import 'theme.dart';

/// A search box that shows products the moment it has focus.
class ProductFinder extends StatefulWidget {
  const ProductFinder({
    super.key,
    required this.products,
    required this.onPick,
    this.exclude = const {},
    this.stockFirst = false,
    this.hint = 'Tap to see products, or type a name, PLU or barcode',
  });

  final List<StockProduct> products;
  final ValueChanged<StockProduct> onPick;
  final Set<int> exclude;
  final bool stockFirst;
  final String hint;

  @override
  State<ProductFinder> createState() => _ProductFinderState();
}

class _ProductFinderState extends State<ProductFinder> {
  final _text = TextEditingController();
  final _focus = FocusNode();
  final _link = LayerLink();
  OverlayEntry? _overlay;
  Timer? _closing;

  static const _max = 60;

  List<StockProduct> get _rows {
    final rows = widget.products
        .where((p) => !widget.exclude.contains(p.pluId) && p.matches(_text.text))
        .toList();
    if (widget.stockFirst) {
      rows.sort((a, b) => (b.stockItem ? 1 : 0) - (a.stockItem ? 1 : 0));
    }
    return rows;
  }

  @override
  void initState() {
    super.initState();
    _focus.addListener(() {
      if (_focus.hasFocus) {
        _show();
      } else {
        // After a tap on a row has had its chance.
        _closing?.cancel();
        _closing = Timer(const Duration(milliseconds: 180), () {
          if (mounted && !_focus.hasFocus) _hide();
        });
      }
    });
  }

  @override
  void didUpdateWidget(covariant ProductFinder oldWidget) {
    super.didUpdateWidget(oldWidget);
    // After this frame: the overlay is another part of the tree, and marking it
    // dirty while this one builds is not allowed.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _overlay?.markNeedsBuild();
    });
  }

  void _show() {
    _hide();
    final box = context.findRenderObject() as RenderBox?;
    final width = box?.size.width ?? 480;
    _overlay = OverlayEntry(
      builder: (_) => Positioned(
        width: width,
        child: CompositedTransformFollower(
          link: _link,
          showWhenUnlinked: false,
          offset: Offset(0, (box?.size.height ?? 56) + 4),
          child: _list(),
        ),
      ),
    );
    Overlay.of(context).insert(_overlay!);
  }

  void _hide() {
    _overlay?.remove();
    _overlay = null;
  }

  Widget _list() {
    final theme = Theme.of(context);
    final all = _rows;
    final rows = all.take(_max).toList();
    return Material(
      elevation: 10,
      borderRadius: BorderRadius.circular(12),
      color: theme.colorScheme.surface,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 360),
        child: rows.isEmpty
            ? Padding(
                padding: const EdgeInsets.all(18),
                child: Text('Nothing matches “${_text.text.trim()}”.', textAlign: TextAlign.center),
              )
            : ListView(
                key: const Key('product-finder-list'),
                padding: EdgeInsets.zero,
                shrinkWrap: true,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 8, 14, 4),
                    child: Text(
                      all.length > _max
                          ? '${all.length} match — showing $_max. Keep typing, or use Choose products.'
                          : '${all.length} product${all.length == 1 ? '' : 's'}${_text.text.trim().isEmpty ? ' — type to narrow' : ''}',
                      style: theme.textTheme.bodySmall,
                    ),
                  ),
                  for (final p in rows)
                    ListTile(
                      key: Key('finder-${p.pluId}'),
                      dense: true,
                      title: Text(p.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text('${p.shelf} · PLU ${p.pluId}'),
                      trailing: _Tag(p.caseLabel),
                      onTap: () {
                        widget.onPick(p);
                        _text.clear();
                        _overlay?.markNeedsBuild();
                        _focus.requestFocus();
                      },
                    ),
                ],
              ),
      ),
    );
  }

  @override
  void dispose() {
    _closing?.cancel();
    _hide();
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: _link,
      child: TextField(
        key: const Key('product-finder'),
        controller: _text,
        focusNode: _focus,
        decoration: InputDecoration(
          prefixIcon: const Icon(Icons.search),
          hintText: widget.hint,
          border: const OutlineInputBorder(),
        ),
        onChanged: (_) => _overlay?.markNeedsBuild(),
        onSubmitted: (_) {
          final rows = _rows;
          if (rows.length == 1) {
            widget.onPick(rows.first);
            _text.clear();
            _overlay?.markNeedsBuild();
          }
          _focus.requestFocus();
        },
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(99),
        ),
        child: Text(text, style: Theme.of(context).textTheme.labelSmall),
      );
}

/// Choose many products: by search, department, sub-department; stock items
/// only; select all shown. Resolves to the chosen products (maybe none).
Future<List<StockProduct>> showProductChooser(
  BuildContext context, {
  required List<StockProduct> products,
  Set<int> exclude = const {},
  bool stockOnly = false,
  String title = 'Choose products',
}) async {
  final picked = await showDialog<List<StockProduct>>(
    context: context,
    builder: (_) => _Chooser(products: products, exclude: exclude, stockOnly: stockOnly, title: title),
  );
  return picked ?? const [];
}

class _Chooser extends StatefulWidget {
  const _Chooser({required this.products, required this.exclude, required this.stockOnly, required this.title});
  final List<StockProduct> products;
  final Set<int> exclude;
  final bool stockOnly;
  final String title;
  @override
  State<_Chooser> createState() => _ChooserState();
}

class _ChooserState extends State<_Chooser> {
  final _q = TextEditingController();
  String? _dept;
  String? _group;
  late bool _stockOnly = widget.stockOnly;
  final _chosen = <int>{};

  List<StockProduct> get _shown => widget.products
      .where((p) =>
          !widget.exclude.contains(p.pluId) &&
          (_dept == null || p.department == _dept) &&
          (_group == null || p.group == _group) &&
          (!_stockOnly || p.stockItem) &&
          p.matches(_q.text))
      .toList();

  @override
  Widget build(BuildContext context) {
    final depts = {for (final p in widget.products) p.department}.toList()..sort();
    final groups = {
      for (final p in widget.products)
        if ((_dept == null || p.department == _dept) && p.group != null) p.group!,
    }.toList()
      ..sort();
    final shown = _shown;
    final allOn = shown.isNotEmpty && shown.every((p) => _chosen.contains(p.pluId));
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 640,
        height: 520,
        child: Column(
          children: [
            TextField(
              key: const Key('chooser-search'),
              controller: _q,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search a name, PLU or barcode', border: OutlineInputBorder()),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: DropdownButtonFormField<String?>(
                  key: const Key('chooser-dept'),
                  initialValue: _dept,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Department', border: OutlineInputBorder()),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('All departments')),
                    for (final d in depts) DropdownMenuItem(value: d, child: Text(d)),
                  ],
                  onChanged: (v) => setState(() {
                    _dept = v;
                    _group = null;
                  }),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: DropdownButtonFormField<String?>(
                  key: ValueKey('chooser-group-$_dept'),
                  initialValue: _group,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Sub-department', border: OutlineInputBorder()),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('All sub-departments')),
                    for (final g in groups) DropdownMenuItem(value: g, child: Text(g)),
                  ],
                  onChanged: (v) => setState(() => _group = v),
                ),
              ),
            ]),
            Row(children: [
              Checkbox(key: const Key('chooser-stock-only'), value: _stockOnly, onChanged: (v) => setState(() => _stockOnly = v ?? false)),
              const Text('Stock items only'),
              const Spacer(),
              Checkbox(
                key: const Key('chooser-all'),
                value: allOn,
                onChanged: (v) => setState(() {
                  for (final p in shown) {
                    v == true ? _chosen.add(p.pluId) : _chosen.remove(p.pluId);
                  }
                }),
              ),
              Text('Select all shown (${shown.length})'),
            ]),
            const Divider(height: 1),
            Expanded(
              child: shown.isEmpty
                  ? Center(
                      child: Text(_stockOnly
                          ? 'No stock items match. Untick “Stock items only”, or give products a case size.'
                          : 'Nothing matches.'),
                    )
                  : ListView.builder(
                      itemCount: shown.length,
                      itemBuilder: (_, i) {
                        final p = shown[i];
                        return CheckboxListTile(
                          key: Key('chooser-${p.pluId}'),
                          dense: true,
                          value: _chosen.contains(p.pluId),
                          onChanged: (v) => setState(() => v == true ? _chosen.add(p.pluId) : _chosen.remove(p.pluId)),
                          title: Text(p.name),
                          subtitle: Text('${p.shelf} · PLU ${p.pluId}'),
                          secondary: _Tag(p.caseLabel),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          key: const Key('chooser-ok'),
          onPressed: _chosen.isEmpty
              ? null
              : () => Navigator.pop(context, [for (final p in widget.products) if (_chosen.contains(p.pluId)) p]),
          child: Text(_chosen.isEmpty ? 'Add' : 'Add ${_chosen.length} product${_chosen.length == 1 ? '' : 's'}'),
        ),
      ],
    );
  }
}

/// Cases and units, side by side, and what they come to.
///
/// A product with no real case gets the units box alone. What the caller
/// reads is always units: [StockLine.quantity].
class CasesUnitsField extends StatefulWidget {
  const CasesUnitsField({super.key, required this.line, required this.onChanged, this.autofocus = false});
  final StockLine line;
  final VoidCallback onChanged;
  final bool autofocus;
  @override
  State<CasesUnitsField> createState() => _CasesUnitsFieldState();
}

class _CasesUnitsFieldState extends State<CasesUnitsField> {
  late final _cases = TextEditingController(text: widget.line.cases);
  late final _units = TextEditingController(text: widget.line.units);

  @override
  void didUpdateWidget(covariant CasesUnitsField old) {
    super.didUpdateWidget(old);
    if (_cases.text != widget.line.cases) _cases.text = widget.line.cases;
    if (_units.text != widget.line.units) _units.text = widget.line.units;
  }

  @override
  void dispose() {
    _cases.dispose();
    _units.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final line = widget.line;
    final hasCase = line.product.hasCase;
    final q = line.quantity;
    final digits = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))];
    Widget box(String label, TextEditingController c, void Function(String) set, {bool enabled = true, Key? key}) => SizedBox(
          width: 86,
          child: TextField(
            key: key,
            controller: c,
            enabled: enabled,
            autofocus: widget.autofocus && label == (hasCase ? 'Cases' : 'Units'),
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: digits,
            textAlign: TextAlign.right,
            decoration: InputDecoration(labelText: label, isDense: true, border: const OutlineInputBorder()),
            onChanged: (v) {
              set(v);
              widget.onChanged();
              setState(() {});
            },
          ),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(mainAxisSize: MainAxisSize.min, children: [
          if (hasCase) ...[
            box('Cases', _cases, (v) => line.cases = v, key: Key('cases-${line.product.pluId}')),
            const SizedBox(width: 6),
          ],
          box('Units', _units, (v) => line.units = v, key: Key('units-${line.product.pluId}')),
        ]),
        if (hasCase && q != null)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text('= ${fmtQty(q.abs())} units', key: Key('total-${line.product.pluId}'), style: Theme.of(context).textTheme.bodySmall),
          ),
      ],
    );
  }
}

/// A case-size dropdown for one product. Saving is the caller's.
class CaseSizeDropdown extends StatelessWidget {
  const CaseSizeDropdown({super.key, required this.product, required this.packs, required this.onChanged, this.enabled = true});
  final StockProduct product;
  final List<PackSize> packs;
  final ValueChanged<int?> onChanged;
  final bool enabled;
  @override
  Widget build(BuildContext context) {
    final known = packs.any((k) => k.id == product.packSizeId);
    return DropdownButton<int?>(
      key: Key('case-${product.pluId}'),
      value: known ? product.packSizeId : null,
      isDense: true,
      hint: const Text('No case size'),
      onChanged: enabled ? onChanged : null,
      items: [
        const DropdownMenuItem<int?>(value: null, child: Text('No case size')),
        for (final k in packs) DropdownMenuItem<int?>(value: k.id, child: Text(k.label)),
      ],
    );
  }
}

/// Colour for a difference: short is red, over is green.
Color diffColour(double diff) => diff < 0 ? Pos.red : diff > 0 ? Pos.green : Colors.grey;
