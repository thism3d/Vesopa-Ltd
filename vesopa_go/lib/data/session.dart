/// Where Vesopa Go is, and everything the screens read.
///
/// The phone's life has five phases, and every screen is one of them:
///
///   booting   reading its terminal token from the phone's secure storage
///   welcome   not set up: Sign in with Vesopa, Register a venue, or the demo
///   setup     signed in: choose how this phone is used
///   locked    set up, nobody signed on: PIN, staff card or Face ID
///   ready     a clerk is signed on and serving
///
/// The terminal token is in the Keychain / Keystore (flutter_secure_storage),
/// never in plain preferences: it is what makes this phone a till.
///
/// With Vesopa EPOS, the phone is one terminal among the tills: it pulls the
/// venue's shared open bills every few seconds (a bill another terminal holds
/// shows here as held by it, and must be claimed before it is changed), pushes
/// its own, sends kitchen tickets to the venue's stations, and records the
/// sale when a bill is paid -- the same rows a till writes.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../payments/payment_service.dart';
import 'go_options.dart';
import 'mix_match_types.dart';
import 'lan/lan_link.dart' show LanMessage;
import 'lan/lan_service.dart';
import '../config/constants.dart' show apiBase;
import 'screen_set.dart';

export 'go_options.dart';
export 'screen_set.dart';
import 'api.dart';
import 'demo_venue.dart';
import 'models.dart';
import 'outbox.dart';
import 'payloads.dart';
import 'venue_data.dart';

enum Phase { booting, welcome, setup, locked, ready }

/// The venue's Vesopa Go settings from the back office (tips on by default).
@immutable
class TapConfig {
  const TapConfig({
    this.environment = 'sandbox',
    this.tips = true,
    this.tipPercents = const [10, 12.5, 15],
    this.servicePercents = const [0, 10, 12.5],
    this.allowCash = true,
    this.receiptEmail = true,
    this.go = const GoOptions(),
    this.licensed = true,
    this.consolidateLines = true,
    this.idleImageUrl,
    this.idleMessage = 'Touch to begin',
    this.branding = const {},
    this.staffPhotos = const {},
    this.softwareHouseId = '',
    this.resellerId = '',
    this.screens = ScreenSet.empty,
    this.homeScreenId,
    this.topBarScreenId,
    this.bottomBarScreenId,
    this.goLayouts = const {},
  });
  final String environment;
  final bool tips;
  final List<double> tipPercents;
  final List<double> servicePercents;
  final bool allowCash;
  final bool receiptEmail;

  /// Every Vesopa Go option from the back office.
  final GoOptions go;

  /// Whether the venue has Vesopa Go on its licence. A server too old to say
  /// is taken as yes, so an update to the app never locks a venue out.
  final bool licensed;

  /// The till's own settings Go follows (`/api/till-settings/public`).
  final bool consolidateLines;
  final String? idleImageUrl;
  final String idleMessage;

  /// The venue's receipt as the tills print it (`/api/branding/public`):
  /// address, VAT number, header and footer, which parts show.
  final Map<String, dynamic> branding;

  /// Staff id to photo (back office, Staff > Photo).
  final Map<String, String> staffPhotos;

  /// Dojo's partner ids, shown on the card machine page as the till shows them.
  final String softwareHouseId;
  final String resellerId;

  /// The venue's programmed screens (back office, Screen Programming) and the
  /// till's choice of home screen and bars. No home screen: the built-in
  /// departments and products, as on the till.
  final ScreenSet screens;
  final int? homeScreenId;
  final int? topBarScreenId;
  final int? bottomBarScreenId;

  /// Go's own layouts, `{form: {screenId: buttons}}` (layout_editor.dart).
  final Map<String, Map<String, dynamic>> goLayouts;

  /// The home screen to draw, or null for the built-in grid.
  TillScreen? get home => screens.surfaceById(homeScreenId, ScreenSurface.sale);

  /// Whether a second tap of the same item raises the quantity.
  bool get stacks => switch (go.stackLines) { 'on' => true, 'off' => false, _ => consolidateLines };

