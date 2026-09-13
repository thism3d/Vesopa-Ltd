import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'hardware_fingerprint.dart';
import 'pairing.dart' show displayDeviceId, displayDeviceName;
import 'vesopa_sso.dart';

/// Signing this display in with Vesopa, before it is paired with a till.
///
/// WHY A DISPLAY SIGNS IN AT ALL
///
/// It never used to. A display was paired by a till and had no credential of its
/// own, which is exactly why it could not be counted: a venue paying for one
/// could run six, and the display subscription was the one product whose screens
/// carried on working while it sat expired.
///
/// So the first screen is **Continue with Vesopa**. The venue's display licence
/// is checked, this screen takes one of them, and then the ordinary pairing with
/// a till happens as it always did. Pairing is not replaced — it is preceded.
///
/// EVERYTHING HERE FAILS SOFT
///
/// A server too old to offer this, a venue with no licence limit, no network at
/// all: every one of them leaves the display doing what it did before. A screen
/// that would not start because a licence service was unreachable would be a far
/// worse fault than a screen that went uncounted.
class VesopaOption {
  const VesopaOption({required this.enabled, required this.issuer, required this.clientId});

  final bool enabled;
  final String issuer;
  final String clientId;

  static const off = VesopaOption(enabled: false, issuer: '', clientId: '');
}

/// The display's own commissioning, kept between runs.
class DisplayCommission {
  const DisplayCommission({required this.token, required this.office, this.venue, this.licensed = false});

  final String token;

  /// The venue this screen belongs to — the tenancy key everything is scoped by.
  final String office;
  final String? venue;

  /// Whether a licence seat was actually taken. False where the venue has no
  /// limit set, which is most of them, and is not a failure.
  final bool licensed;
}

const _keyToken = 'display.vesopa_token';
const _keyOffice = 'display.vesopa_office';
const _keyVenue = 'display.vesopa_venue';

/// What this server allows. Answers "off" for anything it cannot work out, so a
/// display against an older back office simply shows its pairing screen.
Future<VesopaOption> fetchOption(String apiBase) async {
  try {
    final res = await http
        .get(Uri.parse('$apiBase/api/display/vesopa/enabled'))
        .timeout(const Duration(seconds: 8));
    if (res.statusCode != 200) return VesopaOption.off;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final clientId = (body['clientId'] as String?) ?? '';
    return VesopaOption(
      enabled: body['enabled'] == true && clientId.isNotEmpty,
      issuer: (body['issuer'] as String?) ?? '',
      clientId: clientId,
    );
  } catch (_) {
    return VesopaOption.off;
  }
}

/// Read back what this screen was commissioned as, or null if it never was.
Future<DisplayCommission?> readCommission() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_keyToken);
    final office = prefs.getString(_keyOffice);
    if (token == null || office == null || token.isEmpty || office.isEmpty) return null;
    return DisplayCommission(
      token: token,
      office: office,
      venue: prefs.getString(_keyVenue),
      licensed: true,
    );
  } catch (_) {
    return null;
  }
}

Future<void> forgetCommission() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keyToken);
    await prefs.remove(_keyOffice);
    await prefs.remove(_keyVenue);
  } catch (_) {
    // A screen that cannot forget is still a screen that works.
  }
}

/// Refused because the venue has no licence left. Carries what to tell somebody.
class DisplayLicenceFull implements Exception {
  DisplayLicenceFull(this.message);
  final String message;
  @override
  String toString() => message;
}

class DisplaySetupFailed implements Exception {
  DisplaySetupFailed(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Sign in with Vesopa, claim a display licence, and remember the result.
///
/// Throws [DisplayLicenceFull] when the venue's displays are all in use — which
/// on a display should almost never happen, because the server bounces the
/// screen that has been connected longest rather than refusing this one. It is
/// handled anyway: a venue whose limit is zero, because the subscription lapsed,
/// has no oldest screen to bounce.
Future<DisplayCommission> commission({
  required String apiBase,
  required VesopaOption option,
  void Function(Uri url)? onUrl,
}) async {
  if (!option.enabled) {
    throw DisplaySetupFailed('Vesopa sign-in is not switched on for this venue.');
  }

  final idToken = await VesopaSso(issuer: option.issuer, clientId: option.clientId)
      .authorize(onUrl: onUrl);

  String? fingerprint;
  try {
    fingerprint = await HardwareFingerprint.get();
  } catch (_) {
    // A screen that cannot identify its hardware is still licensed, just not
    // bound to a machine. Never a reason to stop.
  }

  final http.Response res;
  try {
    res = await http
        .post(
          Uri.parse('$apiBase/api/display/vesopa/commission'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'id_token': idToken,
            'device_id': await displayDeviceId(),
            'device_name': await displayDeviceName(),
            'device_fingerprint': ?fingerprint,
          }),
        )
        .timeout(const Duration(seconds: 20));
  } catch (_) {
    throw DisplaySetupFailed('Could not reach the back office. Check the network and try again.');
  }

  final body = jsonDecode(res.body) as Map<String, dynamic>;
  if (res.statusCode == 409) {
    throw DisplayLicenceFull(
      (body['error'] as String?) ?? 'Every display licence for this venue is in use.',
    );
  }
  if (res.statusCode != 200) {
    throw DisplaySetupFailed((body['error'] as String?) ?? 'That sign-in could not be accepted.');
  }

  final token = body['token'] as String?;
  final office = body['office'] as String?;
  if (token == null || office == null) {
    throw DisplaySetupFailed('The back office did not finish setting this screen up.');
  }

  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyToken, token);
    await prefs.setString(_keyOffice, office);
    final venue = body['venue'] as String?;
    if (venue != null) await prefs.setString(_keyVenue, venue);
  } catch (_) {
    // Not fatal: the screen is commissioned, it will simply ask again next time.
  }

  return DisplayCommission(
    token: token,
    office: office,
    venue: body['venue'] as String?,
    licensed: body['seat'] == true,
  );
}

/// What this screen is commissioned as, for the app to decide its first page.
final commissionProvider = FutureProvider<DisplayCommission?>((ref) => readCommission());
