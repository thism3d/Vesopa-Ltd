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
import 'package:vesopa_go/data/models.dart' show money;
import 'package:vesopa_go/data/session.dart';

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

Future<void> _system(List<PrintLine> lines, String name) async {
  final doc = pw.Document();
  final font = pw.Font.courier();
  final bold = pw.Font.courierBold();
  doc.addPage(pw.Page(
    pageFormat: const PdfPageFormat(80 * PdfPageFormat.mm, double.infinity, marginAll: 4 * PdfPageFormat.mm),
    build: (_) => pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
      for (final l in lines) pw.Text(l.text(), style: pw.TextStyle(font: l.bold ? bold : font, fontSize: 7.4)),
    ]),
  ));
  await Printing.layoutPdf(name: name, onLayout: (_) async => doc.save());
}

/// Prints [sale]'s receipt, saying how it went.
Future<void> printReceipt(BuildContext context, WidgetRef ref, SaleRecord sale) async {
  final s = ref.read(tapProvider);
  final lines = receiptLines(sale, s);
  final messenger = ScaffoldMessenger.of(context);
  final target = kIsWeb ? '' : await receiptPrinter();
  if (target.isNotEmpty) {
    try {
      await _network(target, lines);
      messenger.showSnackBar(const SnackBar(content: Text('Receipt printed')));
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
    await _system(lines, 'Receipt ${sale.number}');
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text('Could not print: $e')));
  }
}

/// The receipt text as it prints, for a test or a share.
String receiptText(SaleRecord sale, TapState s) => const LineSplitter().convert(receiptLines(sale, s).map((l) => l.text()).join('\n')).join('\n');