  factory TapConfig.fromJson(Map<String, dynamic> j) {
    final till = j['till'] is Map ? Map<String, dynamic>.from(j['till'] as Map) : const <String, dynamic>{};
    final idle = '${till['idle_image_url'] ?? ''}'.trim();
    List<double> nums(Object? v, List<double> d) =>
        v is List ? [for (final n in v) (n as num).toDouble()] : d;
    return TapConfig(
      environment: j['environment'] as String? ?? 'sandbox',
      tips: j['tips'] as bool? ?? true,
      tipPercents: nums(j['tip_percents'], const [10, 12.5, 15]),
      servicePercents: nums(j['service_percents'], const [0, 10, 12.5]),
      allowCash: j['allow_cash'] as bool? ?? true,
      receiptEmail: j['receipt_email'] as bool? ?? true,
      go: GoOptions.fromJson(j['go']),
      licensed: j['go_licensed'] as bool? ?? true,
      // The till's rule: absent is on (tap Carling three times, the bill says 3 Carling).
      consolidateLines: switch (till['consolidate_lines']) { null => true, final v => v == true || v == 1 || v == '1' || v == 'true' },
      idleImageUrl: idle.isEmpty ? null : idle,
      idleMessage: till['idle_message'] as String? ?? 'Touch to begin',
      branding: j['branding'] is Map ? Map<String, dynamic>.from(j['branding'] as Map) : const {},
      staffPhotos: j['photos'] is Map ? {for (final e in (j['photos'] as Map).entries) '${e.key}': '${e.value}'} : const {},
      softwareHouseId: '${j['software_house_id'] ?? ''}',
      resellerId: '${j['reseller_id'] ?? ''}',
      screens: j['screens'] is List ? ScreenSet.fromJson({'screens': j['screens']}) : ScreenSet.empty,
      homeScreenId: (till['home_screen_id'] as num?)?.toInt(),
      topBarScreenId: (till['top_bar_screen_id'] as num?)?.toInt(),
      bottomBarScreenId: (till['bottom_bar_screen_id'] as num?)?.toInt(),
      goLayouts: {
        for (final form in const ['tablet', 'phone'])
          if (j['layouts'] is Map && (j['layouts'] as Map)[form] is Map) form: Map<String, dynamic>.from((j['layouts'] as Map)[form] as Map),
      },
    );
  }
}

/// A card payment taken here today, for a receipt or a refund.
@immutable
class RecentPayment {
  const RecentPayment({required this.paymentId, required this.billId, required this.billName, required this.amountMinor, required this.tipMinor, required this.at, required this.clerk, this.refundedMinor = 0});
  final String paymentId;
  final String billId;
  final String billName;
  final int amountMinor;
  final int tipMinor;
  final DateTime at;
  final String clerk;
  final int refundedMinor;
  int get totalMinor => amountMinor + tipMinor;
}

@immutable
class TapState {
  const TapState({
    required this.phase,
    this.venue,
    this.demo = false,
    this.clerk,
    this.lastClerk,
    this.staff = const [],
    this.categories = const [],
    this.products = const [],
    this.tables = const [],
    this.bills = const {},
    this.config = const TapConfig(),
    this.recent = const [],
    this.alerts = const [],
    this.online = true,
    this.sharing = false,
    this.pendingSync = 0,
    this.message,
    this.lastClosed,
  });

  final Phase phase;
  final Venue? venue;
  final bool demo;
  final Clerk? clerk;

  /// Who last signed on here: Face ID brings back only them.
  final Clerk? lastClerk;
  final List<Clerk> staff;
  final List<MenuCategory> categories;
  final List<Product> products;
  final List<TableInfo> tables;

  /// Open bills by id: this phone's and (connected) every other terminal's.
  final Map<String, Bill> bills;
  final TapConfig config;
  final List<RecentPayment> recent;

  /// "Table 4: food ready", newest first, until the clerk clears them.
  final List<String> alerts;
  final bool online;

  /// True once the venue's shared bills have been read: the floor is the whole room.
  final bool sharing;

  /// Sales and tickets waiting to reach the back office.
  final int pendingSync;
  final String? message;

  /// The last bill paid in full: the counter's day journal and reports read
  /// it, whichever screen took the payment.
  final Bill? lastClosed;

  Bill? billForTable(String tableId) {
    for (final b in bills.values) {
      if (b.tableId == tableId) return b;
    }
    return null;
  }

  TableState tableState(String tableId) {
    final b = billForTable(tableId);
    if (b == null) return TableState.free;
    if (b.lines.isEmpty) return TableState.seated;
    if (b.dueMinor <= 0) return TableState.paid;
    if (b.paidMinor > 0) return TableState.bill;
    if (b.lines.any((l) => l.sent && l.product.course >= 2)) return TableState.mains;
    return TableState.ordered;
  }

  TapState copyWith({
    Phase? phase,
    Venue? venue,
    bool? demo,
    Clerk? clerk,
    bool clearClerk = false,
    Clerk? lastClerk,
    List<Clerk>? staff,
    List<MenuCategory>? categories,
    List<Product>? products,
    List<TableInfo>? tables,
    Map<String, Bill>? bills,
    TapConfig? config,
    List<RecentPayment>? recent,
    List<String>? alerts,
    bool? online,
    bool? sharing,
    int? pendingSync,
    String? message,
    Bill? lastClosed,
  }) =>
      TapState(
        phase: phase ?? this.phase,
        venue: venue ?? this.venue,
        demo: demo ?? this.demo,
        clerk: clearClerk ? null : (clerk ?? this.clerk),
        lastClerk: lastClerk ?? this.lastClerk,
        staff: staff ?? this.staff,
        categories: categories ?? this.categories,
        products: products ?? this.products,
        tables: tables ?? this.tables,
        bills: bills ?? this.bills,
        config: config ?? this.config,
        recent: recent ?? this.recent,
        alerts: alerts ?? this.alerts,
        online: online ?? this.online,
        sharing: sharing ?? this.sharing,
        pendingSync: pendingSync ?? this.pendingSync,
        message: message,
        lastClosed: lastClosed ?? this.lastClosed,
      );
}

