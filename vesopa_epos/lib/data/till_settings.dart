import 'dart:convert';

import 'package:http/http.dart' as http;

import '../printing/print_targets.dart';

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
    this.changeWindowSeconds = 30,
    this.receiptAutoPrint = false,
    this.buttonsShowPrices = true,
    this.printerNames = const {},
    this.kitchenDelivery = const {},
    this.homeScreenId,
  });

  /// The programmed screen this venue's tills open on, or null.
  ///
  /// Null is not an absence of configuration — it is the venue's answer, and it
  /// means the built-in Default: the catalogue-driven grid the till has always
  /// drawn. So a venue that has programmed nothing, or has deleted everything
  /// it programmed, still gets a working sale screen. See
  /// docs/screen-programming.md §2.
  final int? homeScreenId;

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

  /// How long the change box stays up after a sale settles, before the till
  /// signs the staff member off and drops to the idle screen. 0 leaves it up
  /// until somebody taps it, which is how it behaved before this was settable.
  final int changeWindowSeconds;

  /// Print the customer's receipt automatically the moment a sale settles.
  ///
  /// The till no longer asks. Off means no paper at the counter — the clerk
  /// prints one on request from the Receipts screen or the Last Bill key,
  /// which is where a customer who changes their mind is served from anyway.
  final bool receiptAutoPrint;

  /// Whether product buttons carry their price.
  ///
  /// On by default. A venue whose prices change by the hour, or whose staff
  /// know the menu cold, gets a cleaner grid with it off.
  final bool buttonsShowPrices;

  /// What the venue calls each printer slot, keyed by station ("kp3").
  ///
  /// The hardware stays on the terminal — which USB device, which IP — because
  /// that is physical to a counter. The *naming* is venue-wide, so a station
  /// the kitchen calls "Fryer" reads "Fryer" on every till and in the back
  /// office, rather than "KP 3" in one place and "Fryer" in another.
  ///
  /// A slot with no name here is absent, and falls back to its built-in label.
  final Map<String, String> printerNames;

  /// Where each kitchen station's tickets come out, keyed by station ("kp3").
  ///
  /// A station that is absent from this map delivers to a printer, which is
  /// what every station did before kitchen screens existed and what every
  /// station keeps doing until somebody says otherwise in the back office.
  /// Only stations the venue has actually changed are carried, so the map is
  /// empty on the overwhelming majority of venues.
  final Map<String, KitchenDelivery> kitchenDelivery;

  /// Where [station]'s tickets come out. Printer unless told otherwise.
  KitchenDelivery deliveryFor(String station) =>
      kitchenDelivery[station] ?? KitchenDelivery.printer;

  /// Whether any station in this venue delivers to a screen at all.
  ///
  /// The till asks before doing any of the work of composing a ticket for one,
  /// so a venue with no kitchen screens pays nothing for the feature existing.
  bool get usesKitchenScreens =>
      kitchenDelivery.values.any((mode) => mode.toScreen);

  /// The name to show for [target]: the venue's, or the built-in one.
  String labelFor(PrintTarget target) => labelForStation(target.station!);

  /// The same, from a stored routing key. Falls back to the raw key so an
  /// unrecognised station still names itself rather than vanishing.
  String labelForStation(String station) {
    final named = printerNames[station]?.trim();
    if (named != null && named.isNotEmpty) return named;
    return PrintTarget.fromStation(station)?.label ?? station.toUpperCase();
  }

  bool get autoSignOff => signoffSeconds > 0;

  Duration get signoffAfter => Duration(seconds: signoffSeconds);

  /// Whether the change box counts down rather than waiting for a tap.
  bool get changeWindowTimed => changeWindowSeconds > 0;

  Duration get changeWindow => Duration(seconds: changeWindowSeconds);

  static const defaults = TillSettings();

  /// Compared by value, so a poll that fetches an identical row changes nothing.
  ///
  /// The till re-reads these every couple of minutes as a backstop against a
  /// missed push. Without this, each of those fetches would hand the tree a new
  /// object, Riverpod would call it a change, and the idle screen — which is the
  /// widget most likely to be on screen at the time — would rebuild for nothing
  /// every two minutes for the life of the terminal.
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TillSettings &&
          other.homeScreenId == homeScreenId &&
          other.idleEnabled == idleEnabled &&
          other.idleImageUrl == idleImageUrl &&
          other.idleAfterSale == idleAfterSale &&
          other.idleRequirePin == idleRequirePin &&
          other.idleMessage == idleMessage &&
          other.signoffSeconds == signoffSeconds &&
          other.changeWindowSeconds == changeWindowSeconds &&
          other.receiptAutoPrint == receiptAutoPrint &&
          other.buttonsShowPrices == buttonsShowPrices &&
          _sameNames(other.printerNames, printerNames) &&
          _sameDelivery(other.kitchenDelivery, kitchenDelivery);

  /// Seven short strings, compared by hand rather than pulling in a collection
  /// dependency for one call. Order does not matter; contents do.
  static bool _sameNames(Map<String, String> a, Map<String, String> b) {
    if (a.length != b.length) return false;
    for (final entry in a.entries) {
      if (b[entry.key] != entry.value) return false;
    }
    return true;
  }

  /// The same, for the six delivery modes. Separate only because the value type
  /// differs; the reasoning is identical.
  static bool _sameDelivery(
    Map<String, KitchenDelivery> a,
    Map<String, KitchenDelivery> b,
  ) {
    if (a.length != b.length) return false;
    for (final entry in a.entries) {
      if (b[entry.key] != entry.value) return false;
    }
    return true;
  }

  @override
  int get hashCode => Object.hash(
        homeScreenId,
        idleEnabled,
        idleImageUrl,
        idleAfterSale,
        idleRequirePin,
        idleMessage,
        signoffSeconds,
        changeWindowSeconds,
        receiptAutoPrint,
        buttonsShowPrices,
        // Order-independent, so two identical maps built in different orders
        // hash the same — which is what stops a re-fetch of the same row
        // looking like a change and rebuilding the idle screen for nothing.
        Object.hashAllUnordered([
          for (final e in printerNames.entries) '${e.key}=${e.value}',
        ]),
        Object.hashAllUnordered([
          for (final e in kitchenDelivery.entries) '${e.key}=${e.value.key}',
        ]),
      );

  // The server sends MySQL TINYINT(1) for the switches, which arrives as 0/1
  // rather than a bool.
  static bool _flag(Object? v) => v == 1 || v == true || v == '1';

  factory TillSettings.fromJson(Map<String, dynamic> j) {
    final url = (j['idle_image_url'] as String?)?.trim();
    return TillSettings(
      homeScreenId: (j['home_screen_id'] as num?)?.toInt(),
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
      // Same bounds as the server's changeWindowSeconds, and clamped here for
      // the same reason: a bad row must not leave a customer's change on screen
      // for a fifth of a second, or for the rest of the shift.
      changeWindowSeconds:
          switch ((j['change_window_seconds'] as num?)?.toInt() ?? 30) {
        <= 0 => 0,
        final n when n < 5 => 5,
        final n when n > 300 => 300,
        final n => n,
      },
      // Absent means off, matching the column default: a server that has not
      // run the migration yet must not have every till start printing.
      receiptAutoPrint: _flag(j['receipt_auto_print']),
      // Absent means *on* — the behaviour every terminal has had until now.
      // Only an explicit 0 takes prices off the buttons.
      buttonsShowPrices: j['buttons_show_prices'] == null
          ? true
          : _flag(j['buttons_show_prices']),
      // Only slots the venue has actually named. An empty column stays out of
      // the map so [labelFor] falls back to the built-in label rather than
      // showing a station with a blank name.
      printerNames: {
        for (final target in PrintTarget.routable)
          if ((j['printer_name_${target.station}'] as String?)?.trim()
              case final name? when name.isNotEmpty)
            target.station!: name,
      },
      // Only the stations that are *not* on a printer. Absent means printer,
      // so a server that has not run schema_till_kitchen.sql yet — where every
      // one of these columns is missing and reads as null — leaves every till
      // printing, which is exactly right.
      kitchenDelivery: {
        for (final target in PrintTarget.kitchenStations)
          if (KitchenDelivery.fromKey(
                j['kitchen_mode_${target.station}'] as String?,
              )
              case final mode when mode != KitchenDelivery.printer)
            target.station!: mode,
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

/// Writing the venue's kitchen delivery modes from a till.
///
/// The rest of the till-settings row is read-only here and edited in the back
/// office, which is right for an idle-screen picture nobody sets up twice. The
/// six delivery modes are the exception the brief asks for, and it is the right
/// exception: the person plugging a screen into the kitchen wall is standing at
/// a till, not at a laptop, and making them walk to the office to say "the
/// fryer has a screen now" is how a feature goes unused.
///
/// Authorised with the **terminal token**, not a session. A till has no usable
/// session — the one it was commissioned with expired months ago — and the
/// scope is exactly right anyway: a commissioned terminal may say where its own
/// venue's kitchen stations deliver, and may do nothing else through this route.
class KitchenDeliveryClient {
  KitchenDeliveryClient({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;

  /// Null on a terminal commissioned before terminal tokens existed. Such a
  /// till is told to sign in again rather than shown a screen whose Save button
  /// cannot work.
  final String? terminalToken;

  final http.Client _client;

  bool get canWrite => terminalToken != null;

  /// Set [station] to [mode]. Returns the venue's modes as the server now holds
  /// them, so the till shows what was actually saved rather than what it asked
  /// for.
  Future<Map<String, KitchenDelivery>> setMode(
    String station,
    KitchenDelivery mode,
  ) async {
    final token = terminalToken;
    if (token == null) {
      throw StateError(
        'This till needs to be signed in again before it can change where the '
        'kitchen stations deliver.',
      );
    }

    final res = await _client
        .put(
          Uri.parse('$apiBase/till/kitchen/modes'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
          body: jsonEncode({station: mode.key}),
        )
        .timeout(const Duration(seconds: 10));

    if (res.statusCode != 200) {
      throw StateError(_errorFrom(res.body, res.statusCode));
    }

    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return {
      for (final entry in body.entries)
        entry.key: KitchenDelivery.fromKey(entry.value as String?),
    };
  }

  /// The server's message if it sent one, so a paused office or an expired
  /// terminal token explains itself rather than arriving as a status code.
  static String _errorFrom(String body, int status) {
    try {
      final message = (jsonDecode(body) as Map<String, dynamic>)['error'];
      if (message is String && message.isNotEmpty) return message;
    } catch (_) {
      // Not JSON; fall through to the status.
    }
    return 'The back office refused the change (HTTP $status).';
  }
}
