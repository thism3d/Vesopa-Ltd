/// The kiosk's own printer: which one, and how its bytes get there.
///
/// Chosen on the kiosk, in its staff Settings, and kept on the kiosk -- like a
/// till's printers, and for the same reason: a printer is physical to the
/// machine it is plugged into, and a venue with two kiosks has two printers.
/// The back office decides only WHETHER a ticket is printed (always, when
/// asked, or never); a kiosk with no printer chosen prints nothing, whatever
/// that says.
///
/// Three ways to reach one, the till's three that make sense on a kiosk:
///
///   * a printer Windows already knows, sent a RAW job -- nothing re-renders
///     the ESC/POS, but the spooler queues it
///   * a USB printer, written to directly with no spooler in the way -- the
///     most reliable on a busy kiosk
///   * a network printer on port 9100
///
/// Serial is left out: a kiosk's printer is built into the cabinet on USB, and
/// the serial library is a native plugin nothing else here needs.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'windows_printing.dart';

export 'windows_printing.dart' show WindowsPrintQueue, UsbPrinterDevice;

enum TicketPrinterKind {
  windowsQueue('Windows printer'),
  usb('USB printer (direct)'),
  network('Network printer');

  const TicketPrinterKind(this.label);
  final String label;

  static TicketPrinterKind parse(String? name) =>
      values.where((k) => k.name == name).firstOrNull ?? windowsQueue;
}

/// What the pound sign rests on, as on the till: the UK international
/// character set, in which the printer draws 0x23 as "£" whatever its code
/// page. A clone printer that ignores `ESC t` otherwise prints "ú12.00".
const escPosGbp = 'UK_ASCII';

@immutable
class TicketPrinter {
  const TicketPrinter({
    required this.kind,
    this.queue,
    this.usbPath,
    this.usbLabel,
    this.host,
    this.port = 9100,
    this.paperWidthMm = 80,
    this.codePage = escPosGbp,
  });

  final TicketPrinterKind kind;

  /// The Windows queue name, for [TicketPrinterKind.windowsQueue].
  final String? queue;

  /// The `\\?\usb#...` interface path, and what the device called itself.
  final String? usbPath;
  final String? usbLabel;

  final String? host;
  final int port;

  /// 80 or 58: the roll decides how many characters fit on a line, and an 80mm
  /// layout on a 58mm roll prints the prices off the edge.
  final int paperWidthMm;
  final String codePage;

  int get columns => paperWidthMm == 58 ? 32 : 48;

  bool get isComplete => switch (kind) {
    TicketPrinterKind.windowsQueue => (queue ?? '').isNotEmpty,
    TicketPrinterKind.usb => (usbPath ?? '').isNotEmpty,
    TicketPrinterKind.network => (host ?? '').trim().isNotEmpty,
  };

  /// For a person reading Settings.
  String get summary => switch (kind) {
    TicketPrinterKind.windowsQueue => queue ?? '?',
    TicketPrinterKind.usb => usbLabel ?? usbPath ?? '?',
    TicketPrinterKind.network => '${host ?? '?'}:$port',
  };

  TicketPrinter copyWith({int? paperWidthMm}) => TicketPrinter(
    kind: kind,
    queue: queue,
    usbPath: usbPath,
    usbLabel: usbLabel,
    host: host,
    port: port,
    paperWidthMm: paperWidthMm ?? this.paperWidthMm,
    codePage: codePage,
  );

  Map<String, Object?> toJson() => {
    'kind': kind.name,
    'queue': queue,
    'usb_path': usbPath,
    'usb_label': usbLabel,
    'host': host,
    'port': port,
    'paper_width_mm': paperWidthMm,
    'code_page': codePage,
  };

  factory TicketPrinter.fromJson(Map<String, dynamic> j) => TicketPrinter(
    kind: TicketPrinterKind.parse(j['kind'] as String?),
    queue: j['queue'] as String?,
    usbPath: j['usb_path'] as String?,
    usbLabel: j['usb_label'] as String?,
    host: j['host'] as String?,
    port: (j['port'] as num?)?.toInt() ?? 9100,
    paperWidthMm: (j['paper_width_mm'] as num?)?.toInt() == 58 ? 58 : 80,
    codePage: ((j['code_page'] as String?) ?? '').isEmpty ? escPosGbp : j['code_page'] as String,
  );

  /// Put [bytes] on the printer, or throw saying why not.
  ///
  /// The two Win32 paths block until the printer has taken the bytes -- and a
  /// printer out of paper can hold a write open for seconds -- so they run on a
  /// worker isolate. On the UI isolate that would freeze the number on screen,
  /// which is the one thing the customer is looking at.
  Future<void> send(List<int> bytes) async {
    final payload = List<int>.unmodifiable(bytes);
    switch (kind) {
      case TicketPrinterKind.windowsQueue:
        final name = queue!;
        await Isolate.run(() => sendToWindowsQueue(name, payload, documentName: 'Vesopa Express ticket'));
      case TicketPrinterKind.usb:
        final path = usbPath!;
        await Isolate.run(() => sendToUsbDevice(path, payload));
      case TicketPrinterKind.network:
        final socket = await Socket.connect(host!.trim(), port, timeout: const Duration(seconds: 5));
        try {
          socket.add(payload);
          await socket.flush();
        } finally {
          socket.destroy();
        }
    }
  }
}

/// Where the chosen printer is kept: on this kiosk, beside its token.
class TicketPrinterStore {
  const TicketPrinterStore();

  static const _key = 'express_ticket_printer';

  Future<TicketPrinter?> load() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key);
      if (raw == null || raw.isEmpty) return null;
      final printer = TicketPrinter.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      return printer.isComplete ? printer : null;
    } catch (_) {
      // A setting that cannot be read is a kiosk with no printer, not a kiosk
      // that will not start.
      return null;
    }
  }

  Future<void> save(TicketPrinter printer) async =>
      (await SharedPreferences.getInstance()).setString(_key, jsonEncode(printer.toJson()));

  Future<void> clear() async => (await SharedPreferences.getInstance()).remove(_key);
}

/// Printers Windows knows about, for Settings. A blocking Win32 walk, so off
/// the UI isolate; empty anywhere but Windows.
Future<List<WindowsPrintQueue>> findWindowsPrinters() async {
  if (!Platform.isWindows) return const [];
  final found = await Isolate.run(
    () => windowsPrintQueues().map((q) => (name: q.name, server: q.server)).toList(),
  );
  return [for (final q in found) WindowsPrintQueue(name: q.name, server: q.server)];
}

/// USB printers plugged in and switched on right now.
Future<List<UsbPrinterDevice>> findUsbPrinters() async {
  if (!Platform.isWindows) return const [];
  final found = await Isolate.run(
    () => usbPrinterDevices().map((d) => (path: d.devicePath, label: d.label)).toList(),
  );
  return [for (final d in found) UsbPrinterDevice(devicePath: d.path, label: d.label)];
}
