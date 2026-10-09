import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../main.dart';
import 'dojo_config.dart';

/// Card settings from the venue's back office (vesopaepos.com/admin › Card
/// payments), so a venue sets its Dojo key, environment and reseller id once
/// and every till picks them up.
///
/// The back office wins when it changes: each time its `updated_at` moves,
/// the till takes the office's values. Between changes, a till may still be
/// edited by hand in Settings (a manager trying a different machine), and that
/// stays until the office saves again. The card machine is per till, so the
/// office's machine only fills a till that has none.
///
/// The key comes over the terminal's own token, never the public routes.
final dojoOfficeSyncProvider = Provider<void>((ref) {
  final token = ref.watch(sessionProvider).terminalToken;
  final apiBase = ref.watch(apiBaseProvider);
  if (token == null || token.isEmpty) return;

  Future<void> pull() async {
    try {
      final res = await http
          .get(
            Uri.parse('$apiBase/api/till/dojo-settings'),
            headers: {'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 12));
      if (res.statusCode != 200) return;
      final office = jsonDecode(res.body) as Map<String, dynamic>;
      await applyOfficeDojo(ref, office);
    } catch (_) {
      // Offline: the till keeps what it has.
    }
  }

  unawaited(pull());
  ref.listen(syncEventsProvider, (_, next) {
    final type = next.value?.type;
    if (type == 'dojo-settings' || type == 'till-settings') unawaited(pull());
  });
});

const _appliedKey = 'dojo_office_applied_at';

/// Apply the office's card settings to this till, once per office change.
Future<void> applyOfficeDojo(Ref ref, Map<String, dynamic> office) async {
  if (office['configured'] != true) return;
  final key = '${office['api_key'] ?? ''}'.trim();
  if (key.isEmpty) return;

  final stamp = '${office['updated_at'] ?? ''}';
  final prefs = await SharedPreferences.getInstance();
  if (stamp.isNotEmpty && prefs.getString(_appliedKey) == stamp) return;

  final current = await ref
      .read(dojoConfigProvider.future)
      .catchError((_) => const DojoConfig());
  final sandbox =
      key.startsWith('sk_sandbox_') || office['environment'] == 'sandbox';
  final officeTerminal = '${office['terminal_id'] ?? ''}'.trim();
  final next = current.copyWith(
    platform: CardPlatform.dojo,
    baseUrl: DojoConfig.dojoBaseUrl,
    apiKey: key,
    sandbox: sandbox,
    resellerId: '${office['reseller_id'] ?? ''}'.trim(),
    softwareHouseId: DojoConfig.lockedSoftwareHouseId,
    resultSeconds: DojoConfig.cleanResultSeconds(office['result_seconds'] ?? 5),
    // A machine on this till stays; the office's only fills an empty one.
    terminalId:
        current.terminalId.trim().isEmpty && current.apiKey.trim() == key
        ? officeTerminal
        : (current.apiKey.trim() == key ? current.terminalId : officeTerminal),
    fromOffice: true,
  );
  await ref.read(dojoConfigProvider.notifier).save(next);
  await prefs.setString(_appliedKey, stamp);
}
