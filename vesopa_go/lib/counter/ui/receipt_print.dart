/// Printing a receipt: to this device's receipt printer on the network
/// (ESC/POS over raw TCP, port 9100, as the till's network printers), or by
/// AirPrint / Android printing when none is set or it cannot be reached and the
/// venue allows it (back office, Vesopa Go options > Printing).
///
/// The text is the same receipt ReceiptView draws, laid out for 42 columns
/// (80 mm paper).
library;

import 'dart:convert';
import 'dart:io' show Socket;
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/models.dart' show Bill, money;
import 'package:vesopa_go/data/session.dart';

import '../data/day_report.dart';
import '../data/journal.dart';
import 'receipt_view.dart' show ddmmyy, hhmm, payKind;

const _receiptPrinterKey = 'go_receipt_printer';
const _cols = 42;

/// This device's receipt printer, `host` or `host:port`; empty for none.
Future<String> receiptPrinter() async {
  try {
    return (await SharedPreferences.getInstance()).getString(_receiptPrinterKey) ?? '';
  } catch (_) {
    return '';
  }
}

Future<void> setReceiptPrinter(String v) async {
  try {
    await (await SharedPreferences.getInstance()).setString(_receiptPrinterKey, v.trim());
  } catch (_) {}
}

/// One printed line: centred, or a left and right pair, optionally bold.
@immutable
class PrintLine {
  const PrintLine(this.left, [this.right = '', this.centre = false, this.bold = false]);
  final String left;
  final String right;
  final bool centre;
  final bool bold;

  String text([int cols = _cols]) {
    if (centre) {
      final pad = ((cols - left.length) / 2).floor().clamp(0, cols);
      return '${' ' * pad}$left';
    }
    if (right.isEmpty) return left;
    final room = cols - right.length - 1;
    final l = left.length > room ? left.substring(0, room) : left;
    return '$l${' ' * (cols - l.length - right.length)}$right';
  }
}

/// The receipt as lines, in the till's order.
List<PrintLine> receiptLines(SaleRecord sale, TapState s) {
  final b = s.config.branding;
  String str(String k) => '${b[k] ?? ''}'.trim();
  bool on(String k, {bool byDefault = false}) => b[k] == null ? byDefault : (b[k] == 1 || b[k] == true || b[k] == '1');
  final venue = str('venue_name').isNotEmpty ? str('venue_name') : (s.venue?.name ?? '');
  const rule = PrintLine('------------------------------------------');
  final out = <PrintLine>[
    PrintLine(venue, '', true, true),
    for (final a in [str('address_line1'), str('address_line2'), [str('city'), str('postcode')].where((x) => x.isNotEmpty).join(' ')])
      if (a.isNotEmpty) PrintLine(a, '', true),
    if (str('phone').isNotEmpty) PrintLine('Tel ${str('phone')}', '', true),
    if (str('vat_number').isNotEmpty) PrintLine('VAT No. ${str('vat_number')}', '', true),
    if (str('header_note').isNotEmpty) PrintLine(str('header_note'), '', true),
    rule,
    PrintLine('Receipt ${sale.number}', '${ddmmyy(sale.at)} ${hhmm(sale.at)}'),
    if (sale.place.isNotEmpty) PrintLine(sale.place),
    if (on('show_served_by', byDefault: true) && sale.clerk.isNotEmpty) PrintLine('Served by ${sale.clerk}'),
    rule,
    for (final l in sale.lines) ...[
      PrintLine('${l.quantity} ${l.name}', money(l.totalMinor)),
      if (l.detail.isNotEmpty) for (final d in l.detail.split(' · ')) PrintLine('   - $d'),
    ],
    rule,
    if (sale.discountMinor > 0) ...[PrintLine('Subtotal', money(sale.subtotalMinor)), PrintLine('Discount', '-${money(sale.discountMinor)}')],
    PrintLine('TOTAL', money(sale.totalMinor), false, true),
    for (final p in sale.payments) PrintLine(payKind(p.kind), money(p.amountMinor + p.tipMinor)),
    if (sale.tipsMinor > 0) PrintLine('  of which tip', money(sale.tipsMinor)),
    if (sale.changeMinor > 0) PrintLine('Change', money(sale.changeMinor), false, true),
    rule,
    PrintLine(str('footer_message').isNotEmpty ? str('footer_message') : 'Thank you for your custom', '', true, true),
    if (str('footer_note').isNotEmpty) PrintLine(str('footer_note'), '', true),
    if (on('show_powered_by', byDefault: true)) const PrintLine('Powered by Vesopa EPOS', '', true),
  ];
  return out;
}

