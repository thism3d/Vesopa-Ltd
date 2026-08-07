import 'dart:async';
import 'dart:io';

import 'package:drift/drift.dart' show OrderingTerm, OrderingMode;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:window_manager/window_manager.dart';

import 'config/constants.dart';
import 'data/auth_service.dart';
import 'data/branding.dart';
import 'data/commerce.dart';
import 'data/floor_repository.dart';
import 'data/local/database.dart';
import 'data/loyalty_repository.dart';
import 'data/session_controller.dart';
import 'data/order_repository.dart';
import 'data/session_repository.dart';
import 'data/staff_repository.dart';
import 'data/staff_session.dart';
import 'data/sync_service.dart';
import 'data/table_repository.dart';
import 'data/till_settings.dart';
import 'payments/connect_pac.dart';
import 'payments/connect_ws.dart';
import 'payments/dojo_config.dart';
import 'payments/dojo_desktop.dart';
import 'payments/dojo_native.dart';
import 'payments/payment_provider.dart';
import 'ui/idle_screen.dart';
import 'ui/shell.dart';
import 'ui/sign_in_page.dart';
import 'ui/splash_page.dart';
import 'ui/theme.dart';
import 'ui/theme_controller.dart';

/// Where the server lives. Both resolve from [Api], which reads the single
/// `useLiveServer` switch in `config/constants.dart` — see that file to move
/// the app between the local and live servers.
final apiBaseProvider = Provider<String>((_) => Api.resolvedBase);

final wsUrlProvider = Provider<String>((_) => Api.resolvedWs);

final databaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase();
  ref.onDispose(db.close);
  return db;
});

final orderRepositoryProvider = Provider<OrderRepository>(
  (ref) => OrderRepository(ref.watch(databaseProvider)),
);

final sessionRepositoryProvider = Provider<SessionRepository>(
  (ref) => SessionRepository(ref.watch(databaseProvider)),
);

final tableRepositoryProvider = Provider<TableRepository>(
  (ref) => TableRepository(
    ref.watch(databaseProvider),
    ref.watch(orderRepositoryProvider),
  ),
);

final loyaltyRepositoryProvider = Provider<LoyaltyRepository>(
  (ref) => LoyaltyRepository(ref.watch(databaseProvider)),
);

/// Signing out: verifies the password against the live server and flushes every
/// offline sale before the session is cleared.
final authServiceProvider = Provider<AuthService>(
  (ref) => AuthService(
    apiBase: ref.watch(apiBaseProvider),
    db: ref.watch(databaseProvider),
    sync: ref.watch(syncServiceProvider),
  ),
);

/// Server-push events, surfaced from the sync service so non-DB providers can
/// refresh when the back office changes.
///
/// Carries a [SyncEvent] rather than the event name on its own so that two
/// pushes of the same kind are two distinct values — Riverpod drops a state
/// change that compares equal to the one before it, which used to swallow every
/// repeat. Listeners want `next.value?.type`.
final syncEventsProvider = StreamProvider<SyncEvent>((ref) {
  return ref.watch(syncServiceProvider).events;
});

/// The floor plan drawn in the back office, cached so it survives going offline.
///
/// Reloads automatically when the back office signals a floor change, so a
/// table added or moved in the office appears on the till without a manual
/// refresh.
final floorPlanProvider = FutureProvider<List<FloorRoom>>((ref) async {
  // A floor (or catalogue) push from the server re-runs this provider.
  ref.listen(syncEventsProvider, (_, next) {
    final type = next.value?.type;
    if (type == 'floor.updated' || type == 'catalogue.updated') {
      ref.invalidateSelf();
    }
  });

  final prefs = await SharedPreferences.getInstance();
  final office = ref.watch(officeProvider);
  final repo = FloorRepository(
    apiBase: ref.watch(apiBaseProvider),
    cache: PrefsFloorCache(prefs, office: office),
    office: office,
  );
  return repo.load();
});

