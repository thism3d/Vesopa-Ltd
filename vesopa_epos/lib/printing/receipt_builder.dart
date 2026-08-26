import 'dart:typed_data';

import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';
import 'package:image/image.dart' as img;
import 'package:intl/intl.dart';

import '../data/local/database.dart';
import '../data/modifier_layout.dart';
import '../data/session_repository.dart';
import '../data/cash_tally.dart';
import '../data/receipt_repository.dart';
import 'printer_transport.dart';

String _money(int minor) =>
    NumberFormat.currency(locale: 'en_GB', symbol: '£').format(minor / 100);

final _time = DateFormat('dd/MM/yyyy HH:mm');

/// The code page every document is printed in.
///
/// A thermal printer powers up in its factory code page, which is almost always
/// CP437 — and in CP437 the byte 0xA3 is "ú", not "£". Nothing here used to
/// select a page at all, so the till encoded "£12.00" correctly and the printer
/// then drew it as "ú12.00".
///
/// CP1252 is the fix because it agrees with Latin-1 across the whole 0xA0–0xFF
/// range, and Latin-1 is what [Generator] encodes with. The bytes the till
/// already produced are right; this is what makes the printer read them the
/// same way.
const _codePage = 'CP1252';

/// Characters no CP1252 printer can render, mapped to what a receipt should
/// show instead.
///
/// The pound and euro signs are deliberately absent from the *dropping* side of
/// this: "£" is a plain CP1252 byte and must survive untouched, while "€" has
/// no Latin-1 encoding at all and has to be spelled out. Everything else here
/// is typography that reaches the printer from human-entered text — a footer
/// message typed in the back office, a product name pasted from a supplier's
/// spreadsheet, a customer's name.
const _substitutions = {
  '€': 'EUR ',
  '—': '-',
  '–': '-',
  '‑': '-',
  '’': "'",
  '‘': "'",
  '‚': ',',
  '“': '"',
  '”': '"',
  '„': '"',
  '…': '...',
  '•': '*',
  '×': 'x',
  '÷': '/',
  '≥': '>=',
  '≤': '<=',
  '→': '->',
  '™': 'TM',
  // A non-breaking space (U+00A0), flattened to an ordinary one. It survives
  // Latin-1 intact, but it arrives invisibly in text pasted from a spreadsheet
  // or a web page, and some printers draw it as a solid block, not a gap.
  ' ': ' ',
};

/// Makes [text] safe to put on a thermal printer.
///
/// This exists because the failure it prevents is not a cosmetic one. The
/// generator encodes with Latin-1, and Latin-1 *throws* on anything it cannot
/// represent — so a single em dash in a heading did not print a wrong
/// character, it threw `Invalid argument (string): Contains invalid
/// characters.` and no receipt came out at all. The venue's own footer message
/// and any product name from the back office both land here, so this cannot be
/// left to whoever writes the string literals.
///
/// Anything unrecognised outside Latin-1 becomes "?" rather than vanishing:
/// visible evidence of a problem beats a blank where a customer's name should
/// be. Control characters become spaces, because a stray newline or carriage
/// return in a product name silently derails the column layout for the rest of
/// the line.
String escPosSafe(String text) {
  final out = StringBuffer();
  for (final rune in text.runes) {
    final ch = String.fromCharCode(rune);
    final swap = _substitutions[ch];
    if (swap != null) {
      out.write(swap);
    } else if (rune == 0x0a) {
      out.write(ch);
    } else if (rune < 0x20 || (rune >= 0x7f && rune <= 0x9f)) {
      out.write(' ');
    } else if (rune <= 0xff) {
      out.write(ch);
    } else {
      out.write('?');
    }
  }
  return out.toString();
}

