import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/receipt_repository.dart';
import '../main.dart';
import '../printing/printer_transport.dart';
import '../printing/receipt_builder.dart';
import 'print_receipt_sheet.dart';
import 'printers_page.dart';
import 'receipts_page.dart' show receiptListProvider;
import 'widgets/pos_message.dart';

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
