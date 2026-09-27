import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/local/database.dart';
import '../data/stock_api.dart';
import '../main.dart';
import '../printing/printer_transport.dart';
import 'product_editor.dart';
import 'stock_widgets.dart';
import 'widgets/pos_message.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// Every product on this terminal, live from the local catalogue.
final _productsProvider = StreamProvider<List<Product>>((ref) {
  final db = ref.watch(databaseProvider);
  return db.select(db.products).watch();
});

/// Each product's stock as the back office's ledger has it, by PLU, with the
/// venue's case sizes (2026-09-27). The till's own stockQuantity was only ever
/// this till's copy; a child, a recipe or a non-stock product read as "Out of
/// stock" from it (found by the end-to-end check). Empty when offline, and
/// the page falls back to what the till holds.
final _stockProvider = FutureProvider.autoDispose<({Map<int, StockProduct> byPlu, List<PackSize> packs})>((ref) async {
  final api = ref.watch(stockApiProvider);
  final r = await Future.wait([api.products(), api.packSizes()]);
  return (
    byPlu: {for (final p in r[0] as List<StockProduct>) p.pluId: p},
    packs: r[1] as List<PackSize>,
  );
});

/// The product catalogue as the till holds it.
///
/// Replaces the placeholder that only described what products do. The
/// catalogue is owned by the back office and synced down, so this shows
/// everything the terminal actually knows — price, VAT, stock, routing,
/// button position — and lets a manager fix the things that go wrong
/// mid-service (a price, a stock count) without walking to a computer.
///
/// Edits are written locally and pushed on the next sync, which matches how
/// the rest of the till behaves: the floor never waits on the network.
class ProductsPage extends ConsumerStatefulWidget {
  const ProductsPage({super.key});

  @override
  ConsumerState<ProductsPage> createState() => _ProductsPageState();
}

class _ProductsPageState extends ConsumerState<ProductsPage> {
  String _search = '';
  String? _department;
  _ProductFilter _filter = _ProductFilter.all;

