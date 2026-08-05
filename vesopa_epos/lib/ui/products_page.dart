import 'package:drift/drift.dart' show Value;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../data/local/database.dart';
import '../main.dart';
import 'widgets/pos_message.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

/// Every product on this terminal, live from the local catalogue.
final _productsProvider = StreamProvider<List<Product>>((ref) {
  final db = ref.watch(databaseProvider);
  return db.select(db.products).watch();
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
          if (!_filter.matches(p)) return false;
          if (_search.isEmpty) return true;
          final q = _search.toLowerCase();
          return p.name.toLowerCase().contains(q) ||
              p.pluId.toString().contains(q) ||
              (p.departmentName?.toLowerCase().contains(q) ?? false);
        }).toList()
          ..sort((a, b) => a.name.compareTo(b.name));

        return Column(
          children: [
            _Summary(products: all, onFilter: (f) => setState(() => _filter = f),
                active: _filter),
            _Toolbar(
              search: _search,
              onSearch: (v) => setState(() => _search = v),
              departments: departments,
              department: _department,
              onDepartment: (v) => setState(() => _department = v),
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
                        onEdit: () => _edit(visible[i]),
                        onStock: () => _adjustStock(visible[i]),
                      ),
                    ),
            ),
          ],
        );
      },
    );
  }

  Future<void> _edit(Product product) async {
    final result = await showDialog<_ProductEdit>(
      context: context,
      builder: (_) => _ProductDialog(product: product),
    );
    if (result == null) return;

    final db = ref.read(databaseProvider);
    await (db.update(db.products)..where((t) => t.pluId.equals(product.pluId)))
        .write(
      ProductsCompanion(
        priceMinor: Value(result.priceMinor),
        stockQuantity: Value(result.stockQuantity),
        taxPercentage: Value(result.taxPercentage),
        printerRoute: Value(result.printerRoute),
      ),
    );

    if (mounted) {
      PosMessenger.success(
        context,
        '${product.name} updated on this terminal',
      );
    }
  }

  /// Adding stock is the single most common thing a manager does at the till,
  /// so it gets its own one-tap path rather than living inside a form.
  Future<void> _adjustStock(Product product) async {
    final added = await showDialog<double>(
      context: context,
      builder: (_) => _StockDialog(product: product),
    );
    if (added == null) return;

    final db = ref.read(databaseProvider);
    await (db.update(db.products)..where((t) => t.pluId.equals(product.pluId)))
        .write(ProductsCompanion(
      stockQuantity: Value(product.stockQuantity + added),
    ));
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

  bool matches(Product p) => switch (this) {
        _ProductFilter.all => true,
        // "Low" is a soft threshold; the till has no per-product level, so a
        // small positive count is the useful signal.
        _ProductFilter.lowStock =>
          p.stockQuantity > 0 && p.stockQuantity <= 5,
        _ProductFilter.outOfStock => p.stockQuantity <= 0,
        _ProductFilter.noPrice => p.priceMinor <= 0,
        _ProductFilter.unassigned => p.buttonPosition == null,
      };
}

/// Headline counts, each one a filter. The numbers are the point: a manager
/// wants to know what is about to run out, not read a table to find it.
class _Summary extends StatelessWidget {
  const _Summary({
    required this.products,
    required this.onFilter,
    required this.active,
  });

  final List<Product> products;
  final void Function(_ProductFilter) onFilter;
  final _ProductFilter active;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final value = products.fold<double>(
        0, (s, p) => s + (p.priceMinor * p.stockQuantity));

    final cards = <(_ProductFilter, String, Color)>[
      (_ProductFilter.all, '${products.length}', scheme.primary),
      (
        _ProductFilter.lowStock,
        '${products.where(_ProductFilter.lowStock.matches).length}',
        Colors.orange,
      ),
      (
        _ProductFilter.outOfStock,
        '${products.where(_ProductFilter.outOfStock.matches).length}',
        scheme.error,
      ),
      (
        _ProductFilter.noPrice,
        '${products.where(_ProductFilter.noPrice.matches).length}',
        scheme.tertiary,
      ),
      (
        _ProductFilter.unassigned,
        '${products.where(_ProductFilter.unassigned.matches).length}',
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
  });

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
        ],
      ),
    );
  }
}

/// One product, showing everything the terminal knows about it.
class _ProductRow extends StatelessWidget {
  const _ProductRow({
    required this.product,
    required this.onEdit,
    required this.onStock,
  });