/// The REST client for whichever acquirer this till is configured against.
///
/// Which one is decided by the **base URL**, because Dojo and Paymentsense
/// Connect are two different APIs behind one brand: Connect gives each merchant
/// their own host and drives the PDQ directly, Dojo shares one host and routes
/// by the key. Null until both a key and a URL are present.
({DojoProvider? dojo, ConnectPacProvider? connect})? _cardClients(
  DojoConfig? config, {
  required bool keyed,
}) {
  if (config == null || !config.configured) return null;

  final key = config.apiKey.trim();
  final terminal = config.terminalId.trim();
  final softwareHouse = config.softwareHouseId.trim();
  final reseller = config.resellerId.trim();

  if (config.platform == CardPlatform.connect) {
    // Connect keeps the reader for both routes: a keyed sale is the same
    // terminal transaction with `cardholderNotPresent` set, which sends the PDQ
    // straight to its "Key card number" screen. There is no other card surface
    // on a Connect account, so dropping the TID for the keyed route would leave
    // the button with nothing to talk to.
    return (
      dojo: null,
      connect: ConnectPacProvider(
        baseUrl: config.normalisedBaseUrl,
        apiKey: key,
        terminalId: terminal.isEmpty ? null : terminal,
        softwareHouseId: softwareHouse.isEmpty ? null : softwareHouse,
        installerId: reseller.isEmpty ? null : reseller,
      )
        // The socket is the preferred transport: the reader pushes each prompt
        // as it happens rather than the till polling for it once a second. The
        // provider falls back to REST on its own if this will not open, so a
        // venue is never left unable to take a card.
        ..socket = ConnectSocket(
          baseUrl: config.normalisedBaseUrl,
          apiKey: key,
          softwareHouseId: softwareHouse.isEmpty ? null : softwareHouse,
          installerId: reseller.isEmpty ? null : reseller,
        ),
    );
  }

  return (
    dojo: DojoProvider(
      apiKey: key,
      baseUrl: config.normalisedBaseUrl,
      // A keyed card must never reach for the reader, even on a till that has
      // one paired: a card machine can only take a card that is in the room.
      terminalId: keyed || terminal.isEmpty ? null : terminal,
      softwareHouseId: softwareHouse.isEmpty ? null : softwareHouse,
      resellerId: reseller.isEmpty ? null : reseller,
    ),
    connect: null,
  );
}

/// **Card** — a card the customer presents. Always the card machine where one
/// is configured, on Android and on Windows alike: that is what integrated
/// payments are for, and it is the only route that takes a chip or a tap.
///
/// Built from the terminal's runtime config ([dojoConfigProvider]) rather than
/// a build-time flag, so a till already installed can have its credentials
/// entered in Settings without a rebuild. Null until they are, so a till
/// without them shows cash only instead of failing at the moment of payment.
///
/// With no reader configured there is nothing to present a card *to*, so this
/// falls back to the same card-entry route as [manualCardProvider] rather than
/// leaving the Card button dead. Settings says plainly which of the two is
/// live.
final dojoProvider = Provider<PaymentProvider?>((ref) {
  final config = ref.watch(dojoConfigProvider).value;
  final clients = _cardClients(config, keyed: false);
  if (clients == null) return null;

  final connect = clients.connect;
  if (connect != null) return connect;

  final rest = clients.dojo!;
  // A reader on the counter drives the sale directly, on every platform.
  if (rest.canUseTerminal) return rest;

  return _keyedFallback(rest, config!);
});

/// **Manual card** — the number is keyed rather than presented, for a chip that
/// will not read, a telephone order, or a card taken from a booking. Recorded
/// separately because it carries different liability from a dipped card.
///
/// Where the keying happens is the acquirer's business, not the till's:
///
///   * Connect — on the PDQ itself, via `cardholderNotPresent`.
///   * Dojo on Android — the native drop-in SDK's own card form
///     (`tech.dojo.pay:uisdk`), in the app.
///   * Dojo on Windows — Dojo publish no desktop card SDK (`Dojo.Net` is a
///     server-side `PaymentIntentsClient` with no UI), so it is the hosted
///     checkout, rendered inside the till by `CardCheckoutPage` rather than
///     handed to a browser.
final manualCardProvider = Provider<PaymentProvider?>((ref) {
  final config = ref.watch(dojoConfigProvider).value;
  final clients = _cardClients(config, keyed: true);
  if (clients == null) return null;

  final connect = clients.connect;
  if (connect != null) return connect;

  return _keyedFallback(clients.dojo!, config!);
});

