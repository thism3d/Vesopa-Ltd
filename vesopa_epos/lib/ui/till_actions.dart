import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/kitchen_printing.dart';
import '../data/receipt_repository.dart';
import '../main.dart';
import '../printing/printer_transport.dart';
import '../printing/receipt_builder.dart';
import 'print_receipt_sheet.dart';
import 'printers_page.dart';
import 'receipts_page.dart' show receiptListProvider;
import 'widgets/pos_message.dart';
import 'widgets/print_status.dart';

/// The till functions that touch hardware or reprint paper.
///
/// Shared between the Functions screen and the sale screen's action bar,
/// because both offer the same three keys and a clerk who finds "No Sale"
/// working in one place and stubbed in the other has learned not to trust
/// either.
abstract final class TillActions {
  /// Open the cash drawer for a no-sale.
  ///
  /// The drawer is not a device the till talks to directly — it is wired into
  /// the receipt printer's kick port, so opening it is a printer command with
  /// nothing to print. That makes "no receipt printer" the real failure here,
  /// and it is reported as such rather than as a generic error.
  static Future<void> openCashDrawer(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final settings = await ref.read(printerSettingsProvider.future);
    final printer = settings.receiptPrinter;

    if (printer == null) {
      if (context.mounted) {
        _explain(
          context,
          'No receipt printer',
          'The cash drawer opens through the receipt printer it is plugged '
              'into, so one has to be set up before this key can work.\n\n'
              'Settings › Printing › Set up printers.',
        );
      }
      return;
    }

    try {
      final builder = await ReceiptBuilder.create();
      await PrinterTransport.of(printer).send(builder.openDrawer());
      if (context.mounted) _toast(context, 'Drawer opened.');
    } catch (e) {
      if (context.mounted) {
        _explain(
          context,
          'Could not open the drawer',
          'The till could not reach ${printer.name}.\n\n$e',
        );
      }
    }
  }

  /// Open the cash drawer for a sale that was paid, in whole or in part, with
  /// cash — the other half of [openCashDrawer].
  ///
  /// Same pulse down the same wire, but silent. The No Sale key is a clerk
  /// asking for the drawer and waiting to see it open, so that one reports what
  /// happened. This one fires while a sale is settling: the money is already
  /// taken, the customer is standing there waiting for change, and the next
  /// thing on screen is the one number the clerk needs. A dialog about a
  /// printer in front of that would cover the change and could not be acted on
  /// anyway — and a drawer that failed to open is not news to somebody standing
  /// in front of it.
  ///
  /// Never throws. A sale is not undone by a drawer, and by this point it
  /// cannot be undone at all.
  static Future<void> openCashDrawerQuietly(WidgetRef ref) async {
    try {
      final settings = await ref.read(printerSettingsProvider.future);
      final printer = settings.receiptPrinter;
      if (printer == null) return;
      final builder = await ReceiptBuilder.create();
      await PrinterTransport.of(printer).send(builder.openDrawer());
    } catch (_) {
      // Deliberately swallowed — see above.
    }
  }

