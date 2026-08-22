import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/kitchen_printing.dart';
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
import 'widgets/on_screen_keyboard.dart';
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
  return db
      .select(db.departments)
      .watch()
      .map(
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

final selectedLinesProvider = NotifierProvider<SelectedLines, LineSelection>(
  SelectedLines.new,
);

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
        ref.watch(categoryMediaProvider).value ??
        const <String, CategoryMedia>{};

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
              category: selected,
              color:
                  categoryMedia[selected]?.colour ??
                  Pos.categoryColor(selected ?? ''),
              // Set once per venue in the back office rather than per till: a
              // clerk moving between two terminals in the same shop must not
              // find the buttons reading differently on each.
              showPrices: ref.watch(tillSettingsProvider).buttonsShowPrices,
              // Attributed to whoever is signed on. Falls back to the terminal's
              // own account so a venue that does not use staff sign-on still
              // records a name against its sales, as it always has.
              onTap: (p) => repo.addLine(
                orderId,
                p,
                addedBy:
                    ref.read(staffSessionProvider).name ??
                    ref.read(sessionProvider).name,
              ),
              promotions: PricingEngine(
                promotions: ref.watch(promotionsProvider),
              ),
            );

            void selectCategory(String c) =>
                ref.read(selectedCategoryProvider.notifier).select(c);

            // The Ledger board: one dark ground with the bill, the grid and
            // the category rail sitting on it as separate panels. The same
            // surfaces the payment screen is built from, deliberately — the
            // sale screen and the screen it hands over to should not look like
            // two different products.
            return ColoredBox(
              color: PayPalette.of(context).canvas,
              child: Column(
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
                                  padding: const EdgeInsets.fromLTRB(
                                    10,
                                    10,
                                    4,
                                    10,
                                  ),
                                  child: LiveReceipt(
                                    // The order's own reductions are fed in, not
                                    // just the lines. Priced from the lines alone
                                    // this panel showed the full price while the
                                    // stored total was already discounted, which
                                    // is what made the customer discount look
                                    // like it did nothing.
                                    totals:
                                        PricingEngine(
                                          promotions: ref.watch(
                                            promotionsProvider,
                                          ),
                                        ).price(
                                          [
                                            for (final l in lines)
                                              PricedLine(
                                                id: l.id,
                                                pluid: l.pluId,
                                                name: l.name,
                                                quantity: l.quantity,
                                                unitPriceMinor:
                                                    l.unitPriceMinor,
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
                                              (l) =>
                                                  l.id == selectedLines.first,
                                            ),
                                            onChanged: (q) =>
                                                repo.setLineQuantity(
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
                    primaryLabel: 'Pay',
                    // What the clerk is about to charge, on the key they press
                    // to charge it.
                    primaryValue: total == 0 ? null : money(total),
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
                      // A bill that is already sitting on a table saves back to
                      // it without asking. Recalling table 5, ringing another
                      // round and being shown the floor plan again is the till
                      // asking a question it already knows the answer to — and
                      // the answer it is fishing for is the table the clerk
                      // just came from.
                      //
                      // The label carries the destination so the tap is never a
                      // guess, and a long press still opens the plan for the
                      // one case the tap cannot serve: moving the bill.
                      PosAction(
                        label: order?.tableNumber == null
                            ? 'Save Table'
                            : 'Save to Table ${order!.tableNumber}',
                        icon: Icons.table_restaurant,
                        onTap: () => _saveTable(context, ref, order),
                        onLongPress: order?.tableNumber == null
                            ? null
                            : () => _promptTable(context, ref),
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
                        onTap: () =>
                            TillActions.reprintLastReceipt(context, ref),
                      ),
                    ],
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  /// Save Table's ordinary tap.
  ///
  /// Straight back to the table this bill is already on, when it is on one, and
  /// the floor plan only when there is a genuine question to ask. The plan is
  /// still one long press away, because "this round is actually for table 9" is
  /// a real thing that happens.
  Future<void> _saveTable(BuildContext context, WidgetRef ref, Order? order) {
    final table = order?.tableNumber;
    if (table == null) return _promptTable(context, ref);
    return _saveToTable(context, ref, table);
  }

  Future<void> _promptTable(BuildContext context, WidgetRef ref) async {
    // Visual picker off the real floor plan, instead of typing a number blind.
    final number = await showTablePicker(context, ref);
    if (number == null) return;

    final tables = ref.read(tableRepositoryProvider);
    final lines = await ref
        .read(orderRepositoryProvider)
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

      // Fired against the surviving bill, and only its unsent lines go — so
      // the round just added prints and the courses already sent do not.
      if (context.mounted) {
        await TillActions.fireKitchen(
          context,
          ref,
          orderId: existing.id,
          reason: KitchenFire.table,
        );
      }

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

    if (!context.mounted) return;
    await _saveToTable(context, ref, number);
  }

  /// Park this bill on [number], fire the kitchen, and clear the till.
  ///
  /// The one path that actually saves a table, whether the number came from the
  /// floor plan or from the bill already being on it. Kept in one place so the
  /// two entry points cannot drift — an earlier arrangement had the parking and
  /// the firing written out twice, and the second copy is exactly where a
  /// course goes unsent.
  Future<void> _saveToTable(
    BuildContext context,
    WidgetRef ref,
    int number,
  ) async {
    final repo = ref.read(orderRepositoryProvider);
    final lines = await repo.watchLines(orderId).first;

    if (lines.isEmpty) {
      if (!context.mounted) return;
      PosMessenger.error(context, 'Ring up some items first.');
      return;
    }

    // How many of these the kitchen has not seen. Worked out before firing,
    // because firing marks them sent — and it is what the clerk is told, so
    // "Added 2 items" means two items are being cooked rather than two items
    // are on a bill that already had nine.
    final unsent = lines.where((l) => l.kitchenPrintedAt == null).length;

    // Park keeps the order live — it is not takings until it is settled — and
    // frees the sale screen so several tables can run at once. The clerk hops
    // back to any of them from the open-orders bar or the tables plan.
    final tables = ref.read(tableRepositoryProvider);
    await tables.park(orderId, number);

    // The kitchen gets the order the moment the table is saved, which is the
    // point of saving it. Parked first, so a printer that hangs cannot cost the
    // clerk the table.
    if (context.mounted) {
      await TillActions.fireKitchen(
        context,
        ref,
        orderId: orderId,
        reason: KitchenFire.table,
      );
    }

    onNewOrder();
    if (!context.mounted) return;
    PosMessenger.success(
      context,
      unsent == 0
          ? 'Saved to table $number.'
          : unsent == 1
          ? 'Added 1 item to table $number.'
          : 'Added $unsent items to table $number.',
    );
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
      target.length == 1
          ? 'Note on ${target.first.name}'
          : 'Note on ${target.length} items',
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
  final typed = await _fieldDialog(
    context,
    title,
    mode: PosKeyboardMode.number,
  );
  return typed == null ? null : int.tryParse(typed.trim());
}

Future<String?> _textDialog(
  BuildContext context,
  String title, {
  String initial = '',
  String? hint,
}) => _fieldDialog(context, title, initial: initial, hint: hint);

/// Ask for a value, with a keyboard the clerk can actually reach.
///
/// Every free-text field on this screen goes through here. A till is a touch
/// screen on a counter and most of them have no keyboard behind them, so a
/// dialog with a bare `TextField` in it was a dialog that could be opened and
/// not answered — Covers, Notes and Customer were all effectively unusable on a
/// terminal without one plugged in.
///
/// A hardware keyboard still works, and is still what a machine on a bench
/// during setup will use: the field keeps focus and accepts real keystrokes.
/// What is suppressed is the *operating system's* touch keyboard, which would
/// otherwise slide up on top of ours.
Future<String?> _fieldDialog(
  BuildContext context,
  String title, {
  String initial = '',
  String? hint,
  PosKeyboardMode mode = PosKeyboardMode.text,
}) async {
  final controller = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (context) => _FieldDialog(
      title: title,
      hint: hint,
      mode: mode,
      controller: controller,
    ),
  );
}

class _FieldDialog extends StatefulWidget {
  const _FieldDialog({
    required this.title,
    required this.controller,
    required this.mode,
    this.hint,
  });

  final String title;
  final TextEditingController controller;
  final PosKeyboardMode mode;
  final String? hint;

  @override
  State<_FieldDialog> createState() => _FieldDialogState();
}

class _FieldDialogState extends State<_FieldDialog> {
  @override
  void initState() {
    super.initState();
    // Rebuild as the value changes, so the green key can be greyed out while
    // there is nothing to submit. The same omission is what left the Void
    // dialog's confirm button dead after a reason had been typed into it.
    widget.controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() => setState(() {});

  bool get _canSubmit => widget.controller.text.trim().isNotEmpty;

  void _submit() {
    if (_canSubmit) Navigator.pop(context, widget.controller.text.trim());
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      // Wide enough for the keyboard to lay out at a usable key size, and
      // scrollable so it survives the shortest till anybody runs this on.
      content: SizedBox(
        width: widget.mode == PosKeyboardMode.text ? 660 : 380,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: widget.controller,
                autofocus: true,
                textAlign: widget.mode == PosKeyboardMode.text
                    ? TextAlign.start
                    : TextAlign.center,
                style: widget.mode == PosKeyboardMode.text
                    ? null
                    : const TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
                decoration: InputDecoration(
                  hintText: widget.hint,
                  border: const OutlineInputBorder(),
                ),
                onSubmitted: (_) => _submit(),
                // Ours is the input method. A hardware keyboard still types
                // into it; this only stops Windows sliding its own touch
                // keyboard over the top of the one below.
                keyboardType: TextInputType.none,
              ),
              const SizedBox(height: 12),
              OnScreenKeyboard(
                controller: widget.controller,
                mode: widget.mode,
                submitLabel: 'Save',
                onSubmit: _canSubmit ? _submit : null,
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _canSubmit ? _submit : null,
          child: const Text('OK'),
        ),
      ],
    );
  }
}

/// The product grid, headed by the category the clerk is in.
///
/// The heading is not decoration: with the categories on a rail down the right
/// and the bill down the left, the grid is the one panel with nothing naming
/// it, and "which category am I looking at?" was being answered by reading the
/// rail back the other way. The count beside it answers the next question —
/// whether what is on screen is all of it.
class _ProductGrid extends StatelessWidget {
  const _ProductGrid({
    required this.products,
    required this.category,
    required this.color,
    required this.onTap,
    required this.promotions,
    required this.showPrices,
  });

  final List<Product> products;

  /// The department these belong to, for the heading. Null before the
  /// catalogue has synced, when there is no category to be in.
  final String? category;

  final Color color;
  final void Function(Product) onTap;

  /// Prices the offers so a discounted product can be flagged on its button.
  final PricingEngine promotions;

  /// Whether buttons carry their price. Set per venue in the back office.
  final bool showPrices;

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);
    final phone = context.isPhone;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (category != null)
          Padding(
            padding: EdgeInsets.fromLTRB(phone ? 12 : 18, 14, 12, 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                // The name gets the room and the count gives way. A long
                // category on a narrow grid — which is most of them once the
                // bill and the rail have taken their share — otherwise pushes
                // the count off the edge and overflows the row.
                Flexible(
                  child: Text(
                    category!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: pal.ink,
                      fontSize: phone ? 18 : 21,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.2,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    products.length == 1
                        ? '1 product'
                        : '${products.length} products',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: pal.inkMuted, fontSize: 13),
                  ),
                ),
              ],
            ),
          ),
        Expanded(child: _tiles(context, phone)),
      ],
    );
  }

  Widget _tiles(BuildContext context, bool phone) {
    if (products.isEmpty) {
      return Center(
        child: Text(
          'No products in this category.',
          style: TextStyle(color: PayPalette.of(context).inkMuted),
        ),
      );
    }

    // The grid adapts to the width it is given rather than to the platform: a
    // Windows till and an Android tablet at the same size get the same layout.
    // Tiles are sized by a max extent so they stay a comfortable touch target
    // on a large desk-mounted screen instead of stretching into a few enormous
    // buttons.
    //
    // One ratio for the whole grid, whether or not anything in it has a
    // picture: tiles that changed shape depending on the category made the
    // grid jump every time the rail was tapped, and a clerk builds muscle
    // memory on where a button *is*.
    return GridView.builder(
      padding: EdgeInsets.fromLTRB(
        phone ? 12 : 18,
        0,
        phone ? 12 : 18,
        phone ? 12 : 16,
      ),
      gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: phone ? 220 : 260,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        childAspectRatio: 1.12,
      ),
      itemCount: products.length,
      itemBuilder: (context, i) => _ProductTile(
        product: products[i],
        accent: Pos.parseColor(products[i].buttonColor) ?? color,
        showPrice: showPrices,
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
}

/// One product button.
///
/// Laid out the same way whatever the product carries: the name reads from the
/// top-left, the price sits bottom-left, and anything visual — an uploaded
/// picture or an emoji — takes the space between them. That constant frame is
/// the point. A grid where a photographed item and a plain one are different
/// shapes reads as two different menus, and the clerk has to look at each tile
/// rather than at the position they already know.
///
/// The back office's button colour rides as a bar down the left edge instead
/// of filling the tile. Colour-coding a menu is genuinely useful and venues
/// use it; a wall of saturated fills is not what the counter should look like,
/// and it makes the offer flash — the one thing that should shout — compete
/// with sixteen things that should not.
class _ProductTile extends StatelessWidget {
  const _ProductTile({
    required this.product,
    required this.accent,
    required this.showPrice,
    required this.onTap,
    this.promotion,
  });

  final Product product;

  /// This product's colour from the back office, or its department's.
  final Color accent;

  final bool showPrice;
  final VoidCallback onTap;

  /// The offer covering this product now, if any.
  final Promotion? promotion;

  @override
  Widget build(BuildContext context) {
    final pal = PayPalette.of(context);
    final hasImage = product.imageUrl?.isNotEmpty ?? false;
    final hasEmoji = product.emoji?.isNotEmpty ?? false;

    return _PressableTile(
      onTap: onTap,
      child: Material(
        color: pal.panel,
        borderRadius: BorderRadius.circular(10),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: DecoratedBox(
            decoration: BoxDecoration(
              border: Border(
                left: BorderSide(color: accent, width: 3),
                top: BorderSide(color: pal.panelLine),
                right: BorderSide(color: pal.panelLine),
                bottom: BorderSide(color: pal.panelLine),
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(11, 10, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    product.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: pal.ink,
                      fontSize: 15,
                      height: 1.2,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  // Takes whatever the name and price leave, and gives it to
                  // the picture. An item with neither picture nor emoji simply
                  // has air here, which is what holds the price on the same
                  // line across the row.
                  Expanded(
                    child: hasImage
                        ? _image(pal)
                        : hasEmoji
                        ? Center(
                            child: FittedBox(
                              fit: BoxFit.scaleDown,
                              child: Text(
                                product.emoji!,
                                style: const TextStyle(fontSize: 42),
                              ),
                            ),
                          )
                        : const SizedBox.expand(),
                  ),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      if (showPrice)
                        Expanded(
                          child: Text(
                            money(product.priceMinor),
                            maxLines: 1,
                            style: TextStyle(
                              color: pal.ink,
                              fontSize: 18,
                              fontWeight: FontWeight.w700,
                              letterSpacing: -0.3,
                            ),
                          ),
                        )
                      else
                        const Spacer(),
                      if (_badgeText case final text?) ...[
                        const SizedBox(width: 6),
                        _OfferChip(text: text, colour: _badgeColour),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// The uploaded picture, inset so the tile's own edge still reads as the
  /// button and the accent bar is not covered.
  Widget _image(PayPalette pal) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: ClipRRect(
      borderRadius: BorderRadius.circular(7),
      child: Image.network(
        product.imageUrl!,
        fit: BoxFit.cover,
        width: double.infinity,
        // A picture that will not load leaves the tile exactly as a
        // product with no picture: name, space, price. The button stays
        // usable rather than showing a broken frame.
        errorBuilder: (_, _, _) => const SizedBox.expand(),
        loadingBuilder: (context, child, progress) => progress == null
            ? child
            : DecoratedBox(
                decoration: BoxDecoration(
                  color: pal.rowAlt,
                  borderRadius: BorderRadius.circular(7),
                ),
                child: const SizedBox.expand(),
              ),
      ),
    ),
  );

  String? get _badgeText {
    final text = promotion?.badgeText;
    return text == null || text.isEmpty ? null : text;
  }

  Color get _badgeColour =>
      Pos.parseColor(promotion?.badgeColour) ?? const Color(0xFFD81B60);
}

/// The offer flash on a product button.
class _OfferChip extends StatelessWidget {
  const _OfferChip({required this.text, required this.colour});

  final String text;
  final Color colour;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: colour,
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        text,
        // The badge colour is set per-promotion in the back office, so a
        // yellow "HALF PRICE" flash would otherwise be white-on-yellow.
        style: TextStyle(
          color: Pos.inkOn(colour),
          fontSize: 10,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.3,
        ),
      ),
    );
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
  late final TextEditingController _controller = TextEditingController(
    text: _quantity.toString(),
  );
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
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
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
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
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
                                final selection = ref.watch(
                                  selectedLinesProvider,
                                );
                                final picked =
                                    selection.orderId == orderId &&
                                    selection.ids.contains(line.id);
                                final scheme = Theme.of(context).colorScheme;

                                return ListTile(
                                  selected: picked,
                                  selectedTileColor: scheme.primary.withValues(
                                    alpha: 0.18,
                                  ),
                                  leading: picked
                                      ? Icon(
                                          Icons.check_circle,
                                          color: scheme.primary,
                                        )
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
    // the row on a smaller tablet.
    final width = MediaQuery.sizeOf(context).width.clamp(600.0, 1600.0) * 0.20;

    return SizedBox(
      width: width.clamp(150.0, 300.0),
      child: LayoutBuilder(
        builder: (context, constraints) {
          // Share the height out so at least ten rows fit. Rows grow when there
          // are only a few categories and shrink (to a floor that is still
          // comfortably tappable) when there are many; past that it scrolls,
          // because a 20px row nobody can hit is worse than scrolling.
          final slots = categories.length < _minVisible
              ? _minVisible
              : categories.length;
          // The gap between pills comes out of each slot, so the arithmetic
          // still lands on ten visible rows.
          final rowHeight = (constraints.maxHeight / slots - 6).clamp(
            42.0,
            70.0,
          );

          return ListView.builder(
            padding: const EdgeInsets.fromLTRB(0, 14, 14, 14),
            itemCount: categories.length,
            itemBuilder: (context, i) {
              final category = categories[i];
              return Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _CategoryTile(
                  label: category,
                  media: media[category],
                  // The office's colour wins; the till's per-name default is
                  // the fallback for categories it was never set on.
                  colour:
                      media[category]?.colour ?? Pos.categoryColor(category),
                  active: category == selected,
                  height: rowHeight,
                  onTap: () => onSelect(category),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

/// One key on the category rail.
///
/// The selected one is the brand lime, and the rest are quiet panels. That is
/// a change from filling every key with its own category colour, which made
/// the rail the loudest thing on a screen whose subject is the bill and the
/// grid — and left the clerk no single cue for *which one they are in*, since
/// everything was already shouting.
///
/// The category's own colour is not lost: it rides as a bar down the left of
/// the unselected keys, so a venue that has colour-coded its menu still reads
/// the rail by colour at a glance.
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
    final pal = PayPalette.of(context);
    final ink = active ? Pos.onBrand : pal.ink;
    // The thumbnail scales with the row so it never crowds out the name when
    // the rail is packed with categories.
    final thumb = (height - 16).clamp(24.0, 42.0);

    return Material(
      color: active ? Pos.brand : pal.panel,
      borderRadius: BorderRadius.circular(9),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: height,
          alignment: Alignment.centerLeft,
          padding: EdgeInsets.only(left: active ? 14 : 11, right: 12),
          decoration: BoxDecoration(
            border: active
                ? null
                : Border(
                    left: BorderSide(color: colour, width: 3),
                    top: BorderSide(color: pal.panelLine),
                    right: BorderSide(color: pal.panelLine),
                    bottom: BorderSide(color: pal.panelLine),
                  ),
          ),
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
              // shrinks it if a long name will not fit. The inner
              // ConstrainedBox is what makes wrapping possible: FittedBox
              // gives its child unbounded width, so without it `maxLines: 2`
              // could never wrap and every long name would be scaled down to a
              // single thin line.
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
                          fontSize: (height * 0.38).clamp(15.0, 24.0),
                          height: 1.1,
                          fontWeight: active
                              ? FontWeight.w700
                              : FontWeight.w600,
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
