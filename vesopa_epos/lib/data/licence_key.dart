import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The licence key this machine was commissioned with.
///
/// Vesopa issues a key per paid device. The first machine to present one claims
/// it, and it is thereafter bound to that machine's hardware fingerprint — so a
/// venue that copies the install to a second PC finds the second one refused,
/// which is the point of issuing keys at all.
///
/// OPTIONAL, ON PURPOSE
///
/// Most venues are counted and trusted: the back office knows how many tills
/// they pay for and refuses the one over. Keys are for venues where that is not
/// enough. A till with no key signs in exactly as it always did, so this must
/// never become a box somebody has to fill in before they can open.
///
/// KEPT, SO IT IS TYPED ONCE
///
/// Stored on the machine after a successful sign-in. A till signed in again —
/// after an update, or because a manager signed it out — sends the same key
/// without anybody being asked for it again. It is not a secret worth
/// protecting harder than this: on its own it is useless on any other machine.
const _key = 'licence_key';

/// The stored key, or null where this till has none.
Future<String?> readLicenceKey() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final value = prefs.getString(_key)?.trim();
    return (value == null || value.isEmpty) ? null : value;
  } catch (_) {
    // Settings unreadable. A till with no licence key still signs in.
    return null;
  }
}

/// Remember a key, or forget it when [value] is null or blank.
Future<void> writeLicenceKey(String? value) async {
  final clean = value?.trim();
  try {
    final prefs = await SharedPreferences.getInstance();
    if (clean == null || clean.isEmpty) {
      await prefs.remove(_key);
    } else {
      await prefs.setString(_key, clean.toUpperCase());
    }
  } catch (_) {
    // Not fatal: the key was accepted, it simply has to be typed again next
    // time. Refusing the sign-in over it would be the wrong trade.
  }
}

/// What this till holds, for the Settings page that shows and changes it.
final licenceKeyProvider = FutureProvider<String?>((ref) => readLicenceKey());