final apiProvider = Provider<TapApi>((ref) => TapApi());

final paymentsProvider = Provider<PaymentService>((ref) {
  final demo = ref.watch(tapProvider.select((s) => s.demo));
  return demo ? DemoPayments() : DojoTapToPay(ref.watch(apiProvider));
});

final tapProvider = NotifierProvider<TapSession, TapState>(TapSession.new);

/// What Continue with Vesopa answered when the login runs several sites.
class SiteChoice {
  const SiteChoice({required this.pickToken, required this.sites});
  final String pickToken;
  final List<Map<String, dynamic>> sites;
}

class TapSession extends Notifier<TapState> {
  static const _store = FlutterSecureStorage();
  static const _tokenKey = 'vesopa_go_token';
  static const _venueKey = 'vesopa_go_venue';
  static const _deviceKey = 'vesopa_go_device';
  static const _cacheKey = 'vesopa_go_venue_cache';
  final _uuid = const Uuid();

  Timer? _billTimer;
  Timer? _kitchenTimer;
  int _cursor = 0;
  String _deviceId = '';
  final _readyTickets = <String>{};
  late final Outbox _outbox = Outbox(ref.read(apiProvider));

  /// The app this session runs in, as terminals and the back office name it.
  /// Set by main.dart.
  static String product = 'Vesopa Go';

  /// This phone as the other terminals see it: "iPhone (Vesopa Go) 3F2A".
  String get terminalName {
    final kind = kIsWeb ? 'Phone' : (Platform.isIOS ? 'iPhone' : 'Android');
    final tag = _deviceId.isEmpty ? '' : ' ${_deviceId.substring(0, 4).toUpperCase()}';
    return '$kind ($product)$tag';
  }

  String get deviceId => _deviceId;

  @override
  TapState build() {
    ref.onDispose(_stopTimers);
    unawaited(_boot());
    return const TapState(phase: Phase.booting);
  }

  Future<void> _boot() async {
    String? token;
    String? venue;
    try {
      token = await _store.read(key: _tokenKey);
      venue = await _store.read(key: _venueKey);
      _deviceId = await _store.read(key: _deviceKey) ?? '';
      if (_deviceId.isEmpty) {
        _deviceId = _uuid.v4().replaceAll('-', '');
        await _store.write(key: _deviceKey, value: _deviceId);
      }
    } catch (_) {
      // a phone restored from a backup can lose its Keychain items: set up again
    }
    if (_deviceId.isEmpty) _deviceId = _uuid.v4().replaceAll('-', '');
    if (token == null || venue == null) {
      state = state.copyWith(phase: Phase.welcome);
      return;
    }
    final v = Venue.fromJson(jsonDecode(venue) as Map<String, dynamic>);
    final api = ref.read(apiProvider)
      ..token = token
      ..office = v.office;
    api.office = v.office;
    state = state.copyWith(phase: Phase.locked, venue: v);
    await _loadCache();
    await refresh();
  }

  /// Try everything with the demo venue: no back office, pretend payments.
  /// Another app on this session can bring a demo venue of its own.
  void startDemo({
    Venue venue = demoVenue,
    List<Clerk> staff = demoClerks,
    List<MenuCategory> categories = demoCategories,
    List<Product> products = demoProducts,
    List<TableInfo>? tables,
  }) {
    _stopTimers();
    state = TapState(
      phase: Phase.locked,
      venue: venue,
      demo: true,
      staff: staff,
      categories: categories,
      products: products,
      tables: tables ?? demoTables,
    );
  }

  /// After Continue with Vesopa or Register: keep only the terminal token.
  /// Returns a [SiteChoice] when the login runs several sites.
  Future<SiteChoice?> commissioned(Map<String, dynamic> answer) async {
    if (answer['choose_site'] == true) {
      return SiteChoice(
        pickToken: answer['pick_token'] as String,
        sites: [for (final s in answer['sites'] as List? ?? const []) Map<String, dynamic>.from(s as Map)],
      );
    }
    final token = (answer['terminalToken'] ?? answer['token']) as String?;
    final user = Map<String, dynamic>.from(answer['user'] as Map? ?? const {});
    final office = (user['officeEmail'] ?? user['office_email'] ?? '') as String;
    if (token == null || office.isEmpty) throw const TapApiError(0, 'Vesopa did not sign this phone in.');
    final api = ref.read(apiProvider)
      ..token = token
      ..office = office;
    api.office = office;
    await _store.write(key: _tokenKey, value: token);
    state = state.copyWith(
      phase: Phase.setup,
      venue: Venue(name: (user['officeName'] ?? user['office_name'] ?? 'Your venue') as String, office: office, mode: VenueMode.connected),
    );
    return null;
  }

