import 'dart:typed_data';

import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:image/image.dart' as img;
import 'package:intl/intl.dart';

import '../data/local/database.dart';
import '../data/session_repository.dart';
import '../data/cash_tally.dart';

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

  /// A kitchen ticket. Deliberately plain and large: it is read across a
  /// counter, at speed, and never shows prices — the kitchen does not need
  /// them and they only add noise.
  List<int> kitchenTicket({
    required Order order,
    required List<OrderLine> lines,
    required String station,
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

  /// Opens the cash drawer (the "No Sale" key). The drawer is wired to the
  /// receipt printer, so this is a printer command with nothing to print.
  List<int> openDrawer() => _generator.drawer();

  List<int> _row(String label, String value) => _generator.row([
        PosColumn(text: label, width: 7),
        PosColumn(
          text: value,
          width: 5,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]);
}
