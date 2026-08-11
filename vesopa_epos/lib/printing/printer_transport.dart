import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_libserialport/flutter_libserialport.dart';

/// How a printer is reached. Both are supported because a venue may have a
/// modern networked kitchen printer and a legacy till printer wired to a COM
/// port at the same counter.
enum PrinterKind { network, serial }

/// What a printer is for. A venue routinely has one printer at the counter and
/// another in the kitchen, and they need different documents: the receipt
/// carries prices and branding, the ticket carries items and modifiers.
///
/// The kitchen printers are numbered rather than named ("KP 1", not "Kitchen"
/// and "Bar") because the number is what the back office assigns products to.
/// A venue with a grill, a fryer, a cold section and a bar has four stations
/// and no vocabulary the till could have guessed; a number lets them label the
/// physical printer however they like and route to it by position.
enum PrinterRole {
  receipt('Receipt printer', 'receipt'),
  kp1('KP 1', 'kp1'),
  kp2('KP 2', 'kp2'),
  kp3('KP 3', 'kp3'),
  kp4('KP 4', 'kp4'),
  kp5('KP 5', 'kp5'),
  kp6('KP 6', 'kp6');

  const PrinterRole(this.label, this.station);

  final String label;

  /// The key the back office routes products to, and the key this role is
  /// stored under. Kept separate from [name] so the enum can be renamed
  /// without invalidating every terminal's saved printer setup.
  final String station;

  /// Every kitchen printer, in order. The receipt printer is deliberately not
  /// in this list: it is the one printer whose document is different.
  static List<PrinterRole> get kitchenPrinters =>
      values.where((r) => r != PrinterRole.receipt).toList();

  /// The role a stored `station` key belongs to, or null.
  ///
  /// Accepts the two names this used to have. A venue that set up "kitchen"
  /// and "bar" before the numbered stations existed keeps printing: kitchen
  /// becomes KP 1 and bar becomes KP 2, which is the order they were listed in
  /// and so the order their printers were almost certainly plugged in.
  static PrinterRole? fromStation(String? key) {
    if (key == null || key.isEmpty) return null;
    final k = key.trim().toLowerCase();
    for (final role in values) {
      if (role.station == k || role.name == k) return role;
    }
    return switch (k) {
      'kitchen' => PrinterRole.kp1,
      'bar' => PrinterRole.kp2,
      _ => null,
    };
  }
}

/// Reading and writing the comma-separated station list a product carries.
///
/// One place for it because three layers touch the same string — the sync that
/// stores it, the product editor that sets it, and the print run that reads it
/// — and a routing list that round-trips differently in any of them sends food
/// to the wrong printer.
abstract final class KitchenRouting {
  /// The stations named by a stored routing string, unknown names dropped.
  ///
  /// Unknown rather than invalid: a back office offering KP 7 to a till that
  /// only knows six should route to the six it has, not refuse the product.
  static Set<String> parse(String? raw) {
    if (raw == null || raw.isEmpty) return const {};
    return {
      for (final part in raw.split(','))
        if (PrinterRole.fromStation(part) case final role?) role.station,
    };
  }

  /// The storable form, in station order. Null for "not sent to a kitchen",
  /// which is what the column means by empty.
  static String? format(Iterable<String> stations) {
    final roles = <PrinterRole>{
      for (final s in stations)
        if (PrinterRole.fromStation(s) case final role?) role,
    }.toList()..sort((a, b) => a.index.compareTo(b.index));
    return roles.isEmpty ? null : roles.map((r) => r.station).join(',');
  }
}

class PrinterConfig {
  const PrinterConfig({
    required this.id,
    required this.name,
    required this.kind,
    this.role = PrinterRole.receipt,
    this.host,
    this.port = 9100,
    this.serialPort,
    this.baudRate = 9600,
    this.paperWidthMm = 80,
  });

  final String id;
  final String name;
  final PrinterKind kind;
  final PrinterRole role;

  /// Network printers.
  final String? host;
  final int port;

  /// Serial printers: the device path (COM3 on Windows, /dev/tty.* on macOS).
  final String? serialPort;
  final int baudRate;