/// Renders EPOS documents as ESC/POS byte streams for a thermal printer.
class ReceiptBuilder {
  ReceiptBuilder(this._generator, {this.columns = 48}) {
    // Recorded on the generator rather than emitted, so that every later
    // `reset()` re-selects it: `reset()` sends ESC @, which drops the printer
    // back to its factory code page, and then re-applies whatever was set here.
    // [_begin] is what actually puts the selection on the wire.
    _generator.setGlobalCodeTable(_codePage);
  }

  final Generator _generator;

  /// Characters per line at Font A on the roll this builder is laying out for.
  final int columns;

  /// The profile is loaded once and reused.
  ///
  /// [paperWidthMm] must match the roll actually loaded in the printer this
  /// document is going to. It drives the column arithmetic, so an 80mm layout
  /// sent to a 58mm roll does not wrap — it prints off the edge of the paper,
  /// taking the right-hand price column with it.
  static Future<ReceiptBuilder> create({int paperWidthMm = 80}) async {
    final profile = await CapabilityProfile.load();
    final narrow = paperWidthMm == 58;
    return ReceiptBuilder(
      Generator(narrow ? PaperSize.mm58 : PaperSize.mm80, profile),
      columns: narrow ? 32 : 48,
    );
  }

  /// Opens a document: clears whatever the last job left behind and selects the
  /// code page. Every builder below starts with this.
  List<int> _begin() => _generator.reset();

  /// Text, with anything the printer cannot render dealt with first.
  List<int> _text(String text, {PosStyles styles = const PosStyles()}) =>
      _generator.text(escPosSafe(text), styles: styles);

  /// A column, sanitised the same way. Named exactly like [PosColumn] so the
  /// two are not confusable at a call site.
  PosColumn _col({
    String text = '',
    int width = 2,
    PosStyles styles = const PosStyles(),
  }) => PosColumn(text: escPosSafe(text), width: width, styles: styles);

