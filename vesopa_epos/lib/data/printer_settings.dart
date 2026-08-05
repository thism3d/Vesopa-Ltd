import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../printing/printer_transport.dart';

/// The printers wired to *this* terminal.
///
/// Stored locally rather than in the back office on purpose: printers are
/// physical to a counter. Two tills in the same venue have different printers
/// plugged into them, so a venue-wide setting would send one till's receipts
/// to the other's printer.
class PrinterSettings {
  const PrinterSettings({this.printers = const []});

  final List<PrinterConfig> printers;

  PrinterConfig? forRole(PrinterRole role) {
    for (final printer in printers) {
      if (printer.role == role) return printer;
    }
    return null;
  }

  PrinterConfig? get receiptPrinter => forRole(PrinterRole.receipt);
  PrinterConfig? get kitchenPrinter => forRole(PrinterRole.kitchen);
  PrinterConfig? get barPrinter => forRole(PrinterRole.bar);

  /// The roll the receipt should be laid out for. Falls back to 80mm, the
  /// common size, when no receipt printer has been configured yet.
  int get receiptWidthMm => receiptPrinter?.paperWidthMm ?? 80;

  /// Where a kitchen ticket for [route] goes. Falls back to the kitchen
  /// printer so a product routed to "bar" still prints somewhere rather than
  /// being silently dropped.
  PrinterConfig? printerForRoute(String? route) {
    if (route == null || route.isEmpty) return null;
    if (route.toLowerCase() == 'bar') {
      return barPrinter ?? kitchenPrinter;
    }
    return kitchenPrinter;
  }

  PrinterSettings upsert(PrinterConfig printer) {
    final next = [...printers];
    final index = next.indexWhere((p) => p.id == printer.id);
    if (index == -1) {
      next.add(printer);
    } else {
      next[index] = printer;
    }
    return PrinterSettings(printers: next);
  }

  PrinterSettings remove(String id) => PrinterSettings(
        printers: printers.where((p) => p.id != id).toList(),
      );
}

/// Reads and writes [PrinterSettings] to this device.
class PrinterSettingsStore {
  const PrinterSettingsStore();

  static const _key = 'vesopa_printers';

  Future<PrinterSettings> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null || raw.isEmpty) return const PrinterSettings();

      final list = (jsonDecode(raw) as List)
          .cast<Map<String, dynamic>>()
          .map(PrinterConfig.fromJson)
          .toList();
      return PrinterSettings(printers: list);
    } catch (_) {
      // Corrupt settings must not stop the till starting; a venue can
      // reconfigure a printer far more easily than recover a crash loop.
      return const PrinterSettings();
    }
  }

  Future<void> save(PrinterSettings settings) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _key,
      jsonEncode(settings.printers.map((p) => p.toJson()).toList()),
    );
  }
}
