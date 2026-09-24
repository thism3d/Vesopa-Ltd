import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/hardware_fingerprint.dart';

/// The fingerprint a licence is bound to, against the machine actually running
/// the test.
///
/// Deliberately not mocked. The whole value of this thing is that it reads what
/// Windows really says about the hardware, and a test that stubbed `reg` and
/// `Get-CimInstance` would pass just as happily on a build where both had been
/// spelled wrong. On anything but Windows it asserts the honest answer — null —
/// which is the other half of the contract: no fingerprint ever refuses anybody.
void main() {
  test('answers null off Windows, and a stable hash on it', () async {
    final value = await HardwareFingerprint.get();

    if (!Platform.isWindows) {
      expect(value, isNull, reason: 'only Windows machines are fingerprinted');
      return;
    }

    // A machine that will not answer gives null and that is allowed — but if it
    // did answer, the answer has to be a SHA-256 and nothing else.
    if (value == null) {
      // ignore: avoid_print
      print('This machine would not identify itself; a licence here stays unbound.');
      return;
    }

    expect(value, matches(RegExp(r'^[0-9a-f]{64}$')),
        reason: 'what leaves the machine is a hash, never the serials');

    // Asked twice, the same machine. A fingerprint that wandered would unbind
    // every licence on every restart.
    expect(await HardwareFingerprint.get(), value);
  });

  test('does not leak the serials it is made of', () async {
    if (!Platform.isWindows) return;
    final value = await HardwareFingerprint.get();
    if (value == null) return;

    // The registry's MachineGuid is one of the ingredients; it must not be
    // recoverable from what is sent.
    final reg = await Process.run(
      'reg',
      ['query', r'HKLM\SOFTWARE\Microsoft\Cryptography', '/v', 'MachineGuid', '/reg:64'],
      stdoutEncoding: const SystemEncoding(),
    );
    final guid =
        RegExp(r'MachineGuid\s+REG_SZ\s+(\S+)').firstMatch(reg.stdout as String)?.group(1);
    if (guid == null) return;
    expect(value.contains(guid), isFalse);
    expect(value, isNot(equals(guid)));
  });
}