/// Card entry with no reader involved: the native drop-in on Android, the
/// hosted checkout on desktop. Plain REST polling is deliberately not an
/// option — it presents no card at all, which is what once left the till stuck
/// on "Waiting for the card…".
PaymentProvider _keyedFallback(DojoProvider rest, DojoConfig config) {
  if (Platform.isAndroid) {
    return NativeDojoProvider(
      intents: rest,
      isSandbox: config.isSandboxKey,
      // Google Pay rides along with the drop-in: same sheet, same result code.
      // Passed unconditionally — blank values are how the SDK is told there is
      // no wallet, so there is nothing to branch on here.
      walletMerchantName: config.walletMerchantName.trim(),
      walletMerchantId: config.walletMerchantId.trim(),
      walletGatewayMerchantId: config.walletGatewayMerchantId.trim(),
    );
  }
  if (Platform.isWindows || Platform.isMacOS || Platform.isLinux) {
    return DesktopDojoProvider(intents: rest);
  }
  return rest;
}

/// Who is signed into this terminal.
final sessionProvider = Provider<Session>(
  (ref) => ref.watch(sessionControllerProvider).value ?? Session.empty,
);

/// Which venue this terminal belongs to. Comes from the sign-in rather than a
/// build flag, so one APK can be installed in any venue.
final officeProvider = Provider<String>(
  (ref) => ref.watch(sessionProvider).office ?? '',
);

/// What this venue prints on its receipts, owned by the back office.
final brandingRepositoryProvider = Provider<BrandingRepository>(
  (ref) => BrandingRepository(
    apiBase: ref.watch(apiBaseProvider),
    office: ref.watch(officeProvider),
  ),
);

/// The branding a receipt is built from.
///
/// Exposed as the plain [Branding] rather than an AsyncValue: printing must
/// never block on this, so a till that has not loaded it yet prints with
/// defaults instead of waiting or failing.
/// The cash note keys, straight from the local cache so the payment screen
/// renders with no network at all. Synced by [SyncService.pullDenominations].
///
/// Sorted by the order the back office chose, then by value descending, so an
/// office that never set an order still gets the biggest note first.
final cashDenominationsProvider = StreamProvider<List<CashDenomination>>((ref) {
  final db = ref.watch(databaseProvider);
  return (db.select(db.cashDenominations)
        ..orderBy([
          (d) => OrderingTerm(expression: d.sortOrder),
          (d) => OrderingTerm(
                expression: d.valueMinor,
                mode: OrderingMode.desc,
              ),
        ]))
      .watch();
});

/// Pull the note-key artwork into Flutter's image cache before anybody needs it.
///
/// The note keys are photographs fetched over the network, and they were taking
/// a visible second or two to appear the first time a clerk opened the payment
/// screen — which is the one moment on a till where a picture arriving late
/// actually matters, because the clerk is matching what is in their hand to what
/// is on the screen while a customer waits.
///
/// Nothing is awaited and nothing is reported. A picture that will not load is
/// already handled where it is drawn (see CashNotesPanel, which falls back to
/// the label), and warming the cache is an optimisation — it must never be able
/// to delay the till opening or fail it. `onError` is what makes that true: a
/// precache that throws with no handler takes the error to the zone.
void warmCashNoteImages(
  Iterable<CashDenomination> denominations,
  BuildContext context,
) {
  final urls = <String>{
    for (final d in denominations)
      if (d.imageUrl != null && d.imageUrl!.isNotEmpty) d.imageUrl!,
  };

  for (final url in urls) {
    unawaited(
      precacheImage(NetworkImage(url), context, onError: (_, _) {}),
    );
  }
}

/// Reads whatever branding has already been fetched.
///
/// Deliberately pure: it starts no network work of its own, so reading it on
/// the way to the printer cannot stall a receipt (or, in a test, leave a
/// pending timer behind). [brandingRefreshProvider] does the fetching.
final brandingProvider = Provider<Branding>(
  (ref) => ref.watch(brandingRepositoryProvider).cached ?? const Branding(),
);

/// Keeps branding current in the background.
///
/// Watched once by the shell at startup rather than at print time, and
/// re-fetched when the back office broadcasts a change, so a new footer or
/// logo reaches the tills without anyone restarting a terminal.
final brandingRefreshProvider = FutureProvider<Branding>((ref) async {
  final office = ref.watch(officeProvider);
  // Before sign-in there is no venue to fetch for.
  if (office.isEmpty) return const Branding();

  ref.listen(syncEventsProvider, (_, next) {
    if (next.value?.type == 'branding') ref.invalidateSelf();
  });

  final branding = await ref.watch(brandingRepositoryProvider).load();
  // Publish the freshly cached copy to anything about to print.
  ref.invalidate(brandingProvider);
  return branding;
});

