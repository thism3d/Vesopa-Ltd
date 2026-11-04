/// The Windows kitchen screen hashes its machine for its licence. A Go device
/// is licensed by its Go seat, so this answers null, which never refuses.
library;

class HardwareFingerprint {
  const HardwareFingerprint._();
  static Future<String?> get() async => null;
}
