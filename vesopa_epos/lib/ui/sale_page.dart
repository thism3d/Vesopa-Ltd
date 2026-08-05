import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/local/database.dart';
import '../data/mix_match_engine.dart';
import '../data/order_repository.dart';
import '../data/staff_session.dart';
import '../main.dart';
import 'layout.dart';
import 'customer_picker.dart';
import 'payment_page.dart';
import 'table_picker.dart';
import 'tables_page.dart' show parkedOrdersProvider;
import 'theme.dart';
import 'till_actions.dart';
import 'void_dialog.dart';
import 'widgets/action_bar.dart';
import '../data/commerce.dart';
import '../data/pricing_engine.dart';
import 'widgets/basket_panel.dart';
import 'widgets/live_receipt.dart';
import 'widgets/line_editor.dart';
import 'widgets/pos_message.dart';

/// Live catalogue, straight from the local database so the grid renders with
/// no network at all.
final productsProvider = StreamProvider<List<Product>>((ref) {
  final db = ref.watch(databaseProvider);
  return db.select(db.products).watch();
});

/// How a category button should look: its picture, emoji and colour override.
class CategoryMedia {
  const CategoryMedia({this.emoji, this.imageUrl, this.colour});

  final String? emoji;
  final String? imageUrl;
  final Color? colour;

  bool get hasVisual =>
      (imageUrl?.isNotEmpty ?? false) || (emoji?.isNotEmpty ?? false);
}

/// Category decoration by department name, synced from the back office.
///
/// Keyed by name rather than id because the rail is built from the *products'*
/// department names — so a category with no row here simply renders as it always
/// did, and the till never depends on this having synced to be able to sell.
final categoryMediaProvider = StreamProvider<Map<String, CategoryMedia>>((ref) {
  final db = ref.watch(databaseProvider);
  return db.select(db.departments).watch().map(
        (rows) => {
          for (final d in rows)
            d.name: CategoryMedia(
              emoji: d.emoji,
              imageUrl: d.imageUrl,
              colour: Pos.parseColor(d.buttonColor),
            ),
        },
      );
});

/// Which department the clerk is looking at. StateProvider was removed in
/// Riverpod 3, so this is the Notifier equivalent.
class SelectedCategory extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String category) => state = category;
}

final selectedCategoryProvider = NotifierProvider<SelectedCategory, String?>(
  SelectedCategory.new,
);

/// Which lines on the current bill the clerk has picked out.
///
/// Void acts on this set, so it carries the order id it belongs to: switching
/// to another table must not inherit a stale tick. Voiding the wrong table's
/// items because a selection survived a screen change is exactly the sort of
/// thing that loses a venue's trust in the till, so the order id is checked on
/// every mutation rather than relying on a screen to clear up after itself.
typedef LineSelection = ({String? orderId, Set<String> ids});

class SelectedLines extends Notifier<LineSelection> {
  @override
  LineSelection build() => (orderId: null, ids: const {});

  Set<String> forOrder(String orderId) =>
      state.orderId == orderId ? state.ids : const {};

  void toggle(String orderId, String lineId) {
    final current = forOrder(orderId);
    state = (
      orderId: orderId,
      ids: current.contains(lineId)
          ? ({...current}..remove(lineId))
          : {...current, lineId},
    );
  }

  void clear() => state = (orderId: null, ids: const {});
}

final selectedLinesProvider =
    NotifierProvider<SelectedLines, LineSelection>(SelectedLines.new);

/// The mix & match deals firing on this bill. Recomputed whenever the lines
/// change, so the saving appears the moment the qualifying item is rung up.
final dealsProvider = FutureProvider.family<MixMatchResult, String>((
  ref,
  orderId,
) async {
  final repo = ref.watch(orderRepositoryProvider);
  // Re-run when the basket changes.
  await ref.watch(orderLinesProvider(orderId).future);
  return repo.dealsOn(orderId);
});

final orderLinesProvider = StreamProvider.family<List<OrderLine>, String>((
  ref,
  orderId,
) {
  return ref.watch(orderRepositoryProvider).watchLines(orderId);
});

class SalePage extends ConsumerWidget {
  const SalePage({
    super.key,
    required this.orderId,
    required this.onNewOrder,
    required this.onSwitchOrder,
  });

  final String orderId;
  final VoidCallback onNewOrder;

  /// Jump to another open bill — a parked table the clerk wants to add to or
  /// settle. Runs several tables at once without losing any of them.
  final void Function(String orderId) onSwitchOrder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.watch(orderRepositoryProvider);
    final products = ref.watch(productsProvider).value ?? const <Product>[];

    // Departments drive the right-hand rail: whatever the back office defines
    // is what the clerk sees, no hardcoded menu.
    final categories = {
      for (final p in products)
        if (p.departmentName != null && p.departmentName!.isNotEmpty)
          p.departmentName!,
    }.toList()..sort();

    final selected =
        ref.watch(selectedCategoryProvider) ??
        (categories.isNotEmpty ? categories.first : null);

    final categoryMedia =
        ref.watch(categoryMediaProvider).value ?? const <String, CategoryMedia>{};

    // Honour the button layout set in the back office: positioned products come
    // first, in the manager's order; anything unassigned follows alphabetically
    // rather than disappearing.
    final visible = products.where((p) => p.departmentName == selected).toList()
      ..sort((a, b) {
        final ap = a.buttonPosition;
        final bp = b.buttonPosition;
        if (ap != null && bp != null) return ap.compareTo(bp);
        if (ap != null) return -1;
        if (bp != null) return 1;
        return a.name.compareTo(b.name);
      });

