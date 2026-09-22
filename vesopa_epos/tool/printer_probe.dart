// Smoke-test the Windows printing FFI against the real machine.
//
//     dart run tool/printer_probe.dart
//
// Exercises the two device walks — the spooler's queue list and the USB
// device tree — because a wrong struct size or a bad cbSize in either one
// compiles perfectly and then fails, or corrupts memory, only at runtime.
import 'dart:io';

import 'package:vesopa_epos/printing/windows_printing.dart';

void main() {
  if (!Platform.isWindows) {
    stdout.writeln('Not Windows — nothing to probe.');
    return;
  }

  stdout.writeln('--- Windows print queues (spooler) ---');
  final queues = windowsPrintQueues();
  if (queues.isEmpty) {
    stdout.writeln('  (none installed)');
  }
  for (final q in queues) {
    stdout.writeln('  ${q.name}${q.isShared ? '  [shared from ${q.server}]' : ''}');
  }

  stdout.writeln('--- USB printers (direct, no spooler) ---');
  final usb = usbPrinterDevices();
  if (usb.isEmpty) {
    stdout.writeln('  (none plugged in)');
  }
  for (final d in usb) {
    stdout.writeln('  ${d.label}');
    stdout.writeln('    ${d.devicePath}');
  }

  stdout.writeln('Both device walks completed without crashing.');
}
