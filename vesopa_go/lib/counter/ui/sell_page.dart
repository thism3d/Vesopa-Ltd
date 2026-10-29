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
import 'package:vesopa_go/ui/pages/customers_page.dart';
import 'package:vesopa_go/ui/pages/module_gates.dart';
import 'package:vesopa_go/ui/pages/tables.dart';
import 'package:vesopa_go/ui/sounds.dart';
import 'package:vesopa_go/ui/theme.dart';

import '../data/lite_state.dart';
import 'brand.dart';
import 'cash_page.dart';
import 'reports_page.dart';
import 'sales_page.dart';
import 'shell.dart' show SettingsPage;
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

  /// One of the venue's own pages, over the sale screen, with a way back.
  void _open(String title, Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => Scaffold(appBar: AppBar(title: Text(title)), body: page),
      ));

  void _say(String text) => ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(margin: _noticeMargin, content: Text(text)));

  Bill? get _bill {
    final id = ref.read(currentSaleProvider);
    return id == null ? null : ref.read(tapProvider).bills[id];
  }

  /// The till's function keys, as Go does them (programmed_grid.dart's
  /// goFunctions lists which).
  Future<void> _function(String key) async {
    final s = ref.read(tapProvider);
    final tapper = ref.read(tapProvider.notifier);
    final standalone = s.venue?.mode == VenueMode.standalone;
    switch (key) {
      case 'pay':
        _pay();
      case 'sign_on' || 'sign_off' || 'display_lock':
        tapper.lock();
      case 'note':
        final bill = _bill;
        final last = bill?.lines.where((l) => !l.sent).lastOrNull;
        if (bill == null || last == null) return _say('Ring something up first.');
        final n = await askNote(context, ref, title: last.product.name, initial: last.note);
        if (n != null) tapper.setNote(bill.id, last.id, n);
      case 'void':
        // The last line still to go; a line the kitchen has is voided from
        // the sale with a reason, as on the till.
        final bill = _bill;
        final last = bill?.lines.where((l) => !l.sent && l.paidQuantity == 0).lastOrNull;
        if (bill == null || last == null) return _say('Nothing to void: a sent line is voided from the sale with a reason.');
        tapper.changeQuantity(bill.id, last.id, -last.quantity);
      case 'cancel' || 'new_bill':
        if (_bill == null) return;
        final cancel = key == 'cancel';
        final ok = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            title: Text(cancel ? 'Cancel this sale?' : 'Start a new bill?'),
            content: const Text('Everything on this sale comes off. Nothing has been taken.'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep it')),
              FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(cancel ? 'Cancel sale' : 'New bill')),
            ],
          ),
        );
        if (ok == true) ref.read(currentSaleProvider.notifier).clear();
      case 'go_sale':
        setState(() => _screenId = null);
      case 'go_tables' || 'table_plan' || 'save_table':
        if (standalone) return _say('Tables are for venues with tills.');
        _open('Tables', const TablesPage());
      case 'go_receipts' || 'last_bill' || 'refund':
        _open('Sales', const SalesPage());
      case 'go_reports':
        _open('Reports', const ReportsPage());
      case 'go_tickets':
        _open('Events & tickets', const EventsGate());
      case 'go_settings':
        _open('Settings', const SettingsPage());
      case 'customer':
        _open('Customers', const CustomersPage());
      case 'open_drawer':
        _open('Cash & stock', const CashPage());
      case 'clock_in_out':
        final clerk = s.clerk;
        if (clerk == null) return;
        final ok = await ref.read(apiProvider).clockIn(clerk.id).catchError((Object _) => false);
        if (mounted) _say(ok ? '${clerk.name}: clocked in or out.' : 'Could not reach the back office to clock in.');
    }
  }

  /// The venue's programmed screens, laid out as the till lays them out: the
  /// top bar across the top, the sale on the left, the screen beside it, and
  /// the bottom bar across the bottom. On a phone the same keys, in the same
  /// order and colours, a few to a row.
  Widget _programmed(TapState s, TillScreen home, {required bool phone}) {
    final config = s.config;
    final form = formOf(context);
    final screen = withGoLayout(config.screens.byId(_screenId) ?? home, config, form);
    final top = config.screens.barFor(screen, ScreenSurface.topBar, config.topBarScreenId);
    final bottom = config.screens.barFor(screen, ScreenSurface.bottomBar, config.bottomBarScreenId);
    final byPlu = {for (final p in s.products) if (p.plu != null) p.plu!: p};
    void page(TillScreen t) => setState(() => _screenId = t.id);
    // One Pay, as on the till: the venue's Pay key when it has one (only
    // with something on the sale), else the sale's own.
    final saleId = ref.watch(currentSaleProvider);
    final bill = saleId == null ? null : s.bills[saleId];
    final hasLines = bill?.lines.isNotEmpty ?? false;
    final payLabel = hasLines ? money(bill!.dueMinor) : null;
    bool hasPay(TillScreen? b) => b != null && keysInOrder(b).any((k) => k.kind == ScreenButtonKind.function && k.functionKey == 'pay');
    final keyedPay = hasPay(top) || hasPay(bottom) || hasPay(screen);
    final actions = KeyActions(
      screens: config.screens,
      productsByPlu: byPlu,
      onProduct: _press,
      onProductLong: _longPressFor(s),
      onPage: page,
      onFunction: _function,
      currentScreenId: screen.id,
      payEnabled: hasLines,
      payLabel: payLabel,
    );
    final grid = AnimatedSwitcher(
      duration: const Duration(milliseconds: 180),
      child: KeyedSubtree(
        key: ValueKey(screen.id),
        child: ProgrammedGrid(
          screen: screen,
          screens: config.screens,
          productsByPlu: byPlu,
          onProduct: _press,
          onProductLong: _longPressFor(s),
          onPage: page,
          onFunction: _function,
          payEnabled: hasLines,
          payLabel: payLabel,
          reflowColumns: phone ? 3 : null,
        ),
      ),
    );
    final arrange = config.go.allowRearrange && (s.clerk?.can(TillPermission.isManager) ?? false);
    Widget bar(TillScreen? b) => b == null || !barHasKeys(b)
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
            child: SizedBox(height: phone ? 56 : 64, child: ProgrammedStrip(bar: b, actions: actions, minKey: phone ? 92 : 104)),
          );
    final heading = Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 4, 0),
      child: Row(children: [
        Expanded(child: Text(screen.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800))),
        if (_screenId != null && _screenId != home.id)
          TextButton.icon(onPressed: () => setState(() => _screenId = null), icon: const Icon(Icons.home_rounded, size: 18), label: Text(home.name)),
        if (arrange)
          IconButton(
            tooltip: 'Arrange this screen',
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => LayoutEditorPage(screen: screen, form: form))),
            icon: const Icon(Icons.dashboard_customize_rounded),
          ),
      ]),
    );
    if (phone) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        bar(top),
        heading,
        Expanded(child: Padding(padding: const EdgeInsets.fromLTRB(8, 6, 8, 0), child: grid)),
        bar(bottom),
        const SizedBox(height: 8),
        _SaleBar(onView: _viewSale, onPay: keyedPay ? null : _pay),
      ]);
    }
    final scheme = Theme.of(context).colorScheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      bar(top),
      Expanded(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          // The sale on the left, as on the till.
          Container(
            width: MediaQuery.sizeOf(context).width >= 1100 ? 380 : 330,
            margin: const EdgeInsets.fromLTRB(8, 8, 0, 0),
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: scheme.surfaceContainer,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: scheme.outlineVariant),
            ),
            child: SalePanel(onPay: keyedPay ? null : _pay),
          ),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              heading,
              Expanded(child: Padding(padding: const EdgeInsets.fromLTRB(8, 6, 8, 0), child: grid)),
            ]),
          ),
        ]),
      ),
      bar(bottom),
      const SizedBox(height: 8),
    ]);
  }

  /// Long press on an item: a manager's photo-and-price sheet, else the
  /// choices and a note when the venue allows it.
  ValueChanged<Product>? _longPressFor(TapState s) =>
      (s.clerk?.can(TillPermission.isManager) ?? false) || s.config.go.noteLongPress ? _longPress : null;

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(tapProvider);
    final home = s.config.home;
    // The back office's layout on every device (owner, 2026-10-28), laid out
    // for each: the till's rows and columns on an iPad or tablet, the same
    // keys a few to a row on a phone. Photo buttons by section are the back
    // office's other choice (Vesopa Go options > Screens).
    final form = formOf(context);
    final tillScreens = form == 'tablet' ? s.config.go.screensTablet == 'till' : s.config.go.screensPhone == 'till';
    if (home != null && tillScreens) return _programmed(s, home, phone: form == 'phone');
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

  /// Null when the venue's bottom bar has its own Pay key: one Pay only.
  final VoidCallback? onPay;

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
              if (onPay != null) ...[
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  key: const ValueKey('pay'),
                  onPressed: empty ? null : onPay,
                  child: Text(empty ? 'Pay' : 'Pay ${money(bill.dueMinor)}'),
                ),
              ),
              ],
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
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22), side: BorderSide(color: context.goLine)),
      child: InkWell(
        borderRadius: BorderRadius.circular(22),
        onTap: count == 0 ? null : onView,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
          child: Row(children: [
            Expanded(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(count == 0 ? 'Tap an item to start a sale' : 'This sale · $count item${count == 1 ? '' : 's'}', style: TextStyle(color: context.goMuted, fontSize: 12)),
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