// ---- Idle screen & staff sign-on ------------------------------------------

/// How this venue's terminals behave between sales, owned by the back office.
final tillSettingsRepositoryProvider = Provider<TillSettingsRepository>(
  (ref) => TillSettingsRepository(
    apiBase: ref.watch(apiBaseProvider),
    office: ref.watch(officeProvider),
  ),
);

/// The settings the idle screen is drawn from.
///
/// Pure, like [brandingProvider]: raising the idle screen must never wait on the
/// network, so this reads whatever was last cached and [tillSettingsRefreshProvider]
/// does the fetching.
final tillSettingsProvider = Provider<TillSettings>(
  (ref) =>
      ref.watch(tillSettingsRepositoryProvider).cached ?? TillSettings.defaults,
);

/// How often the till re-reads its settings when nothing has told it to.
///
/// The backstop behind the push below, and the reason a new idle screen now
/// reliably appears. The socket only reaches terminals that are connected at the
/// moment the manager saves — a till on a dropped link, one still booting, one
/// behind a router that ate the frame, gets nothing. Before this, that terminal
/// kept the old picture until somebody restarted it, which is exactly the
/// "adding an idle screen doesn't update on the till" the venue reported.
///
/// Two minutes is chosen against what it costs: one small unauthenticated GET
/// per terminal, against a manager standing at a till waiting to see their
/// change land. Nothing here is on the path of a sale.
const _tillSettingsPoll = Duration(minutes: 2);

/// Keeps the till settings current, and hands the sign-off timer its numbers.
///
/// The `configure` call is the link between the back office and the timer: a
/// manager changing three minutes to five, or switching the PIN off, reaches
/// every terminal without anyone restarting one.
///
/// Three routes in, because one was not enough:
///
///  1. **The push**, for a terminal that is connected — a second or two.
///  2. **The network coming back**, which is the moment a terminal that missed
///     the push is able to ask.
///  3. **The poll**, for everything the first two do not cover.
final tillSettingsRefreshProvider = FutureProvider<TillSettings>((ref) async {
  final office = ref.watch(officeProvider);
  if (office.isEmpty) return TillSettings.defaults;

  ref.listen(syncEventsProvider, (_, next) {
    if (next.value?.type == 'till-settings') ref.invalidateSelf();
  });

  // Offline -> online. Same treatment as the staff list, and for the same
  // reason: a till switched on before the broadband was up otherwise keeps
  // whatever it had.
  ref.listen(syncStatusProvider, (previous, next) {
    final was = previous?.value?.online ?? false;
    final now = next.value?.online ?? false;
    if (!was && now) ref.invalidateSelf();
  });

  final timer = Timer.periodic(_tillSettingsPoll, (_) => ref.invalidateSelf());
  ref.onDispose(timer.cancel);

  final settings = await ref.watch(tillSettingsRepositoryProvider).load();
  ref.invalidate(tillSettingsProvider);

  ref.read(staffSessionProvider.notifier).configure(
        signoffSeconds: settings.signoffSeconds,
        requirePin: settings.idleRequirePin,
      );

  return settings;
});

/// The staff list, and the PIN check that reads it.
final staffRepositoryProvider = Provider<StaffRepository>(
  (ref) => StaffRepository(
    apiBase: ref.watch(apiBaseProvider),
    db: ref.watch(databaseProvider),
    terminalToken: ref.watch(sessionProvider).terminalToken,
  ),
);

/// Who may sign on, straight from the local cache so the PIN pad renders and
/// answers with no network at all.
final staffListProvider = StreamProvider<List<StaffData>>((ref) {
  final db = ref.watch(databaseProvider);
  return (db.select(db.staff)
        ..orderBy([(s) => OrderingTerm(expression: s.pluid)]))
      .watch();
});

