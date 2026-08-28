import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_libserialport/flutter_libserialport.dart';

import 'windows_printing.dart';

export 'print_targets.dart';

/// How a printer is reached.
///
/// Ordered by how directly each one talks to the hardware, which is also the
/// order a venue should prefer them in. The first three put the bytes on the
/// wire themselves; only [windowsQueue] involves the Windows spooler, and it is
/// last because a spooler in the path is the thing that goes wrong at eight on
/// a Friday.
enum PrinterKind {
  /// Raw TCP to port 9100. The standard for networked thermal printers, the
  /// only path that works from an iOS or Android till, and completely outside
  /// the spooler.
  network(
    'Network',
    'Straight to the printer over the network. No spooler, no driver.',
    isDirect: true,
  ),

  /// The printer's `usbprint.sys` device interface, written to directly.
  /// Windows desktop only.
  usb(
    'USB (direct)',
    'Straight to a USB printer, bypassing the Windows spooler entirely. The '
        'most reliable option on a busy counter.',
    isDirect: true,
  ),

  /// A COM port. Desktop only, and still common on older till printers.
  serial(
    'Serial',
    'A COM port. No spooler, no driver.',
    isDirect: true,
  ),

  /// A named Windows printer queue, written as a RAW job.
  ///
  /// The driver never renders anything — the ESC/POS goes through untouched —
  /// but the spooler does queue it. Here for printers already set up in
  /// Windows, printers on a Windows share, and any printer whose driver does
  /// not expose a direct USB interface.
  windowsQueue(
    'Windows printer',
    'A printer already set up in Windows. The bytes are sent raw, so nothing '
        'is re-rendered, but the job still passes through the Windows spooler.',
    isDirect: false,
  );

  const PrinterKind(this.label, this.blurb, {required this.isDirect});

  final String label;
  final String blurb;

  /// Whether this path avoids the Windows spooler altogether.
  final bool isDirect;

  /// Whether this terminal can use this connection at all.
  bool get isAvailableHere => switch (this) {
    PrinterKind.network => true,
    PrinterKind.serial =>
      Platform.isWindows || Platform.isMacOS || Platform.isLinux,
    PrinterKind.usb || PrinterKind.windowsQueue => Platform.isWindows,
  };

  static PrinterKind fromName(String? name) {
    for (final kind in values) {
      if (kind.name == name) return kind;
    }
    // "usbprint" was the name this shipped under briefly; anything else
    // unrecognised falls back to the one connection every platform has.
    return name == 'usbprint' ? PrinterKind.usb : PrinterKind.network;
  }
}

/// One physical printer wired to this terminal.
///
/// A device, not a job. What it *prints* is decided by the target assignments
/// in `PrinterSettings` — the same printer can be the customer's receipt and
/// the cash drawer and KP 3 at once, which is exactly the small venue that
/// owns one printer.
class PrinterConfig {
  const PrinterConfig({
    required this.id,
    required this.name,
    required this.kind,
    this.host,
    this.port = 9100,
    this.serialPort,
    this.baudRate = 9600,
    this.windowsQueueName,
    this.usbDevicePath,
    this.usbLabel,
    this.paperWidthMm = 80,
    this.codePage = 'CP1252',
  });

  final String id;
  final String name;
  final PrinterKind kind;

  /// Network printers.
  final String? host;
  final int port;

  /// Serial printers: the device path (COM3 on Windows, /dev/tty.* elsewhere).
  final String? serialPort;
  final int baudRate;

  /// The Windows queue name, for [PrinterKind.windowsQueue].
  final String? windowsQueueName;

  /// The `\\?\usb#…` interface path, for [PrinterKind.usb].
  final String? usbDevicePath;

  /// What that USB device called itself when it was chosen, so the setup screen
  /// can still name a printer that has since been unplugged.
  final String? usbLabel;

