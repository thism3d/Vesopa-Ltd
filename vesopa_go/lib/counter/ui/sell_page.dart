/// The sale screen: categories down the side, the items as big coloured
/// keys, and the sale's last line with View Sale and Pay along the bottom --
/// TouchPoint Lite's layout, so a bar team that knows one knows the other.
///
/// On a tablet (840 wide and up) the sale stands in its own column beside
/// the items, as the till does, and Pay sits under it.
library;

import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/pages/note_sheet.dart';
import 'package:vesopa_go/ui/layout_editor.dart';
import 'package:vesopa_go/ui/photo_menu.dart';
import 'package:vesopa_go/ui/programmed_grid.dart';
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

  /// Long press: a manager can change the photo and price; anyone else (and a
  /// manager who chooses to) gets the choices and a note.
  Future<void> _longPress(Product p) async {
    final s = ref.read(tapProvider);
    final manager = s.clerk?.can(TillPermission.isManager) ?? false;
    if (!manager) return _pressLong(p);
    final what = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.edit_rounded), title: const Text('Change photo and price'), onTap: () => Navigator.pop(c, 'edit')),
          if (s.config.go.noteLongPress)
            ListTile(leading: const Icon(Icons.edit_note_rounded), title: const Text('Add with choices and a note'), onTap: () => Navigator.pop(c, 'note')),
        ]),
      ),
    );
    if (!mounted || what == null) return;
    if (what == 'edit') {
      await editProduct(context, ref, p);
    } else {
      await _pressLong(p);
    }
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

  /// The programmed screen on show, once the clerk has left the home screen.
  int? _screenId;

  void _function(String key) {
    switch (key) {
      case 'pay':
        _pay();
      case 'sign_on' || 'display_lock':
        ref.read(tapProvider.notifier).lock();
      case 'note':
        final id = ref.read(currentSaleProvider);
        final bill = id == null ? null : ref.read(tapProvider).bills[id];
        final last = bill?.lines.where((l) => !l.sent).lastOrNull;
        if (last != null) {
          askNote(context, ref, title: last.product.name, initial: last.note)
              .then((n) => n == null ? null : ref.read(tapProvider.notifier).setNote(bill!.id, last.id, n));
        }
    }
  }

  /// The venue's programmed screens, as the till lays them out: the top bar,
  /// the screen, the bottom bar.
  Widget _programmed(TapState s, TillScreen home) {
    final config = s.config;
    final form = formOf(context);
    final screen = withGoLayout(config.screens.byId(_screenId) ?? home, config, form);
    final top = config.screens.barFor(screen, ScreenSurface.topBar, config.topBarScreenId);
    final bottom = config.screens.barFor(screen, ScreenSurface.bottomBar, config.bottomBarScreenId);
    final byPlu = {for (final p in s.products) if (p.plu != null) p.plu!: p};
    Widget grid(TillScreen sc) => ProgrammedGrid(
          screen: sc,
          screens: config.screens,
          productsByPlu: byPlu,
          onProduct: _press,
          onProductLong: _longPressFor(s),
          photoFor: config.go.productImages ? (p) => photoOf(s, p) : null,
          onPage: (t) => setState(() => _screenId = t.id),
          onFunction: _function,
        );
    return Padding(
      padding: const EdgeInsets.all(8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        // A manager can rearrange this screen for this kind of device.
        if (config.go.allowRearrange && (s.clerk?.can(TillPermission.isManager) ?? false))
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => LayoutEditorPage(screen: screen, form: form))),
              icon: const Icon(Icons.dashboard_customize_rounded, size: 18),
              label: const Text('Arrange'),
            ),
          ),
        if (top != null && barHasKeys(top)) ...[SizedBox(height: 64.0 * top.rows, child: grid(top)), const SizedBox(height: 8)],
        Expanded(
          child: AnimatedSwitcher(duration: const Duration(milliseconds: 180), child: KeyedSubtree(key: ValueKey(screen.id), child: grid(screen))),
        ),
        if (bottom != null && barHasKeys(bottom)) ...[const SizedBox(height: 8), SizedBox(height: 64.0 * bottom.rows, child: grid(bottom))],
      ]),
    );
  }

  /// Long press on an item: a manager's photo-and-price sheet, else the
  /// choices and a note when the venue allows it.
  ValueChanged<Product>? _longPressFor(TapState s) =>
      (s.clerk?.can(TillPermission.isManager) ?? false) || s.config.go.noteLongPress ? _longPress : null;

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final home = s.config.home;
    // Each kind of device has its own sale screen (owner, 2026-10-28): phones
    // show photo buttons by section, since the till's programmed screens are
    // too small to read there; iPads and tablets show the till's screens.
    // The back office can change either (Vesopa Go options > Screens).
    final form = formOf(context);
    final tillScreens = form == 'tablet' ? s.config.go.screensTablet == 'till' : s.config.go.screensPhone == 'till';
    if (home != null && tillScreens) {
      return LayoutBuilder(builder: (context, box) {
        final screens = _programmed(s, home);
        if (box.maxWidth >= 840) {
          return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Expanded(child: screens),
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
          Expanded(child: screens),
          _SaleBar(onView: _viewSale, onPay: _pay),
        ]);
      });
    }
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

    // Photos on every button, laid out for each device (photo_menu.dart).
    final longPress = _longPressFor(s);
    void pick(String id) => setState(() => _category = id);
    return LayoutBuilder(builder: (context, box) {
      final wide = box.maxWidth >= 840;
      final tablet = form == 'tablet';
      final iphone = !tablet && defaultTargetPlatform == TargetPlatform.iOS;
      if (iphone) {
        final cat = categories.firstWhere((c) => c.id == selected);
        return Stack(children: [
          Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
              child: Text(cat.name, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w800, letterSpacing: -0.5)),
            ),
            PhotoChips(categories: categories, selected: selected, onSelect: pick),
            const SizedBox(height: 6),
            Expanded(child: PhotoGrid(items: items, tint: colour, columns: 2, square: true, bottomPad: 96, onPress: _press, onLongPress: longPress)),
          ]),
          Positioned(left: 12, right: 12, bottom: 12, child: SafeArea(top: false, child: _FloatingSale(onView: _viewSale, onPay: _pay))),
        ]);
      }
      final grid = PhotoGrid(items: items, tint: colour, columns: wide || tablet ? 0 : 2, onPress: _press, onLongPress: longPress);
      final rail = PhotoRail(categories: categories, selected: selected, onSelect: pick, width: wide || tablet ? 96 : 84);
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

