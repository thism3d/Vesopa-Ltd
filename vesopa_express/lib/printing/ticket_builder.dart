/// The kiosk's ticket, as ESC/POS bytes.
///
/// WHAT IT IS FOR
///
/// The number. A customer at a McDonald's kiosk walks away holding a slip with
/// their order number on it, and watches for that number on the board; the
/// screen with the number on it has gone back to the start for the next person
/// by the time they have found a seat. So the number is the biggest thing on
/// the paper, and everything else -- what was ordered, what it cost, the VAT,
/// who took the money -- is the receipt the law and the customer's expenses
/// claim want underneath it.
///
/// A pay-at-the-counter order says PAY AT THE COUNTER across the top in large
/// type, because that slip is what gets handed over the counter. A demo order
/// says it is not a receipt.
///
/// The header and footer are the venue's own receipt branding (Receipt
/// Designer in the back office), so paper from the kiosk and from the till
/// agree about who the venue is and what its VAT number is.
///
/// THE POUND SIGN, AND EVERYTHING ELSE A PRINTER CANNOT DRAW
///
/// The till's rules, brought across whole (vesopa_epos/lib/printing/
/// receipt_builder.dart): the UK international set for "£" by default, and
/// anything outside Latin-1 swapped or replaced before it reaches the
/// generator -- which THROWS on such a character, so one em dash in a dish's
/// name would otherwise mean no ticket at all.
library;

import 'package:esc_pos_utils_plus/esc_pos_utils_plus.dart';

import '../data/basket.dart' show money;
import '../data/models.dart';
import 'ticket_printer.dart' show escPosGbp;

const _codePage = 'CP1252';

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
  '·': '-',
  '×': 'x',
  ' ': ' ',
};