  /// The roll loaded in this printer: 80mm or 58mm. Set per printer rather
  /// than per venue, because a counter printer and a kitchen printer often
  /// take different rolls, and printing an 80mm layout on a 58mm roll silently
  /// crops the right-hand column where the prices are.
  final int paperWidthMm;

  /// Characters per line for ESC/POS at Font A, which is what the receipt
  /// builder lays columns out against.
  int get columns => paperWidthMm == 58 ? 32 : 48;

  PrinterConfig copyWith({
    String? name,
    PrinterKind? kind,
    PrinterRole? role,
    String? host,
    int? port,
    String? serialPort,
    int? baudRate,
    int? paperWidthMm,
  }) =>
      PrinterConfig(
        id: id,
        name: name ?? this.name,
        kind: kind ?? this.kind,
        role: role ?? this.role,
        host: host ?? this.host,
        port: port ?? this.port,
        serialPort: serialPort ?? this.serialPort,
        baudRate: baudRate ?? this.baudRate,
        paperWidthMm: paperWidthMm ?? this.paperWidthMm,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'kind': kind.name,
        'role': role.station,
        'host': host,
        'port': port,
        'serial_port': serialPort,
        'baud_rate': baudRate,
        'paper_width_mm': paperWidthMm,
      };

  factory PrinterConfig.fromJson(Map<String, dynamic> j) => PrinterConfig(
        id: j['id'] as String? ?? '',
        name: j['name'] as String? ?? 'Printer',
        kind: PrinterKind.values.firstWhere(
          (k) => k.name == j['kind'],
          orElse: () => PrinterKind.network,
        ),
        role: PrinterRole.fromStation(j['role'] as String?) ??
            PrinterRole.receipt,
        host: j['host'] as String?,
        port: (j['port'] as num?)?.toInt() ?? 9100,
        serialPort: j['serial_port'] as String?,
        baudRate: (j['baud_rate'] as num?)?.toInt() ?? 9600,
        paperWidthMm: (j['paper_width_mm'] as num?)?.toInt() == 58 ? 58 : 80,
      );
}

/// Sends raw ESC/POS bytes to a printer.
abstract class PrinterTransport {
  Future<void> send(List<int> bytes);

  factory PrinterTransport.of(PrinterConfig config) {
    switch (config.kind) {
      case PrinterKind.network:
        return _NetworkTransport(config);
      case PrinterKind.serial:
        return _SerialTransport(config);
    }
  }
}

/// Raw TCP on port 9100 — the standard for networked thermal printers, and the
/// only path that works on iOS and Android tablets.
class _NetworkTransport implements PrinterTransport {
  _NetworkTransport(this.config);

  final PrinterConfig config;

  @override
  Future<void> send(List<int> bytes) async {
    final socket = await Socket.connect(
      config.host,
      config.port,
      timeout: const Duration(seconds: 5),
    );
    try {
      socket.add(bytes);
      await socket.flush();
    } finally {
      socket.destroy();
    }
  }
}

/// Serial/COM. Desktop only: iOS has no serial API at all, and Android needs
/// USB-host support that most tablets do not expose. Attempting it elsewhere
/// fails loudly rather than silently dropping the receipt.
class _SerialTransport implements PrinterTransport {
  _SerialTransport(this.config);

  final PrinterConfig config;

  @override
  Future<void> send(List<int> bytes) async {
    if (!(Platform.isWindows || Platform.isMacOS || Platform.isLinux)) {
      throw UnsupportedError(
        'Serial printing is not available on this platform. '
        'Use a network printer instead.',
      );
    }

    final port = SerialPort(config.serialPort!);
    if (!port.openWrite()) {
      throw StateError('Could not open ${config.serialPort}.');
    }

    try {
      port.config = SerialPortConfig()
        ..baudRate = config.baudRate
        ..bits = 8
        ..stopBits = 1
        ..parity = SerialPortParity.none;

      port.write(Uint8List.fromList(bytes));
      port.drain();
    } finally {
      port.close();
      port.dispose();
    }
  }
}

/// Available serial ports, for the printer setup screen.
List<String> availableSerialPorts() {
  if (!(Platform.isWindows || Platform.isMacOS || Platform.isLinux)) {
    return const [];
  }
  return SerialPort.availablePorts;
}