  @override
  Widget build(BuildContext context) {
    final products = ref.watch(_productsProvider);
    final stockData = ref.watch(_stockProvider).value;
    final stock = stockData?.byPlu ?? const <int, StockProduct>{};
    final packs = stockData?.packs ?? const <PackSize>[];

    return products.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => _ErrorState(message: '$e'),
      data: (all) {
        final departments = {
          for (final p in all)
            if (p.departmentName?.isNotEmpty ?? false) p.departmentName!,
        }.toList()
          ..sort();

        final visible = all.where((p) {
          if (_department != null && p.departmentName != _department) {
            return false;
          }
          if (!_filter.matches(p, stock[p.pluId])) return false;
          if (_search.isEmpty) return true;
          final q = _search.toLowerCase();
          return p.name.toLowerCase().contains(q) ||
              p.pluId.toString().contains(q) ||
              (p.departmentName?.toLowerCase().contains(q) ?? false);
        }).toList()
          ..sort((a, b) => a.name.compareTo(b.name));

        return Column(
          children: [
            _Summary(products: all, stock: stock, onFilter: (f) => setState(() => _filter = f),
                active: _filter),
            _Toolbar(
              search: _search,
              onSearch: (v) => setState(() => _search = v),
              departments: departments,
              department: _department,
              onDepartment: (v) => setState(() => _department = v),
              onApplyCase: stock.isEmpty ? null : () => _applyCase(stock, packs),
            ),
            Expanded(
              child: visible.isEmpty
                  ? const _EmptyState()
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                      itemCount: visible.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 6),
                      itemBuilder: (_, i) => _ProductRow(
                        product: visible[i],
                        stock: stock[visible[i].pluId],
                        parentName: stock[visible[i].pluId]?.parentPlu == null
                            ? null
                            : stock[stock[visible[i].pluId]!.parentPlu!]?.name,
                        packs: packs,
                        onCase: (id) => _setCase(stock[visible[i].pluId]!, id),
                        onEdit: () => _edit(visible[i], all),
                        onStock: () => _adjustStock(visible[i], stock[visible[i].pluId]),
                      ),
                    ),
            ),
          ],
        );
      },
    );
  }

  /// The product editor, under headings, saving to the back office for
  /// every till (product_editor.dart). It replaced a dialog whose changes
  /// stayed on this till until the next sync put the old values back.
  Future<void> _edit(Product product, List<Product> catalogue) async {
    final saved = await showProductEditor(context, product: product, catalogue: catalogue);
    if (!saved) return;
    await ref.read(syncServiceProvider).pullCatalogue();
    ref.invalidate(_stockProvider);
  }

  /// A case size from the row's dropdown, saved on the product at once.
  Future<void> _setCase(StockProduct p, int? packId) async {
    try {
      await ref.read(stockApiProvider).patchProduct(p.id, {'pack_size_id': packId});
      ref.invalidate(_stockProvider);
      if (mounted) PosMessenger.success(context, '${p.name}: case size saved.');
    } catch (e) {
      if (mounted) PosMessenger.error(context, '$e');
    }
  }

  /// "Mass-apply case sizes": pick one, then the products it applies to.
  Future<void> _applyCase(Map<int, StockProduct> stock, List<PackSize> packs) async {
    final pack = await showDialog<PackSize?>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Apply which case size?'),
        children: [
          for (final k in packs)
            SimpleDialogOption(onPressed: () => Navigator.pop(context, k), child: Text(k.label)),
        ],
      ),
    );
    if (pack == null || !mounted) return;
    final chosen = await showProductChooser(context, products: stock.values.toList(), title: 'Give ${pack.label} to…');
    if (chosen.isEmpty) return;
    try {
      final r = await ref.read(stockApiProvider).patchMany([for (final p in chosen) p.id], {'pack_size_id': pack.id});
      ref.invalidate(_stockProvider);
      if (mounted) {
        PosMessenger.success(context, '${pack.label} given to ${r.updated} product${r.updated == 1 ? '' : 's'}${r.refused.isEmpty ? '' : ' · ${r.refused.length} refused'}.');
      }
    } catch (e) {
      if (mounted) PosMessenger.error(context, '$e');
    }
  }

  /// Book stock in, or set the count -- through the back office's ledger, by
  /// the case or by the unit. It used to add to this till's copy only.
  Future<void> _adjustStock(Product product, StockProduct? stock) async {
    if (stock == null) {
      return PosMessenger.error(context, 'Stock needs the back office, and it cannot be reached. Nothing was changed.');
    }
    if (stock.isLinked || stock.isRecipe) {
      return PosMessenger.info(context, '${stock.name} has no shelf of its own — its stock is ${stock.isLinked ? 'its parent product' : 'its ingredients'}.');
    }
    final r = await showDialog<({String kind, double quantity})>(
      context: context,
      builder: (_) => _StockDialog(product: stock),
    );
    if (r == null || !mounted) return;
    try {
      await ref.read(stockApiProvider).quickDoc(kind: r.kind, pluId: stock.pluId, quantity: r.quantity);
      ref.invalidate(_stockProvider);
      if (mounted) {
        PosMessenger.success(context, r.kind == 'delivery' ? '${fmtQty(r.quantity)} ${stock.name} booked in.' : '${stock.name}: count set to ${fmtQty(r.quantity)}.');
      }
    } catch (e) {
      if (mounted) PosMessenger.error(context, '$e');
    }
  }
}

enum _ProductFilter {
  all('All'),
  lowStock('Low stock'),
  outOfStock('Out of stock'),
  noPrice('No price'),
  unassigned('No button');

  const _ProductFilter(this.label);
  final String label;

  /// [s] is the ledger's view when the back office can be reached: its level
  /// decides low and out, and a product with no shelf of its own (a child, a
  /// recipe, a non-stock or untracked product) is never "out".
  bool matches(Product p, [StockProduct? s]) => switch (this) {
        _ProductFilter.all => true,
        _ProductFilter.lowStock => s != null ? s.level == 'low' : p.stockQuantity > 0 && p.stockQuantity <= 5,
        _ProductFilter.outOfStock => s != null ? s.level == 'out' && !s.isLinked && !s.isRecipe && !s.nonStock : p.stockQuantity <= 0,
        _ProductFilter.noPrice => p.priceMinor <= 0,
        _ProductFilter.unassigned => p.buttonPosition == null,
      };
}

