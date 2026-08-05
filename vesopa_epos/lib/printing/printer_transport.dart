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
enum PrinterRole {
  receipt('Receipt printer'),
  kitchen('Kitchen printer'),
  bar('Bar printer');

  const PrinterRole(this.label);
  final String label;
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
        'role': role.name,
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
        role: PrinterRole.values.firstWhere(
          (r) => r.name == j['role'],
          orElse: () => PrinterRole.receipt,
        ),
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