/// [text] made safe for a thermal printer. See the till's escPosSafe, whose
/// rules these are.
String escPosSafe(String text, {bool ukAscii = false}) {
  final out = StringBuffer();
  for (final rune in text.runes) {
    final ch = String.fromCharCode(rune);
    if (ukAscii) {
      if (ch == '£') {
        out.write('#');
        continue;
      }
      if (ch == '#') {
        out.write('No.');
        continue;
      }
    }
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

String _two(int n) => n.toString().padLeft(2, '0');

String _when(DateTime t) =>
    '${_two(t.day)}/${_two(t.month)}/${t.year} ${_two(t.hour)}:${_two(t.minute)}';

class TicketBuilder {
  TicketBuilder._(this._g, {required this.columns, required this.codePage}) {
    // Recorded on the generator, so every reset() re-selects it -- see the
    // till's ReceiptBuilder for why the fallback matters.
    try {
      _g.setGlobalCodeTable(ukAscii ? _codePage : codePage);
    } catch (_) {
      _g.setGlobalCodeTable(_codePage);
    }
  }

  final Generator _g;
  final int columns;
  final String codePage;

  bool get ukAscii => codePage == escPosGbp;

  static Future<TicketBuilder> create({int paperWidthMm = 80, String codePage = escPosGbp}) async {
    final profile = await CapabilityProfile.load();
    final narrow = paperWidthMm == 58;
    return TicketBuilder._(
      Generator(narrow ? PaperSize.mm58 : PaperSize.mm80, profile),
      columns: narrow ? 32 : 48,
      codePage: codePage,
    );
  }

  List<int> _begin() {
    final bytes = _g.reset();
    if (ukAscii) bytes.addAll(const [0x1B, 0x52, 3]);
    return bytes;
  }

  String _safe(String s) => escPosSafe(s, ukAscii: ukAscii);

  List<int> _text(String s, {PosStyles styles = const PosStyles()}) => _g.text(_safe(s), styles: styles);

  List<int> _centre(String s, {bool bold = false, PosTextSize size = PosTextSize.size1}) =>
      _text(s, styles: PosStyles(align: PosAlign.center, bold: bold, height: size, width: size));

  /// Left words, right figure, on one line.
  List<int> _pair(String left, String right, {bool bold = false, bool tall = false}) => _g.row([
    PosColumn(
      text: _safe(left),
      width: 8,
      styles: PosStyles(bold: bold, height: tall ? PosTextSize.size2 : PosTextSize.size1),
    ),
    PosColumn(
      text: _safe(right),
      width: 4,
      styles: PosStyles(
        align: PosAlign.right,
        bold: bold,
        height: tall ? PosTextSize.size2 : PosTextSize.size1,
      ),
    ),
  ]);

  List<int> _head(ReceiptFace face, String fallbackName) {
    final bytes = <int>[];
    final name = (face.venueName ?? fallbackName).trim();
    if (name.isNotEmpty) {
      // Double width fits half a line; a longer name drops to single width
      // rather than wrapping into a block of giant type.
      bytes.addAll(_centre(name, bold: true, size: _safe(name).length <= columns ~/ 2 ? PosTextSize.size2 : PosTextSize.size1));
    }
    for (final line in face.address) {
      bytes.addAll(_centre(line));
    }
    if (face.phone != null) bytes.addAll(_centre(face.phone!));
    if (face.vatNumber != null) bytes.addAll(_centre('VAT No. ${face.vatNumber}'));
    return bytes;
  }

  List<int> _foot(ReceiptFace face, String kioskName, DateTime at) {
    final bytes = <int>[];
    bytes.addAll(_g.hr());
    // Lines of their own rather than a pair: the right-hand column is a third
    // of the roll, sized for a price, and a kiosk's name broke across two lines
    // in it ("Kiosk by the do" / "or") -- which the tests caught, not a printer.
    bytes.addAll(_centre(_when(at)));
    bytes.addAll(_centre(kioskName));
    if (face.footer != null) {
      bytes.addAll(_g.feed(1));
      bytes.addAll(_centre(face.footer!, bold: true));
    }
    if (face.footerNote != null) bytes.addAll(_centre(face.footerNote!));
    if (face.companyNumber != null) bytes.addAll(_centre('Company No. ${face.companyNumber}'));
    bytes.addAll(_g.feed(1));
    bytes.addAll(_centre('Vesopa Express'));
    bytes.addAll(_g.feed(3));
    bytes.addAll(_g.cut());
    return bytes;
  }

  /// The customer's ticket for [order].
  List<int> ticket({
    required OrderView order,
    required ReceiptFace face,
    required String venueName,
    required String kioskName,
    DateTime? at,
  }) {
    final bytes = _begin();
    bytes.addAll(_head(face, venueName));
    bytes.addAll(_g.hr());

    final counter = order.stage == PayStage.counter;
    final demo = order.stage == PayStage.demo;
    if (counter) {
      bytes.addAll(_text('PAY AT THE COUNTER',
          styles: const PosStyles(align: PosAlign.center, bold: true, reverse: true, height: PosTextSize.size2, width: PosTextSize.size2)));
      bytes.addAll(_g.feed(1));
    }
    if (demo) {
      bytes.addAll(_centre('DEMO ORDER - NOT A RECEIPT', bold: true));
      bytes.addAll(_g.feed(1));
    }

    bytes.addAll(_centre('YOUR ORDER NUMBER', bold: true));
    bytes.addAll(_text('${order.number}',
        styles: const PosStyles(align: PosAlign.center, bold: true, height: PosTextSize.size5, width: PosTextSize.size5)));
    bytes.addAll(_centre(order.orderType == 'eat_in' ? 'EAT IN' : 'TAKE AWAY', bold: true, size: PosTextSize.size2));
    if (order.customerName != null) bytes.addAll(_centre('For ${order.customerName}'));
    bytes.addAll(_g.hr());

    // The dishes, with their answers indented under them -- priced where they
    // cost something, listed where they do not, because "Meal Cola" at nothing
    // is still what the customer should find in the bag.
    for (final line in order.lines) {
      if (line.isModifier) {
        bytes.addAll(_pair('   ${line.name}', line.unitMinor > 0 ? money(line.unitMinor * line.qty) : ''));
      } else {
        bytes.addAll(_pair('${line.qty} x ${line.name}', money(line.unitMinor * line.qty), bold: true));
      }
    }

    bytes.addAll(_g.hr());
    bytes.addAll(_pair('TOTAL', money(order.totalMinor), bold: true, tall: true));
    if (order.taxMinor > 0) bytes.addAll(_pair('VAT included', money(order.taxMinor)));
    bytes.addAll(_pair(
      switch (order.stage) {
        PayStage.counter => 'To pay at the counter',
        PayStage.demo => 'No payment taken (demo)',
        _ => 'Paid by card',
      },
      money(order.totalMinor),
    ));
    bytes.addAll(_foot(face, kioskName, at ?? DateTime.now()));
    return bytes;
  }

  /// What Settings prints to prove the printer works -- and that its pound sign
  /// comes out as a pound, which is the thing that goes wrong.
  List<int> testSlip({required ReceiptFace face, required String venueName, required String kioskName, required String printer}) {
    final bytes = _begin();
    bytes.addAll(_head(face, venueName));
    bytes.addAll(_g.hr());
    bytes.addAll(_centre('TEST TICKET', bold: true, size: PosTextSize.size2));
    bytes.addAll(_g.feed(1));
    bytes.addAll(_centre(printer));
    bytes.addAll(_pair('Roll', columns == 32 ? '58 mm' : '80 mm'));
    bytes.addAll(_pair('Pound sign', '£12.50'));
    bytes.addAll(_g.feed(1));
    bytes.addAll(_centre('If you can read this, customers', bold: true));
    bytes.addAll(_centre('will get their number on paper.', bold: true));
    bytes.addAll(_foot(face, kioskName, DateTime.now()));
    return bytes;
  }
}
