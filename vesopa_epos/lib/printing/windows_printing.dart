/// Windows printing, close to the metal.
///
/// Two paths live here, and the difference between them is the whole reason
/// this file exists.
///
/// **USB direct** talks to the printer's `usbprint.sys` device interface with
/// `CreateFile`/`WriteFile`. Nothing is queued, nothing is rendered, no driver
/// gets a say, and the spooler is not in the path at all — the bytes go from
/// here onto the wire. This is the reliable option in a busy venue, because
/// the failure modes a spooler adds (a stalled queue, a job stuck behind a
/// crashed driver, a print dialog nobody is standing at) simply cannot happen.
/// It needs no driver swap: `usbprint.sys` is the in-box driver Windows binds
/// to a printer installed the ordinary way, and this is its documented device
/// interface.
///
/// **Windows RAW** hands the same bytes to a named printer *queue* with
/// `WritePrinter` under the `RAW` datatype. The driver still does not render
/// anything — the ESC/POS reaches the printer untouched — but the spooler is
/// in the path. It exists because it works with printers this venue has
/// already set up in Windows, including ones reached over a Windows print
/// share, and because a printer whose vendor driver does not expose a
/// `usbprint` interface has no other local route.
///
/// Every call in here blocks the calling thread. None of them should be made
/// on the UI isolate — see `PrinterTransport`, which runs them on a worker.
library;

import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';
import 'package:win32/win32.dart';

/// The device interface class every USB printer bound to `usbprint.sys`
/// registers itself under. Fixed by Windows; not ours to choose.
const _usbPrintInterfaceGuid = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}';

/// `sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W)` as SetupAPI wants it — 4 bytes
/// of `cbSize` plus one `WCHAR`, padded to the struct's 4-byte alignment.
///
/// This is *not* the size of the buffer that gets passed alongside it, which is
/// the mistake this constant exists to stop anyone making: SetupAPI validates
/// `cbSize` against the fixed header size and fails the call with
/// ERROR_INVALID_USER_BUFFER if it is given the buffer length instead.
const _detailHeaderSize = 8;

/// `DevicePath` begins immediately after the 4-byte `cbSize`.
const _devicePathOffset = 4;

/// A printer queue Windows already knows about.
class WindowsPrintQueue {
  const WindowsPrintQueue({required this.name, this.server});

  /// The queue name, exactly as `OpenPrinter` wants it back.
  final String name;

  /// Set for a queue reached over the network from another machine.
  final String? server;

  bool get isShared => server != null && server!.isNotEmpty;
}

/// A USB printer reachable without the spooler.
class UsbPrinterDevice {
  const UsbPrinterDevice({required this.devicePath, required this.label});

  /// The `\\?\usb#vid_…` interface path handed to `CreateFile`.
  ///
  /// Stable across reboots and across USB ports for a printer that reports a
  /// serial number. A printer that does not report one encodes its port in
  /// this path instead, so moving it to a different socket changes it — which
  /// is why the setup screen re-scans rather than trusting a stored path
  /// forever.
  final String devicePath;

  /// What to show a human. The driver's friendly name where there is one.
  final String label;
}

/// Raised when a Windows print path fails, carrying something an operator can
/// act on rather than a bare error number.
class WindowsPrintException implements Exception {
  WindowsPrintException(this.message);
  final String message;

  @override
  String toString() => message;
}

bool get _isWindows => Platform.isWindows;

void _requireWindows() {
  if (!_isWindows) {
    throw WindowsPrintException(
      'Direct Windows printing is only available on a Windows till.',
    );
  }
}