  /// Send the kitchen whatever on this bill it has not been sent yet.
  ///
  /// Called from the two moments the venue asked for — an item is sold, or the
  /// bill is saved to a table — and deliberately from nowhere else, so a clerk
  /// can predict when paper appears in the kitchen.
  ///
  /// Never throws, and never blocks. By the time this runs the sale is already
  /// recorded or the table is already saved; a printer nobody plugged in must
  /// not undo either.
  ///
  /// The outcome goes to the top-bar status chip rather than to a dialog or a
  /// centre-screen message. Both of those sat in front of a clerk who had
  /// already moved on to the next customer, and neither offered them anything
  /// to *do* about it — where the chip stays put until the failure is retried
  /// or dismissed, and carries the retry itself.
  ///
  /// [context] is no longer needed to report anything, and is kept only so
  /// every call site reads the same as the other till actions.
  static Future<void> fireKitchen(
    BuildContext context,
    WidgetRef ref, {
    required String orderId,
    required KitchenFire reason,
  }) async {
    final status = ref.read(printStatusProvider.notifier);
    final printers = await ref.read(printerSettingsProvider.future);
    final settings = ref.read(tillSettingsProvider);

    // No guard here, deliberately. There used to be one — return early when
    // this terminal had no printers *and* the venue had no screens — and it
    // was the reason a venue could save table after table and never find out
    // that nothing reached the kitchen. Their products were routed to DRINKS,
    // DRINKS was still set to Printer, and no printer was bound on the till:
    // three settings that are each individually reasonable and together mean
    // silence. Nothing was shown, because the guard fired before anything had
    // been worked out.
    //
    // The decision belongs one level down, in `_run`, which knows something
    // this does not: whether any line on *this* bill is routed anywhere at
    // all. A counter till with no kitchen routes nothing, so it stays as quiet
    // as it ever was — and a bill that is routed to a station with nowhere to
    // go now says so, per station, on the chip.
    //
    // What the old guard is still good for is the *optimistic* half. "Sending
    // to the kitchen…" on a till with no kitchen configured at all is a chip
    // that flashes on every sale and means nothing, so it is held back here —
    // while the send itself goes ahead, and anything that fails is still
    // reported by `finished` below.
    final expectsAKitchen =
        printers.stations.isNotEmpty || settings.usesKitchenScreens;
    if (expectsAKitchen) status.printing('Sending to the kitchen…');
    try {
      final result = await ref
          .read(kitchenPrintingProvider)
          .fire(
            orderId: orderId,
            reason: reason,
            printers: printers,
            stationNames: settings.printerNames,
            delivery: settings.kitchenDelivery,
            screens: ref.read(kitchenScreenSenderProvider),
            office: ref.read(officeProvider),
            roomName: await _roomFor(ref, orderId),
            staffName: ref.read(servedByProvider),
          );
      status.finished(result);
    } catch (e) {
      status.failed('Kitchen printing: $e');
    }
  }