/// Headline counts, each one a filter. The numbers are the point: a manager
/// wants to know what is about to run out, not read a table to find it.
class _Summary extends StatelessWidget {
  const _Summary({
    required this.products,
    required this.stock,
    required this.onFilter,
    required this.active,
  });

  final List<Product> products;
  final Map<int, StockProduct> stock;
  final void Function(_ProductFilter) onFilter;
  final _ProductFilter active;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // At cost from the ledger, as the back office values it; the till's own
    // copy at retail only when the back office cannot be reached.
    final value = stock.isNotEmpty
        ? stock.values.fold<double>(0, (a, p) => a + (p.tracked ? (p.stock ?? 0) * p.unitCostMinor : 0))
        : products.fold<double>(0, (s, p) => s + (p.priceMinor * p.stockQuantity));

    final cards = <(_ProductFilter, String, Color)>[
      (_ProductFilter.all, '${products.length}', scheme.primary),
      (
        _ProductFilter.lowStock,
        '${products.where((p) => _ProductFilter.lowStock.matches(p, stock[p.pluId])).length}',
        Colors.orange,
      ),
      (
        _ProductFilter.outOfStock,
        '${products.where((p) => _ProductFilter.outOfStock.matches(p, stock[p.pluId])).length}',
        scheme.error,
      ),
      (
        _ProductFilter.noPrice,
        '${products.where((p) => _ProductFilter.noPrice.matches(p)).length}',
        scheme.tertiary,
      ),
      (
        _ProductFilter.unassigned,
        '${products.where((p) => _ProductFilter.unassigned.matches(p)).length}',
        scheme.outline,
      ),
    ];

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
      child: Row(
        children: [
          for (final (filter, count, colour) in cards) ...[
            _StatCard(
              label: filter.label,
              value: count,
              colour: colour,
              selected: active == filter,
              onTap: () => onFilter(filter),
            ),
            const SizedBox(width: 8),
          ],
          _StatCard(
            label: 'Stock value',
            value: _money(value.round()),
            colour: scheme.secondary,
            onTap: null,
          ),
        ],
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.label,
    required this.value,
    required this.colour,
    this.selected = false,
    this.onTap,
  });

  final String label;
  final String value;
  final Color colour;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: selected ? colour.withValues(alpha: 0.16) : scheme.surface,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          width: 128,
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: selected ? colour : scheme.outlineVariant,
              width: selected ? 1.6 : 1,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label,
                  style: TextStyle(
                      fontSize: 11, color: scheme.onSurfaceVariant)),
              const SizedBox(height: 3),
              Text(value,
                  style: TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w800,
                      color: colour)),
            ],
          ),
        ),
      ),
    );
  }
}

class _Toolbar extends StatelessWidget {
  const _Toolbar({
    required this.search,
    required this.onSearch,
    required this.departments,
    required this.department,
    required this.onDepartment,
    this.onApplyCase,
  });

  final VoidCallback? onApplyCase;
  final String search;
  final void Function(String) onSearch;
  final List<String> departments;
  final String? department;
  final void Function(String?) onDepartment;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Search by name, PLU or department',
                isDense: true,
                border: OutlineInputBorder(),
              ),
              onChanged: onSearch,
            ),
          ),
          if (departments.isNotEmpty) ...[
            const SizedBox(width: 10),
            DropdownButton<String?>(
              value: department,
              hint: const Text('All departments'),
              underline: const SizedBox.shrink(),
              items: [
                const DropdownMenuItem(value: null, child: Text('All departments')),
                for (final d in departments)
                  DropdownMenuItem(value: d, child: Text(d)),
              ],
              onChanged: onDepartment,
            ),
          ],
          if (onApplyCase != null) ...[
            const SizedBox(width: 10),
            OutlinedButton.icon(
              key: const Key('apply-case'),
              onPressed: onApplyCase,
              icon: const Icon(Icons.inventory_2_outlined),
              label: const Text('Apply a case size'),
            ),
          ],
        ],
      ),
    );
  }
}