/// Whether this terminal can actually check a PIN.
///
/// False when nobody is cached — either the till was commissioned before the
/// terminal token existed and cannot read the list, or the venue has not added
/// anyone yet. Both cases mean the idle screen must not demand a PIN: a lock with
/// no key is a till that cannot trade, which is a worse fault than an unlocked
/// screen. Everything that raises the lock consults this first.
final canSignOnProvider = Provider<bool>((ref) {
  final staff = ref.watch(staffListProvider).value;
  return staff != null && staff.isNotEmpty;
});

/// Pulls the staff list in the background, and again whenever the back office
/// changes it.
///
/// Failures are deliberately swallowed: the cached list is what signs people on,
/// so a terminal that cannot reach the server carries on working with the staff
/// it already knows about. The PIN pad is what tells the clerk when there is
/// genuinely nobody to sign on as.
final staffSyncProvider = FutureProvider<void>((ref) async {
  final session = ref.watch(sessionProvider);
  if (session.office?.isEmpty ?? true) return;

  // A change made in the back office reaches an *already running* till this way,
  // within a second. The socket only serves terminals that are connected at the
  // time, which is why it is a supplement to SyncService.resync rather than the
  // only route.
  ref.listen(syncEventsProvider, (_, next) {
    if (next.value?.type == 'staff.updated') ref.invalidateSelf();
  });

  // The network coming back is the other moment a stale list gets corrected.
  // Without this, a till switched on before the broadband was up kept whatever
  // it had until something else happened to refresh it.
  ref.listen(syncStatusProvider, (previous, next) {
    final was = previous?.value?.online ?? false;
    final now = next.value?.online ?? false;
    if (!was && now) ref.invalidateSelf();
  });

  try {
    await ref.watch(staffRepositoryProvider).sync();
  } on StaffSyncFailed {
    // Keep whatever is cached.
  }
});

/// Refresh the staff list before the till is handed over, not after.
///
/// Bounded, and deliberately so. Waiting on the network before a till will open
/// is exactly the kind of thing that turns a broadband fault into a venue that
/// cannot trade, so this gives the pull a few seconds and then gets out of the
/// way — the cached list is perfectly good, and [SyncService.resync] will correct
/// it the moment the connection returns.
///
/// The wait is free in practice: the splash animation is already running.
Future<void> refreshStaffBeforeOpening(WidgetRef ref) async {
  try {
    await ref
        .read(staffSyncProvider.future)
        .timeout(const Duration(seconds: 4));
  } catch (_) {
    // Offline, slow, or refused. Open the till anyway.
  }
}

/// Whose name goes on this sale.
///
/// The signed-on member of staff, falling back to the account the terminal was
/// commissioned with. The fallback is what keeps a venue that does not use staff
/// sign-on printing exactly the "Served by" it always has — the feature is
/// additive, and switching it off must not blank a receipt line.
final servedByProvider = Provider<String?>((ref) {
  final staff = ref.watch(staffSessionProvider).name;
  if (staff != null && staff.isNotEmpty) return staff;
  return ref.watch(sessionProvider).name;
});

/// The staff row id for the person on shift, for reports to group by. Null when
/// nobody is signed on — a name can be edited or repeated, an id cannot.
final servedByIdProvider = Provider<int?>(
  (ref) => ref.watch(staffSessionProvider).staff?.id,
);

/// A background image chosen on *this* terminal, overriding the back office's.
///
/// Per-terminal because it is a per-terminal decision — a venue with a screen in
/// the window and one behind the bar may not want the same picture on both. Held
/// as a path rather than a copy of the file: the operator picked a file, and if
/// they move or replace it the till should follow, not keep a stale duplicate.
class IdleImageOverride extends AsyncNotifier<String?> {
  static const _key = 'idle_image_path';

  @override
  Future<String?> build() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_key);
  }

  Future<void> set(String? path) async {
    final prefs = await SharedPreferences.getInstance();
    if (path == null || path.isEmpty) {
      await prefs.remove(_key);
    } else {
      await prefs.setString(_key, path);
    }
    state = AsyncData(path);
  }
}

final idleImageOverrideProvider =
    AsyncNotifierProvider<IdleImageOverride, String?>(IdleImageOverride.new);

/// Vouchers, gift cards, deposits, loyalty and promotions.
final commerceRepositoryProvider = Provider<CommerceRepository>(
  (ref) => CommerceRepository(
    apiBase: ref.watch(apiBaseProvider),
    office: ref.watch(officeProvider),
  ),
);

