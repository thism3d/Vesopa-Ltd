import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

// Re-exports print_targets.dart, which is where PrintTarget lives.
import '../printing/printer_transport.dart';

/// The printers wired to *this* terminal, and what each of them prints.
///
/// Stored locally rather than in the back office on purpose: printers are
/// physical to a counter. Two tills in the same venue have different printers
/// plugged into them, so a venue-wide setting would send one till's receipts to
/// the other's printer. What the back office *does* own is the naming — see
/// `PrinterNames` — so that "KP 3" means the same station in every room.
class PrinterSettings {
  const PrinterSettings({
    this.printers = const [],
    this.assignments = const {},
    this.merchantCopyWhen = MerchantCopyWhen.never,
  });

  /// The devices themselves.
  final List<PrinterConfig> printers;

  /// Target key -> printer id. A target with no entry falls back down
  /// [PrintTarget.fallback]; a target whose entry names a printer that has
  /// since been deleted is treated the same way, which is what stops a removed
  /// printer taking the receipt with it.
  final Map<String, String> assignments;

  /// Whether the venue's own copy of a receipt is printed, and when.
  final MerchantCopyWhen merchantCopyWhen;

  PrinterConfig? byId(String? id) {
    if (id == null || id.isEmpty) return null;
    for (final printer in printers) {
      if (printer.id == id) return printer;
    }
    return null;
  }

  /// The printer explicitly chosen for [target], ignoring any fallback.
  ///
  /// This is what the setup screen shows, so that "unset, using the receipt
  /// printer" reads differently from "deliberately set to the receipt printer".
  PrinterConfig? assigned(PrintTarget target) => byId(assignments[target.key]);

  /// The printer [target] will actually print on, following the fallback chain.
  PrinterConfig? deviceFor(PrintTarget target) {
    final direct = assigned(target);
    if (direct != null) return direct;
    final fallback = target.fallback;
    return fallback == null ? null : deviceFor(fallback);
  }

  /// Whether [target] prints only because something else is standing in for it.
  bool isInherited(PrintTarget target) =>
      assigned(target) == null && deviceFor(target) != null;

  PrinterConfig? get receiptPrinter =>
      deviceFor(PrintTarget.customerReceipt);

  /// The kitchen printers this terminal has, keyed by the station a product is
  /// routed to. A station with no printer set up simply is not here, which is
  /// what lets the print service report it rather than fail silently.
  ///
  /// The receipt printer is included under its own station key, so a product
  /// routed to "Receipt" prints a ticket at the counter.
  Map<String, PrinterConfig> get stations => {
    for (final target in PrintTarget.routable)
      target.station!: ?deviceFor(target),
  };

  /// The roll the receipt should be laid out for. Falls back to 80mm, the
  /// common size, when no receipt printer has been configured yet.
  int get receiptWidthMm => receiptPrinter?.paperWidthMm ?? 80;

  /// Where a kitchen ticket for [route] goes, or null if nothing is set up at
  /// that station.
  PrinterConfig? printerForRoute(String? route) {
    final target = PrintTarget.fromStation(route);
    return target == null ? null : deviceFor(target);
  }

  /// Whether anything at all is set up. Used to keep a till with no printers
  /// silent rather than complaining on every sale.
  bool get isEmpty => printers.isEmpty;

  PrinterSettings copyWith({
    List<PrinterConfig>? printers,
    Map<String, String>? assignments,
    MerchantCopyWhen? merchantCopyWhen,
  }) => PrinterSettings(
    printers: printers ?? this.printers,
    assignments: assignments ?? this.assignments,
    merchantCopyWhen: merchantCopyWhen ?? this.merchantCopyWhen,
  );

  PrinterSettings upsert(PrinterConfig printer) {
    final next = [...printers];
    final index = next.indexWhere((p) => p.id == printer.id);
    if (index == -1) {
      next.add(printer);
    } else {
      next[index] = printer;
    }
    return copyWith(printers: next);
  }

  /// Remove a printer, and every assignment that pointed at it.
  ///
  /// Dropping the assignments matters: a stale id left behind would make the
  /// setup screen show a target as assigned to a printer that is not in the
  /// list, and there would be no way to tell from the screen why nothing
  /// printed.
  PrinterSettings remove(String id) => copyWith(
    printers: printers.where((p) => p.id != id).toList(),
    assignments: {
      for (final entry in assignments.entries)
        if (entry.value != id) entry.key: entry.value,
    },
  );

  /// Point [target] at [printerId], or clear it when null.
  PrinterSettings assign(PrintTarget target, String? printerId) => copyWith(
    assignments: {
      for (final entry in assignments.entries)
        if (entry.key != target.key) entry.key: entry.value,
      if (printerId != null && printerId.isNotEmpty) target.key: printerId,
    },
  );

  Map<String, dynamic> toJson() => {
    'printers': printers.map((p) => p.toJson()).toList(),
    'assignments': assignments,
    'merchant_copy_when': merchantCopyWhen.key,
  };

  factory PrinterSettings.fromJson(Map<String, dynamic> j) => PrinterSettings(
    printers: ((j['printers'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(PrinterConfig.fromJson)
        .toList(),
    assignments: {
      for (final entry in ((j['assignments'] as Map?) ?? const {}).entries)
        '${entry.key}': '${entry.value}',
    },
    merchantCopyWhen: MerchantCopyWhen.fromKey(
      j['merchant_copy_when'] as String?,
    ),
  );

  /// Read the format this shipped with before printers and jobs were separated.
  ///
  /// That format was a bare JSON list of printers, each carrying the single
  /// `role` it filled. Each becomes a device, and its role becomes that
  /// device's one assignment — so a till that upgrades keeps printing exactly
  /// where it printed yesterday, without anybody opening the setup screen.
  factory PrinterSettings.fromLegacyList(List<dynamic> raw) {
    final printers = <PrinterConfig>[];
    final assignments = <String, String>{};

    for (final entry in raw) {
      if (entry is! Map) continue;
      final json = entry.cast<String, dynamic>();
      final printer = PrinterConfig.fromJson(json);
      if (printer.id.isEmpty) continue;
      printers.add(printer);

      // The old `role` held a station key: "receipt", "kp1"…, or one of the
      // two pre-numbering names.
      final target = PrintTarget.fromStation(json['role'] as String?);
      if (target != null) assignments[target.key] = printer.id;
    }

    return PrinterSettings(printers: printers, assignments: assignments);
  }
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

      final decoded = jsonDecode(raw);
      // A list is the pre-targets format. Migrated on read rather than by a
      // one-off upgrade step, so a terminal that skips a release still lands
      // on the right setup.
      if (decoded is List) return PrinterSettings.fromLegacyList(decoded);
      return PrinterSettings.fromJson(decoded as Map<String, dynamic>);
    } catch (_) {
      // Corrupt settings must not stop the till starting; a venue can
      // reconfigure a printer far more easily than recover a crash loop.
      return const PrinterSettings();
    }
  }

  Future<void> save(PrinterSettings settings) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, jsonEncode(settings.toJson()));
  }
}