/// ESC/POS bytes: code page 437, where the pound sign is 0x9C, as the till's
/// printers are sent; bold by ESC E; a feed and a cut at the end.
Uint8List escPos(List<PrintLine> lines) {
  final out = BytesBuilder();
  out.add([0x1B, 0x40, 0x1B, 0x74, 0x00]); // initialise, code page 437
  for (final l in lines) {
    if (l.bold) out.add([0x1B, 0x45, 0x01]);
    for (final c in l.text().runes) {
      out.addByte(c == 0xA3 ? 0x9C : (c < 0x80 ? c : 0x3F));
    }
    out.addByte(0x0A);
    if (l.bold) out.add([0x1B, 0x45, 0x00]);
  }
  out.add([0x1B, 0x64, 0x04, 0x1D, 0x56, 0x42, 0x00]); // feed four lines, cut
  return out.toBytes();
}

Future<void> _network(String target, List<PrintLine> lines) async {
  final parts = target.split(':');
  final port = parts.length > 1 ? int.tryParse(parts[1]) ?? 9100 : 9100;
  final socket = await Socket.connect(parts.first, port, timeout: const Duration(seconds: 4));
  try {
    socket.add(escPos(lines));
    await socket.flush();
  } finally {
    await socket.close();
  }
}

Future<void> _system(List<PrintLine> lines, String name) async =>
    Printing.layoutPdf(name: name, onLayout: (format) async => receiptPdf(lines, format));

/// The receipt as a PDF for the system's printing (AirPrint, Android): on a
/// receipt roll, the roll's width and as long as it needs; on ordinary paper
/// (A4, Letter), the receipt at a readable size in a column at the top of
/// the page, never shrunk to a strip.
Future<Uint8List> receiptPdf(List<PrintLine> lines, PdfPageFormat format) async {
  final doc = pw.Document(title: 'Receipt');
  final font = pw.Font.courier();
  final bold = pw.Font.courierBold();
  final roll = format.width <= 90 * PdfPageFormat.mm;
  final width = roll ? format.width : 90 * PdfPageFormat.mm;
  // 42 characters to a line, as the till's printers: sized to fill the width.
  final size = ((width - 8 * PdfPageFormat.mm) / (42 * 0.6)).clamp(6.0, 10.0);
  pw.Widget body() => pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
        for (final l in lines) pw.Text(l.text(), style: pw.TextStyle(font: l.bold ? bold : font, fontSize: size)),
      ]);
  if (roll) {
    doc.addPage(pw.Page(
      pageFormat: PdfPageFormat(format.width, double.infinity, marginAll: 4 * PdfPageFormat.mm),
      build: (_) => body(),
    ));
  } else {
    // Line by line, so a long X or Z report runs on to a second page.
    const margin = 15 * PdfPageFormat.mm;
    final inset = ((format.width - margin * 2 - width) / 2).clamp(0.0, double.infinity);
    doc.addPage(pw.MultiPage(
      pageFormat: format.copyWith(marginTop: margin, marginBottom: margin, marginLeft: margin, marginRight: margin),
      build: (_) => [
        for (final l in lines)
          pw.Padding(
            padding: pw.EdgeInsets.only(left: inset),
            child: pw.Text(l.text(), style: pw.TextStyle(font: l.bold ? bold : font, fontSize: size)),
          ),
      ],
    ));
  }
  return doc.save();
}