/// How this venue takes money. Cached, so the payment screen never waits.
final tenderSettingsProvider = Provider<TenderSettings>(
  (ref) => ref.watch(commerceRepositoryProvider).tenderSettings,
);

/// The offers live right now. Read from cache for the same reason: pricing a
/// basket happens on every tap and must not touch the network.
final promotionsProvider = Provider<List<Promotion>>(
  (ref) => ref.watch(commerceRepositoryProvider).promotions,
);

/// Pulls tender settings and promotions in the background, and refreshes them
/// when the back office changes either.
final commerceRefreshProvider = FutureProvider<void>((ref) async {
  final office = ref.watch(officeProvider);
  if (office.isEmpty) return;

  ref.listen(syncEventsProvider, (_, next) {
    const watched = {'promotions', 'tender.settings', 'loyalty', 'vouchers'};
    if (watched.contains(next.value?.type)) ref.invalidateSelf();
  });

  final repo = ref.watch(commerceRepositoryProvider);
  await repo.loadTenderSettings();
  await repo.loadPromotions();

  // Publish the freshly cached copies to anything about to price a basket.
  ref.invalidate(tenderSettingsProvider);
  ref.invalidate(promotionsProvider);
});

final syncServiceProvider = Provider<SyncService>((ref) {
  final sync = SyncService(
    ref.watch(databaseProvider),
    apiBase: ref.watch(apiBaseProvider),
    wsUrl: ref.watch(wsUrlProvider),
    office: ref.watch(officeProvider),
  );

  // Staff rides on the same catch-up as the catalogue: startup, every reconnect,
  // and the 30-second backstop. Read lazily inside the callback rather than
  // captured now, so a terminal that signs in later picks up its token without
  // this service being rebuilt.
  sync.pullStaff = () => ref.read(staffRepositoryProvider).sync();

  ref.onDispose(sync.dispose);
  return sync;
});

/// Live online/offline + backlog state for the till's status badge. Seeded with
/// the service's current status so the badge is correct the instant it mounts,
/// before the first stream event arrives.
final syncStatusProvider = StreamProvider<SyncStatus>((ref) {
  final sync = ref.watch(syncServiceProvider);
  return sync.status;
});

/// Desktop tills run as a kiosk: full screen, and with no way to close or
/// minimise the window from the title bar.
///
/// A till that can be minimised is a till that can be minimised *by a customer
/// leaning over the counter*, and a closed till stops taking money until
/// someone finds the shortcut to reopen it. Staff still get out through Sign
/// out, which is the route that ends a session properly.
///
/// Mobile is untouched — Android and iOS have no window chrome to hide, and
/// window_manager does not support them.
Future<void> _lockWindowToKiosk() async {
  if (!(Platform.isWindows || Platform.isMacOS || Platform.isLinux)) return;

  await windowManager.ensureInitialized();
  await windowManager.waitUntilReadyToShow(
    const WindowOptions(
      // `hidden` drops the whole bar on macOS. On Windows the buttons are
      // disabled individually below, which keeps the window draggable.
      titleBarStyle: TitleBarStyle.hidden,
      fullScreen: true,
    ),
    () async {
      await windowManager.setClosable(false);
      await windowManager.setMinimizable(false);
      await windowManager.setFullScreen(true);
      await windowManager.show();
      await windowManager.focus();
    },
  );
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await _lockWindowToKiosk();
  runApp(const ProviderScope(child: VesopaEposApp()));
}

class VesopaEposApp extends ConsumerStatefulWidget {
  const VesopaEposApp({super.key});

  @override
  ConsumerState<VesopaEposApp> createState() => _VesopaEposAppState();
}

class _VesopaEposAppState extends ConsumerState<VesopaEposApp> {
  bool _splashDone = false;

  /// So the recovery below runs once, not on every rebuild.
  bool _recommissioning = false;

