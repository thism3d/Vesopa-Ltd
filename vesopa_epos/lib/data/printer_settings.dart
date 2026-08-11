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

  /// The kitchen printers this terminal has, keyed by the station a product is
  /// routed to. A station with no printer plugged in simply is not here, which
  /// is what lets the print service report it rather than fail silently.
  Map<String, PrinterConfig> get stations => {
        for (final printer in printers)
          if (printer.role != PrinterRole.receipt)
            printer.role.station: printer,
      };

  /// The roll the receipt should be laid out for. Falls back to 80mm, the
  /// common size, when no receipt printer has been configured yet.
  int get receiptWidthMm => receiptPrinter?.paperWidthMm ?? 80;

  /// Where a kitchen ticket for [route] goes, or null if nothing is plugged in
  /// at that station. Understands the old "kitchen"/"bar" keys — see
  /// [PrinterRole.fromStation].
  PrinterConfig? printerForRoute(String? route) {
    final role = PrinterRole.fromStation(route);
    return role == null ? null : forRole(role);
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