/// The iPhone's sale, floating at the bottom within thumb reach.
class _FloatingSale extends ConsumerWidget {
  const _FloatingSale({required this.onView, required this.onPay});
  final VoidCallback onView;
  final VoidCallback onPay;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = ref.watch(currentSaleProvider);
    final bill = ref.watch(tapProvider.select((s) => id == null ? null : s.bills[id]));
    final count = bill?.lines.fold<int>(0, (n, l) => n + l.quantity) ?? 0;
    final due = bill?.dueMinor ?? 0;
    return Material(
      color: const Color(0xEB232320),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22), side: const BorderSide(color: Tp.inkLine)),
      child: InkWell(
        borderRadius: BorderRadius.circular(22),
        onTap: count == 0 ? null : onView,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
          child: Row(children: [
            Expanded(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(count == 0 ? 'Tap an item to start a sale' : 'This sale · $count item${count == 1 ? '' : 's'}', style: const TextStyle(color: Tp.muted, fontSize: 12)),
                Money(due, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
              ]),
            ),
            FilledButton(
              key: const ValueKey('pay'),
              style: FilledButton.styleFrom(minimumSize: const Size(96, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16))),
              onPressed: count == 0 ? null : onPay,
              child: const Text('Pay'),
            ),
          ]),
        ),
      ),
    );
  }
}