/// An X or Z report as the till prints it: the takings, payments, staff and
/// categories, for the receipt printer.
List<PrintLine> reportLines(DayReport r, TapState s, {required String title, DateTime? since, String? by}) {
  const rule = PrintLine('------------------------------------------');
  final now = DateTime.now();
  return [
    PrintLine(s.venue?.name ?? '', '', true, true),
    PrintLine(title, '', true, true),
    rule,
    if (since != null) PrintLine('From', '${ddmmyy(since)} ${hhmm(since)}'),
    PrintLine('To', '${ddmmyy(now)} ${hhmm(now)}'),
    PrintLine('Device', s.venue == null ? 'Vesopa Go' : 'Vesopa Go'),
    if (by != null) PrintLine('By', by),
    rule,
    PrintLine('Sales', '${r.sales}'),
    PrintLine('Gross', money(r.grossMinor)),
    PrintLine('Discounts', '-${money(r.discountMinor)}'),
    PrintLine('NET', money(r.netMinor), false, true),
    PrintLine('Average', money(r.averageMinor)),
    rule,
    PrintLine('Cash', money(r.cashMinor)),
    PrintLine('Card', money(r.cardMinor)),
    if (r.tipsMinor > 0) PrintLine('Tips', money(r.tipsMinor)),
    if (r.refundsMinor > 0) PrintLine('Refunds (${r.refundCount})', '-${money(r.refundsMinor)}'),
    PrintLine('Cash in the drawer', money(r.cashInDrawerMinor), false, true),
    rule,
    const PrintLine('STAFF', '', false, true),
    for (final c in r.byClerk) PrintLine('${c.label} (${c.count})', money(c.minor)),
    rule,
    const PrintLine('CATEGORIES', '', false, true),
    for (final c in r.byCategory) PrintLine('${c.label} (${c.count})', money(c.minor)),
    rule,
  ];
}

Future<void> printReport(BuildContext context, WidgetRef ref, DayReport r, {required String title, DateTime? since, String? by}) =>
    _print(context, ref, reportLines(r, ref.read(tapProvider), title: title, since: since, by: by), title);

/// Prints [sale]'s receipt, saying how it went.
Future<void> printReceipt(BuildContext context, WidgetRef ref, SaleRecord sale) =>
    _print(context, ref, receiptLines(sale, ref.read(tapProvider)), 'Receipt ${sale.number}');

/// The bill before it is paid, as the till's Print bill key prints it: the
/// lines, the subtotal, deals and discounts, service and the total.
List<PrintLine> billLines(Bill bill, TapState s) {
  const rule = PrintLine('------------------------------------------');
  final now = DateTime.now();
  return [
    PrintLine(s.venue?.name ?? '', '', true, true),
    const PrintLine('BILL', '', true, true),
    PrintLine(bill.name, '', true),
    PrintLine('${ddmmyy(now)} ${hhmm(now)}', bill.clerk),
    rule,
    for (final l in bill.lines) ...[
      PrintLine('${l.quantity} x ${l.product.name}', money(l.totalMinor)),
      for (final c in l.choices) PrintLine('    ${c.name}'),
    ],
    rule,
    PrintLine('Subtotal', money(bill.subtotalMinor)),
    for (final d in bill.dealsApplied.deals) PrintLine(d.name, '-${money(d.savingMinor)}'),
    if (bill.discountMinor - bill.dealMinor > 0) PrintLine('Discount', '-${money(bill.discountMinor - bill.dealMinor)}'),
    if (bill.serviceMinor > 0) PrintLine('Service', money(bill.serviceMinor)),
    if (bill.paidMinor > 0) PrintLine('Paid', '-${money(bill.paidMinor)}'),
    PrintLine('TOTAL', money(bill.dueMinor), false, true),
    rule,
    const PrintLine('This is not a receipt', '', true),
  ];
}

Future<void> printBill(BuildContext context, WidgetRef ref, Bill bill) =>
    _print(context, ref, billLines(bill, ref.read(tapProvider)), 'Bill ${bill.name}');

Future<void> _print(BuildContext context, WidgetRef ref, List<PrintLine> lines, String name) async {
  final s = ref.read(tapProvider);
  final messenger = ScaffoldMessenger.of(context);
  final target = kIsWeb ? '' : await receiptPrinter();
  if (target.isNotEmpty) {
    try {
      await _network(target, lines);
      messenger.showSnackBar(SnackBar(content: Text('$name printed')));
      return;
    } catch (_) {
      if (!s.config.go.printAirprintFallback) {
        messenger.showSnackBar(SnackBar(content: Text('The receipt printer at $target did not answer.')));
        return;
      }
    }
  }
  if (!s.config.go.printAirprintFallback && target.isEmpty) {
    messenger.showSnackBar(const SnackBar(content: Text('No receipt printer is set on this device (Settings).')));
    return;
  }
  try {
    await _system(lines, name);
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('Could not print: $e')));
  }
}

/// The receipt text as it prints, for a test or a share.
String receiptText(SaleRecord sale, TapState s) => const LineSplitter().convert(receiptLines(sale, s).map((l) => l.text()).join('\n')).join('\n');
