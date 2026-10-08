import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_libserialport/flutter_libserialport.dart';

import 'print_options.dart';
import 'windows_printing.dart';

export 'print_options.dart';
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
    this.codePage = escPosGbp,
    this.options = PrintOptions.standard,
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

  /// How this printer cuts, feeds and is sent its data. [PrintOptions.standard]
  /// unless somebody opened "Advanced" on this printer -- and standard follows
  /// the venue's own choices in the back office (Receipt Designer, Paper and
  /// cutting), so most tills never touch this.
  final PrintOptions options;

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
    PrintOptions? options,
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
    options: options ?? this.options,
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
    'options': options.toJson(),
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
    // Absent means [escPosGbp] — the setting that draws a pound on any printer
    // rather than on a well-behaved one.
    //
    // It used to mean CP1252, which is what every printer set up before this
    // existed was already being sent, and that was the right call while the
    // pound was believed to work. It is not: a venue reported X and Z reports
    // printing "r" where the pound belonged, which is byte 0xA3 drawn out of
    // CP866 — a printer resolving `ESC t 16` against a different table from the
    // one this till's profile assumes. A default nobody has to find is the
    // whole point, so the safe path is what an unset printer gets.
    codePage: (j['code_page'] as String?)?.trim().isNotEmpty ?? false
        ? j['code_page'] as String
        : escPosGbp,
    // Absent on every printer set up before 1.15: standard, which is what
    // those printers were already doing apart from the transport fixes.
    options: PrintOptions.fromJson(j['options']),
  );
}

/// What the pound sign rests on, and the default.
///
/// Not a code page: it selects the UK *international character set* with
/// `ESC R 3`, in which the printer draws the ASCII byte 0x23 as "£" instead of
/// "#", and sends that byte for the pound.
///
/// This is the default because selecting a code page is not reliable enough to
/// be one. `ESC t 16` means CP1252 in the Epson table this till's profile is
/// built from, and 16 on a clone whose table is shifted is **CP866** — where
/// 0xA3 is "г", which is precisely the "X and Z are printing r instead of £"
/// that was reported from the field. A printer that ignores `ESC t` outright
/// lands somewhere else again, and a venue cannot be asked to work out which.
///
/// `ESC R` is the oldest command in the standard and does not depend on the
/// code page at all, so 0x23 comes out as a pound whether or not `ESC t` was
/// understood. The cost is a single character: a genuine "#" cannot be drawn,
/// and is spelled "No." instead. That is a trade worth making — a bill or a Z
/// report with the wrong currency symbol on it is wrong in a way "No. 4" is
/// not.
///
/// The upper range still gets a real code page selected underneath this, so
/// accented names on a receipt are unaffected.
const escPosGbp = 'UK_ASCII';

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
///
/// CLOSED GRACEFULLY (2026-10-08). This used to flush and then `destroy()` the
/// socket straight away. A flush only means the bytes have left the till; the
/// printer reads them off its own network buffer as fast as it can print,
/// which is slower. Destroying the socket at that moment resets the connection
/// -- and a printer that has sent anything back (many send a status byte the
/// moment they are connected to) gets a reset rather than a goodbye, and drops
/// whatever it had not read yet. That is a slip with the venue's name and
/// "Z REPORT" on it and nothing else, and no cut, because the cut is the last
/// thing sent. Pontardawe's Xprinter printed exactly that.
///
/// So: read and discard whatever the printer says, send, half-close (our side
/// says "that is everything"), and give the printer time to finish reading
/// and close its side before the socket is let go.
class _NetworkTransport implements PrinterTransport {
  _NetworkTransport(this.config);

  final PrinterConfig config;

  @override
  Future<void> send(List<int> bytes) async {
    final gentle = config.options.resolve().gentle;
    final socket = await Socket.connect(
      config.host,
      config.port,
      timeout: const Duration(seconds: 5),
    );
    socket.setOption(SocketOption.tcpNoDelay, true);
    final closed = Completer<void>();
    // Anything the printer sends back is read and dropped. Unread incoming
    // data is what turns a close into a reset.
    final sub = socket.listen(
      (_) {},
      onError: (_) {
        if (!closed.isCompleted) closed.complete();
      },
      onDone: () {
        if (!closed.isCompleted) closed.complete();
      },
      cancelOnError: true,
    );
    try {
      if (gentle) {
        for (var offset = 0; offset < bytes.length; offset += gentleChunk) {
          final end = (offset + gentleChunk).clamp(0, bytes.length);
          socket.add(bytes.sublist(offset, end));
          await socket.flush();
          await Future<void>.delayed(gentlePause);
        }
      } else {
        socket.add(bytes);
        await socket.flush();
      }
      // Half-close: the printer sees the end of the job, not a reset.
      await socket.close().timeout(const Duration(seconds: 5));
      // Wait for the printer to close its side, which it does once it has
      // read everything. A printer that never does is let go after a moment.
      await closed.future.timeout(
        const Duration(seconds: 3),
        onTimeout: () {},
      );
    } finally {
      await sub.cancel();
      socket.destroy();
    }
  }
}

/// How much a gentle send hands over at a time, and how long it waits between
/// pieces. Small enough for the smallest receive buffer seen on a clone
/// printer, with a pause long enough for it to print a line or two.
const gentleChunk = 256;
const gentlePause = Duration(milliseconds: 30);

/// Serial/COM. Desktop only: iOS has no serial API at all, and Android needs
/// USB-host support that most tablets do not expose. Attempting it elsewhere
/// fails loudly rather than silently dropping the receipt.
///
/// BLOCKING WRITES (2026-10-08). `SerialPort.write` with no timeout is a
/// *non-blocking* write: it hands over what fits in the driver's buffer and
/// returns how much that was -- which was never looked at. On a slow port, or
/// a USB "virtual COM" printer, that is the first few lines of a Z report and
/// none of the rest. Every byte is now written with a timeout and checked,
/// and the port is drained before it is closed. Runs on a worker isolate, as
/// the USB path does, because a blocking write must not freeze the till.
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
    final path = config.serialPort!;
    final baud = config.baudRate;
    final gentle = config.options.resolve().gentle;
    final payload = Uint8List.fromList(bytes);
    await Isolate.run(() => writeSerial(path, baud, payload, gentle: gentle));
  }
}

/// Write every byte of [data] to a serial port, or throw saying why not.
void writeSerial(String path, int baud, Uint8List data, {bool gentle = false}) {
  final port = SerialPort(path);
  if (!port.openWrite()) {
    port.dispose();
    throw StateError('Could not open $path.');
  }
  try {
    port.config = SerialPortConfig()
      ..baudRate = baud
      ..bits = 8
      ..stopBits = 1
      ..parity = SerialPortParity.none;

    final piece = gentle ? gentleChunk : 1024;
    var offset = 0;
    while (offset < data.length) {
      final end = (offset + piece).clamp(0, data.length);
      // Blocking, with a timeout: at 9600 baud 1 KB takes about a second.
      final wrote = port.write(
        Uint8List.sublistView(data, offset, end),
        timeout: 10000,
      );
      if (wrote <= 0) {
        throw StateError(
          'The printer on $path stopped accepting data. Check it is switched '
          'on and has paper.',
        );
      }
      offset += wrote;
      if (gentle) sleep(gentlePause);
    }
    port.drain();
  } finally {
    port.close();
    port.dispose();
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
    final gentle = config.options.resolve().gentle;
    await Isolate.run(() => sendToUsbDevice(path, payload, gentle: gentle));
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