    return StreamBuilder<Order>(
      stream: repo.watchOrder(orderId),
      builder: (context, orderSnap) {
        return StreamBuilder<List<OrderLine>>(
          stream: repo.watchLines(orderId),
          builder: (context, linesSnap) {
            final order = orderSnap.data;
            final lines = linesSnap.data ?? const <OrderLine>[];
            final total = order?.totalMinor ?? 0;

            // Intersected with the live lines rather than pruned in place: a
            // post-frame callback that writes back to the provider re-arms
            // itself on every build, which pins the scheduler and hangs any
            // pumpAndSettle. Nothing needs the stale ids gone — every consumer
            // intersects with the real lines anyway — so this stays a read.
            final selection = ref.watch(selectedLinesProvider);
            final selectedLines = selection.orderId != orderId
                ? const <String>{}
                : selection.ids
                    .where((id) => lines.any((l) => l.id == id))
                    .toSet();

            final grid = _ProductGrid(
              products: visible,
              color: categoryMedia[selected]?.colour ??
                  Pos.categoryColor(selected ?? ''),
              // Attributed to whoever is signed on. Falls back to the terminal's
              // own account so a venue that does not use staff sign-on still
              // records a name against its sales, as it always has.
              onTap: (p) => repo.addLine(
                orderId,
                p,
                addedBy: ref.read(staffSessionProvider).name ??
                    ref.read(sessionProvider).name,
              ),
              promotions:
                  PricingEngine(promotions: ref.watch(promotionsProvider)),
            );

            void selectCategory(String c) =>
                ref.read(selectedCategoryProvider.notifier).select(c);

            return Column(
              children: [
                // Switch between concurrent bills: every booked table plus this
                // one, so several parties can be served at once.
                _OpenOrdersBar(
                  currentOrderId: orderId,
                  currentOrder: order,
                  onSwitch: onSwitchOrder,
                ),
                Expanded(
                  child: context.isPhone
                      // One thing at a time: categories as a scrolling strip,
                      // the grid below, and the bill behind a pull-up sheet.
                      ? Column(
                          children: [
                            _CategoryStrip(
                              categories: categories,
                              selected: selected,
                              onSelect: selectCategory,
                              media: categoryMedia,
                            ),
                            Expanded(child: grid),
                            _BasketBar(
                              order: order,
                              lineCount: lines.length,
                              onTap: () => _showBasketSheet(
                                context,
                                ref: ref,
                                orderId: orderId,
                                repo: repo,
                              ),
                            ),
                          ],
                        )
                      : Row(
                          children: [
                            // The bill as the receipt it will become, so the
                            // clerk (and the customer leaning over the counter)
                            // watch it build as items are rung up — and what is
                            // approved here is exactly what prints.
                            // Widened from 340px in v1.3.1.0. The check view's
                            // type is now sized to fit fifteen items on a
                            // 15-inch panel, and bigger type in the old width
                            // truncated half the product names — the two changes
                            // only work together.
                            SizedBox(
                              width: 420,
                              child: Padding(
                                padding: const EdgeInsets.fromLTRB(10, 10, 4, 10),
                                child: LiveReceipt(
                                  // The order's own reductions are fed in, not
                                  // just the lines. Priced from the lines alone
                                  // this panel showed the full price while the
                                  // stored total was already discounted, which
                                  // is what made the customer discount look
                                  // like it did nothing.
                                  totals: PricingEngine(
                                    promotions: ref.watch(promotionsProvider),
                                  ).price(
                                    [
                                      for (final l in lines)
                                        PricedLine(
                                          id: l.id,
                                          pluid: l.pluId,
                                          name: l.name,
                                          quantity: l.quantity,
                                          unitPriceMinor: l.unitPriceMinor,
                                          taxPercentage: l.taxPercentage,
                                          note: l.notes,
                                          // Carried through so the check can
                                          // head each run of items with who
                                          // rang them and when.
                                          addedBy: l.addedBy,
                                          addedAt: l.addedAt,
                                        ),
                                    ],
                                    manualDiscountMinor:
                                        order?.manualDiscountMinor ?? 0,
                                    customerDiscountMinor: order == null
                                        ? 0
                                        : OrderRepository.customerDiscountOn(
                                            order,
                                            lines.fold<int>(
                                              0,
                                              (s, l) =>
                                                  s +
                                                  (l.unitPriceMinor *
                                                          l.quantity)
                                                      .round(),
                                            ),
                                          ),
                                  ),
                                  branding: ref.watch(brandingProvider),
                                  tableNumber: order?.tableNumber,
                                  covers: order?.covers,
                                  customerName: order?.customerName,
                                  emptyMessage: 'Ring up an item to start',
                                  selectedLineIds: selectedLines,
                                  // Tap picks the line out for Void; tap it
                                  // again and it goes back. Symmetric, because
                                  // tapping a second time is the only thing
                                  // anyone tries when they hit the wrong row.
                                  onTapLine: (l) => ref
                                      .read(selectedLinesProvider.notifier)
                                      .toggle(orderId, l.id),
                                  // The item box, opened from the pencil that
                                  // appears on a selected row. A visible
                                  // control rather than a long press: a hidden
                                  // gesture has to be taught to every new
                                  // member of staff, and costs half a second
                                  // every time it is used.
                                  onEditLine: (l) {
                                    final line = lines.firstWhere(
                                      (x) => x.id == l.id,
                                      orElse: () => lines.first,
                                    );
                                    showLineEditor(
                                      context,
                                      ref,
                                      orderId: orderId,
                                      line: line,
                                    );
                                  },
                                  // Exactly one line picked: offer its quantity
                                  // right above Subtotal. With several picked
                                  // there is no single quantity to show, so the
                                  // strip stays out of the way.
                                  aboveTotals: selectedLines.length == 1
                                      ? _QuantityStepper(
                                          key: ValueKey(selectedLines.first),
                                          line: lines.firstWhere(
                                            (l) => l.id == selectedLines.first,
                                          ),
                                          onChanged: (q) => repo
                                              .setLineQuantity(
                                                orderId,
                                                selectedLines.first,
                                                q.toDouble(),
                                              ),
                                        )
                                      : null,
                                ),
                              ),
                            ),
                            Expanded(child: grid),
                            _CategoryRail(
                              categories: categories,
                              selected: selected,
                              onSelect: selectCategory,
                              media: categoryMedia,
                            ),
                          ],
                        ),
                ),
                // What Void is about to take off, and the way back out of a
                // selection. Without this there is no visible way to deselect,
                // because tapping a picked line opens the editor.
                if (selectedLines.isNotEmpty)
                  _SelectionBar(
                    count: selectedLines.length,
                    onClear: () =>
                        ref.read(selectedLinesProvider.notifier).clear(),
                  ),
                PosActionBar(
                  primaryLabel: 'PAY',
                  primaryIcon: Icons.credit_card,
                  onPrimary: total == 0
                      ? null
                      : () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => PaymentPage(
                              orderId: orderId,
                              onSettled: onNewOrder,
                            ),
                          ),
                        ),
                  actions: [
                    // Void takes off the picked lines, not the sale. It and
                    // Cancel both stay on the bar even on a phone: they are the
                    // two destructive keys a clerk needs at a moment's notice,
                    // and burying either in "More" is how a mis-rung item ends
                    // up being fixed by cancelling the whole check.
                    PosAction(
                      label: 'Void',
                      icon: Icons.backspace_outlined,
                      color: Pos.red,
                      onTap: () => _voidSelected(
                        context,
                        ref,
                        lines: lines,
                        selected: selectedLines,
                      ),
                    ),
                    PosAction(
                      label: 'Cancel',
                      icon: Icons.block,
                      color: Pos.red,
                      onTap: () => _cancelCheck(context, ref, lines: lines),
                    ),
                    PosAction(
                      label: 'Save Table',
                      icon: Icons.table_restaurant,
                      onTap: () => _promptTable(context, ref),
                    ),
                    PosAction(
                      label: 'Covers',
                      icon: Icons.people,
                      onTap: () => _promptCovers(context, ref),
                    ),
                    PosAction(
                      label: 'Customer',
                      icon: Icons.person,
                      onTap: () => _promptCustomer(context, ref),
                    ),
                    PosAction(
                      label: 'Notes',
                      icon: Icons.edit_note,
                      onTap: () => _noteSelected(
                        context,
                        ref,
                        lines: lines,
                        selected: selectedLines,
                      ),
                    ),
                    PosAction(
                      label: 'No Sale',
                      icon: Icons.point_of_sale,
                      onTap: () => TillActions.openCashDrawer(context, ref),
                    ),
                    PosAction(
                      label: 'Print',
                      icon: Icons.print,
                      onTap: () =>
                          TillActions.printCurrentBill(context, ref, orderId),
                    ),
                    PosAction(
                      label: 'Last Bill',
                      icon: Icons.receipt_long,
                      onTap: () => TillActions.reprintLastReceipt(context, ref),
                    ),
                  ],
                ),
              ],
            );
          },
        );
      },
    );
  }

  Future<void> _promptTable(BuildContext context, WidgetRef ref) async {
    // Visual picker off the real floor plan, instead of typing a number blind.
    final number = await showTablePicker(context, ref);
    if (number == null) return;

    final tables = ref.read(tableRepositoryProvider);
    final lines = await ref.read(orderRepositoryProvider)
        .watchLines(orderId)
        .first;

    // Read occupancy now rather than trusting what the picker was showing: on a
    // floor with several terminals another waiter may have taken the table
    // between the dialog opening and this tap.
    final existing = await tables.orderOn(number);

    // A round already running on that table. The new items join it instead of
    // being refused — "another green tea for table 5" is the same bill, and
    // before this the clerk had no way to say so from the sale screen.
    if (existing != null && existing.id != orderId) {
      if (lines.isEmpty) {
        // Nothing to add: just bring that table's bill to the till so the clerk
        // can ring the extra items straight onto it.
        await tables.recall(existing.id);
        onSwitchOrder(existing.id);
        if (!context.mounted) return;
        PosMessenger.info(context, 'Table $number recalled — add the items.');
        return;
      }

      // merge() moves the lines across and voids the emptied source, so the
      // till needs a fresh order afterwards.
      await tables.merge(orderId, existing.id);
      await tables.park(existing.id, number);
      onNewOrder();
      if (!context.mounted) return;
      PosMessenger.success(
        context,
        lines.length == 1
            ? 'Added ${lines.first.name} to table $number.'
            : 'Added ${lines.length} items to table $number.',
      );
      return;
    }

    if (lines.isEmpty) {
      if (!context.mounted) return;
      PosMessenger.error(context, 'Ring up some items first.');
      return;
    }

    // Free table. Park the current bill against it and clear the till for the
    // next customer. Parking keeps the order live (it is not takings until
    // settled) and frees the sale screen so several tables can run at once; the
    // clerk hops back to any of them from the open-orders bar or the tables
    // plan.
    await tables.park(orderId, number);
    onNewOrder();
    if (!context.mounted) return;
    PosMessenger.success(context, 'Saved to table $number.');
  }

  Future<void> _promptCovers(BuildContext context, WidgetRef ref) async {
    final value = await _numberDialog(context, 'Covers');
    if (value != null) {
      await ref.read(orderRepositoryProvider).setCovers(orderId, value);
    }
  }

  Future<void> _promptCustomer(BuildContext context, WidgetRef ref) async {
    final customer = await pickCustomer(context, ref);
    if (customer == null) return;
    await ref
        .read(orderRepositoryProvider)
        .attachCustomer(
          orderId,
          id: customer.id,
          name: customer.name,
          discountType: customer.discountType,
          discountValue: customer.discountValue,
        );
    if (context.mounted && customer.hasDiscount) {
      PosMessenger.success(
        context,
        '${customer.name} attached — ${customer.discountLabel} applied.',
      );
    }
  }

  /// Void the picked lines off the check, leaving the rest of the sale alone.
  ///
  /// A reason is required for every removal, even a single mis-rung coffee:
  /// a clerk who can silently take one line off a bill can take the money for
  /// it, so the audit trail does not get a fast path.
  Future<void> _voidSelected(
    BuildContext context,
    WidgetRef ref, {
    required List<OrderLine> lines,
    required Set<String> selected,
  }) async {
    if (selected.isEmpty) {
      PosMessenger.error(
        context,
        'Tap the item(s) on the bill first, then Void.',
      );
      return;
    }

    final going = lines.where((l) => selected.contains(l.id)).toList();
    if (going.isEmpty) return;

    final reason = await showVoidDialog(
      context,
      ref,
      itemCount: going.length,
      itemSummary: going.map((l) => l.name).join(', '),
    );
    if (reason == null) return;

    final removed = await ref
        .read(orderRepositoryProvider)
        .voidLines(orderId, lineIds: selected, reason: reason);

    ref.read(selectedLinesProvider.notifier).clear();
    // The void queues an audit record — push it now rather than waiting for the
    // periodic flush, so the back office sees the reversal in real time.
    unawaited(ref.read(syncServiceProvider).flush());

    if (!context.mounted) return;
    PosMessenger.success(
      context,
      going.length == 1
          ? 'Voided ${going.first.name} · ${money(removed)}'
          : 'Voided ${going.length} items · ${money(removed)}',
    );
  }

  /// Clear the whole check — every item, not just the picked ones.
  Future<void> _cancelCheck(
    BuildContext context,
    WidgetRef ref, {
    required List<OrderLine> lines,
  }) async {
    final repo = ref.read(orderRepositoryProvider);

    // Nothing on the bill: clear silently, no reason needed.
    if (lines.isEmpty) {
      await repo.voidOrder(orderId, reason: 'Empty');
      ref.read(selectedLinesProvider.notifier).clear();
      onNewOrder();
      return;
    }

    final reason = await showVoidDialog(context, ref, wholeCheck: true);
    if (reason == null) return;

    await repo.voidOrder(orderId, reason: reason);
    ref.read(selectedLinesProvider.notifier).clear();
    unawaited(ref.read(syncServiceProvider).flush());
    onNewOrder();
  }

  /// Put a note on the picked line(s).
  ///
  /// This key used to write a single note onto the *order*, which printed once
  /// at the foot of the receipt — no use to a kitchen, because nothing said
  /// which dish "no ice" belonged to. It now works off the same selection Void
  /// uses: tick one item and the note lands on that item, tick several and it
  /// lands on all of them. Either way the selection is released afterwards, so
  /// the next Void cannot inherit it.
  Future<void> _noteSelected(
    BuildContext context,
    WidgetRef ref, {
    required List<OrderLine> lines,
    required Set<String> selected,
  }) async {
    if (selected.isEmpty) {
      PosMessenger.error(
        context,
        'Tap the item(s) on the bill first, then Notes.',
      );
      return;
    }

    final target = lines.where((l) => selected.contains(l.id)).toList();
    if (target.isEmpty) return;

    // One item: open on whatever note it already carries, so this edits rather
    // than silently replaces. Several: start blank, because there is no single
    // existing note to show and pre-filling one item's would be misleading.
    final existing = target.length == 1 ? target.first.notes : null;

    final note = await _textDialog(
      context,
      target.length == 1 ? 'Note on ${target.first.name}' : 'Note on ${target.length} items',
      initial: existing ?? '',
      hint: 'e.g. no ice, well done',
    );
    if (note == null) return;

    final repo = ref.read(orderRepositoryProvider);
    for (final line in target) {
      await repo.setLineNote(line.id, note.isEmpty ? null : note);
    }

    ref.read(selectedLinesProvider.notifier).clear();

    if (!context.mounted) return;
    PosMessenger.success(
      context,
      note.isEmpty
          ? (target.length == 1
              ? 'Note cleared on ${target.first.name}'
              : 'Note cleared on ${target.length} items')
          : (target.length == 1
              ? 'Note added to ${target.first.name}'
              : 'Note added to ${target.length} items'),
    );
  }
}