  final Product product;
  final VoidCallback onEdit;
  final VoidCallback onStock;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final out = product.stockQuantity <= 0;
    final low = !out && product.stockQuantity <= 5;

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
                        if (product.printerRoute?.isNotEmpty ?? false)
                          _Tag('→ ${product.printerRoute}',
                              icon: Icons.print_outlined),
                        if (product.buttonPosition == null)
                          _Tag('No button', tone: scheme.outline),
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
                      out
                          ? 'Out'
                          : product.stockQuantity
                              .toStringAsFixed(
                                  product.stockQuantity % 1 == 0 ? 0 : 1),
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
                        value: (product.stockQuantity / 20).clamp(0.0, 1.0),
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

              IconButton(
                onPressed: onStock,
                icon: const Icon(Icons.add_box_outlined),
                tooltip: 'Add stock',
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
class _ProductEdit {
  const _ProductEdit({
    required this.priceMinor,
    required this.stockQuantity,
    required this.taxPercentage,
    this.printerRoute,
  });

  final int priceMinor;
  final double stockQuantity;
  final double taxPercentage;
  final String? printerRoute;
}

class _ProductDialog extends StatefulWidget {
  const _ProductDialog({required this.product});

  final Product product;

  @override
  State<_ProductDialog> createState() => _ProductDialogState();
}

class _ProductDialogState extends State<_ProductDialog> {
  late final _price = TextEditingController(
      text: (widget.product.priceMinor / 100).toStringAsFixed(2));
  late final _stock = TextEditingController(
      text: widget.product.stockQuantity.toStringAsFixed(
          widget.product.stockQuantity % 1 == 0 ? 0 : 2));
  late final _tax = TextEditingController(
      text: widget.product.taxPercentage.toStringAsFixed(
          widget.product.taxPercentage % 1 == 0 ? 0 : 1));
  late String? _route = widget.product.printerRoute;

  @override
  void dispose() {
    _price.dispose();
    _stock.dispose();
    _tax.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.product.name),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('PLU ${widget.product.pluId}',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 14),
            TextField(
              controller: _price,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                  labelText: 'Price', prefixText: '£ '),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _stock,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Stock on hand'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _tax,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                  labelText: 'VAT rate', suffixText: '%'),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String?>(
              initialValue: _route,
              decoration: const InputDecoration(labelText: 'Kitchen printer'),
              items: const [
                DropdownMenuItem(value: null, child: Text('Not sent to kitchen')),
                DropdownMenuItem(value: 'kitchen', child: Text('Kitchen')),
                DropdownMenuItem(value: 'bar', child: Text('Bar')),
              ],
              onChanged: (v) => setState(() => _route = v),
            ),
            const SizedBox(height: 14),
            Text(
              'Changes apply to this terminal and sync to the back office. '
              'Names, departments and buttons are set in the back office.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(
            context,
            _ProductEdit(
              priceMinor:
                  ((double.tryParse(_price.text) ?? 0) * 100).round(),
              stockQuantity: double.tryParse(_stock.text) ?? 0,
              taxPercentage: double.tryParse(_tax.text) ?? 0,
              printerRoute: _route,
            ),
          ),
          child: const Text('Save'),
        ),
      ],
    );
  }
}

class _StockDialog extends StatefulWidget {
  const _StockDialog({required this.product});

  final Product product;

  @override
  State<_StockDialog> createState() => _StockDialogState();
}

class _StockDialogState extends State<_StockDialog> {
  double _add = 1;

  @override
  Widget build(BuildContext context) {
    final after = widget.product.stockQuantity + _add;
    return AlertDialog(
      title: Text('Add stock — ${widget.product.name}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('On hand now: ${widget.product.stockQuantity.toStringAsFixed(0)}'),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            children: [
              for (final n in [1.0, 5.0, 10.0, 24.0, 50.0])
                ChoiceChip(
                  label: Text('+${n.toStringAsFixed(0)}'),
                  selected: _add == n,
                  onSelected: (_) => setState(() => _add = n),
                ),
            ],
          ),
          const SizedBox(height: 14),
          Text('After: ${after.toStringAsFixed(0)}',
              style: Theme.of(context)
                  .textTheme
                  .titleMedium
                  ?.copyWith(fontWeight: FontWeight.bold)),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, _add),
          child: const Text('Add'),
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
