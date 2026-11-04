/// Kitchen tickets on paper, from Vesopa Go running as a kitchen screen
/// (2026-11-04): the venue's kitchen printer on the network (ESC/POS on TCP
/// 9100, as the till prints), else the device's own printing (AirPrint on an
/// iPad, the system printing on Android). Optional, per device: each new
/// ticket as it lands, or one ticket when somebody asks.
library;

import 'dart:io';

import 'package:printing/printing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../counter/ui/receipt_print.dart' show PrintLine, escPos, receiptPdf;
import 'data/kitchen_session.dart';
import 'data/screen_profile.dart';
import 'data/ticket.dart';

const _printerKey = 'go_kitchen_printer';
const _autoKey = 'go_kitchen_autoprint';

/// This kitchen's printer, `host` or `host:port`; empty for the device's own
/// printing.
Future<String> kitchenPrinter() async {
  try {
    return (await SharedPreferences.getInstance()).getString(_printerKey) ?? '';
  } catch (_) {
    return '';
  }
}

Future<void> setKitchenPrinter(String v) async {
  try {
    await (await SharedPreferences.getInstance()).setString(_printerKey, v.trim());
  } catch (_) {}
}

/// Whether each new ticket prints as it lands. Off unless a manager turns it on.
Future<bool> kitchenAutoPrint() async {
  try {
    return (await SharedPreferences.getInstance()).getBool(_autoKey) ?? false;
  } catch (_) {
    return false;
  }
}

Future<void> setKitchenAutoPrint(bool on) async {
  try {
    await (await SharedPreferences.getInstance()).setBool(_autoKey, on);
  } catch (_) {}
}

/// The ticket as it prints: where it goes in large type, then this board's
/// items, their notes and what is in them.
List<PrintLine> kitchenTicketLines(Ticket t, KitchenSession s, ScreenProfile p, {Map<String, String> allergens = const {}}) {
  final lines = t.linesFor(p.stations);
  return [
    PrintLine(t.destination.toUpperCase(), '', true, true),
    if (t.rushed) const PrintLine('*** RUSH ***', '', true, true),
    PrintLine([if (t.ticketNo != null) '#${t.ticketNo}', if (t.staffName != null) t.staffName!].join('  '),
        '${t.placedAt.hour.toString().padLeft(2, '0')}:${t.placedAt.minute.toString().padLeft(2, '0')}'),
    if ((t.covers ?? 0) > 0) PrintLine('${t.covers} covers'),
    PrintLine(p.isBuiltIn ? s.officeName ?? '' : p.name),
    PrintLine('-' * 42),
    if ((t.note ?? '').isNotEmpty) PrintLine('NOTE: ${t.note}', '', false, true),
    for (final l in lines) ...[
      l.isModifier ? PrintLine('     ${l.name}') : PrintLine('${l.quantityLabel} x ${l.name}', '', false, true),
      if ((l.note ?? '').isNotEmpty) PrintLine('     > ${l.note}'),
      if (l.allergens.isNotEmpty) PrintLine('     ! ${l.allergens.map((a) => allergens[a] ?? a).join(', ')}'),
    ],
    PrintLine('-' * 42),
  ];
}

/// Print [t]. Throws with words for the screen when nothing would print it.
Future<void> printKitchenTicket(Ticket t, KitchenSession s, ScreenProfile p, {Map<String, String> allergens = const {}}) async {
  final lines = kitchenTicketLines(t, s, p, allergens: allergens);
  final target = await kitchenPrinter();
  if (target.isNotEmpty) {
    final parts = target.split(':');
    final port = parts.length > 1 ? int.tryParse(parts[1]) ?? 9100 : 9100;
    try {
      final socket = await Socket.connect(parts.first, port, timeout: const Duration(seconds: 4));
      try {
        socket.add(escPos(lines));
        await socket.flush();
      } finally {
        await socket.close();
      }
      return;
    } on SocketException {
      throw 'The kitchen printer at $target did not answer. Check it is on and on the same Wi-Fi.';
    }
  }
  await Printing.layoutPdf(name: 'Ticket ${t.destination}', onLayout: (format) => receiptPdf(lines, format));
}

/// Reach the printer at [target] without printing: true when it answers.
Future<bool> kitchenPrinterAnswers(String target) async {
  if (target.isEmpty) return false;
  final parts = target.split(':');
  final port = parts.length > 1 ? int.tryParse(parts[1]) ?? 9100 : 9100;
  try {
    final socket = await Socket.connect(parts.first, port, timeout: const Duration(seconds: 3));
    socket.destroy();
    return true;
  } catch (_) {
    return false;
  }
}