Future<int?> _numberDialog(BuildContext context, String title) async {
  final controller = TextEditingController();
  return showDialog<int>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        keyboardType: TextInputType.number,
        autofocus: true,
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () =>
              Navigator.pop(context, int.tryParse(controller.text.trim())),
          child: const Text('OK'),
        ),
      ],
    ),
  );
}

Future<String?> _textDialog(
  BuildContext context,
  String title, {
  String initial = '',
  String? hint,
}) async {
  final controller = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: InputDecoration(hintText: hint),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, controller.text.trim()),
          child: const Text('OK'),
        ),
      ],
    ),
  );
}

class _ProductGrid extends StatelessWidget {
  const _ProductGrid({
    required this.products,
    required this.color,
    required this.onTap,
    required this.promotions,
  });

  final List<Product> products;
  final Color color;
  final void Function(Product) onTap;

  /// Prices the offers so a discounted product can be flagged on its button.
  final PricingEngine promotions;

  @override
  Widget build(BuildContext context) {
    if (products.isEmpty) {
      return const Center(child: Text('No products in this category.'));
    }

    // The grid adapts to the width it is given rather than to the platform:
    // a Windows till and an Android tablet at the same size get the same
    // layout. Tiles are sized by a max extent so they stay a comfortable touch
    // target on a large desk-mounted screen instead of stretching into a few
    // enormous buttons.
    final phone = context.isPhone;

    // Media tiles are near-square to give the picture room; a plain text menu
    // is shallower, but still tall enough for a name above a price.
    final ratio = _hasMedia ? 1.0 : 1.5;

    return GridView.builder(
      padding: const EdgeInsets.all(12),
      gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: phone ? 220 : 240,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        childAspectRatio: ratio,
      ),
      itemCount: products.length,
      itemBuilder: (context, i) => _ProductTile(
        product: products[i],
        color: Pos.parseColor(products[i].buttonColor) ?? color,
        // The price is part of the button on every platform — a till button
        // without a price makes the clerk guess.
        showPrice: true,
        // An offer running on this product right now, so the clerk can see it
        // is discounted before ringing it up rather than after.
        promotion: promotions.badgeFor(
          pluid: products[i].pluId,
          department: products[i].departmentName,
          group: products[i].groupName,
        ),
        onTap: () => onTap(products[i]),
      ),
    );
  }

  /// When any product carries an image or emoji, the whole grid switches to
  /// taller media tiles so the visuals have room — a menu of pictures should
  /// not sit in wide, shallow buttons.
  bool get _hasMedia => products.any(
    (p) => (p.imageUrl?.isNotEmpty ?? false) || (p.emoji?.isNotEmpty ?? false),
  );
}

