/// Which of the venue's terminals this till is.
///
/// Nicky, 2026-11-18: "Can we get terminal name and terminal number on the X
/// and Z reports. Can we when we sign in to a new terminal ... ask which
/// terminal number this till is. The way we currently do it, if a till dies or
/// breaks it will be listed by its PC name and new terminal which is incorrect
/// and needs to report under the terminal it's replacing."
///
/// So after a sign-in the till lists the venue's terminals (Terminal 1 · Bar,
/// Terminal 2 · Lounge, each with the PC it was last on) and a new one. Picking
/// one makes this machine that terminal in the back office: it takes the
/// number and the name, the broken machine's licence seat is given back, and
/// the terminal's saved settings (printers and the rest) come down to this
/// machine. The till then calls itself by that name, so its sales, X and Z
/// carry on under the terminal it replaced (src/terminal_licences.js, claim).
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'terminal_identity.dart';
import 'terminal_sync.dart';

const _numberKey = 'terminal_number';

/// One of the venue's tills, as the back office knows it.
class VenueTerminal {
  const VenueTerminal({
    required this.number,
    this.name,
    this.deviceName,
    this.lastSeen,
    this.mine = false,
  });

  factory VenueTerminal.fromJson(Map<String, dynamic> j) => VenueTerminal(
    number: (j['number'] as num).toInt(),
    name: (j['name'] as String?)?.trim().isEmpty ?? true
        ? null
        : (j['name'] as String).trim(),
    deviceName: j['device_name'] as String?,
    lastSeen: DateTime.tryParse('${j['last_ping_at'] ?? ''}')?.toLocal(),
    mine: j['mine'] == true,
  );

  final int number;
  final String? name;

  /// The PC it was last on.
  final String? deviceName;
  final DateTime? lastSeen;

  /// This machine already is it.
  final bool mine;

  String get label => terminalLabel(number, name);
}

/// "Terminal 2 · Lounge", or "Terminal 2" with no name.
String terminalLabel(int number, String? name) =>
    (name == null || name.trim().isEmpty || name.trim() == 'Terminal $number')
        ? 'Terminal $number'
        : 'Terminal $number · ${name.trim()}';

/// The number this till has been given, or null before it is asked.
class TerminalNumber extends AsyncNotifier<int?> {
  @override
  Future<int?> build() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getInt(_numberKey);
  }

  /// Remember the number, and call the till by the terminal's name so its
  /// sales report under it. An unnamed terminal is "Terminal 2".
  Future<void> adopt(int number, String? name) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_numberKey, number);
    state = AsyncData(number);
    final clean = name?.trim() ?? '';
    await ref
        .read(terminalIdentityProvider.notifier)
        .set(clean.isEmpty ? 'Terminal $number' : clean);
  }
}

final terminalNumberProvider = AsyncNotifierProvider<TerminalNumber, int?>(
  TerminalNumber.new,
);

/// "Terminal 2 · Lounge" for the X and Z, or the till's own name until it has
/// a number.
final terminalTitleProvider = Provider<String>((ref) {
  final number = ref.watch(terminalNumberProvider).value;
  final name = ref.watch(terminalNameProvider);
  return number == null ? name : terminalLabel(number, name);
});

class TerminalClaimFailed implements Exception {
  TerminalClaimFailed(this.message, {this.busy = false});
  final String message;

  /// The terminal is still in use on another machine: ask before taking it.
  final bool busy;
  @override
  String toString() => message;
}

Future<String?> _token() async {
  final prefs = await SharedPreferences.getInstance();
  final raw = prefs.getString('session');
  if (raw == null) return null;
  try {
    return (jsonDecode(raw) as Map<String, dynamic>)['terminalToken'] as String?;
  } catch (_) {
    return null;
  }
}

/// The venue's tills, from the back office. Empty when it cannot be reached.
Future<List<VenueTerminal>> venueTerminals(String apiBase, {http.Client? client}) async {
  final token = await _token();
  if (token == null) return const [];
  final c = client ?? http.Client();
  try {
    final uri = Uri.parse('$apiBase/api/device/terminals').replace(
      queryParameters: {'kind': 'till', 'device_id': await terminalDeviceId()},
    );
    final res = await c
        .get(uri, headers: {'Authorization': 'Bearer $token'})
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) return const [];
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return [
      for (final t in body['terminals'] as List? ?? const [])
        VenueTerminal.fromJson(t as Map<String, dynamic>),
    ]..sort((a, b) => a.number.compareTo(b.number));
  } catch (_) {
    return const [];
  } finally {
    if (client == null) c.close();
  }
}

/// Make this machine terminal [number] (null: a new terminal), then adopt it.
Future<VenueTerminal> claimTerminal(
  WidgetRef ref, {
  required String apiBase,
  required String version,
  int? number,
  String? name,
  bool confirm = false,
  http.Client? client,
}) async {
  final token = await _token();
  if (token == null) {
    throw TerminalClaimFailed('This till is not signed in to a venue.');
  }
  final c = client ?? http.Client();
  final http.Response res;
  try {
    String? pc;
    try {
      pc = await ref.read(terminalIdentityProvider.future);
    } catch (_) {}
    res = await c
        .post(
          Uri.parse('$apiBase/api/device/terminal/claim'),
          headers: {
            'Authorization': 'Bearer $token',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'kind': 'till',
            'device_id': await terminalDeviceId(),
            'device_name': ?pc,
            'number': ?number,
            if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
            if (confirm) 'confirm': true,
          }),
        )
        .timeout(const Duration(seconds: 15));
  } catch (_) {
    throw TerminalClaimFailed('The back office could not be reached. Check the network and try again.');
  } finally {
    if (client == null) c.close();
  }
  final body = jsonDecode(res.body) as Map<String, dynamic>;
  if (res.statusCode == 409 && body['busy'] == true) {
    throw TerminalClaimFailed(body['error'] as String? ?? 'That terminal is in use.', busy: true);
  }
  if (res.statusCode != 200) {
    throw TerminalClaimFailed(body['error'] as String? ?? 'The back office refused that.');
  }
  final t = body['terminal'] as Map<String, dynamic>;
  final chosen = VenueTerminal(
    number: (t['number'] as num).toInt(),
    name: t['name'] as String?,
    deviceName: t['device_name'] as String?,
    mine: true,
  );
  await ref.read(terminalNumberProvider.notifier).adopt(chosen.number, chosen.name);
  // The terminal's own settings (its printers, its screens) come down to
  // this machine, as if it had never been away.
  await forgetTerminalRevision();
  await restoreTerminalSettings(apiBase: apiBase, version: version);
  return chosen;
}