  /// A terminal whose stored session predates the terminal token cannot read its
  /// staff list, so staff sign-on can never work on it. Rather than explain that
  /// on a screen the operator then has to act on, the till clears the session and
  /// shows the sign-in page: signing in is the fix, so ask for the sign-in.
  ///
  /// Only the session is cleared. The local database — the outbox of sales not yet
  /// pushed, parked bills, the cached catalogue — is deliberately left alone: the
  /// outbox is the only copy of that money, and wiping it to tidy up a token
  /// would destroy takings. Signing back into the same office picks all of it up
  /// and flushes the outbox on the next sync.
  void _recommissionIfNeeded(Session session) {
    if (_recommissioning) return;
    if (!session.signedIn || session.commissioned) return;

    _recommissioning = true;
    // After the frame: this is called from build, and signOut moves provider
    // state.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await ref.read(sessionControllerProvider.notifier).signOut();
    });
  }

  @override
  Widget build(BuildContext context) {
    // Dark until the stored preference loads, so the app never flashes white
    // on startup before settling into the operator's actual choice.
    final mode = ref.watch(themeControllerProvider).value ?? ThemeMode.dark;
    final session = ref.watch(sessionControllerProvider);

    // Warm the note-key pictures. Listened for here, at the root, because this
    // widget is alive from launch — so the first emission of the cached set
    // lands while the splash is still animating and the images are decoded
    // before the till has even opened, which is what the venue asked for.
    //
    // It is a listen rather than a one-shot at startup because the set moves:
    // the first sync of a new terminal, and any artwork changed in the back
    // office afterwards, both arrive as a fresh emission here and get the same
    // treatment.
    ref.listen(cashDenominationsProvider, (_, next) {
      final rows = next.value;
      if (rows != null && rows.isNotEmpty) warmCashNoteImages(rows, context);
    });

    final current = session.value;
    if (current != null) _recommissionIfNeeded(current);

    return MaterialApp(
      title: 'VesopaEPOS',
      debugShowCheckedModeBanner: false,
      theme: buildPosTheme(Brightness.light),
      darkTheme: buildPosTheme(Brightness.dark),
      themeMode: mode,
      home: !_splashDone
          // The splash is held until the staff list has had its chance to
          // refresh, so the till opens on current names and PINs rather than on
          // whatever it had when it was last switched off. Bounded, so a till
          // with no network still opens — see refreshStaffBeforeOpening.
          ? SplashPage(
              onDone: () async {
                await refreshStaffBeforeOpening(ref);
                if (mounted) setState(() => _splashDone = true);
              },
            )
          : switch (session) {
              // Not commissioned yet, or signed out: ask who this is. The till
              // cannot sell before it knows which venue's catalogue to load.
              AsyncData(value: final s) when !s.signedIn => const SignInPage(),
              // Holds a session but no terminal token: _recommissionIfNeeded is
              // clearing it, so show the sign-in it is about to land on rather
              // than a flash of the till.
              AsyncData(value: final s) when !s.commissioned =>
                const SignInPage(),
              AsyncData() => const _LockedTill(child: PosShell()),
              _ => const Scaffold(
                body: Center(child: CircularProgressIndicator()),
              ),
            },
    );
  }
}

