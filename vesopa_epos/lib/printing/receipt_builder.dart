import 'dart:typed_data';

import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:image/image.dart' as img;
import 'package:intl/intl.dart';

import '../data/local/database.dart';
import '../data/session_repository.dart';
import '../data/cash_tally.dart';
import '../data/receipt_repository.dart';
import 'printer_transport.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

final _time = DateFormat('dd/MM/yyyy HH:mm');

/// Renders EPOS documents as ESC/POS byte streams for an 80mm thermal printer.
class ReceiptBuilder {
  ReceiptBuilder(this._generator);

  final Generator _generator;

  /// 80mm roll. The profile is loaded once and reused.
  static Future<ReceiptBuilder> create() async {
    final profile = await CapabilityProfile.load();
    return ReceiptBuilder(Generator(PaperSize.mm80, profile));
  }

  /// The customer's receipt.
  List<int> receipt({
    required Order order,
    required List<OrderLine> lines,
    required List<Payment> payments,
    String? shopName,
    String? footer,
    Uint8List? logo,
    String? heading,
  }) {
    final bytes = <int>[];

    if (logo != null) {
      final decoded = img.decodeImage(logo);
      if (decoded != null) {
        // Thermal printers are 1-bit: shrink to the roll width and let the
        // library dither, or the logo prints as a black block.
        final resized = img.copyResize(decoded, width: 360);
        bytes.addAll(_generator.image(resized));
      }
    }

    if (shopName != null) {
      bytes.addAll(
        _generator.text(
          shopName,
          styles: const PosStyles(
            align: PosAlign.center,
            height: PosTextSize.size2,
            width: PosTextSize.size2,
            bold: true,
          ),
        ),
      );
    }

    // Which copy this is, when it is not the customer's. A merchant copy that
    // looks identical to the customer's can be handed over by mistake, and a
    // stack of them on the desk is indistinguishable from receipts that were
    // never given out.
    if (heading != null && heading.isNotEmpty) {
      bytes.addAll(
        _generator.text(
          heading,
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }

    bytes.addAll(_generator.hr());
    bytes.addAll(
      _generator.text(
        _time.format(order.createdAt),
        styles: const PosStyles(align: PosAlign.center),
      ),
    );
    if (order.tableNumber != null) {
      bytes.addAll(
        _generator.text(
          'Table ${order.tableNumber}',
          styles: const PosStyles(align: PosAlign.center),
        ),
      );
    }
    bytes.addAll(_generator.hr());

    for (final line in lines) {
      final lineTotal = (line.unitPriceMinor * line.quantity).round();
      bytes.addAll(
        _generator.row([
          PosColumn(
            text: '${line.quantity.toStringAsFixed(0)}x ${line.name}',
            width: 8,
          ),
          PosColumn(
            text: _money(lineTotal),
            width: 4,
            styles: const PosStyles(align: PosAlign.right),
          ),
        ]),
      );
      // Notes belong to the item they were taken against, printed directly
      // under it. The thermal receipt was dropping them entirely — the PDF
      // receipt has always shown them, so the same sale printed two ways said
      // two different things.
      if (line.notes != null && line.notes!.isNotEmpty) {
        bytes.addAll(_generator.text('   * ${line.notes}'));
      }
    }

    bytes.addAll(_generator.hr());
    bytes.addAll(_row('Subtotal', _money(order.subtotalMinor)));
    if (order.discountMinor > 0) {
      bytes.addAll(_row('Discount', '-${_money(order.discountMinor)}'));
    }
    bytes.addAll(_row('VAT', _money(order.taxMinor)));
    bytes.addAll(
      _generator.row([
        PosColumn(
          text: 'TOTAL',
          width: 6,
          styles: const PosStyles(bold: true, height: PosTextSize.size2),
        ),
        PosColumn(
          text: _money(order.totalMinor),
          width: 6,
          styles: const PosStyles(
            align: PosAlign.right,
            bold: true,
            height: PosTextSize.size2,
          ),
        ),
      ]),
    );

    bytes.addAll(_generator.hr());
    for (final p in payments) {
      bytes.addAll(_row(p.method.toUpperCase(), _money(p.amountMinor)));
      // The notes actually handed over, when they were counted in on the cash
      // keys — so the customer can check the receipt against their wallet.
      final tally = CashTally.decode(p.cashBreakdown);
      if (tally.isNotEmpty) {
        bytes.addAll(_generator.text('   ${tally.describe()}'));
      }
    }

    // Change is only meaningful for cash, and only when they overpaid.
    final paid = payments.fold<int>(0, (s, p) => s + p.amountMinor);
    final change = paid - order.totalMinor;
    if (change > 0) {
      bytes.addAll(_row('CHANGE', _money(change)));
    }

    if (footer != null) {
      bytes.addAll(_generator.feed(1));
      bytes.addAll(
        _generator.text(footer, styles: const PosStyles(align: PosAlign.center)),
      );
    }

    bytes.addAll(_generator.feed(2));
    bytes.addAll(_generator.cut());
    return bytes;
  }

  /// The same receipt, built from a settled receipt read back from the server.
  ///
  /// A second entry point rather than a conversion, because the two sources
  /// genuinely differ: a live order is drift rows on this terminal, a settled
  /// one is JSON from the back office and carries things the local row does not
  /// — the voucher, the service charge, the loyalty points, the clerk. Printing
  /// a reprint through the live path would silently drop all of them, and the
  /// customer would get a different receipt from the one they were given.
  List<int> receiptFromDetail(
    ReceiptDetail detail, {
    String? shopName,
    String? footer,
    Uint8List? logo,
    String? heading,
  }) {
    final bytes = <int>[];
    final summary = detail.summary;

    if (logo != null) {
      final decoded = img.decodeImage(logo);
      if (decoded != null) {
        final resized = img.copyResize(decoded, width: 360);
        bytes.addAll(_generator.image(resized));
      }
    }

    if (shopName != null && shopName.isNotEmpty) {
      bytes.addAll(
        _generator.text(
          shopName,
          styles: const PosStyles(
            align: PosAlign.center,
            height: PosTextSize.size2,
            width: PosTextSize.size2,
            bold: true,
          ),
        ),
      );
    }

    if (heading != null && heading.isNotEmpty) {
      bytes.addAll(
        _generator.text(
          heading,
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }

    bytes.addAll(_generator.hr());
    bytes.addAll(
      _generator.text(
        _time.format(summary.closedAt),
        styles: const PosStyles(align: PosAlign.center),
      ),
    );
    if (summary.tableNumber != null) {
      bytes.addAll(
        _generator.text(
          'Table ${summary.tableNumber}'
          '${summary.covers != null ? '  ·  ${summary.covers} covers' : ''}',
          styles: const PosStyles(align: PosAlign.center),
        ),
      );
    }
    if (summary.clerkName?.isNotEmpty ?? false) {
      bytes.addAll(
        _generator.text(
          'Served by ${summary.clerkName}',
          styles: const PosStyles(align: PosAlign.center),
        ),
      );
    }
    bytes.addAll(_generator.hr());

    for (final line in detail.lines) {
      bytes.addAll(
        _generator.row([
          PosColumn(
            text: '${line.quantity.toStringAsFixed(0)}x ${line.name}',
            width: 8,
          ),
          PosColumn(
            text: _money(line.lineTotalMinor),
            width: 4,
            styles: const PosStyles(align: PosAlign.right),
          ),
        ]),
      );
      if (line.note?.isNotEmpty ?? false) {
        bytes.addAll(_generator.text('   * ${line.note}'));
      }
    }

    bytes.addAll(_generator.hr());
    bytes.addAll(_row('Subtotal', _money(summary.grossMinor)));
    if (summary.discountMinor > 0) {
      bytes.addAll(_row('Discount', '-${_money(summary.discountMinor)}'));
    }
    if (summary.voucherMinor > 0) {
      bytes.addAll(
        _row(
          summary.voucherCode?.isNotEmpty ?? false
              ? 'Voucher ${summary.voucherCode}'
              : 'Voucher',
          '-${_money(summary.voucherMinor)}',
        ),
      );
    }
    if (summary.serviceMinor > 0) {
      bytes.addAll(_row('Service', _money(summary.serviceMinor)));
    }
    bytes.addAll(_row('VAT', _money(summary.taxMinor)));
    bytes.addAll(
      _generator.row([
        PosColumn(
          text: 'TOTAL',
          width: 6,
          styles: const PosStyles(bold: true, height: PosTextSize.size2),
        ),
        PosColumn(
          text: _money(summary.totalMinor),
          width: 6,
          styles: const PosStyles(
            align: PosAlign.right,
            bold: true,
            height: PosTextSize.size2,
          ),
        ),
      ]),
    );

    bytes.addAll(_generator.hr());
    for (final tender in detail.tenders) {
      bytes.addAll(
        _row(tender.method.toUpperCase(), _money(tender.amountMinor)),
      );
      final tally = CashTally.decode(tender.cashBreakdown);
      if (tally.isNotEmpty) {
        bytes.addAll(_generator.text('   ${tally.describe()}'));
      }
    }

    final paid = detail.tenders.fold<int>(0, (s, t) => s + t.amountMinor);
    final change = paid - summary.totalMinor;
    if (change > 0) {
      bytes.addAll(_row('CHANGE', _money(change)));
    }

    // Loyalty, when there is any. A member who cannot see their balance on the
    // receipt has to ask for it, which is the counter's time.
    if (summary.pointsEarned > 0 ||
        summary.pointsRedeemed > 0 ||
        summary.pointsBalance != null) {
      bytes.addAll(_generator.hr());
      if (summary.customerName?.isNotEmpty ?? false) {
        bytes.addAll(_generator.text(summary.customerName!));
      }
      if (summary.pointsEarned > 0) {
        bytes.addAll(_row('Points earned', '${summary.pointsEarned}'));
      }
      if (summary.pointsRedeemed > 0) {
        bytes.addAll(_row('Points spent', '${summary.pointsRedeemed}'));
      }
      if (summary.pointsBalance != null) {
        bytes.addAll(_row('Points balance', '${summary.pointsBalance}'));
      }
    }

    if (footer != null && footer.isNotEmpty) {
      bytes.addAll(_generator.feed(1));
      bytes.addAll(
        _generator.text(footer, styles: const PosStyles(align: PosAlign.center)),
      );
    }

    bytes.addAll(_generator.feed(2));
    bytes.addAll(_generator.cut());
    return bytes;
  }

  /// A kitchen ticket. Deliberately plain and large: it is read across a
  /// counter, at speed, and never shows prices — the kitchen does not need
  /// them and they only add noise.
  List<int> kitchenTicket({
    required Order order,
    required List<OrderLine> lines,
    required String station,
    String? headline,
    String? staffName,
  }) {
    final bytes = <int>[];

    bytes.addAll(
      _generator.text(
        station.toUpperCase(),
        styles: const PosStyles(
          align: PosAlign.center,
          height: PosTextSize.size2,
          width: PosTextSize.size2,
          bold: true,
        ),
      ),
    );

    // Why this ticket exists — a sale that has been paid for, or a table that
    // has just been saved. The kitchen works these two differently, and a
    // ticket that does not say which is a ticket somebody has to come and ask
    // about.
    if (headline != null && headline.isNotEmpty) {
      bytes.addAll(
        _generator.text(
          headline.toUpperCase(),
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }

    if (order.tableNumber != null) {
      bytes.addAll(
        _generator.text(
          'TABLE ${order.tableNumber}',
          styles: const PosStyles(
            align: PosAlign.center,
            height: PosTextSize.size2,
            bold: true,
          ),
        ),
      );
    }

    bytes.addAll(
      _generator.text(
        _time.format(DateTime.now()),
        styles: const PosStyles(align: PosAlign.center),
      ),
    );
    bytes.addAll(_generator.hr());

    for (final line in lines) {
      bytes.addAll(
        _generator.text(
          '${line.quantity.toStringAsFixed(0)}x  ${line.name}',
          styles: const PosStyles(
            height: PosTextSize.size2,
            bold: true,
          ),
        ),
      );
      if (line.notes != null && line.notes!.isNotEmpty) {
        bytes.addAll(_generator.text('   * ${line.notes}'));
      }
    }

    if (order.notes != null && order.notes!.isNotEmpty) {
      bytes.addAll(_generator.hr());
      bytes.addAll(_generator.text('NOTE: ${order.notes}'));
    }

    // Who rang it, so the kitchen has somebody to ask about a query rather
    // than having to work out which till the ticket came off.
    if (staffName != null && staffName.isNotEmpty) {
      bytes.addAll(_generator.hr());
      bytes.addAll(_generator.text(staffName));
    }

    bytes.addAll(_generator.feed(2));
    bytes.addAll(_generator.cut());
    return bytes;
  }

  /// X or Z report.
  List<int> tillReport(TillReport report, {String? shopName}) {
    final bytes = <int>[];
    final title = report.isZ ? 'Z REPORT' : 'X REPORT';

    if (shopName != null) {
      bytes.addAll(
        _generator.text(
          shopName,
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }
    bytes.addAll(
      _generator.text(
        report.isZ && report.zNumber != null ? '$title #${report.zNumber}' : title,
        styles: const PosStyles(
          align: PosAlign.center,
          height: PosTextSize.size2,
          width: PosTextSize.size2,
          bold: true,
        ),
      ),
    );

    bytes.addAll(_generator.hr());
    bytes.addAll(_row('Opened', _time.format(report.openedAt)));
    bytes.addAll(
      _row('Printed', _time.format(report.closedAt ?? DateTime.now())),
    );
    bytes.addAll(_generator.hr());

    bytes.addAll(_row('Orders', '${report.orderCount}'));
    bytes.addAll(_row('Gross', _money(report.grossMinor)));
    bytes.addAll(_row('Discounts', '-${_money(report.discountMinor)}'));
    bytes.addAll(_row('VAT', _money(report.taxMinor)));

    if (report.byMethod.isNotEmpty) {
      bytes.addAll(_generator.hr());
      bytes.addAll(
        _generator.text('BY TENDER', styles: const PosStyles(bold: true)),
      );
      for (final entry in report.byMethod.entries) {
        bytes.addAll(_row(entry.key.toUpperCase(), _money(entry.value)));
      }
    }

    if (report.byDepartment.isNotEmpty) {
      bytes.addAll(_generator.hr());
      bytes.addAll(
        _generator.text('BY DEPARTMENT', styles: const PosStyles(bold: true)),
      );
      for (final entry in report.byDepartment.entries) {
        bytes.addAll(_row(entry.key, _money(entry.value)));
      }
    }

    // What should be in the drawer, so the manager can count against it.
    bytes.addAll(_generator.hr());
    bytes.addAll(_row('Float', _money(report.openingFloatMinor)));
    bytes.addAll(
      _generator.row([
        PosColumn(
          text: 'CASH EXPECTED',
          width: 7,
          styles: const PosStyles(bold: true),
        ),
        PosColumn(
          text: _money(report.expectedCashMinor),
          width: 5,
          styles: const PosStyles(align: PosAlign.right, bold: true),
        ),
      ]),
    );

    if (report.isZ) {
      bytes.addAll(_generator.feed(1));
      bytes.addAll(
        _generator.text(
          '*** TOTALS RESET ***',
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }

    bytes.addAll(_generator.feed(2));
    bytes.addAll(_generator.cut());
    return bytes;
  }

  /// Opens the cash drawer (the "No Sale" key). The drawer is a solenoid wired
  /// into a printer's RJ11 socket, so this is a printer command with nothing to
  /// print.
  List<int> openDrawer() => _generator.drawer();

  /// A slip proving a printer is set up and reachable.
  ///
  /// Prints how it is connected and how wide its roll is, because those are the
  /// two things that are wrong when a printer works but its output does not:
  /// paper coming out of the machine nobody expected, or an 80mm layout with
  /// the price column off the edge of a 58mm roll. The ruler line makes the
  /// second visible at a glance — if it wraps, the width is wrong.
  List<int> testSlip(PrinterConfig printer) {
    final bytes = <int>[];

    bytes.addAll(
      _generator.text(
        'TEST PRINT',
        styles: const PosStyles(
          align: PosAlign.center,
          height: PosTextSize.size2,
          width: PosTextSize.size2,
          bold: true,
        ),
      ),
    );
    bytes.addAll(_generator.hr());
    bytes.addAll(_row('Printer', printer.name));
    bytes.addAll(_row('Connection', printer.kind.label));
    bytes.addAll(_row('Reached at', printer.connectionSummary));
    bytes.addAll(
      _row('Spooler', printer.isDirect ? 'Bypassed' : 'Windows queue'),
    );
    bytes.addAll(_row('Roll', '${printer.paperWidthMm}mm'));
    bytes.addAll(_row('Printed', _time.format(DateTime.now())));
    bytes.addAll(_generator.hr());
    bytes.addAll(
      _generator.text(
        'The line below should fit on one line.',
        styles: const PosStyles(align: PosAlign.center),
      ),
    );
    bytes.addAll(_generator.text('1234567890' * 5));
    bytes.addAll(_generator.feed(2));
    bytes.addAll(_generator.cut());
    return bytes;
  }

  List<int> _row(String label, String value) => _generator.row([
        PosColumn(text: label, width: 7),
        PosColumn(
          text: value,
          width: 5,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]);
}
