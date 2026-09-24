import 'dart:convert';

import 'package:http/http.dart' as http;

import '../printing/print_targets.dart';
import 'notifications.dart';
import 'price_levels.dart';

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
    this.topBarScreenId,
    this.bottomBarScreenId,
    this.consolidateLines = true,
    this.cashDeclaration = CashDeclaration.off,
    this.payTopBarScreenId,
    this.payBottomBarScreenId,
    this.fontFamily,
    this.priceLevelNames = PriceLevelNames.empty,
    this.notify = NotifyPolicy.standard,
    this.notifyDisplayEnabled = false,
    this.customerDisplayGreeting,
    this.customerDisplayShowMember = true,
  });

  /// The programmed screen this venue's tills open on, or null.
  ///
  /// Null is not an absence of configuration — it is the venue's answer, and it
  /// means the built-in Default: the catalogue-driven grid the till has always
  /// drawn. So a venue that has programmed nothing, or has deleted everything
  /// it programmed, still gets a working sale screen. See
  /// docs/screen-programming.md §2.
  final int? homeScreenId;

  /// The bars this venue's tills wear, or null for the built-in ones.
  ///
  /// Null carries exactly the same weight as it does on [homeScreenId]: it is
  /// the venue's answer, not an absence of one, and it means the strip of open
  /// bills along the top and Void / Cancel / Save Table … Pay along the bottom
  /// — what every till has shown since before these were programmable, and what
  /// a venue gets back the moment it deletes the bar it made.
  final int? topBarScreenId;
  final int? bottomBarScreenId;

  /// The bars the *payment* screen wears, or null for its built-in ones.
  ///
  /// A separate pair rather than the sale screen's, because the two screens are
  /// different jobs. A sale bar carries Void, Save Table and Covers; none of
  /// those mean anything once the bill is being settled, and offering them
  /// there would be a bar of keys that do nothing.
  /// Whether the check adds repeats up, or lists them.
  ///
  /// True is what every till has always done — tap Carling three times and the
  /// bill says "3  Carling". False writes a line per tap, which some venues ask
  /// for because the bill then reads as the order was called, and because a
  /// line each is a line each to void rather than a quantity to edit down.
  final bool consolidateLines;

  /// Whether the till counts the drawer before a Z report, and how.
  final CashDeclaration cashDeclaration;

  final int? payTopBarScreenId;
  final int? payBottomBarScreenId;

  /// The slug of the font this venue's tills letter everything in, or null for
  /// the app's own typeface.
  ///
  /// A slug, not a family name, and not resolved here: a font the venue has
  /// chosen may not have finished downloading to this terminal, or may have
  /// been deleted in the back office since. `FontLibrary.familyFor` in
  /// data/fonts.dart is the one place that turns this into something the engine
  /// can be handed.
  final String? fontFamily;

  /// What this venue calls price levels 2 to 6.
  ///
  /// Empty is the ordinary state and reads as "Price 2", "Price 3" and so on —
  /// a venue that has named no levels has named none. Names matter on the till
  /// key: "Happy Hour" tells a clerk what they are switching to and "Price 2"
  /// tells them nothing. See `data/price_levels.dart`.
  final PriceLevelNames priceLevelNames;

  /// What the screen facing the customer says above a member's name, or null
  /// for the built-in "Welcome".
  ///
  /// Null rather than the word itself, so a venue that clears the box gets the
  /// default back instead of being left with a field it cannot empty — the
  /// same rule the printer names follow.
  final String? customerDisplayGreeting;

  /// Whether that screen names the member at all.
  ///
  /// On by default, because a greeting with no name under it is a screen
  /// saying "Welcome" to nobody. Off is a real choice: the display faces a
  /// room, and "Welcome Mrs Protheroe — 1,240 points" is a sentence the next
  /// person in the queue can read.
  final bool customerDisplayShowMember;

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
          other.topBarScreenId == topBarScreenId &&
          other.bottomBarScreenId == bottomBarScreenId &&
          other.consolidateLines == consolidateLines &&
          other.cashDeclaration == cashDeclaration &&
          other.payTopBarScreenId == payTopBarScreenId &&
          other.payBottomBarScreenId == payBottomBarScreenId &&
          other.fontFamily == fontFamily &&
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
        topBarScreenId,
        bottomBarScreenId,
        consolidateLines,
        cashDeclaration,
        payTopBarScreenId,
        payBottomBarScreenId,
        idleEnabled,
        idleImageUrl,
        idleAfterSale,
        idleRequirePin,
        fontFamily,
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

  /// Which notifications this venue's tills are allowed to raise.
  ///
  /// Read from the same row as everything else here, because the venue asked
  /// for one place in the back office that decides which notification goes
  /// where — and a second fetch would be a second thing to be out of date. See
  /// `data/notifications.dart` for how it combines with this terminal's own
  /// switches.
  final NotifyPolicy notify;

  /// Whether this venue lets its customer displays raise a Windows toast.
  ///
  /// Off unless a manager turns it on. A customer display is a screen facing a
  /// queue: a toast sliding over somebody's bill is a notification aimed at
  /// nobody, because the person who needs to know is behind the counter. It
  /// exists for the venue that mounts one in a back office.
  ///
  /// Read here and written into the snapshot file, because the display
  /// application has no network of its own.
  final bool notifyDisplayEnabled;

  factory TillSettings.fromJson(Map<String, dynamic> j) {
    final url = (j['idle_image_url'] as String?)?.trim();
    return TillSettings(
      notify: NotifyPolicy.fromSettings(j),
      notifyDisplayEnabled:
          j['notify_display_enabled'] == 1 ||
          j['notify_display_enabled'] == true ||
          j['notify_display_enabled'] == '1',
      homeScreenId: (j['home_screen_id'] as num?)?.toInt(),
      // Absent — a server that has not run schema_till_fonts.sql — reads as
      // null, which is "the app's own lettering". Which is what every till
      // wore before this existed.
      fontFamily: switch ((j['font_family'] as String?)?.trim()) {
        null => null,
        '' => null,
        final slug => slug,
      },
      // Absent on a server that has not run schema_price_levels.sql, which
      // reads as "nothing named" — the state every venue is in until it names
      // one.
      priceLevelNames: PriceLevelNames.parse(j['price_level_names']),
      // Trimmed, and empty is null. A greeting of spaces would draw a gap
      // above the name and look like a fault.
      customerDisplayGreeting: switch (j['customer_display_greeting']) {
        final String s when s.trim().isNotEmpty => s.trim(),
        _ => null,
      },
      // Absent means on — a server that predates the column must not be read
      // as "this venue has switched the name off".
      customerDisplayShowMember: switch (j['customer_display_show_member']) {
        final bool v => v,
        final num v => v != 0,
        final String v => v == '1' || v == 'true',
        _ => true,
      },
      topBarScreenId: (j['top_bar_screen_id'] as num?)?.toInt(),
      bottomBarScreenId: (j['bottom_bar_screen_id'] as num?)?.toInt(),
      // Absent on a server that has not run schema_till_pay_bars.sql, which
      // reads as null — the payment screen's built-in bars, which is what
      // every venue has today.
      // Absent means "as it has always been": consolidated, and never asking
      // for a cash declaration. A server that has not run the migration must
      // not change how a venue's tills behave.
      // Absent means true, which _flag cannot express: it answers false for
      // anything it does not recognise, and that is right for every other flag
      // here. A server without the migration must not switch consolidation off
      // for every venue on it.
      consolidateLines:
          j['consolidate_lines'] == null || _flag(j['consolidate_lines']),
      cashDeclaration: CashDeclaration.parse(j['cash_declaration']),
      payTopBarScreenId: (j['pay_top_bar_screen_id'] as num?)?.toInt(),
      payBottomBarScreenId: (j['pay_bottom_bar_screen_id'] as num?)?.toInt(),
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

/// Whether the till counts the drawer before a Z report, and how.
///
/// The venue chooses, which is the answer they gave when asked. Venues differ
/// on how much they trust a fast close, and a setting is cheaper than being
/// wrong for half of them.
enum CashDeclaration {
  /// Never ask. What every till does today.
  off,

  /// One figure typed in. Fast at close — and when the till is down, there is
  /// nothing on the Z to say where.
  total,

  /// The denomination grid the venue already has, so a miscount shows up as a
  /// wrong denomination rather than a wrong total. See CashNotesPanel.
  count;

  bool get asks => this != CashDeclaration.off;

  static CashDeclaration parse(Object? raw) => switch (raw) {
        'total' => CashDeclaration.total,
        'count' => CashDeclaration.count,
        // Anything else, including a value from a newer back office than this
        // build knows, means do not ask. A till that invented a way of counting
        // money it did not understand would be worse than one that asked
        // nothing.
        _ => CashDeclaration.off,
      };

  String get wire => name;
}
