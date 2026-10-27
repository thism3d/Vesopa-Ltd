/// The sale screen: categories down the side, the items as big coloured
/// keys, and the sale's last line with View Sale and Pay along the bottom --
/// TouchPoint Lite's layout, so a bar team that knows one knows the other.
///
/// On a tablet (840 wide and up) the sale stands in its own column beside
/// the items, as the till does, and Pay sits under it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/pages/note_sheet.dart';
import 'package:vesopa_go/ui/product_photo.dart';
import 'package:vesopa_go/ui/sounds.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../data/lite_state.dart';
import 'brand.dart';
import 'pay_page.dart';
import 'product_sheet.dart';
import 'sale_panel.dart';

class SellPage extends ConsumerStatefulWidget {
  const SellPage({super.key});
  @override
  ConsumerState<SellPage> createState() => _SellPageState();
}

class _SellPageState extends ConsumerState<SellPage> {
  String? _category;

  /// Notices never cover Pay: above the phone's sale bar, and on a tablet
  /// under the items only, clear of the sale column.
  EdgeInsets get _noticeMargin => MediaQuery.of(context).size.width >= 840
      ? const EdgeInsets.fromLTRB(96, 0, 380 + 12, 12)
      : EdgeInsets.fromLTRB(12, 0, 12, 128 + MediaQuery.of(context).padding.bottom);

  Future<void> _press(Product p) async {
    final messenger = ScaffoldMessenger.of(context);
    if (p.outOfStock) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(margin: _noticeMargin, content: Text('${p.name} is sold out')));
      return;
    }
    final go = ref.read(tapProvider).config.go;
    final sale = ref.read(currentSaleProvider.notifier);
    if (p.options.isEmpty) {
      sale.add(p);
    } else {
      final picked = await pickOptions(context, p);
      if (picked == null) return;
      sale.add(p, choices: picked.choices, quantity: picked.quantity);
    }
    final warn = p.allergens.isNotEmpty && ref.read(liteSettingsProvider).allergenAlerts && go.allergenAlerts;
    GoSounds.play(go, warn ? GoSound.allergen : GoSound.add);
    if (warn) {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          margin: _noticeMargin,
          backgroundColor: Tp.amber,
          duration: const Duration(seconds: 3),
          content: Row(children: [
            const Icon(Icons.back_hand_rounded, color: Tp.ink),
            const SizedBox(width: 12),
            Expanded(
              child: Text('${p.name} contains ${p.allergens.join(', ')}. Check with the customer.',
                  style: const TextStyle(color: Tp.ink, fontWeight: FontWeight.w700)),
            ),
          ]),
        ));
    }
  }

  /// Long press a key: its choices and how many (the product sheet), then a
  /// note for the kitchen, before it goes on.
  Future<void> _pressLong(Product p) async {
    if (p.outOfStock) return;
    var choices = const <Choice>[];
    var quantity = 1;
    if (p.options.isNotEmpty) {
      final picked = await pickOptions(context, p);
      if (picked == null) return;
      choices = picked.choices;
      quantity = picked.quantity;
    }
    if (!mounted) return;
    final note = await askNote(context, ref, title: p.name);
    if (note == null) return;
    ref.read(currentSaleProvider.notifier).add(p, choices: choices, quantity: quantity, note: note);
    GoSounds.play(ref.read(tapProvider).config.go, GoSound.add);
  }

  void _pay() {
    final id = ref.read(currentSaleProvider);
    if (id == null) return;
    ScaffoldMessenger.of(context).hideCurrentSnackBar();
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PayPage(billId: id)));
  }

  void _viewSale() => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        useSafeArea: true,
        builder: (c) => SizedBox(
          height: MediaQuery.of(c).size.height * 0.75,
          child: SalePanel(
            inSheet: true,
            onPay: () {
              Navigator.pop(c);
              _pay();
            },
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final categories = [
      for (final c in s.categories)
        if (s.products.any((p) => p.category == c.id)) c,
    ];
    if (s.products.isEmpty) {
      return const _EmptyMenu();
    }
    final selected = categories.any((c) => c.id == _category) ? _category! : categories.first.id;
    final colour = Color(categories.firstWhere((c) => c.id == selected).colour);
    final items = [for (final p in s.products) if (p.category == selected) p];

    return LayoutBuilder(builder: (context, box) {
      final wide = box.maxWidth >= 840;
      final grid = _Grid(items: items, colour: colour, onPress: _press, onLongPress: ref.read(tapProvider).config.go.noteLongPress ? _pressLong : null);
      final rail = _Rail(categories: categories, selected: selected, onSelect: (id) => setState(() => _category = id));
      if (wide) {
        return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          rail,
          Expanded(child: grid),
          SizedBox(
            width: 380,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainer,
                border: Border(left: BorderSide(color: Theme.of(context).colorScheme.outlineVariant)),
              ),
              child: SalePanel(onPay: _pay),
            ),
          ),
        ]);
      }
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [rail, Expanded(child: grid)])),
        _SaleBar(onView: _viewSale, onPay: _pay),
      ]);
    });
  }
}