class _ProductTile extends StatelessWidget {
  const _ProductTile({
    required this.product,
    required this.color,
    required this.showPrice,
    required this.onTap,
    this.promotion,
  });

  final Product product;
  final Color color;
  final bool showPrice;
  final VoidCallback onTap;

  /// The offer covering this product now, if any.
  final Promotion? promotion;

  /// Layers the offer flash over a finished tile, when one applies.
  Widget _withBadge(Widget tile) {
    final badge = _badge;
    if (badge == null) return tile;
    return Stack(
      // The badge deliberately sits inside the tile bounds so a grid with
      // tight spacing does not clip it.
      children: [Positioned.fill(child: tile), badge],
    );
  }

  /// The offer flash, pinned to the tile's top-right corner.
  Widget? get _badge {
    final promo = promotion;
    if (promo == null || (promo.badgeText?.isEmpty ?? true)) return null;
    final badgeColour =
        Pos.parseColor(promo.badgeColour) ?? const Color(0xFFD81B60);

    return Positioned(
      top: 6,
      right: 6,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          color: badgeColour,
          borderRadius: BorderRadius.circular(5),
          boxShadow: const [
            BoxShadow(color: Color(0x33000000), blurRadius: 4, offset: Offset(0, 1)),
          ],
        ),
        child: Text(
          promo.badgeText!,
          // The badge colour is set per-promotion in the back office, so a
          // yellow "HALF PRICE" flash would otherwise be white-on-yellow.
          style: TextStyle(
            color: Pos.inkOn(badgeColour),
            fontSize: 10,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.3,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final hasImage = product.imageUrl?.isNotEmpty ?? false;
    final hasEmoji = product.emoji?.isNotEmpty ?? false;

    // A product with a picture: the picture fills the tile and the name and
    // price sit in a band along the bottom, over a scrim so they stay legible
    // whatever the image is. The clerk recognises the item by sight but never
    // has to guess what it costs.
    if (hasImage) {
      return _withBadge(_PressableTile(
        onTap: onTap,
        child: Material(
          color: color,
          borderRadius: BorderRadius.circular(6),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Image.network(
                  product.imageUrl!,
                  fit: BoxFit.cover,
                  // A broken image URL falls back to the name on the coloured
                  // tile, so the button is still usable rather than blank.
                  errorBuilder: (_, _, _) => _LabelTile(
                    name: product.name,
                    background: color,
                    priceMinor: showPrice ? product.priceMinor : null,
                  ),
                ),
                // Scrim: only over the lower part, so it darkens the text band
                // without dulling the whole picture.
                const Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [Colors.transparent, Colors.black87],
                      ),
                    ),
                    child: SizedBox(height: 72, width: double.infinity),
                  ),
                ),
                Positioned(
                  left: 8,
                  right: 8,
                  bottom: 8,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Expanded(
                        child: Text(
                          product.name,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 13.5,
                            fontWeight: FontWeight.w600,
                            height: 1.2,
                            shadows: [
                              Shadow(blurRadius: 4, color: Colors.black87),
                            ],
                          ),
                        ),
                      ),
                      if (showPrice) ...[
                        const SizedBox(width: 6),
                        // The price rides in a solid pill rather than as bare
                        // text: over a photograph, plain white numerals lose
                        // contrast against whatever happens to be behind them.
                        DecoratedBox(
                          decoration: BoxDecoration(
                            color: color,
                            borderRadius: BorderRadius.circular(20),
                            boxShadow: const [
                              BoxShadow(
                                color: Colors.black45,
                                blurRadius: 6,
                                offset: Offset(0, 2),
                              ),
                            ],
                          ),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 10,
                              vertical: 4,
                            ),
                            child: Text(
                              money(product.priceMinor),
                              // The pill is filled with the tile colour, so the
                              // numerals follow that colour rather than being
                              // a fixed white that disappears on a pale one.
                              style: TextStyle(
                                color: Pos.inkOn(color),
                                fontSize: 15,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ));
    }

    return _withBadge(_PressableTile(
      onTap: onTap,
      child: Material(
        color: color,
        borderRadius: BorderRadius.circular(6),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Column(
              // Name and price sit centred in the tile — the whole button is the
              // target, so the label reads best in the middle of it. Picture
              // tiles are the exception: there the text moves to a band at the
              // foot so it does not cover the image.
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                if (hasEmoji) ...[
                  Text(product.emoji!, style: const TextStyle(fontSize: 32)),
                  const SizedBox(height: 4),
                ],
                Text(
                  product.name,
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: Pos.inkOn(color),
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (showPrice)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      money(product.priceMinor),
                      style: TextStyle(
                        color: Pos.inkOn(color),
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    ));
  }
}

/// Dips and lifts its child while pressed.
///
/// A touch till gives no haptics and the clerk is often not looking straight at
/// the button, so the tile itself confirms the press: it shrinks slightly under
/// the finger and springs back. Cheap (a single AnimatedScale) and it makes
/// double-taps obvious.
class _PressableTile extends StatefulWidget {
  const _PressableTile({required this.onTap, required this.child});

  final VoidCallback onTap;
  final Widget child;

  @override
  State<_PressableTile> createState() => _PressableTileState();
}

class _PressableTileState extends State<_PressableTile> {
  bool _down = false;

  void _set(bool v) {
    if (_down != v && mounted) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedScale(
      scale: _down ? 0.96 : 1,
      duration: const Duration(milliseconds: 90),
      curve: Curves.easeOut,
      child: GestureDetector(
        onTapDown: (_) => _set(true),
        onTapUp: (_) => _set(false),
        onTapCancel: () => _set(false),
        // The tap itself is handled by the InkWell inside, which also draws the
        // ripple; this layer only tracks the press for the scale.
        child: widget.child,
      ),
    );
  }
}

/// The label+price shown on a coloured tile, used as the fallback when a
/// product's image fails to load.
class _LabelTile extends StatelessWidget {
  const _LabelTile({required this.name, required this.background, this.priceMinor});

  final String name;

  /// The tile behind the text. The ink is derived from it rather than assumed:
  /// this was a fixed white, which bypassed [Pos.inkOn] entirely and left the
  /// label at 2-3:1 on the cyan, blue, teal and green tiles — and worse on any
  /// pale colour the back office picked.
  final Color background;

  final int? priceMinor;

  @override
  Widget build(BuildContext context) {
    final ink = Pos.inkOn(background);

    return Padding(
      padding: const EdgeInsets.all(8),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            name,
            textAlign: TextAlign.center,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: ink,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (priceMinor != null)
            Text(
              money(priceMinor!),
              style: TextStyle(
                color: ink,
                fontSize: 18,
                fontWeight: FontWeight.w800,
              ),
            ),
        ],
      ),
    );
  }
}

/// A strip of every bill currently in play — this one plus each booked table —
/// so the clerk can serve several parties at once and hop between their bills
/// without losing any. Updates live as tables are booked and settled.
class _OpenOrdersBar extends ConsumerWidget {
  const _OpenOrdersBar({
    required this.currentOrderId,
    required this.currentOrder,
    required this.onSwitch,
  });

  final String currentOrderId;
  final Order? currentOrder;
  final void Function(String orderId) onSwitch;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final booked = ref.watch(parkedOrdersProvider).value ?? const <Order>[];

    // The current bill is shown first when it is not itself one of the booked
    // tables (i.e. a fresh walk-in, or a table just recalled onto the till).
    final currentIsBooked = booked.any((o) => o.id == currentOrderId);

    // This bar used to carry a "+ New" key on the right. It was removed in
    // v1.3.1.0 at the venue's request: a fresh bill already appears on its own
    // whenever the current one leaves the till — settled, saved to a table, or
    // cancelled — so on a venue that uses the table plan the key was a second
    // way to do what the till was doing anyway.
    //
    // The one thing it did that nothing else does is hold bill A on the till
    // while starting bill B, since the only way to hold a bill is to park it
    // against a table number. A counter-only venue that later needs two bills at
    // once wants a numberless park ("Hold bill") on the Functions page rather
    // than this key back — the parking machinery is all in TableRepository
    // already and takes a staff name as easily as a table number.
    return Container(
      height: 52,
      color: Theme.of(context).posSurface,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        children: [
          if (!currentIsBooked)
            _OrderChip(
              label: currentOrder?.tableNumber != null
                  ? 'Table ${currentOrder!.tableNumber}'
                  : 'Current',
              total: currentOrder?.totalMinor ?? 0,
              active: true,
              onTap: () {},
            ),
          for (final o in booked)
            _OrderChip(
              label: 'Table ${o.tableNumber}',
              total: o.totalMinor,
              active: o.id == currentOrderId,
              onTap: () => onSwitch(o.id),
            ),
        ],
      ),
    );
  }
}

class _OrderChip extends StatelessWidget {
  const _OrderChip({
    required this.label,
    required this.total,
    required this.active,
    required this.onTap,
  });

  final String label;
  final int total;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Material(
        color: active ? Pos.brand : Theme.of(context).posIdle,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: active ? null : onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: active
                        ? Pos.onBrand
                        : Theme.of(context).colorScheme.onSurface,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  money(total),
                  style: TextStyle(
                    fontSize: 13,
                    color: active
                        ? Pos.onBrand.withValues(alpha: 0.7)
                        : Theme.of(context).hintColor,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Phone: the bill lives behind this bar rather than taking a column. It always
/// shows the total, because that is the one number the clerk must never lose
/// sight of.
class _BasketBar extends StatelessWidget {
  const _BasketBar({
    required this.order,
    required this.lineCount,
    required this.onTap,
  });

  final Order? order;
  final int lineCount;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).posTotals,
      child: InkWell(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            border: Border(top: BorderSide(color: Theme.of(context).posLine)),
          ),
          child: Row(
            children: [
              const Icon(Icons.expand_less),
              const SizedBox(width: 8),
              Text(
                lineCount == 1 ? '1 item' : '$lineCount items',
                style: const TextStyle(fontSize: 15),
              ),
              const Spacer(),
              Text(
                money(order?.totalMinor ?? 0),
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Phone: departments scroll horizontally instead of occupying a rail.
class _CategoryStrip extends StatelessWidget {
  const _CategoryStrip({
    required this.categories,
    required this.selected,
    required this.onSelect,
    this.media = const {},
  });

  final List<String> categories;
  final String? selected;
  final ValueChanged<String> onSelect;
  final Map<String, CategoryMedia> media;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 52,
      // An explicit surface so the strip reads as a bar in both themes rather
      // than blending into whatever is behind it.
      color: Theme.of(context).posSurface,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        itemCount: categories.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, i) {
          final category = categories[i];
          final active = category == selected;
          final art = media[category];
          final color = art?.colour ?? Pos.categoryColor(category);
          // The colour comes from the back office, so the label works out its
          // own contrast rather than assuming white reads on it.
          final ink = active
              ? Pos.inkOn(color)
              : Theme.of(context).colorScheme.onSurface;

          return Material(
            // Idle chip reads from the theme, so it does not stay light-grey
            // (with pale text on it) in dark mode.
            color: active ? color : Theme.of(context).posIdle,
            borderRadius: BorderRadius.circular(18),
            child: InkWell(
              borderRadius: BorderRadius.circular(18),
              onTap: () => onSelect(category),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (art != null && art.hasVisual) ...[
                      _CategoryThumb(media: art, size: 24, fallback: color),
                      const SizedBox(width: 8),
                    ],
                    Text(
                      category,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: ink,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// The strip above the action bar while lines are picked out.
///
/// It exists for one reason beyond information: tapping a picked line opens the
/// editor rather than deselecting it, so without a Clear here a clerk who
/// selected the wrong item would have no obvious way back.
/// Quantity control for the one line the clerk has picked out.
///
/// Sits directly above Subtotal on the running receipt, so "three of these,
/// not one" is fixed where the money is, without opening the line editor.
/// Whole units only — a bar sells two pints, never 2.4 of one — so the field
/// takes digits alone and the steppers move in ones.
class _QuantityStepper extends StatefulWidget {
  const _QuantityStepper({
    super.key,
    required this.line,
    required this.onChanged,
  });

  final OrderLine line;
  final Future<void> Function(int quantity) onChanged;

  @override
  State<_QuantityStepper> createState() => _QuantityStepperState();
}

class _QuantityStepperState extends State<_QuantityStepper> {
  late final TextEditingController _controller =
      TextEditingController(text: _quantity.toString());
  final _focus = FocusNode();

  int get _quantity => widget.line.quantity.round().clamp(1, 999);

  @override
  void didUpdateWidget(_QuantityStepper old) {
    super.didUpdateWidget(old);
    // Follow the line when it changes underneath us (another terminal, or the
    // line editor) — but never while the clerk is mid-keystroke in the field.
    if (!_focus.hasFocus && _controller.text != _quantity.toString()) {
      _controller.text = _quantity.toString();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _set(int next) async {
    final clamped = next.clamp(1, 999);
    _controller.text = clamped.toString();
    await widget.onChanged(clamped);
  }

  /// Commit whatever is in the field. Anything unparseable falls back to the
  /// line's current quantity rather than to zero, which would silently wipe the
  /// item off the bill.
  Future<void> _commit() async {
    final typed = int.tryParse(_controller.text.trim());
    await _set(typed == null || typed < 1 ? _quantity : typed);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      decoration: BoxDecoration(
        color: scheme.primary.withValues(alpha: 0.10),
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  widget.line.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  'Quantity',
                  style: TextStyle(
                    fontSize: 11.5,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          _QtyButton(
            icon: Icons.remove,
            // One is the floor: taking an item off the bill is Void's job, and
            // it asks for a reason. Stepping to zero here would be a silent
            // removal with no audit trail.
            onTap: _quantity <= 1 ? null : () => _set(_quantity - 1),
          ),
          SizedBox(
            width: 58,
            child: TextField(
              controller: _controller,
              focusNode: _focus,
              textAlign: TextAlign.center,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              style: const TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w700,
              ),
              decoration: const InputDecoration(
                isDense: true,
                contentPadding: EdgeInsets.symmetric(vertical: 8),
                border: OutlineInputBorder(),
              ),
              onTapOutside: (_) => _focus.unfocus(),
              onSubmitted: (_) => _commit(),
              onEditingComplete: _commit,
            ),
          ),
          _QtyButton(icon: Icons.add, onTap: () => _set(_quantity + 1)),
        ],
      ),
    );
  }
}

class _QtyButton extends StatelessWidget {
  const _QtyButton({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6),
      child: Material(
        color: onTap == null
            ? scheme.surfaceContainerHighest.withValues(alpha: 0.4)
            : scheme.surfaceContainerHighest,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Icon(
              icon,
              size: 20,
              color: onTap == null ? scheme.outline : scheme.onSurface,
            ),
          ),
        ),
      ),
    );
  }
}

class _SelectionBar extends StatelessWidget {
  const _SelectionBar({required this.count, required this.onClear});

  final int count;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Material(
      color: scheme.primary.withValues(alpha: 0.22),
      child: SizedBox(
        height: 38,
        child: Row(
          children: [
            const SizedBox(width: 14),
            Icon(Icons.check_circle, size: 17, color: scheme.primary),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                count == 1 ? '1 item selected' : '$count items selected',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: scheme.onSurface,
                ),
              ),
            ),
            Text(
              'Void removes these',
              style: TextStyle(
                fontSize: 12,
                color: scheme.onSurfaceVariant,
              ),
            ),
            TextButton(onPressed: onClear, child: const Text('Clear')),
            const SizedBox(width: 6),
          ],
        ),
      ),
    );
  }
}

/// The full bill, as a sheet. Tap a line to pick it out for Void; tap it again
/// to edit it.
Future<void> _showBasketSheet(
  BuildContext context, {
  required WidgetRef ref,
  required String orderId,
  required OrderRepository repo,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      builder: (context, controller) => StreamBuilder<Order>(
        stream: repo.watchOrder(orderId),
        builder: (context, orderSnap) => StreamBuilder<List<OrderLine>>(
          stream: repo.watchLines(orderId),
          builder: (context, linesSnap) {
            final lines = linesSnap.data ?? const <OrderLine>[];
            final order = orderSnap.data;

            return Column(
              children: [
                const SizedBox(height: 8),
                Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: Theme.of(context).dividerColor,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                Expanded(
                  child: lines.isEmpty
                      ? const Center(child: Text('No items'))
                      : ListView.builder(
                          controller: controller,
                          itemCount: lines.length,
                          itemBuilder: (context, i) {
                            final line = lines[i];
                            final total =
                                (line.unitPriceMinor * line.quantity).round() -
                                line.lineDiscountMinor;
                            final extras = [
                              if (line.lineDiscountMinor > 0)
                                '-${money(line.lineDiscountMinor)}',
                              if (line.notes?.isNotEmpty ?? false) line.notes!,
                            ].join('  •  ');

                            // A Consumer, not the captured `ref`: this sheet is
                            // built outside the page's build, so watching on
                            // the outer ref would read the selection once and
                            // never repaint when the clerk taps a line.
                            return Consumer(
                              builder: (context, ref, _) {
                                final selection =
                                    ref.watch(selectedLinesProvider);
                                final picked = selection.orderId == orderId &&
                                    selection.ids.contains(line.id);
                                final scheme = Theme.of(context).colorScheme;

                                return ListTile(
                                  selected: picked,
                                  selectedTileColor:
                                      scheme.primary.withValues(alpha: 0.18),
                                  leading: picked
                                      ? Icon(Icons.check_circle,
                                          color: scheme.primary)
                                      : null,
                                  title: Text(line.name),
                                  subtitle: Text(
                                    '${line.quantity.toStringAsFixed(line.quantity % 1 == 0 ? 0 : 2)} × '
                                    '${money(line.unitPriceMinor)}'
                                    '${extras.isEmpty ? '' : '\n$extras'}',
                                  ),
                                  isThreeLine: extras.isNotEmpty,
                                  trailing: Text(
                                    money(total),
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                  // Same rule as the desktop bill: first tap
                                  // picks the line out for Void, tapping it
                                  // again opens the editor.
                                  onTap: () {
                                    if (!picked) {
                                      ref
                                          .read(selectedLinesProvider.notifier)
                                          .toggle(orderId, line.id);
                                      return;
                                    }
                                    showLineEditor(
                                      context,
                                      ref,
                                      orderId: orderId,
                                      line: line,
                                    );
                                  },
                                );
                              },
                            );
                          },
                        ),
                ),
                const Divider(height: 1),
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Total',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      Text(
                        money(order?.totalMinor ?? 0),
                        style: const TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}

class _CategoryRail extends StatelessWidget {
  const _CategoryRail({
    required this.categories,
    required this.selected,
    required this.onSelect,
    this.media = const {},
  });

  final List<String> categories;
  final String? selected;
  final ValueChanged<String> onSelect;

  /// Picture/emoji/colour per category name, from the back office.
  final Map<String, CategoryMedia> media;

  /// How many categories must be reachable without scrolling. A clerk hunting
  /// for "Tea" by scrolling a list mid-service is the complaint this fixes.
  static const _minVisible = 10;

  @override
  Widget build(BuildContext context) {
    // Proportional, for the same reason as the basket: a fixed width overflows
    // the row on a smaller tablet. Wider than it was — the nav rail no longer
    // takes a fixed slice of the screen, and the rows now carry a picture.
    final width = MediaQuery.sizeOf(context)
        .width
        .clamp(600.0, 1600.0) *
        0.24;

    return Container(
      width: width.clamp(150.0, 340.0),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: Theme.of(context).posLine)),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          // Share the height out so at least ten rows fit. Rows grow when there
          // are only a few categories and shrink (to a floor that is still
          // comfortably tappable) when there are many; past that it scrolls,
          // because a 20px row nobody can hit is worse than scrolling.
          final slots = categories.length < _minVisible
              ? _minVisible
              : categories.length;
          final rowHeight =
              (constraints.maxHeight / slots).clamp(44.0, 76.0);

          return ListView.builder(
            padding: EdgeInsets.zero,
            itemCount: categories.length,
            itemBuilder: (context, i) {
              final category = categories[i];
              return _CategoryTile(
                label: category,
                media: media[category],
                // The office's colour wins; the till's per-name default is the
                // fallback for categories it was never set on.
                colour: media[category]?.colour ??
                    Pos.categoryColor(category),
                active: category == selected,
                height: rowHeight,
                onTap: () => onSelect(category),
              );
            },
          );
        },
      ),
    );
  }
}

/// One row on the category rail: a picture (or emoji) if the back office set
/// one, the name, and the category's colour when it is the active one.
class _CategoryTile extends StatelessWidget {
  const _CategoryTile({
    required this.label,
    required this.media,
    required this.colour,
    required this.active,
    required this.height,
    required this.onTap,
  });

  final String label;
  final CategoryMedia? media;
  final Color colour;
  final bool active;
  final double height;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Category colours are set in the back office and can be anything, so the
    // label picks black or white off the actual luminance rather than assuming.
    final ink = active ? Pos.inkOn(colour) : theme.colorScheme.onSurface;
    // The thumbnail scales with the row so it never crowds out the name when
    // the rail is packed with categories.
    final thumb = (height - 14).clamp(26.0, 46.0);

    return Material(
      // The active category takes its own colour, matching the grid, so the
      // two panels are visibly linked.
      color: active ? colour : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: height,
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              if (media != null && media!.hasVisual) ...[
                _CategoryThumb(media: media!, size: thumb, fallback: colour),
                const SizedBox(width: 10),
              ],
              // The name is sized to fill the row rather than set at a fixed
              // 14.5/16pt. Short categories — "Tea", "Beer" — were rendering
              // tiny in a tall button with the rest of the space empty, which
              // is what makes a rail hard to hit at a glance.
              //
              // The base size is taken from the row height, then FittedBox
              // shrinks it if a long name will not fit. The inner ConstrainedBox
              // is what makes wrapping possible: FittedBox gives its child
              // unbounded width, so without it `maxLines: 2` could never wrap
              // and every long name would be scaled down to a single thin line.
              Expanded(
                child: LayoutBuilder(
                  builder: (context, box) => FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: ConstrainedBox(
                      constraints: BoxConstraints(maxWidth: box.maxWidth),
                      child: Text(
                        label,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: (height * 0.42).clamp(16.0, 28.0),
                          height: 1.1,
                          fontWeight:
                              active ? FontWeight.w700 : FontWeight.w600,
                          color: ink,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CategoryThumb extends StatelessWidget {
  const _CategoryThumb({
    required this.media,
    required this.size,
    required this.fallback,
  });

  final CategoryMedia media;
  final double size;
  final Color fallback;

  @override
  Widget build(BuildContext context) {
    if (media.imageUrl?.isNotEmpty ?? false) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: Image.network(
          media.imageUrl!,
          width: size,
          height: size,
          fit: BoxFit.cover,
          // A picture that will not load must not blank the row — the clerk
          // still needs to be able to find the category.
          errorBuilder: (_, _, _) => _emoji(size),
        ),
      );
    }
    return _emoji(size);
  }

  Widget _emoji(double size) {
    final emoji = media.emoji;
    if (emoji == null || emoji.isEmpty) return SizedBox(width: size);
    return SizedBox(
      width: size,
      height: size,
      child: Center(
        child: Text(emoji, style: TextStyle(fontSize: size * 0.72)),
      ),
    );
  }
}