  /// The venue's name, sized to the roll.
  ///
  /// Double width is the look a receipt wants, but it halves how much fits on a
  /// line — 24 characters on an 80mm roll — and a name longer than that wraps
  /// into a block of oversized text several lines deep at the top of the
  /// receipt. Past that length the name drops to single width, which still
  /// reads as a heading and still fits.
  List<int> _shopName(String name) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return const [];
    final wide = escPosSafe(trimmed).length <= _wideColumns;
    return _text(
      trimmed,
      styles: PosStyles(
        align: PosAlign.center,
        height: wide ? PosTextSize.size2 : PosTextSize.size1,
        width: wide ? PosTextSize.size2 : PosTextSize.size1,
        bold: true,
      ),
    );
  }

  /// Characters that fit on one double-width line.
  int get _wideColumns => columns ~/ 2;

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
    final bytes = _begin();

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
      bytes.addAll(_shopName(shopName));
    }

    // Which copy this is, when it is not the customer's. A merchant copy that
    // looks identical to the customer's can be handed over by mistake, and a
    // stack of them on the desk is indistinguishable from receipts that were
    // never given out.
    if (heading != null && heading.isNotEmpty) {
      bytes.addAll(
        _text(
          heading,
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }

    bytes.addAll(_generator.hr());
    bytes.addAll(
      _text(
        _time.format(order.createdAt),
        styles: const PosStyles(align: PosAlign.center),
      ),
    );
    if (order.tableNumber != null) {
      bytes.addAll(
        _text(
          'Table ${order.tableNumber}',
          styles: const PosStyles(align: PosAlign.center),
        ),
      );
    }
    bytes.addAll(_generator.hr());

    // Modifiers print under the item they were chosen for. See nestModifiers.
    for (final entry in nestModifiers(lines)) {
      final line = entry.line;
      final lineTotal = (line.unitPriceMinor * line.quantity).round();
      // A modifier that costs nothing prints as a bare instruction rather than
      // as "£0.00", which reads on a bill like something went wrong. One that
      // costs money prints its price like any other line, because that is what
      // the customer is being charged for.
      final indent = entry.isModifier ? '  + ' : '';
      final qty = entry.isModifier && line.quantity == 1
          ? ''
          : '${line.quantity.toStringAsFixed(0)}x ';
      bytes.addAll(
        _generator.row([
          _col(
            text: '$indent$qty${line.name}',
            width: 8,
          ),
          _col(
            text: entry.isModifier && lineTotal == 0 ? '' : _money(lineTotal),
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
        bytes.addAll(_text('   * ${line.notes}'));
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
        _col(
          text: 'TOTAL',
          width: 6,
          styles: const PosStyles(bold: true, height: PosTextSize.size2),
        ),
        _col(
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
        bytes.addAll(_text('   ${tally.describe()}'));
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
        _text(footer, styles: const PosStyles(align: PosAlign.center)),
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
    final bytes = _begin();
    final summary = detail.summary;

    if (logo != null) {
      final decoded = img.decodeImage(logo);
      if (decoded != null) {
        final resized = img.copyResize(decoded, width: 360);
        bytes.addAll(_generator.image(resized));
      }
    }

    if (shopName != null && shopName.isNotEmpty) {
      bytes.addAll(_shopName(shopName));
    }

    if (heading != null && heading.isNotEmpty) {
      bytes.addAll(
        _text(
          heading,
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }

    bytes.addAll(_generator.hr());
    bytes.addAll(
      _text(
        _time.format(summary.closedAt),
        styles: const PosStyles(align: PosAlign.center),
      ),
    );
    if (summary.tableNumber != null) {
      bytes.addAll(
        _text(
          'Table ${summary.tableNumber}'
          '${summary.covers != null ? '  ·  ${summary.covers} covers' : ''}',
          styles: const PosStyles(align: PosAlign.center),
        ),
      );
    }
    if (summary.clerkName?.isNotEmpty ?? false) {
      bytes.addAll(
        _text(
          'Served by ${summary.clerkName}',
          styles: const PosStyles(align: PosAlign.center),
        ),
      );
    }
    bytes.addAll(_generator.hr());

    for (final line in detail.lines) {
      bytes.addAll(
        _generator.row([
          _col(
            text: '${line.quantity.toStringAsFixed(0)}x ${line.name}',
            width: 8,
          ),
          _col(
            text: _money(line.lineTotalMinor),
            width: 4,
            styles: const PosStyles(align: PosAlign.right),
          ),
        ]),
      );
      if (line.note?.isNotEmpty ?? false) {
        bytes.addAll(_text('   * ${line.note}'));
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
        _col(
          text: 'TOTAL',
          width: 6,
          styles: const PosStyles(bold: true, height: PosTextSize.size2),
        ),
        _col(
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
        bytes.addAll(_text('   ${tally.describe()}'));
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
        bytes.addAll(_text(summary.customerName!));
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
        _text(footer, styles: const PosStyles(align: PosAlign.center)),
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
    String? roomName,
  }) {
    final bytes = _begin();

    bytes.addAll(
      _text(
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
        _text(
          headline.toUpperCase(),
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }

    if (order.tableNumber != null) {
      bytes.addAll(
        _text(
          'TABLE ${order.tableNumber}',
          styles: const PosStyles(
            align: PosAlign.center,
            height: PosTextSize.size2,
            bold: true,
          ),
        ),
      );
    }

    // Which room that table is in.
    //
    // "Table 4" is not an address in a venue with a Main Floor and a Terrace —
    // both have a table 4, and the cost of the ambiguity is a chef handing a
    // plate to a runner who walks it to the wrong one. Printed under the number
    // rather than beside it, so the number keeps the whole width and stays the
    // thing read first from a metre away.
    //
    // Single height, not double: it qualifies the table, and a room name set as
    // loud as the table number competes with it.
    if (roomName != null && roomName.trim().isNotEmpty) {
      bytes.addAll(
        _text(
          roomName.trim().toUpperCase(),
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }

    bytes.addAll(
      _text(
        _time.format(DateTime.now()),
        styles: const PosStyles(align: PosAlign.center),
      ),
    );
    bytes.addAll(_generator.hr());

    for (final entry in nestModifiers(lines)) {
      final line = entry.line;
      if (entry.isModifier) {
        // Under the dish, indented, and at normal height. Double-height for
        // "Rare" beside a double-height "Steak" is two things competing to be
        // read first on a ticket somebody is glancing at over a pass.
        bytes.addAll(_text('   > ${line.name}', styles: const PosStyles(bold: true)));
      } else {
        bytes.addAll(
          _text(
            '${line.quantity.toStringAsFixed(0)}x  ${line.name}',
            styles: const PosStyles(
              height: PosTextSize.size2,
              bold: true,
            ),
          ),
        );
      }
      if (line.notes != null && line.notes!.isNotEmpty) {
        bytes.addAll(_text('   * ${line.notes}'));
      }
    }

    if (order.notes != null && order.notes!.isNotEmpty) {
      bytes.addAll(_generator.hr());
      bytes.addAll(_text('NOTE: ${order.notes}'));
    }

    // Who rang it, so the kitchen has somebody to ask about a query rather
    // than having to work out which till the ticket came off.
    if (staffName != null && staffName.isNotEmpty) {
      bytes.addAll(_generator.hr());
      bytes.addAll(_text(staffName));
    }

    bytes.addAll(_generator.feed(2));
    bytes.addAll(_generator.cut());
    return bytes;
  }

  /// X or Z report.
  List<int> tillReport(TillReport report, {String? shopName}) {
    final bytes = _begin();
    final title = report.isZ ? 'Z REPORT' : 'X REPORT';

    if (shopName != null) {
      bytes.addAll(
        _text(
          shopName,
          styles: const PosStyles(align: PosAlign.center, bold: true),
        ),
      );
    }
    bytes.addAll(
      _text(
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
        _text('BY TENDER', styles: const PosStyles(bold: true)),
      );
      for (final entry in report.byMethod.entries) {
        bytes.addAll(_row(entry.key.toUpperCase(), _money(entry.value)));
      }
    }

    if (report.byDepartment.isNotEmpty) {
      bytes.addAll(_generator.hr());
      bytes.addAll(
        _text('BY DEPARTMENT', styles: const PosStyles(bold: true)),
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
        _col(
          text: 'CASH EXPECTED',
          width: 7,
          styles: const PosStyles(bold: true),
        ),
        _col(
          text: _money(report.expectedCashMinor),
          width: 5,
          styles: const PosStyles(align: PosAlign.right, bold: true),
        ),
      ]),
    );

    if (report.isZ) {
      bytes.addAll(_generator.feed(1));
      bytes.addAll(
        _text(
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
    final bytes = _begin();

    bytes.addAll(
      _text(
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

    // The pound sign, checked on paper rather than on screen. It depends on the
    // printer being on the right code page, which is a property of the printer
    // and not of the till — so it is only ever really answered by printing one.
    bytes.addAll(_row('Currency', _money(123456)));
    bytes.addAll(
      _text(
        'The amount above must show a £ sign.',
        styles: const PosStyles(align: PosAlign.center),
      ),
    );

    bytes.addAll(_generator.hr());
    bytes.addAll(
      _text(
        'The line below should fit on one line.',
        styles: const PosStyles(align: PosAlign.center),
      ),
    );
    // Exactly one full line for this roll: if it wraps, the printer is loaded
    // with narrower paper than it has been set up for.
    bytes.addAll(_text(('1234567890' * 5).substring(0, columns)));
    bytes.addAll(_generator.feed(2));
    bytes.addAll(_generator.cut());
    return bytes;
  }

  List<int> _row(String label, String value) => _generator.row([
        _col(text: label, width: 7),
        _col(
          text: value,
          width: 5,
          styles: const PosStyles(align: PosAlign.right),
        ),
      ]);
}