  Future<void> chooseMode(VenueMode mode) async {
    final v = state.venue!;
    final venue = Venue(name: v.name, office: v.office, mode: mode, site: v.site);
    try {
      await _store.write(key: _venueKey, value: jsonEncode(venue.toJson()));
    } catch (_) {}
    state = state.copyWith(phase: Phase.locked, venue: venue);
    await refresh();
  }

  // ---- The venue's data ------------------------------------------------------------

  /// Staff, menu, floor and settings from the back office; the last good copy
  /// is kept so a phone that starts with no signal still knows its venue.
  Future<void> refresh() async {
    if (state.demo) return;
    final api = ref.read(apiProvider);
    try {
      final results = await Future.wait([
        api.staff(),
        api.products(),
        api.modifiers().catchError((Object _) => <String, dynamic>{}),
        api.screens().catchError((Object _) => <dynamic>[]),
        api.floor().catchError((Object _) => <dynamic>[]),
        api.tapConfig().catchError((Object _) => <String, dynamic>{}),
        api.tillSettings().catchError((Object _) => <String, dynamic>{}),
        api.branding().catchError((Object _) => <String, dynamic>{}),
        api.staffPhotos().catchError((Object _) => <String, dynamic>{}),
        api.layouts('tablet').catchError((Object _) => <String, dynamic>{}),
        api.layouts('phone').catchError((Object _) => <String, dynamic>{}),
        api.deals().catchError((Object _) => <dynamic>[]),
      ]);
      final raw = {
        'staff': [for (final c in results[0] as List<Clerk>) {'id': c.id, 'name': c.name, 'pin': c.pin, 'swipe_card': c.card, 'permission_group': c.group, 'perms': c.permissions}],
        'products': results[1],
        'deals': results[11],
        'modifiers': results[2],
        'screens': results[3],
        'floor': results[4],
        'config': {...results[5] as Map<String, dynamic>, 'till': results[6], 'branding': results[7], 'photos': (results[8] as Map)['photos'], 'layouts': {'tablet': (results[9] as Map)['layouts'], 'phone': (results[10] as Map)['layouts']}},
      };
      _apply(raw);
      state = state.copyWith(online: true);
      try {
        await (await SharedPreferences.getInstance()).setString(_cacheKey, jsonEncode(raw));
      } catch (_) {}
    } on TapApiError catch (e) {
      state = state.copyWith(online: e.status != 0, message: e.message);
    }
    await _flushOutbox();
  }