class _Rail extends StatelessWidget {
  const _Rail({required this.categories, required this.selected, required this.onSelect});
  final List<MenuCategory> categories;
  final String selected;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 84,
      decoration: BoxDecoration(color: scheme.surfaceContainer, border: Border(right: BorderSide(color: scheme.outlineVariant))),
      child: ListView(padding: const EdgeInsets.symmetric(vertical: 6), children: [
        for (final c in categories)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
            child: Material(
              color: c.id == selected ? Color(c.colour).withValues(alpha: 0.22) : Colors.transparent,
              borderRadius: BorderRadius.circular(14),
              child: InkWell(
                key: ValueKey('cat-${c.id}'),
                borderRadius: BorderRadius.circular(14),
                onTap: () => onSelect(c.id),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
                  child: Column(children: [
                    Icon(categoryIcon(c.name), color: c.id == selected ? Color(c.colour) : scheme.onSurface.withValues(alpha: 0.75)),
                    const SizedBox(height: 4),
                    Text(c.name,
                        maxLines: 2,
                        textAlign: TextAlign.center,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, height: 1.15, fontWeight: c.id == selected ? FontWeight.w800 : FontWeight.w600)),
                  ]),
                ),
              ),
            ),
          ),
      ]),
    );
  }
}

class _Grid extends StatelessWidget {
  const _Grid({required this.items, required this.colour, required this.onPress, this.onLongPress});
  final List<Product> items;
  final Color colour;
  final ValueChanged<Product> onPress;
  final ValueChanged<Product>? onLongPress;

  @override
  Widget build(BuildContext context) => GridView.builder(
        padding: const EdgeInsets.all(8),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 128, mainAxisExtent: 84, crossAxisSpacing: 8, mainAxisSpacing: 8),
        itemCount: items.length,
        itemBuilder: (_, i) => _Key(product: items[i], colour: colour, onTap: () => onPress(items[i]), onLongPress: onLongPress == null ? null : () => onLongPress!(items[i])),
      );
}

/// One item key: its name, its price, and its category's colour along the
/// bottom, the way a till's keys are colour-coded.
class _Key extends StatelessWidget {
  const _Key({required this.product, required this.colour, required this.onTap, this.onLongPress});
  final Product product;
  final Color colour;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final p = product;
    return Opacity(
      opacity: p.outOfStock ? 0.4 : 1,
      child: Material(
        color: scheme.surfaceContainer,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: scheme.outlineVariant)),
        child: InkWell(
          key: ValueKey('item-${p.id}'),
          onTap: onTap,
          onLongPress: onLongPress,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            ProductPhoto(product: p, tint: colour),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  // The name has the key's whole width: "Fortyniner" never breaks.
                  Text(p.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13.5, height: 1.15, fontWeight: FontWeight.w700)),
                  const Spacer(),
                  Row(children: [
                    Expanded(
                      child: Text(p.outOfStock ? 'Sold out' : money(p.priceMinor),
                          style: TextStyle(fontSize: 12, fontFeatures: Tp.tabular, color: scheme.onSurface.withValues(alpha: 0.7))),
                    ),
                    if (p.allergens.isNotEmpty) const Icon(Icons.back_hand_rounded, size: 13, color: Tp.amber, semanticLabel: 'Has allergens'),
                    if (p.options.isNotEmpty && !p.outOfStock) ...[
                      const SizedBox(width: 4),
                      Icon(Icons.tune_rounded, size: 13, color: scheme.onSurface.withValues(alpha: 0.5), semanticLabel: 'Has choices'),
                    ],
                  ]),
                ]),
              ),
            ),
            Container(height: 4, color: colour),
          ]),
        ),
      ),
    );
  }
}

/// The phone's bottom bar: the last thing rung up, then View Sale and Pay.
class _SaleBar extends ConsumerWidget {
  const _SaleBar({required this.onView, required this.onPay});
  final VoidCallback onView;
  final VoidCallback onPay;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = ref.watch(currentSaleProvider);
    final bill = ref.watch(tapProvider.select((s) => id == null ? null : s.bills[id]));
    final scheme = Theme.of(context).colorScheme;
    final t = Theme.of(context).textTheme;
    final last = bill == null || bill.lines.isEmpty ? null : bill.lines.last;
    final count = bill?.lines.fold<int>(0, (n, l) => n + l.quantity) ?? 0;
    final empty = bill == null || bill.lines.isEmpty;
    return Material(
      color: scheme.surfaceContainer,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            SizedBox(
              height: 24,
              child: last == null
                  ? Align(alignment: Alignment.centerLeft, child: Text('Tap an item to start a sale', style: t.bodySmall))
                  : Row(children: [
                      Expanded(
                        child: Text(
                          '${last.quantity > 1 ? '${last.quantity}× ' : ''}${last.product.name}${last.choices.isEmpty ? '' : ' (${last.choices.map((c) => c.name).join(', ')})'}',
                          overflow: TextOverflow.ellipsis,
                          style: t.bodyMedium,
                        ),
                      ),
                      Money(last.totalMinor, style: t.bodyMedium),
                    ]),
            ),
            const SizedBox(height: 6),
            Row(children: [
              Expanded(
                child: OutlinedButton(
                  key: const ValueKey('view-sale'),
                  onPressed: empty ? null : onView,
                  child: Text(count == 0 ? 'View Sale' : 'View Sale ($count)'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  key: const ValueKey('pay'),
                  onPressed: empty ? null : onPay,
                  child: Text(empty ? 'Pay' : 'Pay ${money(bill.dueMinor)}'),
                ),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}

class _EmptyMenu extends StatelessWidget {
  const _EmptyMenu();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const GoMark(size: 56),
          const SizedBox(height: 16),
          Text('No menu yet', style: t.titleLarge),
          const SizedBox(height: 6),
          Text('Add products and screens in the Vesopa back office and they appear here. '
              'Until then, Quick sale takes a typed amount.',
              textAlign: TextAlign.center, style: t.bodyMedium),
        ]),
      ),
    );
  }
}