/// Turn a Win32 error code into something worth reading.
String _describe(int error, String what) {
  final known = switch (error) {
    2 => 'Windows cannot find it — it may have been unplugged or removed.',
    5 => 'Access was denied. Another program may hold the printer open.',
    32 => 'It is in use by something else.',
    // usbprint returns this when the printer is powered down mid-write.
    22 => 'The printer did not accept the data. Check it is switched on and '
        'has paper.',
    1167 => 'The device is not connected.',
    _ => null,
  };
  return known == null
      ? '$what (Windows error $error).'
      : '$what $known (Windows error $error).';
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/// Every printer queue installed on this machine, including shared ones.
///
/// Returns empty off Windows rather than throwing: the setup screen asks for
/// this to decide whether to offer the option at all, and "none" is the honest
/// answer on a tablet.
List<WindowsPrintQueue> windowsPrintQueues() {
  if (!_isWindows) return const [];

  return using((arena) {
    final needed = arena<Uint32>();
    final returned = arena<Uint32>();
    const flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;

    // First pass sizes the buffer. It is *expected* to fail — with
    // ERROR_INSUFFICIENT_BUFFER — so its return value is deliberately ignored
    // and only `needed` is read.
    EnumPrinters(flags, null, 4, null, 0, needed, returned);
    if (needed.value == 0) return const <WindowsPrintQueue>[];

    final buffer = arena<Uint8>(needed.value);
    final result = EnumPrinters(
      flags,
      null,
      4,
      buffer,
      needed.value,
      needed,
      returned,
    );
    if (!result.value) return const <WindowsPrintQueue>[];

    final info = buffer.cast<PRINTER_INFO_4>();
    final queues = <WindowsPrintQueue>[];
    for (var i = 0; i < returned.value; i++) {
      final entry = (info + i).ref;
      final name = entry.pPrinterName.toDartString();
      if (name.isEmpty) continue;
      final server = entry.pServerName;
      queues.add(
        WindowsPrintQueue(
          name: name,
          server: server.address == 0 ? null : server.toDartString(),
        ),
      );
    }
    queues.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return queues;
  });
}

/// Every USB printer that can be written to without the spooler.
///
/// A printer appears here only while it is plugged in and powered up
/// (`DIGCF_PRESENT`), which is what makes this list worth showing during
/// setup: what is in it is what will actually print.
List<UsbPrinterDevice> usbPrinterDevices() {
  if (!_isWindows) return const [];

  return using((arena) {
    final guid = arena<GUID>();
    guid.ref.setGUID(_usbPrintInterfaceGuid);

    final devInfo = SetupDiGetClassDevs(
      guid,
      null,
      null,
      DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
    );
    if (devInfo.value == -1) return const <UsbPrinterDevice>[];

    final found = <UsbPrinterDevice>[];
    try {
      final ifData = arena<SP_DEVICE_INTERFACE_DATA>();
      ifData.ref.cbSize = sizeOf<SP_DEVICE_INTERFACE_DATA>();

      for (var index = 0; ; index++) {
        final more = SetupDiEnumDeviceInterfaces(
          devInfo.value,
          null,
          guid,
          index,
          ifData,
        );
        if (!more.value) break;

        final needed = arena<Uint32>();
        // Sizing pass, expected to fail with ERROR_INSUFFICIENT_BUFFER.
        SetupDiGetDeviceInterfaceDetail(
          devInfo.value,
          ifData,
          null,
          0,
          needed,
          null,
        );
        if (needed.value < _detailHeaderSize) continue;

        final detail = arena<Uint8>(needed.value);
        // The header size, not the buffer size — see [_detailHeaderSize].
        detail.cast<Uint32>().value = _detailHeaderSize;

        final devInfoData = arena<SP_DEVINFO_DATA>();
        devInfoData.ref.cbSize = sizeOf<SP_DEVINFO_DATA>();

        final gotDetail = SetupDiGetDeviceInterfaceDetail(
          devInfo.value,
          ifData,
          detail.cast<SP_DEVICE_INTERFACE_DETAIL_DATA>(),
          needed.value,
          null,
          devInfoData,
        );
        if (!gotDetail.value) continue;

        final path = (detail + _devicePathOffset).cast<Utf16>().toDartString();
        if (path.isEmpty) continue;

        // The friendly name is what the vendor's driver set; the device
        // description is the generic fallback ("USB Printing Support"). Either
        // beats showing an operator a 120-character device path.
        final label =
            _deviceProperty(devInfo.value, devInfoData, SPDRP_FRIENDLYNAME) ??
            _deviceProperty(devInfo.value, devInfoData, SPDRP_DEVICEDESC) ??
            'USB printer';

        found.add(UsbPrinterDevice(devicePath: path, label: label));
      }
    } finally {
      SetupDiDestroyDeviceInfoList(devInfo.value);
    }

    return found;
  });
}

/// One string property off a device node, or null if it has none.
String? _deviceProperty(
  HDEVINFO devInfo,
  Pointer<SP_DEVINFO_DATA> devInfoData,
  SETUP_DI_REGISTRY_PROPERTY property,
) {
  return using((arena) {
    final needed = arena<Uint32>();
    SetupDiGetDeviceRegistryProperty(
      devInfo,
      devInfoData,
      property,
      null,
      null,
      0,
      needed,
    );
    if (needed.value == 0) return null;

    final buffer = arena<Uint8>(needed.value);
    final ok = SetupDiGetDeviceRegistryProperty(
      devInfo,
      devInfoData,
      property,
      null,
      buffer,
      needed.value,
      null,
    );
    if (!ok.value) return null;

    final text = buffer.cast<Utf16>().toDartString();
    return text.isEmpty ? null : text;
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Send raw bytes straight to a USB printer, with no spooler in the path.
void sendToUsbDevice(String devicePath, List<int> bytes) {
  _requireWindows();
  if (bytes.isEmpty) return;

  using((arena) {
    final handle = CreateFile(
      PCWSTR(devicePath.toNativeUtf16(allocator: arena)),
      GENERIC_WRITE,
      // Exclusive. Two tickets interleaving halfway through an ESC/POS stream
      // produces one unreadable ticket and no error, which is worse than
      // waiting.
      const FILE_SHARE_MODE(0),
      null,
      OPEN_EXISTING,
      const FILE_FLAGS_AND_ATTRIBUTES(0),
      null,
    );

    if (!handle.value.isValid) {
      throw WindowsPrintException(
        _describe(handle.error, 'Could not open the USB printer.'),
      );
    }

    try {
      _writeInChunks(
        bytes,
        arena,
        (buffer, length, written) =>
            WriteFile(handle.value, buffer, length, written, null).value,
        () => GetLastError(),
        'USB printer',
      );
    } finally {
      CloseHandle(handle.value);
    }
  });
}

/// Send raw bytes to a named Windows printer queue as a RAW job.
void sendToWindowsQueue(
  String queueName,
  List<int> bytes, {
  String documentName = 'Vesopa receipt',
}) {
  _requireWindows();
  if (bytes.isEmpty) return;

  using((arena) {
    final handlePtr = arena<Pointer>();
    final opened = OpenPrinter(
      PCWSTR(queueName.toNativeUtf16(allocator: arena)),
      handlePtr,
      null,
    );
    if (!opened.value) {
      throw WindowsPrintException(
        _describe(opened.error, 'Could not open the printer "$queueName".'),
      );
    }

    final printer = PRINTER_HANDLE(handlePtr.value);
    var documentOpen = false;
    var pageOpen = false;

    try {
      final docInfo = arena<DOC_INFO_1>();
      docInfo.ref.pDocName = PWSTR(
        documentName.toNativeUtf16(allocator: arena),
      );
      // The one line that matters. "RAW" tells the spooler to pass the bytes
      // through untouched instead of handing them to the driver to render —
      // which is what turns a page of ESC/POS gibberish into a receipt.
      docInfo.ref.pDatatype = PWSTR('RAW'.toNativeUtf16(allocator: arena));

      if (StartDocPrinter(printer, 1, docInfo) == 0) {
        throw WindowsPrintException(
          _describe(GetLastError(), 'Windows refused the print job.'),
        );
      }
      documentOpen = true;

      if (!StartPagePrinter(printer)) {
        throw WindowsPrintException(
          _describe(GetLastError(), 'Windows refused the print job.'),
        );
      }
      pageOpen = true;

      _writeInChunks(
        bytes,
        arena,
        (buffer, length, written) =>
            WritePrinter(printer, buffer, length, written),
        () => GetLastError(),
        'printer "$queueName"',
      );
    } finally {
      // Unwound in the order Windows expects, and only as far as it was
      // actually wound up — calling EndDocPrinter on a job that never started
      // leaves the handle in a state that leaks the queue entry.
      if (pageOpen) EndPagePrinter(printer);
      if (documentOpen) EndDocPrinter(printer);
      ClosePrinter(printer);
    }
  });
}

/// Push [bytes] through [write] in pieces, insisting every byte lands.
///
/// Both Win32 write calls are allowed to accept less than they were offered,
/// and a short write that goes unnoticed is a receipt that ends mid-line with
/// no error anywhere. Chunking also keeps a large ticket — a logo raster is
/// tens of kilobytes — from being handed to a printer's buffer in one go.
void _writeInChunks(
  List<int> bytes,
  Arena arena,
  bool Function(Pointer<Uint8> buffer, int length, Pointer<Uint32> written)
  write,
  int Function() lastError,
  String what,
) {
  const chunkSize = 4096;
  final buffer = arena<Uint8>(chunkSize);
  final written = arena<Uint32>();
  final view = buffer.asTypedList(chunkSize);

  var offset = 0;
  while (offset < bytes.length) {
    final length = (bytes.length - offset).clamp(0, chunkSize);
    view.setRange(0, length, bytes, offset);

    written.value = 0;
    final ok = write(buffer, length, written);
    if (!ok) {
      throw WindowsPrintException(
        _describe(lastError(), 'The $what stopped accepting data.'),
      );
    }
    if (written.value == 0) {
      throw WindowsPrintException(
        'The $what accepted no data. Check it is switched on and online.',
      );
    }
    offset += written.value;
  }
}
