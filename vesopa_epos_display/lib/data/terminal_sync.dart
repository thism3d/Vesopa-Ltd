import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'pairing.dart' show displayDeviceId;

/// This terminal's own settings, kept in the back office.
///
/// Nicky, 2026-11-04: "each terminal all the settings are saved to the back
/// office so we never lose the settings". Until now they lived only in this
/// machine's preferences, so a reinstall lost the printers.
///
/// RESTORED BEFORE ANYTHING READS THEM
///
/// [restore] runs in `main`, before the first provider, so the app starts on
/// the back office's values rather than changing under somebody's hands. It
/// gives up after a few seconds: a till with no signal starts on what it has.
///
/// THE BACK OFFICE WINS
///
/// A value changed there overwrites this machine, and a push from here can
/// never undo it (the server holds back anything changed since [_revKey], see
/// mergeValues in src/terminal_licences.js). The till sends only what differs
/// from what it last sent, so a quiet till sends nothing.
///
/// NOTHING SECRET LEAVES THE MACHINE
///
/// These rows are shown on a page and copied between terminals, so a field
/// whose name looks like a credential is never sent. It stays here, and a
/// restored setting is merged into what is here rather than replacing it.

/// The preferences that belong to this terminal, and where a page shows them.
///
/// Not everything in preferences: caches, queues and money in flight are not
/// settings, and restoring an old queue would send a sale twice.
const Map<String, String> terminalSettings = {
  'display.advert_folder': 'Display',
  'display.advert_volume': 'Display',
  'display.bill_on_right': 'Display',
  'display.bill_share': 'Display',
  'display.child_lock': 'Display',
  'display.customer_qr': 'Display',
  'display.customer_qr_caption': 'Display',
  'display.dwell_seconds': 'Display',
  'display.fill_screen': 'Display',
  'display.fill_screen_video': 'Display',
  'display.full_screen': 'Display',
  'display.idle_seconds': 'Display',
  'display.notifications': 'Display',
  'display.sale_advert_folder': 'Display',
  'display.sale_adverts_same': 'Display',
  'display.screen_key': 'Display',
  'display.screen_size': 'Display',
  'display.show_prices': 'Display',
  'display.special_text': 'Display',
  'display.special_title': 'Display',
  'display.standing_message': 'Display',
  'display.status_hide_seconds': 'Display',
  'display.thank_you': 'Display',
  'display.thank_you_seconds': 'Display',
  'display.tile_place': 'Display',
  'display.tiles': 'Display',
  'display.touch': 'Display',
  'display.welcome_text': 'Display',
  'display.zoom': 'Display',
  'vesopa_lan_manual': 'LocalLink',
};

/// A stored JSON object where only some fields are settings. Everything else in
/// it stays on the machine.
const Map<String, Set<String>> terminalFields = {};

const _revKey = 'terminal_settings_rev';
const _sentKey = 'terminal_settings_sent';

/// Between a JSON setting's key and its field, in a row's name.
const _field = '#';

final _secret = RegExp(r'key|secret|token|password|pin\b', caseSensitive: false);

/// One setting as the back office stores it.
class TerminalSetting {
  const TerminalSetting(this.category, this.name, this.value);
  final String category;
  final String name;
  final Object? value;

  Map<String, Object?> toJson() => {'category': category, 'name': name, 'value': value};
}

/// Preferences as rows. A JSON object becomes one row per field, which is what
/// lets one printer assignment be edited and copied on its own.
List<TerminalSetting> settingsFrom(Map<String, Object?> stored) {
  final out = <TerminalSetting>[];
  for (final entry in terminalSettings.entries) {
    final value = stored[entry.key];
    if (value == null) continue;
    final decoded = value is String ? _objectIn(value) : null;
    if (decoded == null) {
      out.add(TerminalSetting(entry.value, entry.key, value));
      continue;
    }
    final only = terminalFields[entry.key];
    decoded.forEach((field, fieldValue) {
      if (_secret.hasMatch(field)) return;
      if (only != null && !only.contains(field)) return;
      out.add(TerminalSetting(entry.value, '${entry.key}$_field$field', fieldValue));
    });
  }
  return out;
}

Map<String, dynamic>? _objectIn(String text) {
  if (!text.trimLeft().startsWith('{')) return null;
  try {
    final decoded = jsonDecode(text);
    return decoded is Map<String, dynamic> ? decoded : null;
  } catch (_) {
    return null;
  }
}

/// What to write to preferences for rows from the back office.
///
/// Fields go into what is stored, so a secret kept here survives. Anything not
/// in [terminalSettings] is ignored, so a row can never write a queue or a
/// session even if one reached the back office somehow.
Map<String, Object> preferencesFrom(
  List<TerminalSetting> rows,
  Map<String, Object?> stored,
) {
  final out = <String, Object>{};
  final objects = <String, Map<String, dynamic>>{};
  for (final row in rows) {
    final at = row.name.indexOf(_field);
    final key = at < 0 ? row.name : row.name.substring(0, at);
    if (!terminalSettings.containsKey(key)) continue;
    if (at < 0) {
      if (row.value != null) out[key] = row.value!;
      continue;
    }
    final field = row.name.substring(at + 1);
    if (_secret.hasMatch(field)) continue;
    final current = stored[key];
    final object = objects[key] ??=
        (current is String ? _objectIn(current) : null) ?? <String, dynamic>{};
    object[field] = row.value;
  }
  objects.forEach((key, object) => out[key] = jsonEncode(object));
  return out;
}