  /// Which room the bill's table is in, for the top of the kitchen card.
  ///
  /// "Table 4" on its own is ambiguous in any venue with two floors, and a chef
  /// carrying a plate to the wrong one is the cost. Read from the cached floor
  /// plan, so it still resolves with no network.
  ///
  /// Null for a counter sale, for a bill on no table, and for a till whose plan
  /// has not loaded — none of which is worth delaying a ticket over.
  static Future<String?> _roomFor(WidgetRef ref, String orderId) async {
    try {
      final order = await ref.read(orderRepositoryProvider)
          .watchOrder(orderId)
          .first;
      final number = order.tableNumber;
      if (number == null) return null;

      final rooms = ref.read(floorPlanProvider).value;
      if (rooms == null) return null;

      // The room the bill was actually saved to, when it recorded one. This
      // used to be the first room containing a table with that number, which is
      // only right in a venue where numbers do not repeat — and the floor plan
      // has allowed them to repeat across rooms since schema_fix_table_uq.sql.
      // A Terrace bill printed "Main Floor" and the plate went upstairs.
      final roomId = order.roomId;
      if (roomId != null) {
        for (final room in rooms) {
          if (room.id == roomId) return room.name;
        }
      }

      // No room recorded: a bill parked before this was stored, or a venue with
      // no floor plan. Falling back to the old guess is still better than
      // printing nothing, and in a one-room venue it is exactly right.
      for (final room in rooms) {
        if (room.tables.any((t) => t.number == number)) return room.name;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Pull everything the back office owns down to this terminal again.
  ///
  /// The till already does this on startup and on every reconnect, so this key
  /// is not how the catalogue normally arrives. It exists for the minute after
  /// a manager changes a price: they want to see it on the till *now*, and
  /// without this the honest answer is "wait for the push". A visible key that
  /// settles the question in two seconds is worth more than the argument that
  /// it should never be needed.
  ///
  /// Pushes queued sales first (that is what [SyncService.resync] does), so it
  /// doubles as the key to reach for when a till has been offline.
  static Future<void> refreshData(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(syncServiceProvider).resync();
      if (context.mounted) _toast(context, 'Data refreshed.');
    } catch (e) {
      if (context.mounted) {
        _explain(
          context,
          'Could not refresh',
          'The till could not reach the back office. It carries on selling '
              'from the copy it already has.\n\n$e',
        );
      }
    }
  }

  /// Reprint the most recent settled sale.
  ///
  /// Built from the receipt history rather than the bill on screen, so it works
  /// for the sale that has just been handed over — which is what a customer
  /// asking for "the last one" means. Goes through the preview sheet so it can
  /// be looked at, and printed, on a till with no printer bound.
  static Future<void> reprintLastReceipt(
    BuildContext context,
    WidgetRef ref,
  ) async {
    final list = await ref.read(receiptListProvider.future);
    if (!context.mounted) return;
    if (list.isEmpty) {
      _toast(context, 'No receipts yet on this till.');
      return;
    }

    final repo = ReceiptRepository(
      apiBase: ref.read(apiBaseProvider),
      office: ref.read(officeProvider),
    );

    final ReceiptDetail detail;
    try {
      detail = await repo.detail(list.first.id);
    } catch (e) {
      if (context.mounted) {
        _explain(
          context,
          'Could not load the last receipt',
          'Receipt history lives on the server, so this needs the network.'
              '\n\n$e',
        );
      }
      return;
    }
    if (!context.mounted) return;

    await PrintReceiptSheet.show(
      context,
      receipt: detail,
      venueName: ref.read(sessionProvider).venueName,
      branding: ref.read(brandingProvider),
      // A reprint is stamped as one: a second copy that looks identical to the
      // original can be passed off as a second sale.
      isReprint: true,
      title: 'Last receipt',
      showKitchenOption: false,
    );
  }

  /// Preview and print the bill **as it stands**, before it is paid.
  ///
  /// This is the customer's bill on a restaurant table, not a receipt: the
  /// money has not been taken, so it is marked as a request for payment rather
  /// than proof of one.
  static Future<void> printCurrentBill(
    BuildContext context,
    WidgetRef ref,
    String orderId,
  ) async {
    final repo = ref.read(orderRepositoryProvider);
    final order = await repo.watchOrder(orderId).first;
    final lines = await repo.watchLines(orderId).first;
    if (!context.mounted) return;

    if (lines.isEmpty) {
      _toast(context, 'Nothing on this bill yet.');
      return;
    }

    final session = ref.read(sessionProvider);
    final detail = ReceiptDetail(
      summary: ReceiptSummary(
        id: order.id,
        totalMinor: order.totalMinor,
        taxMinor: order.taxMinor,
        discountMinor: order.discountMinor,
        tableNumber: order.tableNumber,
        covers: order.covers,
        // Not closed yet — this is what the bill looks like now.
        closedAt: DateTime.now(),
        clerkName: ref.read(servedByProvider),
        customerName: order.customerName,
        orderNote: order.notes,
      ),
      lines: [
        for (final l in lines)
          ReceiptLine(
            name: l.name,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            taxPercentage: l.taxPercentage,
            note: l.notes,
          ),
      ],
      // No tenders: nothing has been paid. The layout then shows the total as
      // outstanding rather than printing a "Cash £0.00" line.
      tenders: const [],
    );

    await PrintReceiptSheet.show(
      context,
      receipt: detail,
      venueName: session.venueName,
      branding: ref.read(brandingProvider),
      isBill: true,
      title: 'Customer bill',
      showKitchenOption: order.tableNumber != null,
    );
  }

  static void _toast(BuildContext context, String message) {
    PosMessenger.info(context, message);
  }

  /// A dialog rather than a snackbar when the clerk has to *do* something: a
  /// toast about a missing printer scrolls away before it has been read.
  static void _explain(BuildContext context, String title, String detail) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(detail),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }
}