/// One product, showing everything the terminal knows about it.
class _ProductRow extends ConsumerWidget {
  const _ProductRow({
    required this.product,
    required this.onEdit,
    required this.onStock,
    this.stock,
    this.parentName,
    this.packs = const [],
    this.onCase,
  });

  final Product product;
  final StockProduct? stock;
  final String? parentName;
  final List<PackSize> packs;
  final ValueChanged<int?>? onCase;
  final VoidCallback onEdit;
  final VoidCallback onStock;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = stock;
    // What the stock column says. From the ledger when it is to hand; a
    // product with no shelf of its own says what it is instead of "Out".
    final String? kindLabel = s == null
        ? null
        : s.isLinked
            ? 'From ${parentName ?? 'parent'}'
            : s.isRecipe
                ? 'Recipe'
                : s.nonStock
                    ? 'Non-stock'
                    : !s.tracked
                        ? 'Not tracked'
                        : null;
    final qty = s?.stock ?? product.stockQuantity;
    final out = kindLabel == null && (s != null ? s.level == 'out' : product.stockQuantity <= 0);
    final low = !out && kindLabel == null && (s != null ? s.level == 'low' : product.stockQuantity <= 5);

    return Material(
      color: scheme.surface,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: onEdit,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.all(11),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: out
                  ? scheme.error.withValues(alpha: 0.45)
                  : scheme.outlineVariant,
            ),
          ),
          child: Row(
            children: [
              _Thumb(product: product),
              const SizedBox(width: 12),

              Expanded(
                flex: 3,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      product.name,
                      style: theme.textTheme.bodyLarge
                          ?.copyWith(fontWeight: FontWeight.w600),
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Wrap(
                      spacing: 6,
                      runSpacing: 2,
                      children: [
                        _Tag('PLU ${product.pluId}'),
                        if (product.departmentName?.isNotEmpty ?? false)
                          _Tag(product.departmentName!),
                        if (product.groupName?.isNotEmpty ?? false)
                          _Tag(product.groupName!),
                        // Every station it prints on, not a count: a manager
                        // scanning this list is checking a specific printer.
                        for (final station
                            in KitchenRouting.parse(product.printerRoutes))
                          _Tag(
                            // The venue's own name for the station, where they
                            // have set one in the back office.
                            ref
                                .watch(tillSettingsProvider)
                                .labelForStation(station),
                            icon: Icons.print_outlined,
                          ),
                        if (!product.printToReceipt)
                          _Tag('Not on receipt', tone: scheme.outline),
                        if (product.buttonPosition == null)
                          _Tag('No button', tone: scheme.outline),
                        if (s != null && s.unitCostMinor > 0)
                          _Tag('Unit cost ${_money(s.unitCostMinor)}'),
                        if (s?.supplierName?.isNotEmpty ?? false)
                          _Tag(s!.supplierName!, icon: Icons.local_shipping_outlined),
                      ],
                    ),
                  ],
                ),
              ),

              // Price and VAT.
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _money(product.priceMinor),
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: product.priceMinor <= 0 ? scheme.error : null,
                      ),
                    ),
                    Text(
                      '${product.taxPercentage.toStringAsFixed(
                          product.taxPercentage % 1 == 0 ? 0 : 1)}% VAT',
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),

              // Stock, with a bar that makes a low count obvious at a glance.
              SizedBox(
                width: 92,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      kindLabel ??
                          (out
                              ? 'Out'
                              : qty.toStringAsFixed(qty % 1 == 0 ? 0 : 1)),
                      key: Key('stock-label-${product.pluId}'),
                      textAlign: TextAlign.right,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: out
                            ? scheme.error
                            : low
                                ? Colors.orange.shade800
                                : null,
                      ),
                    ),
                    const SizedBox(height: 3),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(3),
                      child: LinearProgressIndicator(
                        // Scaled against 20 units: beyond that the exact
                        // number matters less than "plenty".
                        value: kindLabel != null ? 0 : (qty / 20).clamp(0.0, 1.0),
                        minHeight: 4,
                        backgroundColor: scheme.surfaceContainerHighest,
                        color: out
                            ? scheme.error
                            : low
                                ? Colors.orange
                                : scheme.primary,
                      ),
                    ),
                  ],
                ),
              ),

              // The case size, changeable from the list (Dylan, 21 Sep).
              if (s != null && onCase != null)
                SizedBox(width: 150, child: CaseSizeDropdown(product: s, packs: packs, onChanged: onCase!)),
              IconButton(
                onPressed: onStock,
                icon: const Icon(Icons.add_box_outlined),
                tooltip: 'Book in stock, or set the count',
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.product});

  final Product product;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final colour = _parseColour(product.buttonColor) ?? scheme.primaryContainer;

    return Container(
      width: 46,
      height: 46,
      decoration: BoxDecoration(
        color: colour.withValues(alpha: 0.22),
        borderRadius: BorderRadius.circular(9),
      ),
      clipBehavior: Clip.antiAlias,
      child: product.imageUrl?.isNotEmpty ?? false
          ? Image.network(
              product.imageUrl!,
              fit: BoxFit.cover,
              // A missing image must not leave a broken box on the till.
              errorBuilder: (_, _, _) => _fallback(product, scheme),
            )
          : _fallback(product, scheme),
    );
  }

  Widget _fallback(Product product, ColorScheme scheme) => Center(
        child: Text(
          product.emoji?.isNotEmpty ?? false
              ? product.emoji!
              : product.name.characters.take(1).toString().toUpperCase(),
          style: TextStyle(
            fontSize: product.emoji?.isNotEmpty ?? false ? 22 : 18,
            fontWeight: FontWeight.w700,
            color: scheme.onSurfaceVariant,
          ),
        ),
      );

  static Color? _parseColour(String? hex) {
    if (hex == null || hex.isEmpty) return null;
    final cleaned = hex.replaceAll('#', '');
    final value = int.tryParse(cleaned, radix: 16);
    if (value == null) return null;
    return Color(cleaned.length <= 6 ? 0xFF000000 | value : value);
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.label, {this.icon, this.tone});

  final String label;
  final IconData? icon;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final colour = tone ?? scheme.onSurfaceVariant;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[
          Icon(icon, size: 11, color: colour),
          const SizedBox(width: 3),
        ],
        Text(label, style: TextStyle(fontSize: 11, color: colour)),
      ],
    );
  }
}

