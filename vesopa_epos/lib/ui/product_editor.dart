/// Editing a product on the till, under headings (2026-09-27).
///
/// Dylan: "I like how Newbridge does it, where you have headers for product
/// details - stock - modifiers - printing - images." The back office's
/// product form got those sections; this is the till's, extending the
/// Products page's existing edit dialog rather than sitting beside it:
///
///   Details   name, price, department, sub-department, VAT, barcode
///   Stock     case size, supplier, costs, GP calculator with a recommended
///             price, non-stock, what it sells from, its child products
///             (made here or linked from the list) and its recipe
///   Printing  on the receipt or not, and which kitchen printers
///   Images    the picture, which is changed in the back office
///
/// Everything saves to the server -- the old dialog wrote only this till's
/// database, and the next sync put the old values back. Modifiers stay in the
/// back office, where the questions themselves are written.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/stock_api.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';

/// Open the editor. Resolves true when something was saved.
Future<bool> showProductEditor(
  BuildContext context, {
  required Product product,
  required List<Product> catalogue,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (_) => ProductEditor(product: product, catalogue: catalogue),
    ) ??
    false;

class ProductEditor extends ConsumerStatefulWidget {
  const ProductEditor({super.key, required this.product, required this.catalogue});
  final Product product;
  final List<Product> catalogue;
  @override
  ConsumerState<ProductEditor> createState() => _ProductEditorState();
}

/// One child row in the Stock section.
class _Child {
  _Child.linked(StockProduct p)
      : kind = 'linked',
        id = p.id,
        pluId = p.pluId,
        name = p.name,
        price = p.price.toStringAsFixed(2),
        ratio = p.ratio == null ? '' : fmtQty(p.ratio!),
        was = p.ratio == null ? '' : fmtQty(p.ratio!);
  _Child.link(StockProduct p)
      : kind = 'link',
        id = p.id,
        pluId = p.pluId,
        name = p.name,
        price = p.price.toStringAsFixed(2),
        ratio = p.ratio == null ? '' : fmtQty(p.ratio!),
        was = null;
  _Child.fresh()
      : kind = 'new',
        id = null,
        pluId = null,
        name = '',
        price = '',
        ratio = '',
        was = null;
  final String kind;
  final int? id;
  final int? pluId;
  String name;
  String price;
  String ratio;
  final String? was;
}

class _Ingredient {
  _Ingredient(this.product, this.quantity);
  final StockProduct product;
  String quantity;
}

class _ProductEditorState extends ConsumerState<ProductEditor> {
  late final _name = TextEditingController(text: widget.product.name);
  late final _price = TextEditingController(text: (widget.product.priceMinor / 100).toStringAsFixed(2));
  late final _vat = TextEditingController(text: fmtQty(widget.product.taxPercentage));
  late final _barcode = TextEditingController(text: widget.product.barcode ?? '');
  late String? _dept = widget.product.departmentName;
  late String? _group = widget.product.groupName;
  late bool _onReceipt = widget.product.printToReceipt;
  late final Set<String> _routes = {
    for (final r in (widget.product.printerRoutes ?? '').split(','))
      if (r.trim().isNotEmpty) r.trim().toLowerCase(),
  };

  // Stock, from the server.
  bool _stockLoading = true;
  String? _stockError;
  List<StockProduct> _all = const [];
  List<PackSize> _packs = const [];
  List<Supplier> _suppliers = const [];
  StockProduct? _me;
  int? _packId;
  int? _supplierId;
  final _packCost = TextEditingController();
  final _unitCost = TextEditingController();
  final _target = TextEditingController();
  bool _nonStock = false;
  final List<_Child> _children = [];
  final List<int> _unlink = [];
  final List<_Ingredient> _recipe = [];
  bool _recipeLoaded = false;
  bool _recipeChanged = false;

  bool _saving = false;

  /// On the QR / kiosk menu, and whether it is sold out there. Null until known.
  ({bool onMenu, bool soldOut, double? canMake})? _menu;

  @override
  void initState() {
    super.initState();
    _loadStock();
  }

  @override
  void dispose() {
    for (final c in [_name, _price, _vat, _barcode, _packCost, _unitCost, _target]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _loadStock() async {
    try {
      final api = ref.read(stockApiProvider);
      final r = await Future.wait([api.products(), api.packSizes(), api.suppliers()]);
      final menu = await api.availability().catchError((_) => <int, ({bool onMenu, bool soldOut, double? canMake})>{});
      final all = r[0] as List<StockProduct>;
      final me = all.where((p) => p.pluId == widget.product.pluId).firstOrNull;
      List<_Ingredient> recipe = const [];
      if (me != null && me.isRecipe) {
        final rec = await api.recipe(me.pluId);
        recipe = [
          for (final l in (rec['lines'] as List? ?? const []).cast<Map<String, dynamic>>())
            if (all.any((p) => p.pluId == l['pluid']))
              _Ingredient(all.firstWhere((p) => p.pluId == l['pluid']), fmtQty((l['quantity'] as num).toDouble())),
        ];
      }
      if (!mounted) return;
      setState(() {
        _all = all;
        _packs = r[1] as List<PackSize>;
        _suppliers = r[2] as List<Supplier>;
        _me = me;
        _packId = me?.packSizeId;
        _supplierId = me?.supplierId;
        _packCost.text = me?.packCost == null ? '' : me!.packCost!.toStringAsFixed(2);
        _unitCost.text = me?.costPrice == null ? '' : me!.costPrice!.toStringAsFixed(2);
        _target.text = me?.targetGp == null ? '' : fmtQty(me!.targetGp!);
        _nonStock = me?.nonStock ?? false;
        _children
          ..clear()
          ..addAll([for (final p in all.where((p) => p.parentPlu == widget.product.pluId)) _Child.linked(p)]);
        _recipe
          ..clear()
          ..addAll(recipe);
        _recipeLoaded = true;
        _menu = menu[widget.product.pluId];
        _stockLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _stockLoading = false;
        _stockError = '$e';
      });
    }
  }

  double? get _unitCostNow {
    final pack = _packs.where((k) => k.id == _packId).firstOrNull;
    final pc = double.tryParse(_packCost.text.trim());
    if (pc != null && pack != null && pack.units > 0) return pc / pack.units;
    return double.tryParse(_unitCost.text.trim());
  }

  Future<void> _save() async {
    final api = ref.read(stockApiProvider);
    final price = double.tryParse(_price.text.trim());
    final vat = double.tryParse(_vat.text.trim());
    if (_name.text.trim().isEmpty) return PosMessenger.error(context, 'A product needs a name.');
    if (price == null || price < 0) return PosMessenger.error(context, 'Give the product a price.');
    if (vat == null || vat < 0) return PosMessenger.error(context, 'Give a VAT rate.');
    for (final c in _children) {
      if (c.kind == 'new' && c.name.trim().isEmpty) return PosMessenger.error(context, 'Give each new child product a name, or remove it.');
      if (!((double.tryParse(c.ratio) ?? 0) > 0)) {
        return PosMessenger.error(context, '${c.name.isEmpty ? 'A child product' : c.name}: say how much of this product one uses — 0.5 for a half.');
      }
    }
    for (final i in _recipe) {
      if (!((double.tryParse(i.quantity) ?? 0) > 0)) return PosMessenger.error(context, '${i.product.name}: give its measure.');
    }
    setState(() => _saving = true);
    final failed = <String>[];
    try {
      await api.updateProduct(widget.product.pluId, {
        'product_name': _name.text.trim(),
        'price': price,
        'tax_percentage': vat,
        'department_name': _dept ?? '',
        'group_name': _group ?? '',
        'barcode': _barcode.text.trim(),
        'print_to_receipt': _onReceipt,
        'printer_routes': _routes.join(','),
      });
    } catch (e) {
      if (mounted) {
        setState(() => _saving = false);
        PosMessenger.error(context, '$e');
      }
      return;
    }
    final me = _me;
    if (me != null) {
      try {
        await api.patchProduct(me.id, {
          'pack_size_id': _packId,
          'supplier_id': _supplierId,
          'pack_cost': double.tryParse(_packCost.text.trim()),
          'cost_price': double.tryParse(_unitCost.text.trim()),
          'target_gp': double.tryParse(_target.text.trim()),
          'non_stock': _nonStock ? 1 : 0,
        });
      } catch (e) {
        failed.add('stock: $e');
      }
      for (final id in _unlink) {
        try {
          await api.patchProduct(id, {'stock_parent_pluid': null, 'stock_ratio': null});
        } catch (e) {
          failed.add('$e');
        }
      }
      for (final c in _children) {
        final ratio = double.parse(c.ratio);
        try {
          if (c.kind == 'new') {
            final made = await api.createProduct({
              'product_name': c.name.trim(),
              'price': double.tryParse(c.price) ?? 0,
              'department_name': _dept ?? '',
              'group_name': _group ?? '',
              'tax_percentage': vat,
              'printer_routes': _routes.join(','),
              'print_to_receipt': _onReceipt,
            });
            await api.patchProduct(made.id, {'stock_parent_pluid': widget.product.pluId, 'stock_ratio': ratio});
          } else if (c.kind == 'link' || c.ratio != c.was) {
            await api.patchProduct(c.id!, {'stock_parent_pluid': widget.product.pluId, 'stock_ratio': ratio});
          }
        } catch (e) {
          failed.add('${c.name}: $e');
        }
      }
      if (_recipeChanged) {
        try {
          if (_recipe.isEmpty) {
            if (me.isRecipe) await api.deleteRecipe(me.pluId);
          } else {
            await api.saveRecipe(me.pluId, [for (final i in _recipe) (pluId: i.product.pluId, quantity: double.parse(i.quantity))]);
          }
        } catch (e) {
          failed.add('recipe: $e');
        }
      }
    }
    if (!mounted) return;
    setState(() => _saving = false);
    if (failed.isNotEmpty) {
      PosMessenger.error(context, 'Saved, but not all of it: ${failed.join(' · ')}');
    } else {
      PosMessenger.success(context, '${_name.text.trim()} saved for every till.');
    }
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    return Dialog(
      insetPadding: const EdgeInsets.all(20),
      child: SizedBox(
        width: size.width.clamp(360, 860).toDouble(),
        height: size.height.clamp(420, 760).toDouble() - 40,
        child: DefaultTabController(
          length: 4,
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
              child: Row(children: [
                Expanded(child: Text('Edit ${widget.product.name}', style: Theme.of(context).textTheme.titleLarge)),
                Text('PLU ${widget.product.pluId}', style: Theme.of(context).textTheme.bodySmall),
              ]),
            ),
            const TabBar(
              key: Key('editor-tabs'),
              isScrollable: true,
              tabs: [Tab(text: 'Product details'), Tab(text: 'Stock'), Tab(text: 'Printing'), Tab(text: 'Images')],
            ),
            Expanded(
              child: TabBarView(children: [_details(), _stock(), _printing(), _images()]),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(children: [
                const Expanded(child: Text('Saves to the back office, for every till. Modifiers are set in the back office.', style: TextStyle(fontSize: 12))),
                TextButton(onPressed: _saving ? null : () => Navigator.pop(context, false), child: const Text('Cancel')),
                const SizedBox(width: 8),
                FilledButton(key: const Key('editor-save'), onPressed: _saving ? null : _save, child: Text(_saving ? 'Saving…' : 'Save')),
              ]),
            ),
          ]),
        ),
      ),
    );
  }

  Widget _pad(List<Widget> children) => ListView(padding: const EdgeInsets.all(20), children: [
        for (final c in children) Padding(padding: const EdgeInsets.only(bottom: 14), child: c),
      ]);

  Widget _details() {
    final depts = {for (final p in widget.catalogue) if (p.departmentName?.isNotEmpty ?? false) p.departmentName!, ?_dept}.toList()..sort();
    final groups = {
      for (final p in widget.catalogue)
        if ((p.groupName?.isNotEmpty ?? false) && (_dept == null || p.departmentName == _dept)) p.groupName!,
      ?_group,
    }.toList()
      ..sort();
    final money = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))];
    return _pad([
      TextField(key: const Key('editor-name'), controller: _name, decoration: const InputDecoration(labelText: 'Name', border: OutlineInputBorder())),
      Row(children: [
        Expanded(child: TextField(key: const Key('editor-price'), controller: _price, inputFormatters: money, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Price', prefixText: '£ ', border: OutlineInputBorder()), onChanged: (_) => setState(() {}))),
        const SizedBox(width: 12),
        Expanded(child: TextField(controller: _vat, inputFormatters: money, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'VAT rate', suffixText: '%', border: OutlineInputBorder()), onChanged: (_) => setState(() {}))),
      ]),
      Row(children: [
        Expanded(
          child: DropdownButtonFormField<String?>(
            initialValue: _dept,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Department', border: OutlineInputBorder()),
            items: [const DropdownMenuItem(value: null, child: Text('None')), for (final d in depts) DropdownMenuItem(value: d, child: Text(d))],
            onChanged: (v) => setState(() => _dept = v),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: DropdownButtonFormField<String?>(
            key: ValueKey('group-$_dept'),
            initialValue: groups.contains(_group) ? _group : null,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Sub-department', border: OutlineInputBorder()),
            items: [const DropdownMenuItem(value: null, child: Text('None')), for (final g in groups) DropdownMenuItem(value: g, child: Text(g))],
            onChanged: (v) => setState(() => _group = v),
          ),
        ),
      ]),
      TextField(controller: _barcode, decoration: const InputDecoration(labelText: 'Barcode', border: OutlineInputBorder())),
    ]);
  }

  Widget _stock() {
    if (_stockLoading) return const Center(child: CircularProgressIndicator());
    if (_stockError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('$_stockError\n\nDetails and printing can still be saved.', textAlign: TextAlign.center)));
    }
    final me = _me;
    if (me == null) return const Center(child: Text('The back office does not know this product yet. Refresh the catalogue and try again.'));
    final money = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))];
    final unit = _unitCostNow;
    final price = double.tryParse(_price.text.trim()) ?? 0;
    final vat = double.tryParse(_vat.text.trim()) ?? 0;
    final target = double.tryParse(_target.text.trim()) ?? 70;
    final gp = unit == null ? null : gpFor(price: price, vatPercent: vat, unitCost: unit, targetGp: target);
    final parent = me.parentPlu == null ? null : _all.where((p) => p.pluId == me.parentPlu).firstOrNull;
    return _pad([
      Row(children: [
        Expanded(
          child: DropdownButtonFormField<int?>(
            key: const Key('editor-case'),
            initialValue: _packs.any((k) => k.id == _packId) ? _packId : null,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Case size', helperText: 'Only products with a case size appear on a stock take.', border: OutlineInputBorder()),
            items: [const DropdownMenuItem(value: null, child: Text('No case size')), for (final k in _packs) DropdownMenuItem(value: k.id, child: Text(k.label))],
            onChanged: (v) => setState(() => _packId = v),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: DropdownButtonFormField<int?>(
            key: const Key('editor-supplier'),
            initialValue: _suppliers.any((s) => s.id == _supplierId) ? _supplierId : null,
            isExpanded: true,
            decoration: InputDecoration(labelText: 'Supplier', helperText: _suppliers.isEmpty ? 'Add suppliers in the back office.' : null, border: const OutlineInputBorder()),
            items: [const DropdownMenuItem(value: null, child: Text('None')), for (final s in _suppliers.where((s) => s.active || s.id == _supplierId)) DropdownMenuItem(value: s.id, child: Text(s.name))],
            onChanged: (v) => setState(() => _supplierId = v),
          ),
        ),
      ]),
      Row(children: [
        Expanded(child: TextField(key: const Key('editor-case-cost'), controller: _packCost, inputFormatters: money, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Cost of one case', prefixText: '£ ', border: OutlineInputBorder()), onChanged: (_) => setState(() {}))),
        const SizedBox(width: 12),
        Expanded(child: TextField(key: const Key('editor-unit-cost'), controller: _unitCost, inputFormatters: money, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Unit cost', prefixText: '£ ', border: OutlineInputBorder()), onChanged: (_) => setState(() {}))),
        const SizedBox(width: 12),
        SizedBox(width: 130, child: TextField(controller: _target, inputFormatters: money, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Target GP', hintText: '70', suffixText: '%', border: OutlineInputBorder()), onChanged: (_) => setState(() {}))),
      ]),
      // The GP calculator.
      Container(
        key: const Key('editor-gp'),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), color: Theme.of(context).colorScheme.surfaceContainerHighest),
        child: gp == null
            ? const Text('Add a unit cost (or a case cost and case size) to see the GP and a recommended price.')
            : Wrap(spacing: 16, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                Text('Unit cost £${unit!.toStringAsFixed(2)}'),
                Text(gp.gp == null ? 'GP —' : 'GP now ${gp.gp!.toStringAsFixed(1)}%',
                    style: TextStyle(fontWeight: FontWeight.w700, color: (gp.gp ?? 0) < target ? Pos.red : null)),
                Text('At ${fmtQty(target)}% charge £${gp.recommended.toStringAsFixed(2)} incl. VAT', key: const Key('editor-recommended')),
                OutlinedButton(
                  key: const Key('editor-use-price'),
                  onPressed: () => setState(() => _price.text = gp.recommended.toStringAsFixed(2)),
                  child: const Text('Use this price'),
                ),
              ]),
      ),
      // Sold out is the QR menu's own switch (2026-09-27) -- the one the kitchen
      // screen flips too -- applied at once, not on Save: running out is now.
      if (_menu != null && _menu!.onMenu)
        SwitchListTile(
          key: const Key('editor-sold-out'),
          contentPadding: EdgeInsets.zero,
          title: const Text('Sold out'),
          subtitle: Text(_menu!.canMake == null
              ? 'Off the QR menu and the kiosk until switched back.'
              : 'Off the QR menu and the kiosk until switched back. ${fmtQty(_menu!.canMake!)} can still be made.'),
          value: _menu!.soldOut,
          onChanged: (v) async {
            try {
              await ref.read(stockApiProvider).setSoldOut(widget.product.pluId, v);
              if (!mounted) return;
              setState(() => _menu = (onMenu: true, soldOut: v, canMake: _menu!.canMake));
              PosMessenger.success(context, v ? '${widget.product.name} is sold out on the QR menu and kiosk.' : '${widget.product.name} is back on.');
            } catch (e) {
              if (mounted) PosMessenger.error(context, '$e');
            }
          },
        ),
      SwitchListTile(
        key: const Key('editor-non-stock'),
        contentPadding: EdgeInsets.zero,
        title: const Text('Non-stock item'),
        subtitle: const Text('Never counted on a stock take.'),
        value: _nonStock,
        onChanged: (v) => setState(() => _nonStock = v),
      ),
      if (parent != null)
        Text('Sells from ${parent.name}: each one takes ${fmtQty(me.ratio ?? 0)} of it. Change that from ${parent.name}’s Child products.',
            key: const Key('editor-sells-from')),
      if (parent == null) _childPanel(),
      _recipePanel(),
    ]);
  }

  Widget _childPanel() {
    final unit = _unitCostNow;
    final taken = {for (final c in _children) if (c.id != null) c.id};
    final parents = {for (final p in _all) if (p.parentPlu != null) p.parentPlu};
    final candidates = _all
        .where((p) => p.pluId != widget.product.pluId && !taken.contains(p.id) && (p.parentPlu == null || p.parentPlu == widget.product.pluId) && !parents.contains(p.pluId))
        .toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Child products — sold from this product’s stock', style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: 4),
      Text('A half pint uses 0.5 of the pint; a 175ml glass uses 0.25 of a 70cl bottle. A new child copies this product’s department, VAT and printers.',
          style: Theme.of(context).textTheme.bodySmall),
      const SizedBox(height: 8),
      for (var i = 0; i < _children.length; i++) _childRow(i, unit),
      Wrap(spacing: 8, children: [
        OutlinedButton.icon(
          key: const Key('editor-child-new'),
          onPressed: () => setState(() => _children.add(_Child.fresh())),
          icon: const Icon(Icons.add),
          label: const Text('New child product'),
        ),
        PopupMenuButton<StockProduct>(
          key: const Key('editor-child-link'),
          onSelected: (p) => setState(() {
            _unlink.remove(p.id);
            _children.add(_Child.link(p));
          }),
          itemBuilder: (_) => [for (final p in candidates) PopupMenuItem(value: p, child: Text('${p.name} — PLU ${p.pluId}'))],
          child: const Chip(avatar: Icon(Icons.link, size: 18), label: Text('Link an existing product')),
        ),
      ]),
    ]);
  }

  Widget _childRow(int i, double? unit) {
    final c = _children[i];
    final ratio = double.tryParse(c.ratio);
    return Padding(
      key: ValueKey('child-$i-${c.id ?? 'new'}'),
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(children: [
        Expanded(
          flex: 3,
          child: c.kind == 'new'
              ? TextFormField(key: Key('child-name-$i'), initialValue: c.name, decoration: const InputDecoration(labelText: 'New child product', isDense: true, border: OutlineInputBorder()), onChanged: (v) => c.name = v)
              : Text('${c.name}  ·  PLU ${c.pluId}${c.kind == 'link' ? ' (links on save)' : ''}'),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 100,
          child: c.kind == 'new'
              ? TextFormField(key: Key('child-price-$i'), initialValue: c.price, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Price', prefixText: '£', isDense: true, border: OutlineInputBorder()), onChanged: (v) => c.price = v)
              : Text('£${c.price}', textAlign: TextAlign.right),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 110,
          child: TextFormField(
            key: Key('child-ratio-$i'),
            initialValue: c.ratio,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Uses of this', hintText: '0.5', isDense: true, border: OutlineInputBorder()),
            onChanged: (v) => setState(() => c.ratio = v),
          ),
        ),
        SizedBox(width: 72, child: Text(unit != null && (ratio ?? 0) > 0 ? '£${(unit * ratio!).toStringAsFixed(2)}' : '—', textAlign: TextAlign.right)),
        IconButton(
          tooltip: 'Remove',
          onPressed: () => setState(() {
            final gone = _children.removeAt(i);
            if (gone.kind == 'linked' && gone.id != null) _unlink.add(gone.id!);
          }),
          icon: const Icon(Icons.close, color: Pos.red),
        ),
      ]),
    );
  }

  Widget _recipePanel() {
    if (!_recipeLoaded) return const SizedBox.shrink();
    final me = _me!;
    final cost = _recipe.fold<double>(0, (a, i) => a + i.product.unitCostMinor / 100 * (double.tryParse(i.quantity) ?? 0));
    final candidates = _all.where((p) => p.pluId != me.pluId && !_recipe.any((i) => i.product.pluId == p.pluId)).toList()..sort((a, b) => a.name.compareTo(b.name));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Divider(),
      Text('Recipe — made from other products', style: Theme.of(context).textTheme.titleSmall),
      Text('Selling one takes each ingredient off by its measure, and its cost is the recipe’s.', style: Theme.of(context).textTheme.bodySmall),
      const SizedBox(height: 8),
      for (var i = 0; i < _recipe.length; i++)
        Padding(
          key: ValueKey('ing-${_recipe[i].product.pluId}'),
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(children: [
            Expanded(child: Text(_recipe[i].product.name)),
            SizedBox(
              width: 110,
              child: TextFormField(
                initialValue: _recipe[i].quantity,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Measure', isDense: true, border: OutlineInputBorder()),
                onChanged: (v) => setState(() {
                  _recipe[i].quantity = v;
                  _recipeChanged = true;
                }),
              ),
            ),
            IconButton(
              onPressed: () => setState(() {
                _recipe.removeAt(i);
                _recipeChanged = true;
              }),
              icon: const Icon(Icons.close, color: Pos.red),
            ),
          ]),
        ),
      Row(children: [
        PopupMenuButton<StockProduct>(
          key: const Key('editor-ingredient'),
          onSelected: (p) => setState(() {
            _recipe.add(_Ingredient(p, ''));
            _recipeChanged = true;
          }),
          itemBuilder: (_) => [for (final p in candidates) PopupMenuItem(value: p, child: Text(p.name))],
          child: const Chip(avatar: Icon(Icons.add, size: 18), label: Text('Add an ingredient')),
        ),
        const Spacer(),
        if (_recipe.isNotEmpty) Text('Recipe cost £${cost.toStringAsFixed(2)}'),
      ]),
    ]);
  }

  Widget _printing() => _pad([
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Show on the customer receipt'),
          value: _onReceipt,
          onChanged: (v) => setState(() => _onReceipt = v),
        ),
        const Text('Kitchen printers — prints when sold and when saved to a table'),
        Wrap(spacing: 8, children: [
          for (var n = 1; n <= 6; n++)
            FilterChip(
              key: Key('route-kp$n'),
              label: Text('KP $n'),
              selected: _routes.contains('kp$n'),
              onSelected: (on) => setState(() => on ? _routes.add('kp$n') : _routes.remove('kp$n')),
            ),
        ]),
      ]);

  Widget _images() => _pad([
        if (widget.product.imageUrl?.isNotEmpty ?? false)
          ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: Image.network(widget.product.imageUrl!, height: 220, fit: BoxFit.contain, errorBuilder: (_, _, _) => const Text('The picture could not be loaded.')),
          )
        else
          const Text('No picture yet.'),
        const Text('Pictures are cropped and uploaded in the back office (Products → Edit → Images), so every till, the kiosk and the QR menu get the same one.'),
      ]);
}