/// Rows that differ from what was last sent, as name -> encoded value.
List<TerminalSetting> changedSince(
  List<TerminalSetting> rows,
  Map<String, dynamic> sent,
) => [for (final r in rows) if (sent[r.name] != jsonEncode(r.value)) r];

Map<String, Object?> _read(SharedPreferences prefs) => {
  for (final key in terminalSettings.keys) key: prefs.get(key),
};

Future<void> _write(SharedPreferences prefs, Map<String, Object> values) async {
  for (final entry in values.entries) {
    final value = entry.value;
    switch (value) {
      case bool():
        await prefs.setBool(entry.key, value);
      case int():
        await prefs.setInt(entry.key, value);
      case double():
        await prefs.setDouble(entry.key, value);
      case String():
        await prefs.setString(entry.key, value);
      case List():
        await prefs.setStringList(entry.key, value.map((e) => '$e').toList());
    }
  }
}

Future<String?> _deviceToken(SharedPreferences prefs) async {
  return prefs.getString('display.vesopa_token');
}

/// Take the back office's values for this terminal. Never throws: a till that
/// cannot reach the server starts on what it has.
Future<void> restoreTerminalSettings({
  required String apiBase,
  required String version,
  String kind = 'display',
  http.Client? client,
}) async {
  final http_ = client ?? http.Client();
  try {
    final prefs = await SharedPreferences.getInstance();
    final token = await _deviceToken(prefs);
    if (token == null) return;
    final uri = Uri.parse('$apiBase/api/device/terminal').replace(queryParameters: {
      'device_id': await displayDeviceId(),
      'kind': kind,
      'version': version,
      'applied_rev': '${prefs.getInt(_revKey) ?? 0}',
    });
    final res = await http_
        .get(uri, headers: {'Authorization': 'Bearer $token'})
        .timeout(const Duration(seconds: 4));
    if (res.statusCode != 200) return;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final rev = (body['rev'] as num?)?.toInt() ?? 0;
    if (rev <= (prefs.getInt(_revKey) ?? 0)) return;

    final rows = [
      for (final row in body['settings'] as List<dynamic>? ?? const [])
        TerminalSetting(
          (row as Map<String, dynamic>)['category'] as String,
          row['name'] as String,
          row['value'],
        ),
    ];
    await _write(prefs, preferencesFrom(rows, _read(prefs)));
    await prefs.setInt(_revKey, rev);
    await prefs.setString(
      _sentKey,
      jsonEncode({for (final r in rows) r.name: jsonEncode(r.value)}),
    );
  } catch (_) {
    // Offline, or the server has not got this yet. Start on what is here.
  } finally {
    if (client == null) http_.close();
  }
}

/// Send what changed on this machine. Also how a till that is already open
/// fills in its row the first time.
Future<void> pushTerminalSettings({
  required String apiBase,
  String kind = 'display',
  http.Client? client,
}) async {
  final http_ = client ?? http.Client();
  try {
    final prefs = await SharedPreferences.getInstance();
    final token = await _deviceToken(prefs);
    if (token == null) return;
    final raw = prefs.getString(_sentKey);
    final sent = raw == null ? <String, dynamic>{} : jsonDecode(raw) as Map<String, dynamic>;
    final rows = changedSince(settingsFrom(_read(prefs)), sent);
    if (rows.isEmpty) return;

    final res = await http_
        .put(
          Uri.parse('$apiBase/api/device/terminal/settings'),
          headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
          body: jsonEncode({
            'device_id': await displayDeviceId(),
            'kind': kind,
            'base_rev': prefs.getInt(_revKey) ?? 0,
            'values': [for (final r in rows) r.toJson()],
          }),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) return;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final held = {
      for (final h in body['held'] as List<dynamic>? ?? const [])
        (h as Map<String, dynamic>)['name'] as String,
    };
    for (final r in rows) {
      if (!held.contains(r.name)) sent[r.name] = jsonEncode(r.value);
    }
    await prefs.setString(_sentKey, jsonEncode(sent));
    // With nothing held back this machine has everything the server has. With
    // something held, the revision stays behind so the next start fetches it.
    if (held.isEmpty) await prefs.setInt(_revKey, (body['rev'] as num?)?.toInt() ?? 0);
  } catch (_) {
    // Tried again on the next round.
  } finally {
    if (client == null) http_.close();
  }
}

Timer? _pushTimer;

/// Send changes now and every few minutes. Safe to call twice.
void startTerminalSettingsPush({required String apiBase, String kind = 'display'}) {
  _pushTimer?.cancel();
  unawaited(pushTerminalSettings(apiBase: apiBase, kind: kind));
  _pushTimer = Timer.periodic(
    const Duration(minutes: 5),
    (_) => pushTerminalSettings(apiBase: apiBase, kind: kind),
  );
}
