import 'dart:async';

import 'api.dart';

/// What the member pressed, sent to the server for the activity log.
///
/// So that "it didn't work when I pressed Add" can be matched to exactly what
/// happened: every tap and screen is recorded with its name, and sent in small
/// batches. NEVER WHAT WAS TYPED -- a button's name, a screen's name, and at
/// most a plate the member has just added (which the server logs anyway).
///
/// Logging never gets in the member's way: a batch that cannot be sent is
/// kept for the next one, and the queue is capped so a device offline all day
/// does not fill up.
class ActivityLog {
  ActivityLog(this._api);

  final MetricApi _api;
  final List<Map<String, dynamic>> _queue = [];
  Timer? _timer;
  bool _sending = false;
  String _screen = '';

  static const _max = 200;

  void screen(String name) {
    _screen = name;
    _add('screen', name);
  }

  void tap(String name, [Map<String, dynamic>? data]) => _add('tap', name, data);

  void event(String name, [Map<String, dynamic>? data]) => _add('event', name, data);

  void _add(String type, String name, [Map<String, dynamic>? data]) {
    _queue.add({
      'type': type,
      'name': name,
      'screen': _screen,
      'at': DateTime.now().toUtc().toIso8601String(),
      'app': AppConfig.appLabel,
      'data': ?data,
    });
    if (_queue.length > _max) _queue.removeRange(0, _queue.length - _max);
    _timer ??= Timer(const Duration(seconds: 5), flush);
  }

  Future<void> flush() async {
    _timer?.cancel();
    _timer = null;
    if (_sending || _queue.isEmpty || _api.token == null) return;
    _sending = true;
    final batch = _queue.take(50).toList();
    try {
      await _api.log(batch);
      _queue.removeRange(0, batch.length);
    } catch (_) {
      // Kept for the next batch.
    } finally {
      _sending = false;
    }
    if (_queue.isNotEmpty) _timer ??= Timer(const Duration(seconds: 30), flush);
  }

  void dispose() => _timer?.cancel();
}