/// What the edit dialog agreed to change.
/// Book stock in, or set the count, by the case or by the unit. Pops the
/// document kind ('delivery' or 'stocktake') and the quantity in units.
class _StockDialog extends StatefulWidget {
  const _StockDialog({required this.product});
  final StockProduct product;
  @override
  State<_StockDialog> createState() => _StockDialogState();
}

class _StockDialogState extends State<_StockDialog> {
  String _kind = 'delivery';
  late final StockLine _line = StockLine(widget.product);

  @override
  Widget build(BuildContext context) {
    final p = widget.product;
    final q = _line.quantity;
    return AlertDialog(
      title: Text(p.name),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(p.tracked ? 'On the shelf now: ${p.stockDisplay}' : 'No count kept yet.'),
          const SizedBox(height: 12),
          SegmentedButton<String>(
            key: const Key('stock-dialog-kind'),
            segments: const [
              ButtonSegment(value: 'delivery', label: Text('Book in a delivery')),
              ButtonSegment(value: 'stocktake', label: Text('Set the count')),
            ],
            selected: {_kind},
            onSelectionChanged: (v) => setState(() => _kind = v.first),
          ),
          const SizedBox(height: 12),
          Align(alignment: Alignment.centerRight, child: CasesUnitsField(line: _line, onChanged: () => setState(() {}), autofocus: true)),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          key: const Key('stock-dialog-ok'),
          onPressed: q == null || (_kind == 'delivery' && q <= 0) || q < 0 ? null : () => Navigator.pop(context, (kind: _kind, quantity: q)),
          child: Text(_kind == 'delivery' ? 'Book in' : 'Set the count'),
        ),
      ],
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.inventory_2_outlined, size: 46, color: scheme.outlineVariant),
          const SizedBox(height: 12),
          Text('Nothing matches',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text('Try a different search or filter.',
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 40, color: scheme.error),
            const SizedBox(height: 12),
            Text('Could not read the catalogue',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(message,
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: scheme.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }
}