  Future<void> _loadCache() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_cacheKey);
      if (raw != null) _apply(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {}
  }

  void _apply(Map<String, dynamic> raw) {
    // The venue's mix & match, as the till reads /till/deals.
    final deals = <MixMatchDeal>[];
    final members = <int, Set<int>>{};
    for (final d in raw['deals'] as List? ?? const []) {
      final m = Map<String, dynamic>.from(d as Map);
      final id = (m['id'] as num?)?.toInt();
      if (id == null) continue;
      deals.add(MixMatchDeal(
        id: id,
        name: '${m['name'] ?? ''}',
        triggerQty: (m['trigger_qty'] as num?)?.toInt() ?? 2,
        dealPriceMinor: (m['deal_price_minor'] as num?)?.toInt() ?? 0,
        active: m['active'] == null || m['active'] == true || m['active'] == 1,
      ));
      members[id] = {for (final p in m['plu_ids'] as List? ?? const []) (p as num).toInt()};
    }
    Bill.deals = MixMatchEngine(deals, members);
    final menu = menuFrom(
      products: raw['products'] as List? ?? const [],
      modifiers: raw['modifiers'] as Map<String, dynamic>?,
      screens: raw['screens'] as List?,
    );
    state = state.copyWith(
      staff: [for (final s in raw['staff'] as List? ?? const []) Clerk.fromJson(Map<String, dynamic>.from(s as Map))],
      categories: menu.categories,
      products: menu.products,
      tables: tablesFrom(raw['floor'] as List? ?? const []),
      config: TapConfig.fromJson({...Map<String, dynamic>.from(raw['config'] as Map? ?? const {}), 'screens': raw['screens']}),
    );
  }

  // ---- Clerks --------------------------------------------------------------------

  void signOn(Clerk clerk) {
    state = state.copyWith(phase: Phase.ready, clerk: clerk, lastClerk: clerk);
    _startTimers();
  }

  void lock() {
    _stopTimers();
    state = state.copyWith(phase: Phase.locked, clearClerk: true);
  }

  /// Whoever this PIN belongs to, if they may approve [permission] (the
  /// till's rule: they hold the key, or they are a manager).
  Clerk? managerByPin(String pin, [TillPermission permission = TillPermission.isManager]) {
    for (final c in state.staff) {
      if (c.pin == pin && pin.length >= 4 && c.canApprove(permission)) return c;
    }
    return null;
  }

  Future<void> forgetPhone() async {
    _stopTimers();
    try {
      await _store.delete(key: _tokenKey);
      await _store.delete(key: _venueKey);
    } catch (_) {}
    ref.read(apiProvider)
      ..token = null
      ..office = null;
    state = const TapState(phase: Phase.welcome);
  }

  // ---- Live with the tills ---------------------------------------------------------

  bool get _connected => !state.demo && state.venue?.mode == VenueMode.connected;

  void _startTimers() {
    _stopTimers();
    if (state.demo) return;
    if (_connected) unawaited(pullBills());
    _connectLive();
    if (_connected) unawaited(_joinLan());
    // The safety net under the live connection: slow while the socket is up,
    // every few seconds when it is not.
    _billTimer = Timer.periodic(const Duration(seconds: 5), (t) {
      if (_connected && (_live == null || t.tick % 6 == 0)) unawaited(pullBills());
    });
    _kitchenTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      unawaited(_checkKitchen());
      unawaited(_flushOutbox());
    });
  }

  void _stopTimers() {
    _billTimer?.cancel();
    _kitchenTimer?.cancel();
    _billTimer = null;
    _kitchenTimer = null;
    _liveRetry?.cancel();
    _liveRetry = null;
    _liveSub?.cancel();
    _liveSub = null;
    _live?.sink.close();
    _live = null;
  }

  // ---- The live connection ---------------------------------------------------------
  //
  // The back office's /ws (vesopa_server/src/server.js): subscribed to this
  // venue, it nudges the moment a till changes a bill (open-bills.updated), a
  // kitchen ticket moves, or the menu, screens, staff or floor change. A nudge
  // carries no data: what it names is read over HTTP, with this phone's token,
  // as before. So a dropped socket costs only speed; the timers still run.

  WebSocketChannel? _live;
  StreamSubscription<dynamic>? _liveSub;
  Timer? _liveRetry;
  Timer? _menuSoon;
  int _liveFailures = 0;

  /// Whether the live connection is up (for the status in the app bar).
  bool get live => _live != null;

  static const _menuNudges = {'catalogue.updated', 'staff.updated', 'screens', 'floor.updated', 'till-settings', 'dojo-settings'};

  void _connectLive() {
    final office = state.venue?.office;
    if (state.demo || office == null || office.isEmpty || _live != null) return;
    final base = Uri.parse(ref.read(apiProvider).base);
    final uri = base.replace(scheme: base.scheme == 'https' ? 'wss' : 'ws', path: '/ws');
    try {
      final ch = WebSocketChannel.connect(uri);
      _live = ch;
      ch.sink.add(jsonEncode({'type': 'subscribe', 'office': office}));
      _liveSub = ch.stream.listen(_onLive, onDone: _liveLost, onError: (Object _) => _liveLost(), cancelOnError: true);
      ch.ready.then((_) { _liveFailures = 0; }, onError: (Object _) { _liveLost(); });
    } catch (_) {
      _liveLost();
    }
  }

  void _onLive(dynamic raw) {
    Map<String, dynamic> msg;
    try {
      msg = Map<String, dynamic>.from(jsonDecode(raw is String ? raw : utf8.decode(raw as List<int>)) as Map);
    } catch (_) {
      return;
    }
    final type = '${msg['type'] ?? ''}';
    if (type == 'open-bills.updated') {
      unawaited(pullBills());
    } else if (type.startsWith('kitchen')) {
      unawaited(_checkKitchen());
    } else if (_menuNudges.contains(type)) {
      // A back-office edit sends several at once: one refresh for all of them.
      _menuSoon?.cancel();
      _menuSoon = Timer(const Duration(seconds: 2), () => unawaited(refresh()));
    }
  }

  void _liveLost() {
    _liveSub?.cancel();
    _liveSub = null;
    _live = null;
    if (_billTimer == null) return; // signed off: no reconnecting
    _liveFailures++;
    final wait = Duration(seconds: (2 << _liveFailures.clamp(0, 5)).clamp(4, 60));
    _liveRetry?.cancel();
    _liveRetry = Timer(wait, _connectLive);
  }

  /// The venue's shared bills: every other terminal's, mirrored here as held by it.
  Future<void> pullBills() async {
    if (!_connected) return;
    try {
      final feed = await ref.read(apiProvider).openBills(since: _cursor);
      final bills = Map.of(state.bills);
      for (final b in feed['bills'] as List? ?? const []) {
        final row = Map<String, dynamic>.from(b as Map);
        if (row['terminal'] == terminalName) continue;
        final mirrored = _billFromFeed(row);
        if (mirrored != null) bills[mirrored.id] = mirrored;
      }
      for (final g in feed['removed'] as List? ?? const []) {
        final id = (g as Map)['id'] as String?;
        if (id != null && bills[id]?.heldBy != null) bills.remove(id);
      }
      _cursor = (feed['rev'] as num?)?.toInt() ?? _cursor;
      state = state.copyWith(bills: bills, sharing: true, online: true);
    } on TapApiError catch (e) {
      state = state.copyWith(online: e.status != 0);
    }
  }

  // ---- The venue's local link (vesopa_epos lib/data/lan, the till's own) --------
  //
  // Bills straight from the tills over the venue's network, in the shape the
  // tills publish them ('bills', the open-bills feed's rows), and this device's
  // own bills to them: milliseconds rather than the next poll, and still there
  // when the internet is not. The tills' local addresses come from the back
  // office with the venue key (/api/lan/key), which is also how an iPhone finds
  // them: iOS does not let an app broadcast without Apple's multicast
  // entitlement (applied for).

  bool _lanJoined = false;

  Future<void> _joinLan() async {
    final token = ref.read(apiProvider).token;
    if (token == null || token.isEmpty || _deviceId.isEmpty) return;
    try {
      await LanService.instance.configure(
        apiBase: apiBase,
        token: token,
        deviceId: 'go-$_deviceId',
        name: terminalName,
        version: 'go',
        role: 'go',
      );
      if (_lanJoined) return;
      _lanJoined = true;
      LanService.instance.subscribe('bills', _onLanBill);
    } catch (_) {
      // The local link is the fast path; the back office is still there.
    }
  }

  void _onLanBill(LanMessage m) {
    final id = m.key;
    if (id == null) return;
    final d = m.data;
    final bills = Map.of(state.bills);
    if (d == null) {
      if (bills[id]?.heldBy != null) bills.remove(id);
    } else if (d is Map) {
      final row = {...Map<String, dynamic>.from(d), 'id': id};
      if (row['terminal'] == terminalName) return;
      final mirrored = _billFromFeed(row);
      if (mirrored == null) return;
      bills[id] = mirrored;
    }
    state = state.copyWith(bills: bills, sharing: true);
  }

  Bill? _billFromFeed(Map<String, dynamic> row) {
    final p = row['payload'];
    if (p is! Map) return null;
    final payload = Map<String, dynamic>.from(p);
    final number = (row['table_number'] as num?)?.toInt();
    final table = number == null ? null : state.tables.where((t) => t.number == number).firstOrNull;
    final lines = <BillLine>[];
    for (final l in payload['lines'] as List? ?? const []) {
      final m = Map<String, dynamic>.from(l as Map);
      if (m['is_modifier'] == true) continue;
      final plu = (m['plu_id'] as num?)?.toInt();
      final known = plu == null ? null : state.products.where((x) => x.plu == plu).firstOrNull;
      lines.add(BillLine(
        id: '${m['id']}',
        product: known ??
            Product(id: 'plu$plu', plu: plu, name: '${m['name']}', priceMinor: (m['unit_price_minor'] as num?)?.toInt() ?? 0, category: ''),
        quantity: (m['quantity'] as num?)?.toInt() ?? 1,
        note: '${m['notes'] ?? m['note'] ?? ''}',
        sent: m['kitchen_printed_at'] != null,
        addedBy: '${m['added_by'] ?? ''}',
      ));
    }
    return Bill(
      id: '${row['id']}',
      name: table?.name ?? (payload['name'] as String? ?? (number == null ? 'Tab' : 'Table $number')),
      tableId: table?.id,
      tableNumber: number,
      roomId: (row['room_id'] as num?)?.toInt(),
      covers: (row['covers'] as num?)?.toInt() ?? 0,
      lines: lines,
      heldBy: '${row['terminal'] ?? 'another till'}',
      clerk: '${row['clerk_name'] ?? ''}',
      staffId: (row['staff_id'] as num?)?.toInt(),
    );
  }

  /// Take over a bill another terminal is holding.
  Future<bool> claim(String billId) async {
    final bill = state.bills[billId];
    if (bill == null || bill.heldBy == null) return true;
    if (state.demo) {
      _put(bill.copyWith(clearHeldBy: true));
      return true;
    }
    try {
      await ref.read(apiProvider).claimBill(billId, terminalName);
      _put(bill.copyWith(clearHeldBy: true));
      return true;
    } on TapApiError catch (e) {
      state = state.copyWith(message: e.message);
      return false;
    }
  }

  /// Tickets this phone sent that every station has finished: "food ready".
  Future<void> _checkKitchen() async {
    final mine = {for (final b in state.bills.values) for (final t in b.tickets) t: b.name};
    if (mine.isEmpty) return;
    try {
      final board = await ref.read(apiProvider).kitchenBoard();
      final alerts = <String>[];
      for (final t in board['tickets'] as List? ?? const []) {
        final ticket = Map<String, dynamic>.from(t as Map);
        final id = '${ticket['id']}';
        if (!mine.containsKey(id) || _readyTickets.contains(id)) continue;
        final stations = ticket['stations'] as List? ?? const [];
        if (stations.isNotEmpty && stations.every((s) => (s as Map)['status'] == 'done')) {
          _readyTickets.add(id);
          alerts.add('${mine[id]}: food ready to take out');
        }
      }
      if (alerts.isNotEmpty) state = state.copyWith(alerts: [...alerts, ...state.alerts].take(10).toList());
    } on TapApiError {
      // the next check will see it
    }
  }

  void clearAlerts() => state = state.copyWith(alerts: const []);

  Future<void> _flushOutbox() async {
    if (state.demo) return;
    await _outbox.flush();
    state = state.copyWith(pendingSync: await _outbox.pending());
  }

  // ---- Bills -------------------------------------------------------------------------

  Bill openTable(TableInfo table, {int covers = 0}) {
    final had = state.billForTable(table.id);
    if (had != null) return had;
    final bill = Bill(
      id: _uuid.v4(),
      name: table.name,
      tableId: table.id,
      tableNumber: table.number,
      roomId: table.roomId,
      covers: covers,
      clerk: state.clerk?.name ?? '',
      staffId: state.clerk?.id,
      openedAt: DateTime.now(),
    );
    _put(bill);
    return bill;
  }

  Bill openTab(String name) {
    final bill = Bill(id: _uuid.v4(), name: name, clerk: state.clerk?.name ?? '', staffId: state.clerk?.id, openedAt: DateTime.now());
    _put(bill, share: false);
    return bill;
  }

  /// Puts [product] on the bill and answers the id of the line it went on.
  String addLine(String billId, Product product, {List<Choice> choices = const [], String note = '', int seat = 0, bool hold = false}) {
    final bill = state.bills[billId]!;
    // The till's "consolidate lines" (or Go's own override): the same item,
    // with the same choices and note, not yet sent, goes up by one.
    if (state.config.stacks) {
      final i = bill.lines.lastIndexWhere((l) => l.sameAs(product, choices: choices, note: note, seat: seat, held: hold));
      if (i >= 0) {
        final lines = [...bill.lines];
        lines[i] = lines[i].copyWith(quantity: lines[i].quantity + 1);
        _put(bill.copyWith(lines: lines));
        return lines[i].id;
      }
    }
    final id = _uuid.v4();
    _put(bill.copyWith(lines: [
      ...bill.lines,
      BillLine(
        id: id,
        product: product,
        choices: choices,
        note: note,
        seat: seat,
        held: hold,
        addedBy: state.clerk?.name ?? '',
        addedAt: DateTime.now(),
      ),
    ]));
    return id;
  }

  /// A note on an unsent line (No ice, Well done...), for the kitchen ticket.
  void setNote(String billId, String lineId, String note) {
    final bill = state.bills[billId]!;
    _put(bill.copyWith(lines: [for (final l in bill.lines) l.id == lineId && !l.sent ? l.copyWith(note: note.trim()) : l]));
  }

  void changeQuantity(String billId, String lineId, int delta) {
    final bill = state.bills[billId]!;
    final lines = <BillLine>[];
    for (final l in bill.lines) {
      if (l.id != lineId) {
        lines.add(l);
        continue;
      }
      // A sent line goes only through a void with a reason (the till's rule).
      if (l.sent && delta < 0) {
        lines.add(l);
        continue;
      }
      final q = l.quantity + delta;
      if (q > 0) lines.add(l.copyWith(quantity: q));
    }
    _put(bill.copyWith(lines: lines));
  }

  /// Take [quantity] of a SENT line off, with a reason and a manager's approval.
  void voidLine(String billId, String lineId, {required int quantity, required String reason, required Clerk approvedBy}) {
    final bill = state.bills[billId]!;
    final line = bill.lines.firstWhere((l) => l.id == lineId);
    final q = quantity.clamp(1, line.unpaidQuantity);
    final record = VoidRecord(
      name: line.product.name,
      quantity: q,
      amountMinor: line.unitMinor * q,
      reason: reason,
      by: state.clerk?.name ?? '',
      approvedBy: approvedBy.name,
    );
    final lines = [
      for (final l in bill.lines)
        if (l.id != lineId) l else if (l.quantity - q > 0) l.copyWith(quantity: l.quantity - q),
    ];
    _put(bill.copyWith(lines: lines, voids: [...bill.voids, record]));
    final ticket = kitchenTicket(bill, [line.copyWith(quantity: q, note: 'VOID: $reason')],
        id: _uuid.v4(), office: state.venue?.office ?? '', kind: 'void');
    if (ticket != null && !state.demo) unawaited(_outbox.add('/till/kitchen/tickets', ticket).then((_) => _flushOutbox()));
  }

  /// Send what is new (not held) to the kitchen and bar. Returns how many lines went.
  int send(String billId) => _sendWhere(billId, (l) => !l.sent && !l.held);

  /// Fire the held course: mains away.
  int fire(String billId) => _sendWhere(billId, (l) => !l.sent && l.held);

  int _sendWhere(String billId, bool Function(BillLine) which) {
    final bill = state.bills[billId]!;
    final going = bill.lines.where(which).toList();
    if (going.isEmpty) return 0;
    final ticketId = _uuid.v4();
    final ticket = kitchenTicket(bill, going, id: ticketId, office: state.venue?.office ?? '',
        roomName: bill.tableId == null ? null : state.tables.where((t) => t.id == bill.tableId).firstOrNull?.area);
    final ids = {for (final l in going) l.id};
    _put(bill.copyWith(
      lines: [for (final l in bill.lines) ids.contains(l.id) ? l.copyWith(sent: true, held: false) : l],
      tickets: ticket == null ? bill.tickets : [...bill.tickets, ticketId],
    ));
    if (ticket != null && !state.demo) unawaited(_outbox.add('/till/kitchen/tickets', ticket).then((_) => _flushOutbox()));
    return going.length;
  }

  /// A discount on the whole sale: [percent] off, or [fixedMinor] pence off
  /// (zero both to take it off again).
  void setDiscount(String billId, {double percent = 0, int fixedMinor = 0, String reason = ''}) =>
      _put(state.bills[billId]!.copyWith(discountPercent: percent, discountFixedMinor: fixedMinor, discountReason: reason));

  /// An unpaid bill thrown away before anything was taken or sent: a counter
  /// sale the customer walked away from.
  void discard(String billId) {
    final bill = state.bills[billId];
    if (bill == null || bill.paidMinor > 0 || bill.lines.any((l) => l.sent)) return;
    state = state.copyWith(bills: Map.of(state.bills)..remove(billId));
    if (_connected && bill.heldBy == null) unawaited(ref.read(apiProvider).retireBill(billId, reason: 'cancelled').then((_) {}, onError: (Object _) {}));
  }

  /// Something for the back office that is not a sale (a refund for the Z),
  /// kept on the phone until the server takes it.
  Future<void> queue(String path, Map<String, Object?> body) async {
    if (state.demo) return;
    await _outbox.add(path, body);
    await _flushOutbox();
  }

  void setServiceCharge(String billId, double percent) =>
      _put(state.bills[billId]!.copyWith(serviceChargePercent: percent));

  /// A Loyalty member on the bill (their discount applies at once), or off it.
  void setMember(String billId, Member? member) =>
      _put(member == null ? state.bills[billId]!.copyWith(clearMember: true) : state.bills[billId]!.copyWith(member: member));

  /// A voucher the back office accepted, for [minor] off.
  void setVoucher(String billId, String code, int minor) =>
      _put(state.bills[billId]!.copyWith(voucherCode: code, voucherMinor: minor));

  /// A payment the server confirmed. A bill paid in full is closed: the sale
  /// goes to the back office (through the outbox) and off the shared plan.
  void addTender(String billId, Tender tender, {Map<String, int> items = const {}}) {
    final bill = state.bills[billId]!;
    final lines = [
      for (final l in bill.lines)
        items.containsKey(l.id) ? l.copyWith(paidQuantity: l.paidQuantity + items[l.id]!) : l,
    ];
    final next = bill.copyWith(lines: lines, tenders: [...bill.tenders, tender]);
    if (tender.kind != 'cash') {
      state = state.copyWith(recent: [
        RecentPayment(paymentId: tender.id, billId: bill.id, billName: bill.name, amountMinor: tender.amountMinor,
            tipMinor: tender.tipMinor, at: tender.at, clerk: tender.clerk),
        ...state.recent,
      ].take(50).toList());
    }
    if (next.dueMinor <= 0) {
      final bills = Map.of(state.bills)..remove(billId);
      state = state.copyWith(bills: bills, lastClosed: next);
      if (!state.demo) {
        final sale = salePayload(next, office: state.venue?.office ?? '', terminal: terminalName, clerkPin: null);
        unawaited(_outbox.add('/till/orders', sale).then((_) => _flushOutbox()));
        // The voucher is used up only now that the bill is paid, as on the till.
        if (next.voucherCode != null) {
          unawaited(_outbox.add('/api/vouchers/redeem', {'id': next.voucherCode, 'office': state.venue?.office, 'code': next.voucherCode}));
        }
        if (_connected) unawaited(ref.read(apiProvider).retireBill(billId).then((_) {}, onError: (Object _) {}));
      }
    } else {
      _put(next);
    }
  }

  /// A refund the server made, recorded against today's payment.
  void refunded(String paymentId, int refundedMinor) {
    state = state.copyWith(recent: [
      for (final r in state.recent)
        r.paymentId == paymentId
            ? RecentPayment(paymentId: r.paymentId, billId: r.billId, billName: r.billName, amountMinor: r.amountMinor,
                tipMinor: r.tipMinor, at: r.at, clerk: r.clerk, refundedMinor: refundedMinor)
            : r,
    ]);
  }

  void _put(Bill bill, {bool share = true}) {
    state = state.copyWith(bills: {...state.bills, bill.id: bill});
    if (share && _connected && bill.heldBy == null) {
      // On the venue's shared plan at once: the tills see this table now,
      // over the venue's network first and the back office as well.
      final payload = openBillPayload(bill, terminal: terminalName);
      if (_lanJoined) {
        try {
          LanService.instance.publish('bills', {...payload, 'changed_at': LanService.instance.now()}, key: bill.id);
        } catch (_) {}
      }
      unawaited(ref.read(apiProvider).saveBill(payload).then((_) {}, onError: (Object _) {}));
    }
  }
}