  /// The roll loaded in this printer: 80mm or 58mm. Set per printer rather
  /// than per venue, because a counter printer and a kitchen printer often
  /// take different rolls, and printing an 80mm layout on a 58mm roll silently
  /// crops the right-hand column where the prices are.
  final int paperWidthMm;

  /// Which character table this printer is told to draw in.
  ///
  /// This exists because of the pound sign, and because a thermal printer is
  /// not obliged to do as it is told. The till selects a page with `ESC t n`
  /// and encodes Latin-1 underneath it, which is correct and works on most
  /// hardware — but plenty of cheap printers ignore `ESC t` entirely and draw
  /// whatever their DIP switches say, and on the factory default (CP437) the
  /// byte behind "£" is "ú". A Z report that reads "ú1,204.40" is not a
  /// cosmetic fault; it is a document a manager has to hand to an accountant.
  ///
  /// Per printer rather than per venue, because the two printers on one counter
  /// are routinely different models. CP1252 is the default and is right almost
  /// everywhere; the alternatives are here for the printer that is not. See
  /// [ReceiptBuilder] for what each one does to the pound sign, and Settings ›
  /// Printing, where a test slip prints one so it can be checked on paper
  /// rather than guessed at.
  final String codePage;

  /// Characters per line for ESC/POS at Font A, which is what the receipt
  /// builder lays columns out against.
  int get columns => paperWidthMm == 58 ? 32 : 48;

  /// Whether this printer avoids the Windows spooler.
  bool get isDirect => kind.isDirect;

  /// Whether enough has been filled in for this to have any chance of printing.
  bool get isComplete => switch (kind) {
    PrinterKind.network => (host ?? '').trim().isNotEmpty,
    PrinterKind.serial => (serialPort ?? '').trim().isNotEmpty,
    PrinterKind.usb => (usbDevicePath ?? '').trim().isNotEmpty,
    PrinterKind.windowsQueue => (windowsQueueName ?? '').trim().isNotEmpty,
  };

  /// How this printer is reached, for a human reading the setup screen.
  String get connectionSummary => switch (kind) {
    PrinterKind.network => '${host ?? '?'}:$port',
    PrinterKind.serial => '${serialPort ?? '?'} @ $baudRate',
    PrinterKind.usb => usbLabel ?? usbDevicePath ?? '?',
    PrinterKind.windowsQueue => windowsQueueName ?? '?',
  };

  PrinterConfig copyWith({
    String? name,
    PrinterKind? kind,
    String? host,
    int? port,
    String? serialPort,
    int? baudRate,
    String? windowsQueueName,
    String? usbDevicePath,
    String? usbLabel,
    int? paperWidthMm,
    String? codePage,
  }) => PrinterConfig(
    id: id,
    name: name ?? this.name,
    kind: kind ?? this.kind,
    host: host ?? this.host,
    port: port ?? this.port,
    serialPort: serialPort ?? this.serialPort,
    baudRate: baudRate ?? this.baudRate,
    windowsQueueName: windowsQueueName ?? this.windowsQueueName,
    usbDevicePath: usbDevicePath ?? this.usbDevicePath,
    usbLabel: usbLabel ?? this.usbLabel,
    paperWidthMm: paperWidthMm ?? this.paperWidthMm,
    codePage: codePage ?? this.codePage,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'kind': kind.name,
    'host': host,
    'port': port,
    'serial_port': serialPort,
    'baud_rate': baudRate,
    'windows_queue': windowsQueueName,
    'usb_device_path': usbDevicePath,
    'usb_label': usbLabel,
    'paper_width_mm': paperWidthMm,
    'code_page': codePage,
  };

