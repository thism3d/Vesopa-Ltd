import 'dart:convert';

import 'package:http/http.dart' as http;

/// How the terminal behaves *between* sales: the idle screen it drops to, and
/// how long it waits before signing the current member of staff off.
///
/// Held separately from [Branding] — which is what the venue prints *around* a
/// sale — because the two change on different clocks and for different reasons.
/// A venue swapping its idle picture should not be rewriting the row its VAT
/// number lives on.
class TillSettings {
  const TillSettings({
    this.idleEnabled = true,
    this.idleImageUrl,
    this.idleAfterSale = true,
    this.idleRequirePin = true,
    this.idleMessage = 'Touch to begin',
    this.signoffSeconds = 180,
  });

  final bool idleEnabled;

  /// Server-relative path of the background, or null for the built-in branded
  /// screen. Resolved against the API base at display time.
  final String? idleImageUrl;

  /// Drop to the idle screen the moment a sale completes, not only after the
  /// inactivity timer has run down.
  final bool idleAfterSale;

  /// Whether coming back in needs a PIN. A venue can turn this off for a fast
  /// counter, where one PIN entry per customer costs more than the attribution
  /// is worth — the idle screen then clears on any touch.
  final bool idleRequirePin;

  final String idleMessage;

  /// Seconds of no touching before the signed-on member of staff is signed off.
  /// 0 disables it.
  final int signoffSeconds;

  bool get autoSignOff => signoffSeconds > 0;

  Duration get signoffAfter => Duration(seconds: signoffSeconds);

  static const defaults = TillSettings();

  // The server sends MySQL TINYINT(1) for the switches, which arrives as 0/1
  // rather than a bool.
  static bool _flag(Object? v) => v == 1 || v == true || v == '1';

  factory TillSettings.fromJson(Map<String, dynamic> j) {
    final url = (j['idle_image_url'] as String?)?.trim();
    return TillSettings(
      idleEnabled: _flag(j['idle_enabled']),
      idleImageUrl: url == null || url.isEmpty ? null : url,
      idleAfterSale: _flag(j['idle_after_sale']),
      idleRequirePin: _flag(j['idle_require_pin']),
      idleMessage: j['idle_message'] as String? ?? 'Touch to begin',
      // Clamped here as well as on the server: a terminal must not lock itself
      // every five seconds because a bad row reached the database by some other
      // route. 0 stays 0 — that is "switched off", not a mistake.
      signoffSeconds: switch ((j['signoff_seconds'] as num?)?.toInt() ?? 180) {
        <= 0 => 0,
        final n when n < 20 => 20,
        final n when n > 3600 => 3600,
        final n => n,
      },
    );
  }
}

/// Fetches the till's behaviour settings, falling back to sensible defaults.
///
/// Cached for the same reason branding is: the idle screen has to be able to
/// appear on a terminal that cannot reach the server, and "no network" must
/// never mean "no lock".
class TillSettingsRepository {
  TillSettingsRepository({
    required this.apiBase,
    required this.office,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String office;
  final http.Client _client;

  TillSettings? _cached;
  TillSettings? get cached => _cached;

  Future<TillSettings> load({
    Duration timeout = const Duration(seconds: 6),
  }) async {
    try {
      final uri = Uri.parse(
        '$apiBase/api/till-settings/public'
        '?office=${Uri.encodeComponent(office)}',
      );
      final res = await _client.get(uri).timeout(timeout);
      if (res.statusCode != 200) return _cached ?? TillSettings.defaults;

      final settings =
          TillSettings.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
      _cached = settings;
      return settings;
    } catch (_) {
      // Offline, slow, or malformed: keep whatever was working.
      return _cached ?? TillSettings.defaults;
    }
  }
}
