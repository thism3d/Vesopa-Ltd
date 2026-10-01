/// Adding and editing a product on the till, in steps (2026-10-01).
///
/// "When creating a product can we copy Newbridge where it is in stages and
/// all fits on the screen instead of scrolling down." The back office's
/// product form became eight steps, and this is the till's, the same steps in
/// the same order, extending the editor the Products page already had
/// (2026-09-27: details, stock, printing, images under headings):
///
///   1 Product details  name, short description, prices 1 to 6, VAT,
///                      department, barcode (or a generated store EAN-13),
///                      sold by weight, attached-only
///   2 Stock control    case size, supplier and code, costs, GP calculator,
///                      min / max stock, non-stock, sold out, its recipe
///   3 Modifiers        the questions it asks, in order
///   4 Printing         on the receipt or not, which kitchen printers
///   5 Child products   halves and glasses sold from its stock
///   6 Allergens        the fourteen, "may contain" traces, diet labels
///   7 Information      description, calories, a picture the venue already
///                      has, and "Add to a till page"
///   8 Review           what is about to be saved
///
/// Back / Save / Continue on every step, and every step can be tapped
/// straight to. Everything saves to the server, for every till. With no
/// product it adds a new one -- the till could only edit before.
library;

import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/dinein_orders.dart' show allergenLabelsProvider;
import '../data/local/database.dart';
import '../data/modifiers.dart';
import '../data/price_level_controller.dart' show priceLevelNamesProvider;
import '../data/product_extras.dart';
import '../data/screens.dart';
import '../data/stock_api.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';

/// Open the editor; with no [product] it adds one. Resolves true when
/// something was saved.
Future<bool> showProductEditor(
  BuildContext context, {
  Product? product,
  required List<Product> catalogue,
}) async =>
    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => ProductEditor(product: product, catalogue: catalogue),
    ) ??
    false;

class ProductEditor extends ConsumerStatefulWidget {
  const ProductEditor({super.key, this.product, required this.catalogue});

  /// Null when adding a new product.
  final Product? product;
  final List<Product> catalogue;
  @override
  ConsumerState<ProductEditor> createState() => _ProductEditorState();
}

/// The steps, in the back office's order.
enum _Step {
  details('Product details'),
  stock('Stock control'),
  modifiers('Modifiers'),
  printing('Printing'),
  children('Child products'),
  allergens('Allergens'),
  information('Information'),
  review('Review');

  const _Step(this.label);
  final String label;
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
  bool get _isNew => widget.product == null;

  /// The product's PLU: its own, or the one the server gave it on save.
  int? get _plu => widget.product?.pluId ?? _madePlu;
  int? _madePlu;

  late final ProductExtras _was = ProductExtras.decode(widget.product?.extras);

  late final _name = TextEditingController(text: widget.product?.name ?? '');
  late final _short = TextEditingController(text: _was.shortDescription ?? '');
  late final _price = TextEditingController(text: widget.product == null ? '' : (widget.product!.priceMinor / 100).toStringAsFixed(2));
  late final _vat = TextEditingController(text: fmtQty(widget.product?.taxPercentage ?? 20));
  late final _barcode = TextEditingController(text: widget.product?.barcode ?? '');
  late final List<TextEditingController> _levels = [
    for (final m in [widget.product?.price2Minor, widget.product?.price3Minor, widget.product?.price4Minor, widget.product?.price5Minor, widget.product?.price6Minor])
      TextEditingController(text: m == null ? '' : (m / 100).toStringAsFixed(2)),
  ];
  late String? _dept = widget.product?.departmentName;
  late String? _group = widget.product?.groupName;
  late bool _weighted = _was.isWeighted;
  late bool _manualWeight = _was.manualWeight;
  late bool _attachedOnly = widget.product?.isModifier ?? false;
  late bool _onReceipt = widget.product?.printToReceipt ?? true;
  late final Set<String> _routes = {
    for (final r in (widget.product?.printerRoutes ?? '').split(','))
      if (r.trim().isNotEmpty) r.trim().toLowerCase(),
  };

  // Allergens. Sent only when somebody has looked: a product nobody has
  // answered for stays "not said" rather than becoming "contains none"
  // because its price was changed.
  late final Set<String> _allergens = {...?ProductExtras.decodeCodes(widget.product?.allergens)};
  late final Set<String> _mayContain = {...?_was.mayContain};
  late final Set<String> _dietary = {...?_was.dietary};
  late bool _allergensSeen = widget.product?.allergens != null;

