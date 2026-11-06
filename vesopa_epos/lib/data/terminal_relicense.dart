import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'session_controller.dart';
import 'terminal_identity.dart';

/// A till that has lost its session gets it back by itself.
///
/// Nicky, 2026-11-04: Pontardawe's lounge till logged the manager out and came
/// back with no printers. "The till needs to work 24/7 without asking customers
/// to log in." The hardware fingerprint survives what loses a session (a
/// damaged preferences file, a reinstall), and the back office knows which
/// terminal has it, so nobody has to type anything.
///
/// Only for a machine the back office already knows, and never one whose
/// licence was withdrawn: that till goes to the sign-in page as before. Nor one
/// somebody signed out on purpose ([signedOutKey]): a lost session and a
/// sign-out look the same from here, and only one should undo itself.

/// Set by a deliberate sign-out, cleared by the next sign-in.
const signedOutKey = 'terminal_signed_out';

/// The session the server's answer describes, or null if it is not one.
Session? sessionFromLicence(Map<String, dynamic> body) {
  final token = body['terminalToken'] as String?;
  final user = body['user'];
  if (token == null || user is! Map<String, dynamic>) return null;
  final office = user['officeEmail'] as String?;
  if (office == null) return null;
  return Session(
    name: user['name'] as String?,
    office: office,
    officeName: user['officeName'] as String?,
    token: body['token'] as String?,
    terminalToken: token,
  );
}

/// Never throws, and gives up quickly: a till with no signal goes to the page
/// it would have shown anyway.
Future<void> relicenseIfNeeded({
  required String apiBase,
  required String? fingerprint,
  required String version,
  http.Client? client,
}) async {
  if (fingerprint == null || fingerprint.isEmpty) return;
  final http_ = client ?? http.Client();
  try {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getString('session') != null || prefs.getBool(signedOutKey) == true) return;
    final res = await http_
        .post(
          Uri.parse('$apiBase/api/terminal/relicense'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'device_kind': 'till',
            'device_fingerprint': fingerprint,
            'device_id': await terminalDeviceId(),
            'app_version': version,
          }),
        )
        .timeout(const Duration(seconds: 5));
    if (res.statusCode != 200) return;
    final session = sessionFromLicence(jsonDecode(res.body) as Map<String, dynamic>);
    if (session != null) await prefs.setString('session', jsonEncode(session.toJson()));
  } catch (_) {
    // Offline, or a server without this yet.
  } finally {
    if (client == null) http_.close();
  }
}
