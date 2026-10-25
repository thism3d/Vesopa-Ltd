/// What must reach the back office even if the wifi drops: finished sales and
/// kitchen tickets. Kept on the phone (shared_preferences) until the server
/// takes them, and sent again with the same id, which both endpoints treat as
/// the same thing (a sale twice is one sale; a ticket twice is one ticket).
///
/// Card payments are never queued: a tap needs Dojo there and then, and the
/// app says so rather than pretending.
library;

import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

class Outbox {
  Outbox(this.api);
  final TapApi api;

  static const _key = 'vesopa_tap_outbox';
  bool _busy = false;

  Future<List<Map<String, dynamic>>> _read() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key);
      if (raw == null) return [];
      return [for (final e in jsonDecode(raw) as List) Map<String, dynamic>.from(e as Map)];
    } catch (_) {
      return [];
    }
  }

  Future<void> _write(List<Map<String, dynamic>> items) async {
    try {
      await (await SharedPreferences.getInstance()).setString(_key, jsonEncode(items));
    } catch (_) {
      // no storage (tests, a full phone): the item is still sent once now
    }
  }

  /// How many are waiting.
  Future<int> pending() async => (await _read()).length;

  /// Queue [body] for [path] and try to send everything.
  Future<void> add(String path, Map<String, Object?> body) async {
    final items = await _read()..add({'path': path, 'body': body, 'at': DateTime.now().toIso8601String()});
    await _write(items);
    await flush();
  }

  /// Send what is waiting, oldest first; stop at the first that cannot go.
  Future<void> flush() async {
    if (_busy) return;
    _busy = true;
    try {
      final items = await _read();
      while (items.isNotEmpty) {
        final item = items.first;
        try {
          await api.post(item['path'] as String, Map<String, Object?>.from(item['body'] as Map));
        } on TapApiError catch (e) {
          // 409 duplicate: the server already has it. Other 4xx: it never will.
          if (e.status == 0 || e.status >= 500) break;
        }
        items.removeAt(0);
        await _write(items);
      }
    } finally {
      _busy = false;
    }
  }
}
