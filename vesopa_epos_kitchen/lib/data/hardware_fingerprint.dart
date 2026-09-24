import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What machine this is, as a hash — the "hardware information" a licence is
/// bound to.
///
/// WHY NOT THE DEVICE ID
///
/// The kitchen screen already has a device id, and it is a UUID it generated on first run
/// and keeps in its own settings (its own device-identity file). A reinstall makes a
/// new one; copying the install folder to a second machine brings the old one
/// along. It can say which machine this *probably* is, and a licence needs to
/// know which machine this *is*.
///
/// WHAT IT IS MADE OF
///
/// Three values Windows holds about the machine rather than the installation:
///
///   * `MachineGuid` — written by Windows setup, under
///     `HKLM\SOFTWARE\Microsoft\Cryptography`. Survives an app reinstall,
///     changes when Windows is reinstalled.
///   * the SMBIOS UUID (`Win32_ComputerSystemProduct.UUID`) — burnt into the
///     firmware by the manufacturer.
///   * the motherboard serial (`Win32_BaseBoard.SerialNumber`).
///
/// Hashed together, so what leaves the machine is 64 characters of hex and
/// never the serials themselves: a venue's hardware inventory is not something
/// this product needs a copy of.
///
/// NEVER STORED ON DISK
///
/// Computed fresh every run and kept only in memory. Caching it in settings
/// would put the answer in the same folder somebody would copy to a second
/// machine, which is exactly the thing being defended against.
///
/// WHAT IT COSTS WHEN IT FAILS
///
/// Null, on any platform that is not Windows and on any machine that will not
/// answer. A null fingerprint never refuses a sign-in — it only means that
/// device's licence cannot be bound to hardware. A licence check that stopped a
/// venue opening would be a far worse fault than a licence briefly unbound.
class HardwareFingerprint {
  HardwareFingerprint._();

  static String? _cached;
  static Future<String?>? _inFlight;

  /// The fingerprint for this machine, computed once per run.
  static Future<String?> get() {
    if (_cached != null) return Future.value(_cached);
    return _inFlight ??= _compute().then((value) {
      _cached = value;
      _inFlight = null;
      return value;
    });
  }

  static Future<String?> _compute() async {
    if (!Platform.isWindows) return null;
    final parts = <String>[];

    final guid = await _machineGuid();
    if (guid != null) parts.add('guid:$guid');

    final firmware = await _firmwareIds();
    parts.addAll(firmware);

    // One value is not enough to call a machine identified: a PC that answers
    // only the registry would fingerprint the Windows installation, which is
    // the thing an image copies. Two independent sources or nothing.
    if (parts.length < 2) return null;

    parts.sort();
    return sha256.convert(utf8.encode(parts.join('|'))).toString();
  }

  /// `HKLM\SOFTWARE\Microsoft\Cryptography` → MachineGuid.
  static Future<String?> _machineGuid() async {
    try {
      final res = await Process.run(
        'reg',
        [
          'query',
          r'HKLM\SOFTWARE\Microsoft\Cryptography',
          '/v',
          'MachineGuid',
          // 64-bit view explicitly: a 32-bit process would otherwise be given
          // the WOW6432Node copy, and the same machine would fingerprint
          // differently depending on how the app was built.
          '/reg:64',
        ],
        stdoutEncoding: const SystemEncoding(),
      ).timeout(const Duration(seconds: 5));
      if (res.exitCode != 0) return null;
      final match =
          RegExp(r'MachineGuid\s+REG_SZ\s+(\S+)').firstMatch(res.stdout as String);
      return _clean(match?.group(1));
    } catch (_) {
      return null;
    }
  }

  /// The firmware's own ids, in one PowerShell call rather than two.
  static Future<List<String>> _firmwareIds() async {
    try {
      final res = await Process.run(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          r"$p = Get-CimInstance -ClassName Win32_ComputerSystemProduct; "
              r"$b = Get-CimInstance -ClassName Win32_BaseBoard; "
              r"Write-Output ($p.UUID + '~' + $b.SerialNumber)",
        ],
        stdoutEncoding: const SystemEncoding(),
      ).timeout(const Duration(seconds: 10));
      if (res.exitCode != 0) return const [];
      final line = (res.stdout as String).trim().split('\n').first;
      final bits = line.split('~');
      final out = <String>[];
      final uuid = _clean(bits.isNotEmpty ? bits[0] : null);
      final board = _clean(bits.length > 1 ? bits[1] : null);
      if (uuid != null) out.add('uuid:$uuid');
      if (board != null) out.add('board:$board');
      return out;
    } catch (_) {
      return const [];
    }
  }

  /// Values manufacturers put in these fields when they could not be bothered.
  ///
  /// A rack of machines all reporting "To be filled by O.E.M." would otherwise
  /// fingerprint identically, and one venue's licence would activate on
  /// another's machine — the precise failure this exists to prevent.
  static const _useless = {
    '',
    '0',
    'none',
    'default string',
    'to be filled by o.e.m.',
    'to be filled by oem',
    'not applicable',
    'not specified',
    'system serial number',
    'unknown',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  };

  static String? _clean(String? raw) {
    final value = (raw ?? '').trim();
    if (_useless.contains(value.toLowerCase())) return null;
    return value.isEmpty ? null : value;
  }
}

/// This machine's fingerprint, for the sign-in that claims a licence.
final hardwareFingerprintProvider =
    FutureProvider<String?>((ref) => HardwareFingerprint.get());
