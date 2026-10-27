/// Who is holding the phone, by one of three ways in. All three check against
/// the venue's own staff list from the back office (/api/till/staff), the
/// same PIN and the same staff card as on every till, so there is one list of
/// staff to keep and a leaver is gone from every till and phone at once.
///
///   PIN          4-6 digits, the till's own
///   staff card   an NFC card or fob tapped on the phone; its id is the
///                `swipe_card` set in the back office
///   Face ID /    on a phone that is one person's own: the last clerk on it
///   fingerprint  comes back without typing, and only them
library;

import 'package:local_auth/local_auth.dart';

import 'models.dart';

class ClerkAuth {
  ClerkAuth({LocalAuthentication? local}) : _local = local ?? LocalAuthentication();
  final LocalAuthentication _local;

  /// The clerk whose PIN this is. The back office refuses two people the same
  /// PIN, so a PIN is a lookup, never a guess.
  static Clerk? byPin(List<Clerk> staff, String pin) {
    if (pin.length < 4) return null;
    for (final c in staff) {
      if (c.pin.isNotEmpty && c.pin == pin) return c;
    }
    return null;
  }

  /// The clerk whose staff card this is. Ids are compared as upper-case hex
  /// with any separators taken out ("04:a1:b2" == "04A1B2").
  static Clerk? byCard(List<Clerk> staff, String cardId) {
    final want = normaliseCard(cardId);
    if (want.isEmpty) return null;
    for (final c in staff) {
      if (c.card.isNotEmpty && normaliseCard(c.card) == want) return c;
    }
    return null;
  }

  static String normaliseCard(String raw) => raw.toUpperCase().replaceAll(RegExp('[^0-9A-F]'), '');

  /// Whether this phone can do Face ID / Touch ID / fingerprint at all.
  Future<bool> biometricsAvailable() async {
    try {
      return await _local.isDeviceSupported() && await _local.canCheckBiometrics;
    } catch (_) {
      return false;
    }
  }

  /// Face ID or fingerprint for [clerk], who last used this phone.
  Future<bool> unlockWithBiometrics(Clerk clerk) async {
    try {
      return await _local.authenticate(
        localizedReason: 'Sign in to Vesopa Go as ${clerk.name}',
        biometricOnly: true,
        persistAcrossBackgrounding: true,
      );
    } catch (_) {
      return false;
    }
  }
}