  factory PrinterConfig.fromJson(Map<String, dynamic> j) => PrinterConfig(
    id: j['id'] as String? ?? '',
    name: j['name'] as String? ?? 'Printer',
    kind: PrinterKind.fromName(j['kind'] as String?),
    host: j['host'] as String?,
    port: (j['port'] as num?)?.toInt() ?? 9100,
    serialPort: j['serial_port'] as String?,
    baudRate: (j['baud_rate'] as num?)?.toInt() ?? 9600,
    windowsQueueName: j['windows_queue'] as String?,
    usbDevicePath: j['usb_device_path'] as String?,
    usbLabel: j['usb_label'] as String?,
    paperWidthMm: (j['paper_width_mm'] as num?)?.toInt() == 58 ? 58 : 80,
    // Absent on every printer set up before this existed, and absent means
    // CP1252 -- which is exactly what those printers were already being sent.
    codePage: (j['code_page'] as String?)?.trim().isNotEmpty ?? false
        ? j['code_page'] as String
        : 'CP1252',
  );
}

/// Sends raw ESC/POS bytes to a printer.
abstract class PrinterTransport {
  Future<void> send(List<int> bytes);

  factory PrinterTransport.of(PrinterConfig config) => switch (config.kind) {
    PrinterKind.network => _NetworkTransport(config),
    PrinterKind.serial => _SerialTransport(config),
    PrinterKind.usb => _UsbTransport(config),
    PrinterKind.windowsQueue => _WindowsQueueTransport(config),
  };
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

/// USB, straight to the device, with the spooler out of the picture.
///
/// The Win32 calls block until the printer has taken the bytes, so they run on
/// a worker isolate. On a till that matters: a printer that has run out of
/// paper can hold a write open for seconds, and doing that on the UI isolate
/// would freeze the sale screen mid-service — which is precisely the thing
/// direct printing is meant to prevent.
class _UsbTransport implements PrinterTransport {
  _UsbTransport(this.config);

  final PrinterConfig config;

  @override
  Future<void> send(List<int> bytes) async {
    final path = config.usbDevicePath;
    if (path == null || path.isEmpty) {
      throw StateError('No USB printer chosen for ${config.name}.');
    }
    // Copied into a plain list before crossing the isolate boundary.
    final payload = List<int>.unmodifiable(bytes);
    await Isolate.run(() => sendToUsbDevice(path, payload));
  }
}

/// A Windows print queue, written as a RAW job. Runs on a worker isolate for
/// the same reason as [_UsbTransport].
class _WindowsQueueTransport implements PrinterTransport {
  _WindowsQueueTransport(this.config);

  final PrinterConfig config;

  @override
  Future<void> send(List<int> bytes) async {
    final queue = config.windowsQueueName;
    if (queue == null || queue.isEmpty) {
      throw StateError('No Windows printer chosen for ${config.name}.');
    }
    final payload = List<int>.unmodifiable(bytes);
    final name = config.name;
    await Isolate.run(
      () => sendToWindowsQueue(queue, payload, documentName: name),
    );
  }
}

/// Available serial ports, for the printer setup screen.
List<String> availableSerialPorts() {
  if (!(Platform.isWindows || Platform.isMacOS || Platform.isLinux)) {
    return const [];
  }
  return SerialPort.availablePorts;
}

/// USB printers plugged in right now. Enumeration is a blocking Win32 walk of
/// the device tree, so it happens off the UI isolate.
Future<List<UsbPrinterDevice>> discoverUsbPrinters() async {
  if (!Platform.isWindows) return const [];
  final found = await Isolate.run(
    () => usbPrinterDevices()
        .map((d) => (path: d.devicePath, label: d.label))
        .toList(),
  );
  return [
    for (final d in found)
      UsbPrinterDevice(devicePath: d.path, label: d.label),
  ];
}

/// Printer queues Windows knows about, for the setup screen.
Future<List<WindowsPrintQueue>> discoverWindowsQueues() async {
  if (!Platform.isWindows) return const [];
  final found = await Isolate.run(
    () => windowsPrintQueues()
        .map((q) => (name: q.name, server: q.server))
        .toList(),
  );
  return [
    for (final q in found) WindowsPrintQueue(name: q.name, server: q.server),
  ];
}