  // Information.
  late final String _descriptionWas = ProductExtras.plain(_was.description);
  late final _description = TextEditingController(text: _descriptionWas);
  late final _calories = TextEditingController(text: _was.calories?.toString() ?? '');
  late String? _image = widget.product?.imageUrl;
  int? _placeOn;

  // Modifiers.
  List<int>? _mods;

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
  late final _supplierCode = TextEditingController(text: _was.supplierCode ?? '');
  late final _minStock = TextEditingController(text: _was.minStock == null ? '' : fmtQty(_was.minStock!));
  late final _maxStock = TextEditingController(text: _was.maxStock == null ? '' : fmtQty(_was.maxStock!));
  bool _nonStock = false;
  final List<_Child> _children = [];
  final List<int> _unlink = [];
  final List<_Ingredient> _recipe = [];
  bool _recipeLoaded = false;
  bool _recipeChanged = false;

  bool _saving = false;
  _Step _at = _Step.details;
  final Set<_Step> _seen = {_Step.details};

  /// On the QR / kiosk menu, and whether it is sold out there. Null until known.
  ({bool onMenu, bool soldOut, double? canMake})? _menu;

  @override
  void initState() {
    super.initState();
    _loadStock();
  }

  @override
  void dispose() {
    for (final c in [
      _name, _short, _price, _vat, _barcode, _packCost, _unitCost, _target,
      _supplierCode, _minStock, _maxStock, _description, _calories, ..._levels,
    ]) {
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
      final me = _isNew ? null : all.where((p) => p.pluId == widget.product!.pluId).firstOrNull;
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
          ..addAll([if (!_isNew) for (final p in all.where((p) => p.parentPlu == widget.product!.pluId)) _Child.linked(p)]);
        _recipe
          ..clear()
          ..addAll(recipe);
        _recipeLoaded = true;
        _menu = _isNew ? null : menu[widget.product!.pluId];
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

  /// What is wrong with the details, or null. Continue and Save both ask.
  String? get _detailsProblem {
    final price = double.tryParse(_price.text.trim());
    final vat = double.tryParse(_vat.text.trim());
    if (_name.text.trim().isEmpty) return 'A product needs a name.';
    if (price == null || price < 0) return 'Give the product a price.';
    if (vat == null || vat < 0 || vat > 100) return 'Give a VAT rate.';
    for (final c in _levels) {
      final t = c.text.trim();
      if (t.isNotEmpty && ((double.tryParse(t) ?? -1) < 0)) return 'A price level is a price, or blank.';
    }
    return null;
  }

  void _go(_Step step) => setState(() {
        _at = step;
        _seen.add(step);
        if (step == _Step.allergens) _allergensSeen = true;
      });

  void _next() {
    if (_at == _Step.details) {
      final problem = _detailsProblem;
      if (problem != null) return PosMessenger.error(context, problem);
    }
    if (_at.index < _Step.values.length - 1) _go(_Step.values[_at.index + 1]);
  }

  double? _levelValue(int i) {
    final t = _levels[i].text.trim();
    return t.isEmpty ? null : double.tryParse(t);
  }

  Future<void> _save() async {
    final api = ref.read(stockApiProvider);
    final problem = _detailsProblem;
    if (problem != null) {
      _go(_Step.details);
      return PosMessenger.error(context, problem);
    }
    final price = double.parse(_price.text.trim());
    final vat = double.parse(_vat.text.trim());
    for (final c in _children) {
      if (c.kind == 'new' && c.name.trim().isEmpty) {
        _go(_Step.children);
        return PosMessenger.error(context, 'Give each new child product a name, or remove it.');
      }
      if (!((double.tryParse(c.ratio) ?? 0) > 0)) {
        _go(_Step.children);
        return PosMessenger.error(context, '${c.name.isEmpty ? 'A child product' : c.name}: say how much of this product one uses — 0.5 for a half.');
      }
    }
    for (final i in _recipe) {
      if (!((double.tryParse(i.quantity) ?? 0) > 0)) {
        _go(_Step.stock);
        return PosMessenger.error(context, '${i.product.name}: give its measure.');
      }
    }
    setState(() => _saving = true);
    final failed = <String>[];
    int? rowId = _me?.id;
    try {
      if (_isNew && _madePlu == null) {
        final made = await api.createProduct({
          'product_name': _name.text.trim(),
          'price': price,
          'tax_percentage': vat,
          'department_name': _dept ?? '',
          'group_name': _group ?? '',
          'printer_routes': _routes.join(','),
          'print_to_receipt': _onReceipt,
        });
        _madePlu = made.pluId;
        rowId = made.id;
      }
      final description = _description.text.trim();
      await api.updateProduct(_plu!, {
        'product_name': _name.text.trim(),
        'price': price,
        'tax_percentage': vat,
        'department_name': _dept ?? '',
        'group_name': _group ?? '',
        'barcode': _barcode.text.trim(),
        'print_to_receipt': _onReceipt,
        'printer_routes': _routes.join(','),
        for (var i = 0; i < 5; i++) 'price_${i + 2}': _levelValue(i),
        'is_modifier': _attachedOnly,
        'short_description': _short.text.trim(),
        // Only when it changed: the back office's description can carry
        // formatting this plain box would flatten.
        if (_isNew || description != _descriptionWas) 'description': ProductExtras.toHtml(description),
        'calories': _calories.text.trim(),
        'is_weighted': _weighted ? 1 : 0,
        'manual_weight': _manualWeight ? 1 : 0,
        if (_allergensSeen) ...{
          'allergens': _allergens.toList(),
          'may_contain': _mayContain.toList(),
          'dietary': _dietary.toList(),
        },
        if (_image != widget.product?.imageUrl) 'image_url': _image ?? '',
        if (_mods != null) 'modifier_group_ids': _mods,
      });
    } catch (e) {
      if (mounted) {
        setState(() => _saving = false);
        PosMessenger.error(context, '$e');
      }
      return;
    }
    final plu = _plu!;
    if (rowId != null) {
      try {
        await api.patchProduct(rowId, {
          'pack_size_id': _packId,
          'supplier_id': _supplierId,
          'pack_cost': double.tryParse(_packCost.text.trim()),
          'cost_price': double.tryParse(_unitCost.text.trim()),
          'target_gp': double.tryParse(_target.text.trim()),
          'non_stock': _nonStock ? 1 : 0,
          'supplier_code': _supplierCode.text.trim(),
          'min_stock': double.tryParse(_minStock.text.trim()),
          'max_stock': double.tryParse(_maxStock.text.trim()),
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
            await api.patchProduct(made.id, {'stock_parent_pluid': plu, 'stock_ratio': ratio});
          } else if (c.kind == 'link' || c.ratio != c.was) {
            await api.patchProduct(c.id!, {'stock_parent_pluid': plu, 'stock_ratio': ratio});
          }
        } catch (e) {
          failed.add('${c.name}: $e');
        }
      }
      final me = _me;
      if (me != null && _recipeChanged) {
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
    String placed = '';
    final page = _placeOn;
    if (page != null) {
      try {
        final r = await api.placeOnPage(page, plu);
        placed = r.already ? ' Already on ${r.name}.' : ' Added to ${r.name}.';
      } catch (e) {
        failed.add('page: $e');
      }
    }
    if (!mounted) return;
    setState(() => _saving = false);
    if (failed.isNotEmpty) {
      PosMessenger.error(context, 'Saved, but not all of it: ${failed.join(' · ')}');
    } else {
      PosMessenger.success(context, '${_name.text.trim()} saved for every till.$placed');
    }
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final phone = size.width < 640;
    final last = _at == _Step.review;
    final body = switch (_at) {
      _Step.details => _details(),
      _Step.stock => _stock(),
      _Step.modifiers => _modifiers(),
      _Step.printing => _printing(),
      _Step.children => _childrenStep(),
      _Step.allergens => _allergenStep(),
      _Step.information => _information(),
      _Step.review => _review(),
    };
    return Dialog(
      insetPadding: phone ? EdgeInsets.zero : const EdgeInsets.all(20),
      child: SizedBox(
        width: phone ? size.width : size.width.clamp(360, 1000).toDouble(),
        height: phone ? size.height : size.height.clamp(420, 800).toDouble() - 40,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Row(children: [
              Expanded(
                child: Text(_isNew ? 'Add product' : 'Edit ${widget.product!.name}',
                    style: Theme.of(context).textTheme.titleLarge, overflow: TextOverflow.ellipsis),
              ),
              if (_plu != null) Text('PLU $_plu', style: Theme.of(context).textTheme.bodySmall),
            ]),
          ),
          SizedBox(
            height: 44,
            child: SingleChildScrollView(
              key: const Key('editor-steps'),
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(children: [for (final step in _Step.values) _stepChip(step, compact: phone)]),
            ),
          ),
          LinearProgressIndicator(
            value: (_at.index + 1) / _Step.values.length,
            minHeight: 3,
            color: Pos.brand,
            backgroundColor: Colors.transparent,
          ),
          const Divider(height: 1),
          Expanded(child: KeyedSubtree(key: ValueKey(_at), child: body)),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              TextButton(onPressed: _saving ? null : () => Navigator.pop(context, false), child: const Text('Cancel')),
              const Spacer(),
              OutlinedButton(
                key: const Key('editor-back'),
                onPressed: _saving || _at.index == 0 ? null : () => _go(_Step.values[_at.index - 1]),
                child: const Text('Back'),
              ),
              const SizedBox(width: 8),
              FilledButton(
                key: const Key('editor-save'),
                style: last ? null : FilledButton.styleFrom(backgroundColor: Pos.green, foregroundColor: Colors.white),
                onPressed: _saving ? null : _save,
                child: Text(_saving ? 'Saving…' : 'Save'),
              ),
              if (!last) ...[
                const SizedBox(width: 8),
                FilledButton(
                  key: const Key('editor-continue'),
                  style: FilledButton.styleFrom(backgroundColor: Pos.brand, foregroundColor: Pos.inkOn(Pos.brand)),
                  onPressed: _saving ? null : _next,
                  child: const Text('Continue'),
                ),
              ],
            ]),
          ),
        ]),
      ),
    );
  }

  Widget _stepChip(_Step step, {bool compact = false}) {
    final on = step == _at;
    final done = _seen.contains(step) && !on;
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(right: 6, top: 4, bottom: 4),
      child: InkWell(
        key: Key('step-${step.name}'),
        borderRadius: BorderRadius.circular(99),
        onTap: () => _go(step),
        child: Container(
          padding: EdgeInsets.fromLTRB(4, 4, compact && !on ? 4 : 12, 4),
          decoration: BoxDecoration(
            color: on ? Pos.brand : null,
            border: Border.all(color: on ? Pos.brand : scheme.outlineVariant),
            borderRadius: BorderRadius.circular(99),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            CircleAvatar(
              radius: 12,
              backgroundColor: on ? Colors.black.withValues(alpha: 0.14) : (done ? Pos.brand.withValues(alpha: 0.25) : scheme.surfaceContainerHighest),
              child: done
                  ? Icon(Icons.check, size: 14, color: scheme.onSurface)
                  : Text('${step.index + 1}', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: on ? Pos.inkOn(Pos.brand) : scheme.onSurfaceVariant)),
            ),
            if (!compact || on) ...[
              const SizedBox(width: 8),
              Text(step.label, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: on ? Pos.inkOn(Pos.brand) : null)),
            ],
          ]),
        ),
      ),
    );
  }

  Widget _pad(List<Widget> children) => ListView(padding: const EdgeInsets.all(20), children: [
        for (final c in children) Padding(padding: const EdgeInsets.only(bottom: 14), child: c),
      ]);

  /// Two fields side by side on a counter screen, one above the other on a
  /// phone.
  Widget _pair(Widget a, Widget b) => LayoutBuilder(
        builder: (context, box) => box.maxWidth < 520
            ? Column(children: [a, const SizedBox(height: 14), b])
            : Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: a), const SizedBox(width: 12), Expanded(child: b)]),
      );

  Widget _details() {
    final depts = {for (final p in widget.catalogue) if (p.departmentName?.isNotEmpty ?? false) p.departmentName!, ?_dept}.toList()..sort();
    final groups = {
      for (final p in widget.catalogue)
        if ((p.groupName?.isNotEmpty ?? false) && (_dept == null || p.departmentName == _dept)) p.groupName!,
      ?_group,
    }.toList()
      ..sort();
    final money = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))];
    final names = ref.watch(priceLevelNamesProvider);
    return _pad([
      _pair(
        TextField(key: const Key('editor-name'), controller: _name, autofocus: _isNew, decoration: const InputDecoration(labelText: 'Name', border: OutlineInputBorder()), onChanged: (_) => setState(() {})),
        TextField(key: const Key('editor-short'), controller: _short, decoration: const InputDecoration(labelText: 'Short description', hintText: 'e.g. Crisp Italian lager, 5%', border: OutlineInputBorder())),
      ),
      _pair(
        DropdownButtonFormField<String?>(
          initialValue: _dept,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Department', border: OutlineInputBorder()),
          items: [const DropdownMenuItem(value: null, child: Text('None')), for (final d in depts) DropdownMenuItem(value: d, child: Text(d))],
          onChanged: (v) => setState(() => _dept = v),
        ),
        DropdownButtonFormField<String?>(
          key: ValueKey('group-$_dept'),
          initialValue: groups.contains(_group) ? _group : null,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Sub-department', border: OutlineInputBorder()),
          items: [const DropdownMenuItem(value: null, child: Text('None')), for (final g in groups) DropdownMenuItem(value: g, child: Text(g))],
          onChanged: (v) => setState(() => _group = v),
        ),
      ),
      _pair(
        TextField(key: const Key('editor-price'), controller: _price, inputFormatters: money, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: _weighted ? 'Price per kg' : 'Price', prefixText: '£ ', border: const OutlineInputBorder()), onChanged: (_) => setState(() {})),
        TextField(controller: _vat, inputFormatters: money, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'VAT rate', suffixText: '%', border: OutlineInputBorder()), onChanged: (_) => setState(() {})),
      ),
      Row(children: [
        Expanded(child: TextField(key: const Key('editor-barcode'), controller: _barcode, decoration: const InputDecoration(labelText: 'Barcode', border: OutlineInputBorder()))),
        const SizedBox(width: 8),
        OutlinedButton(
          key: const Key('editor-make-ean'),
          onPressed: () => setState(() => _barcode.text = storeEan13()),
          child: const Text('Generate'),
        ),
      ]),
      Wrap(spacing: 12, runSpacing: 12, children: [
        for (var i = 0; i < 5; i++)
          SizedBox(
            width: 170,
            child: TextField(
              key: Key('editor-price-${i + 2}'),
              controller: _levels[i],
              inputFormatters: money,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(labelText: names.nameFor(i + 2), hintText: 'Uses Price 1', prefixText: '£ ', isDense: true, border: const OutlineInputBorder()),
            ),
          ),
      ]),
      SwitchListTile(
        key: const Key('editor-weighted'),
        contentPadding: EdgeInsets.zero,
        title: const Text('Sold by weight'),
        subtitle: const Text('The price is per kg; the till asks for the weight when it is rung up.'),
        value: _weighted,
        onChanged: (v) => setState(() => _weighted = v),
      ),
      if (_weighted)
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Type the weight in'),
          subtitle: const Text('Off: read it from the scale and type it in. Either way the till asks.'),
          value: _manualWeight,
          onChanged: (v) => setState(() => _manualWeight = v),
        ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Can only be sold attached to another item'),
        subtitle: const Text('For things like “No ice” or “Extra shot”.'),
        value: _attachedOnly,
        onChanged: (v) => setState(() => _attachedOnly = v),
      ),
    ]);
  }

  Widget _stock() {
    if (_stockLoading) return const Center(child: CircularProgressIndicator());
    if (_stockError != null) {
      return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('$_stockError\n\nDetails and printing can still be saved.', textAlign: TextAlign.center)));
    }
    final me = _me;
    if (me == null && !_isNew) return const Center(child: Text('The back office does not know this product yet. Refresh the catalogue and try again.'));
    final money = [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))];
    final unit = _unitCostNow;
    final price = double.tryParse(_price.text.trim()) ?? 0;
    final vat = double.tryParse(_vat.text.trim()) ?? 0;
    final target = double.tryParse(_target.text.trim()) ?? 70;
    final gp = unit == null ? null : gpFor(price: price, vatPercent: vat, unitCost: unit, targetGp: target);
    final parent = me?.parentPlu == null ? null : _all.where((p) => p.pluId == me!.parentPlu).firstOrNull;
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
              await ref.read(stockApiProvider).setSoldOut(widget.product!.pluId, v);
              if (!mounted) return;
              setState(() => _menu = (onMenu: true, soldOut: v, canMake: _menu!.canMake));
              PosMessenger.success(context, v ? '${widget.product!.name} is sold out on the QR menu and kiosk.' : '${widget.product!.name} is back on.');
            } catch (e) {
              if (mounted) PosMessenger.error(context, '$e');
            }
          },
        ),
      Row(children: [
        Expanded(child: TextField(key: const Key('editor-supplier-code'), controller: _supplierCode, decoration: const InputDecoration(labelText: 'Supplier code', hintText: 'Their product code', border: OutlineInputBorder()))),
        const SizedBox(width: 12),
        Expanded(child: TextField(key: const Key('editor-min-stock'), controller: _minStock, inputFormatters: money, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Min stock', helperText: 'Reorder below this', border: OutlineInputBorder()))),
        const SizedBox(width: 12),
        Expanded(child: TextField(key: const Key('editor-max-stock'), controller: _maxStock, inputFormatters: money, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Max stock', helperText: 'Order up to this', border: OutlineInputBorder()))),
      ]),
      SwitchListTile(
        key: const Key('editor-non-stock'),
        contentPadding: EdgeInsets.zero,
        title: const Text('Non-stock item'),
        subtitle: const Text('Never counted on a stock take.'),
        value: _nonStock,
        onChanged: (v) => setState(() => _nonStock = v),
      ),
      if (parent != null)
        Text('Sells from ${parent.name}: each one takes ${fmtQty(me!.ratio ?? 0)} of it. Change that from ${parent.name}’s Child products.',
            key: const Key('editor-sells-from')),
      if (_isNew)
        Text('A recipe can be added once the product is saved.', style: Theme.of(context).textTheme.bodySmall)
      else
        _recipePanel(),
    ]);
  }


  Widget _childrenStep() {
    if (_stockLoading) return const Center(child: CircularProgressIndicator());
    final me = _me;
    final parent = me?.parentPlu == null ? null : _all.where((p) => p.pluId == me!.parentPlu).firstOrNull;
    return _pad([
      Text('Halves, glasses and singles sold from this product’s stock.', style: Theme.of(context).textTheme.bodyMedium),
      if (parent != null)
        Text('Sells from ${parent.name}, so it cannot have children of its own.', key: const Key('editor-sells-from'))
      else
        _childPanel(),
    ]);
  }

  Widget _childPanel() {
    final unit = _unitCostNow;
    final taken = {for (final c in _children) if (c.id != null) c.id};
    final parents = {for (final p in _all) if (p.parentPlu != null) p.parentPlu};
    final candidates = _all
        .where((p) => p.pluId != _plu && !taken.contains(p.id) && (p.parentPlu == null || (_plu != null && p.parentPlu == _plu)) && !parents.contains(p.pluId))
        .toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
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

  Widget _modifiers() {
    final set = ref.watch(modifiersProvider).value ?? ModifierSet.empty;
    final chosen = _mods ?? (_plu == null ? <int>[] : (set.byPlu[_plu] ?? const <int>[]));
    final byId = {for (final g in set.groups) g.id: g};
    final left = set.groups.where((g) => !chosen.contains(g.id)).toList()..sort((a, b) => a.name.compareTo(b.name));
    void change(List<int> next) => setState(() => _mods = next);
    return _pad([
      Text('The questions the till asks when this is rung up, in order. They are the QR menu’s add-ons too.', style: Theme.of(context).textTheme.bodyMedium),
      if (chosen.isEmpty) const Text('None yet.'),
      for (var i = 0; i < chosen.length; i++)
        Card(
          key: ValueKey('mod-${chosen[i]}'),
          margin: EdgeInsets.zero,
          child: ListTile(
            leading: CircleAvatar(radius: 14, child: Text('${i + 1}')),
            title: Text(byId[chosen[i]]?.name ?? 'A question that has been deleted'),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              IconButton(tooltip: 'Up', onPressed: i == 0 ? null : () => change([...chosen]..insert(i - 1, chosen[i])..removeAt(i + 1)), icon: const Icon(Icons.arrow_upward)),
              IconButton(tooltip: 'Down', onPressed: i == chosen.length - 1 ? null : () => change([...chosen]..insert(i + 2, chosen[i])..removeAt(i)), icon: const Icon(Icons.arrow_downward)),
              IconButton(tooltip: 'Remove', onPressed: () => change([...chosen]..removeAt(i)), icon: const Icon(Icons.close, color: Pos.red)),
            ]),
          ),
        ),
      if (set.groups.isEmpty)
        const Text('No questions yet. They are written in the back office, under Programming › Modifiers.')
      else
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final g in left)
            ActionChip(key: Key('mod-add-${g.id}'), avatar: const Icon(Icons.add, size: 18), label: Text(g.name), onPressed: () => change([...chosen, g.id])),
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
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (var n = 1; n <= 6; n++)
            FilterChip(
              key: Key('route-kp$n'),
              label: Text('KP $n'),
              selected: _routes.contains('kp$n'),
              onSelected: (on) => setState(() => on ? _routes.add('kp$n') : _routes.remove('kp$n')),
            ),
        ]),
      ]);

  Widget _tiles(String title, Map<String, String> options, Set<String> chosen, String keyPrefix) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in options.entries)
              FilterChip(
                key: Key('$keyPrefix-${e.key}'),
                label: Text(e.value),
                selected: chosen.contains(e.key),
                selectedColor: Pos.brand.withValues(alpha: 0.3),
                onSelected: (on) => setState(() {
                  _allergensSeen = true;
                  on ? chosen.add(e.key) : chosen.remove(e.key);
                }),
              ),
          ]),
        ],
      );

  Widget _allergenStep() {
    final served = ref.watch(allergenLabelsProvider).value ?? const <String, String>{};
    final labels = served.isEmpty ? allergenFallback : served;
    return _pad([
      Text('Shown on the QR menu, the kiosk, kitchen tickets and the customer display. Saving with none ticked records that it contains none of them.',
          style: Theme.of(context).textTheme.bodyMedium),
      _tiles('Contains', labels, _allergens, 'allergen'),
      _tiles('May contain traces of', labels, _mayContain, 'trace'),
      _tiles('Suitable for', dietaryLabels, _dietary, 'diet'),
    ]);
  }

  Widget _information() {
    final pages = (ref.watch(screensProvider).value ?? ScreenSet.empty).screens.where((x) => x.surface == ScreenSurface.sale).toList();
    final pictures = {
      for (final p in widget.catalogue)
        if (p.imageUrl?.isNotEmpty ?? false) p.imageUrl!,
    }.toList();
    return _pad([
      TextField(
        key: const Key('editor-description'),
        controller: _description,
        minLines: 4,
        maxLines: 8,
        decoration: const InputDecoration(
          labelText: 'Description',
          hintText: 'Ingredients, serving suggestions, what makes it special…',
          helperText: 'Shown on the QR menu and the kiosk. A blank line starts a new paragraph.',
          alignLabelWithHint: true,
          border: OutlineInputBorder(),
        ),
      ),
      _pair(
        TextField(key: const Key('editor-calories'), controller: _calories, keyboardType: TextInputType.number, inputFormatters: [FilteringTextInputFormatter.digitsOnly], decoration: const InputDecoration(labelText: 'Calories', suffixText: 'kcal', border: OutlineInputBorder())),
        DropdownButtonFormField<int?>(
          key: const Key('editor-place'),
          initialValue: _placeOn,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Add to a till page', helperText: 'A key in the first free space on that page.', border: OutlineInputBorder()),
          items: [
            DropdownMenuItem(value: null, child: Text(pages.isEmpty ? 'No sale pages yet' : 'Not now')),
            for (final s in pages) DropdownMenuItem(value: s.id, child: Text(s.name)),
          ],
          onChanged: (v) => setState(() => _placeOn = v),
        ),
      ),
      Text('Picture', style: Theme.of(context).textTheme.titleSmall),
      SizedBox(
        height: 104,
        child: ListView(scrollDirection: Axis.horizontal, children: [
          _pictureTile(null),
          for (final url in pictures) _pictureTile(url),
        ]),
      ),
      Text('Pick one the venue already has. New pictures are cropped and uploaded in the back office, so every till, the kiosk and the QR menu get the same one.',
          style: Theme.of(context).textTheme.bodySmall),
    ]);
  }

  Widget _pictureTile(String? url) {
    final on = _image == url || (url == null && (_image == null || _image!.isEmpty));
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: InkWell(
        onTap: () => setState(() => _image = url),
        borderRadius: BorderRadius.circular(10),
        child: Container(
          width: 140,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: on ? Pos.brand : Theme.of(context).colorScheme.outlineVariant, width: on ? 3 : 1),
          ),
          clipBehavior: Clip.antiAlias,
          child: url == null
              ? const Center(child: Text('No picture'))
              : Image.network(url, fit: BoxFit.cover, errorBuilder: (_, _, _) => const Center(child: Icon(Icons.broken_image_outlined))),
        ),
      ),
    );
  }

  Widget _review() {
    final served = ref.watch(allergenLabelsProvider).value ?? const <String, String>{};
    final labels = served.isEmpty ? allergenFallback : served;
    final set = ref.watch(modifiersProvider).value ?? ModifierSet.empty;
    final mods = _mods ?? (_plu == null ? <int>[] : (set.byPlu[_plu] ?? const <int>[]));
    final names = {for (final g in set.groups) g.id: g.name};
    String words(Iterable<String> codes, Map<String, String> l) => codes.map((c) => l[c] ?? c).join(', ');
    final pack = _packs.where((k) => k.id == _packId).firstOrNull;
    final supplier = _suppliers.where((x) => x.id == _supplierId).firstOrNull;
    final pages = (ref.watch(screensProvider).value ?? ScreenSet.empty).screens;
    final cards = <(_Step, List<(String, String)>)>[
      (_Step.details, [
        ('Name', _name.text.trim()),
        ('Short description', _short.text.trim()),
        ('Department', [?_dept, ?_group].join(' › ')),
        (_weighted ? 'Price per kg' : 'Price', _price.text.trim().isEmpty ? '' : '£${_price.text.trim()}'),
        ('VAT', '${_vat.text.trim()}%'),
        ('Barcode', _barcode.text.trim()),
        for (var i = 0; i < 5; i++)
          if (_levels[i].text.trim().isNotEmpty) (ref.read(priceLevelNamesProvider).nameFor(i + 2), '£${_levels[i].text.trim()}'),
        if (_attachedOnly) ('Sold', 'Attached to another item only'),
      ]),
      (_Step.stock, [
        ('Case size', pack?.label ?? ''),
        ('Supplier', [?supplier?.name, if (_supplierCode.text.trim().isNotEmpty) _supplierCode.text.trim()].join(' · ')),
        ('Unit cost', _unitCostNow == null ? '' : '£${_unitCostNow!.toStringAsFixed(2)}'),
        ('Min / max', [_minStock.text.trim(), _maxStock.text.trim()].where((x) => x.isNotEmpty).join(' / ')),
        if (_nonStock) ('Stock', 'Non-stock item'),
      ]),
      (_Step.modifiers, [if (mods.isNotEmpty) ('Asks', mods.map((id) => names[id] ?? '?').join(', '))]),
      (_Step.printing, [('Receipt', _onReceipt ? 'Shown' : 'Hidden'), ('Kitchen', _routes.map((r) => r.toUpperCase()).join(', '))]),
      (_Step.children, [if (_children.isNotEmpty) ('Children', _children.map((c) => c.name).join(', '))]),
      (_Step.allergens, [
        ('Contains', _allergensSeen ? (_allergens.isEmpty ? 'None' : words(_allergens, labels)) : 'Not answered'),
        ('May contain', words(_mayContain, labels)),
        ('Suitable for', words(_dietary, dietaryLabels)),
      ]),
      (_Step.information, [
        ('Description', _description.text.trim()),
        ('Calories', _calories.text.trim().isEmpty ? '' : '${_calories.text.trim()} kcal'),
        ('Picture', (_image?.isNotEmpty ?? false) ? 'Yes' : ''),
        ('Add to page', pages.where((x) => x.id == _placeOn).firstOrNull?.name ?? ''),
      ]),
    ];
    return LayoutBuilder(builder: (context, box) {
      final cols = box.maxWidth > 900 ? 3 : (box.maxWidth > 560 ? 2 : 1);
      final w = (box.maxWidth - 40 - (cols - 1) * 12) / cols;
      return SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Wrap(spacing: 12, runSpacing: 12, children: [
          for (final (step, rows) in cards)
            SizedBox(
              width: w,
              child: Card(
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Row(children: [
                      Expanded(child: Text(step.label, style: const TextStyle(fontWeight: FontWeight.w700))),
                      TextButton(key: Key('review-${step.name}'), onPressed: () => _go(step), child: const Text('Change')),
                    ]),
                    if (rows.every((r) => r.$2.isEmpty))
                      Text('Nothing set.', style: Theme.of(context).textTheme.bodySmall)
                    else
                      for (final (k, v) in rows)
                        if (v.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              SizedBox(width: 110, child: Text(k, style: Theme.of(context).textTheme.bodySmall)),
                              Expanded(child: Text(v, maxLines: 4, overflow: TextOverflow.ellipsis)),
                            ]),
                          ),
                  ]),
                ),
              ),
            ),
        ]),
      );
    });
  }
}

/// An EAN-13 for a venue's own labels: starts with 2, which GS1 keeps for
/// in-store numbers, and ends in the proper check digit. The back office
/// makes them the same way (makeStoreEan13 in public/app.js).
String storeEan13([Random? random]) {
  final r = random ?? Random.secure();
  final digits = [2, for (var i = 0; i < 11; i++) r.nextInt(10)];
  var sum = 0;
  for (var i = 0; i < 12; i++) {
    sum += digits[i] * (i.isOdd ? 3 : 1);
  }
  digits.add((10 - sum % 10) % 10);
  return digits.join();
}