/// The till, with the idle screen over the top of it when it is up.
///
/// Wrapping the shell rather than living inside it, for two reasons:
///
///  * The idle screen has to cover *everything*, dialogs and sheets included. A
///    lock that a half-open payment dialog painted over would not be a lock.
///  * The shell keeps its state while the screen is up. Whoever signs back on
///    returns to the same bill, the same category, the same scroll position —
///    the till was covered, not restarted.
class _LockedTill extends ConsumerWidget {
  const _LockedTill({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Start the background pulls that feed this. Watched here rather than in the
    // shell so the settings are loaded and the timer configured before the first
    // sale can complete.
    ref.watch(tillSettingsRefreshProvider);
    ref.watch(staffSyncProvider);

    final settings = ref.watch(tillSettingsProvider);
    final staffSession = ref.watch(staffSessionProvider);

    // A venue with the idle screen switched off never sees any of this, and the
    // pointer listener below costs it nothing.
    //
    // The second clause is what covers a till that has just been switched on:
    // nobody has signed on yet, so a venue that wants a PIN gets the idle screen
    // rather than an open till. Where the venue does *not* want a PIN there is
    // nothing to unlock with, so the till simply opens.
    //
    // canSignOn is the guard against locking a terminal shut. A till with no
    // staff cached — commissioned before the terminal token existed, or at a
    // venue that has not added anyone — cannot answer a PIN, so it is never held
    // behind one at startup. The screensaver still appears after a sale, and the
    // pad it opens carries its own way out.
    final canSignOn = ref.watch(canSignOnProvider);
    final showIdle = settings.idleEnabled &&
        (staffSession.idle ||
            (settings.idleRequirePin && canSignOn && !staffSession.signedOn));

    return Listener(
      // Any pointer down anywhere is activity. `behavior: deferToChild` would
      // miss taps that the child handles, which is most of them — this has to see
      // the event on the way past, not compete for it.
      behavior: HitTestBehavior.translucent,
      onPointerDown: (_) => ref.read(staffSessionProvider.notifier).touch(),
      onPointerSignal: (_) => ref.read(staffSessionProvider.notifier).touch(),
      child: Stack(
        children: [
          child,
          // The idle screen does not blink in and out. It comes down over the
          // till like a shutter and goes back up off it, which is what makes
          // "the till locked" and "the till opened" read as events rather than
          // as a repaint. [_IdleShutter] owns that movement, and keeps the
          // screen mounted for as long as it takes to leave.
          _IdleShutter(
            showing: showIdle,
            builder: (_) => IdleScreen(settings: settings),
          ),
        ],
      ),
    );
  }
}

/// The idle screen's entrance and exit: down from the top, and back up to it.
///
/// This exists because `if (showIdle) IdleScreen(...)` cannot animate away — by
/// the time the flag is false the widget is already gone, so an exit has nothing
/// left to run on. Holding the screen here keeps it mounted through the whole
/// closing move and only then lets it go, which is also what resets it: the
/// state (and with it any half-typed PIN) is disposed when the shutter finishes
/// lifting, never while it is still on screen.
class _IdleShutter extends StatefulWidget {
  const _IdleShutter({required this.showing, required this.builder});

  final bool showing;
  final WidgetBuilder builder;

  @override
  State<_IdleShutter> createState() => _IdleShutterState();
}

class _IdleShutterState extends State<_IdleShutter>
    with SingleTickerProviderStateMixin {
  /// Slower coming down than going up, on purpose. The lock is the till taking
  /// itself away and can afford to be seen doing it; the unlock is answering
  /// someone who has just typed their PIN and is waiting, so it gets out of the
  /// way. Equal timings made the unlock feel like a delay.
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 460),
    reverseDuration: const Duration(milliseconds: 320),
    // A till that starts up locked is locked, not caught mid-close.
    value: widget.showing ? 1 : 0,
  );

  /// Decelerating in and accelerating out, so the shutter lands rather than
  /// stops, and leaves rather than drifts.
  late final Animation<double> _slide = CurvedAnimation(
    parent: _controller,
    curve: Curves.easeOutCubic,
    reverseCurve: Curves.easeInCubic,
  );

  @override
  void didUpdateWidget(covariant _IdleShutter oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.showing != oldWidget.showing) {
      if (widget.showing) {
        _controller.forward();
      } else {
        _controller.reverse();
      }
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _slide,
      builder: (context, _) {
        // Fully up and out of the way: nothing in the tree, so the till below is
        // untouched by a lock that is not happening. This is also what disposes
        // the idle screen's state, so the next lock opens a clean one.
        if (_controller.isDismissed) return const SizedBox.shrink();

        // Off the top by its own height at 0, flush at 1. Unpositioned, exactly
        // as the screen was before: SlideTransition is a transform and passes
        // the stack's constraints straight through, so the shutter still covers
        // everything.
        return FractionalTranslation(
          translation: Offset(0, _slide.value - 1),
          // The leading edge, and the only thing on this screen that is not
          // black: a lime rule riding the bottom of the shutter as it travels.
          // It reads as the brand closing the till rather than the display
          // failing, which on a shop floor is the difference that matters. It
          // fades out as the shutter seats, so the screen at rest is the
          // venue's picture and nothing else.
          child: Stack(
            children: [
              widget.builder(context),
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: IgnorePointer(
                  child: Opacity(
                    // Gone by the time it lands. Held at full while travelling
                    // so the edge is legible for the whole move.
                    opacity: (1 - _slide.value).clamp(0.0, 1.0),
                    child: Container(
                      height: 3,
                      decoration: const BoxDecoration(
                        color: Pos.brand,
                        boxShadow: [
                          BoxShadow(color: Pos.brand, blurRadius: 18, spreadRadius: 1),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
