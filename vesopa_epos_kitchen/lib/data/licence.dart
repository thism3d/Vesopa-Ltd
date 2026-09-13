import 'dart:convert';

import 'package:http/http.dart' as http;

/// What this venue is entitled to, as this device sees it.
///
/// ONE FILE, FOUR APPS. The till, the kitchen screen, the display and the kiosk
/// all ask the same server question with their own credential and show the same
/// four facts. Written to take the address and the token as arguments and to
/// import nothing app-specific, so the copies cannot drift into four slightly
/// different ideas of what "expired" means.
///
/// THE SERVER DECIDES WHETHER IT IS LOCKED, not this. A device that worked out
/// its own lock would be a device that could be argued out of it by changing the
/// clock, and four apps would each get the boundary subtly wrong. All this does
/// is carry the answer.
class LicenceState {
  const LicenceState({
    required this.label,
    required this.locked,
    this.status,
    this.endsAt,
    this.renewBy,
    this.limit,
    this.keyPrefix,
    this.keyLabel,
    this.device,
  });

  /// What this product is called, from the server, so the wording is the same
  /// here as on the back office screen a manager is reading down the phone.
  final String label;

  /// This product will not run. Shown instead of the app, not beside it.
  final bool locked;

  /// `active`, `expired`, `cancelled`, or null where the venue has no
  /// subscription for this product — which is most of them, and is not a fault.
  final String? status;

  /// When the subscription ended, where it has.
  final DateTime? endsAt;

  /// The last day this still works. Set only while a lapsed subscription is
  /// inside its grace — so its presence IS the warning.
  final DateTime? renewBy;

  /// How many of this product the venue may run, or null for no limit.
  final int? limit;

  /// The first part of the licence key, for telling two apart.
  ///
  /// Never the whole key. It is shown once when issued and stored hashed; a
  /// settings page that could display it would turn every screen in a venue
  /// into somewhere to read one off.
  final String? keyPrefix;

  /// What somebody called the key: "Bar till", "Kitchen - pass".
  final String? keyLabel;

  /// The machine the key is registered to.
  final String? device;

  bool get hasSubscription => status != null;
  bool get lapsing => renewBy != null;

  static DateTime? _date(Object? raw) {
    if (raw is! String || raw.isEmpty) return null;
    return DateTime.tryParse(raw);
  }

  factory LicenceState.fromJson(Map<String, dynamic> j) {
    final key = j['key'] as Map<String, dynamic>?;
    return LicenceState(
      label: (j['label'] as String?) ?? 'This app',
      locked: j['locked'] == true,
      status: j['status'] as String?,
      endsAt: _date(j['endsAt']),
      renewBy: _date(j['renewBy']),
      limit: (j['limit'] as num?)?.toInt(),
      keyPrefix: key?['prefix'] as String?,
      keyLabel: key?['label'] as String?,
      device: j['device'] as String?,
    );
  }
}

/// Ask the back office about this device's licence.
///
/// Null on anything that goes wrong — no network, a server too old to answer,
/// a credential it will not accept. Every caller treats null as "carry on":
/// a licence lookup failing must never be why a venue cannot trade, and that
/// rule runs through every layer of this on the server too.
Future<LicenceState?> fetchLicence({
  required String apiBase,
  required String token,
}) async {
  if (token.isEmpty) return null;
  try {
    final res = await http
        .get(
          Uri.parse('$apiBase/api/licence/state'),
          headers: {'Authorization': 'Bearer $token'},
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) return null;
    return LicenceState.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
  } catch (_) {
    return null;
  }
}
