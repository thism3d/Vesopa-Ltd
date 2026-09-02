import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/constants.dart';
import '../data/customer_display.dart';
import '../data/device_registry.dart';
import '../data/display_pairing.dart';
import '../data/session_controller.dart';
import '../data/staff_session.dart';
import '../data/sync_service.dart';
import '../data/terminal_identity.dart';
import '../data/terminal_service.dart';
import '../main.dart';
import 'layout.dart';
import 'about_page.dart';
import 'card_actions.dart';
import 'functions_page.dart';
import 'logout_dialog.dart';
import 'nav_panel_controller.dart';
import 'pair_request_overlay.dart';
import 'placeholder_page.dart';
import 'products_page.dart';
import 'settings_page.dart';
import 'receipts_page.dart';
import 'recovery_page.dart';
import 'reports_page.dart';
import 'sale_page.dart';
import 'swipe_listener.dart';
import 'tables_page.dart';
import 'theme.dart';
import 'widgets/pos_message.dart';
import 'widgets/nav_rail.dart';
import 'widgets/till_top_bar.dart';

/// The till frame: fixed nav rail on the left, the selected page beside it.
class PosShell extends ConsumerStatefulWidget {
  const PosShell({super.key});

  @override
  ConsumerState<PosShell> createState() => _PosShellState();
}

class _PosShellState extends ConsumerState<PosShell> {
  int _index = 0;
  String? _orderId;

  /// Which bill the customer display is following.
  ///
  /// The shell owns the *subscription* because it is the only thing that knows
  /// which bill is in front of the customer — the sale page is rebuilt,
  /// replaced and swapped between orders, and a publisher owned by it would
  /// restart on every one of those. The feed itself is shared (see
  /// `customerDisplayProvider`), because the payment screen writes to it too.
  StreamSubscription<void>? _displayFeed;

  /// Says "this till is running" for any customer display on this machine.
  ///
  /// A display cannot ask whether a process is running — there is no supported
  /// way to do that from a sandboxed application — so the till says so, every
  /// few seconds, and the display judges by the timestamp. See
  /// data/display_pairing.dart.
  Timer? _presence;

  /// Held for [dispose], which cannot `ref.read` a container that may already
  /// have gone.
  String? _presenceDeviceId;

  /// Held rather than read through `ref` each time, because [dispose] needs it
  /// and a `ref.read` there is a read against a container that may already have
  /// gone.
  late final CustomerDisplayFeed _display;

  /// Why the till could not open a bill, when it could not.
  ///
  /// This used to be nowhere: [_newOrder] awaited a database write and, if that
  /// threw, simply never set [_orderId] — leaving the shell drawn, the tab bar
  /// drawn, "Online" drawn, and a spinner where the sale buttons go. For ever,
  /// with the exception swallowed. That is the screen a broken migration put in
  /// front of an operator, and there was nothing on it to act on.
  Object? _openFailure;

  /// Lets the desktop title bar's Settings button open the nav drawer, which is
  /// otherwise only reachable from an AppBar's automatic hamburger.
  final _scaffold = GlobalKey<ScaffoldState>();

  @override
  void initState() {
    super.initState();
    // Start syncing only once the terminal knows which venue it belongs to —
    // before sign-in there is no catalogue to pull.
    ref.read(syncServiceProvider).start();
    // And the venue's shared open bills, for the same reason and at the same
    // moment: before sign-in there is no venue whose tables this terminal
    // could be showing. A no-op on a till that is not commissioned for it.
    ref.read(billSyncRunnerProvider);
    _display = ref.read(customerDisplayProvider);
    unawaited(_announceThisMachine());
    unawaited(_readCardRules());
    unawaited(_startPresence());
    _newOrder();
  }

  /// Load the venue's card prefixes, then refresh them.
  ///
  /// Stored first and pulled second, so a till with no network starts reading
  /// cards immediately with whatever it had last — and a brand new one starts
  /// with the defaults, which are this venue's real numbers. A reader that only
  /// worked once the broadband was up would be a staff card that cannot unlock
  /// the till at the one moment it matters.
  /// Start saying that this till is here, and keep saying it.
  ///
  /// The heartbeat runs whether or not anybody has signed in: "installed and
  /// running but signed out" is a state the display needs to be able to tell
  /// apart from "not running at all", because the two call for completely
  /// different things from whoever is standing in front of the screen.
  Future<void> _startPresence() async {
    final pairing = ref.read(displayPairingProvider);
    final deviceId = await terminalDeviceId();
    if (!mounted) return;
    _presenceDeviceId = deviceId;

    Future<void> beat() async {
      final session = ref.read(sessionControllerProvider).value;
      await pairing.announcePresence(
        deviceId: deviceId,
        terminalName: ref.read(terminalNameProvider),
        venueName: session?.venueName ?? '',
        appVersion: VesopaBrand.appVersion,
        signedIn: session?.signedIn ?? false,
      );
    }

    await beat();
    _presence = Timer.periodic(tillPresenceInterval, (_) => unawaited(beat()));
  }

  Future<void> _readCardRules() async {
    final cards = ref.read(cardRepositoryProvider);
    await cards.load();
    if (!mounted) return;
    // The pull is a courtesy. Nothing waits on it and a failure is not reported
    // anywhere: the till carries on with what it had.
    await cards.sync();
    if (!mounted) return;
    // Anything already on screen that is laid out from these rules -- the Swipe
    // cards page, chiefly -- watches this rather than the repository, which
    // mutates in place and so never looks changed. See cardRulesRevisionProvider.
    ref.read(cardRulesRevisionProvider.notifier).bump();
    setState(() {});
  }

  /// Re-read the card rules when the back office changes them.
  ///
  /// The rules were read once, at start-up, and nothing brought them back. That
  /// was survivable while they were only prefixes -- a venue sets those once and
  /// never touches them again -- and stopped being survivable when they grew the
  /// two switches that decide whether the counter is offered a card at all. A
  /// manager turning those off in the back office and walking out to the till to
  /// check would have found them still there, with no way to tell a setting that
  /// had not arrived from one that does not work.
  ///
  /// `cards` is the event PUT /api/cards/settings already broadcasts. The till
  /// was simply not listening to it.
  void _watchCardRules() {
    ref.listen(syncEventsProvider, (_, next) {
      if (next.value?.type == 'cards') unawaited(_readCardRules());
    });
  }

  /// Re-grant every paired display, and tell the back office what is here.
  ///
  /// Runs once, on the first screen the till draws after sign-in.
  ///
  /// The re-grant is what makes a pairing survive this application being
  /// upgraded, reinstalled, or moved between the .exe and the Store: the
  /// relationship is remembered and the *path* is written afresh from wherever
  /// this build actually writes today. See data/display_pairing.dart. A venue
  /// that has paired its display once never has to do it again, and the class of
  /// fault where a screen quietly follows a folder nobody writes to any more
  /// cannot come back.
  ///
  /// The registration is best-effort and unawaited by anything. A till whose
  /// POST does not land sells exactly as it did; the back office's device list
  /// is a day out of date until the next start.
  Future<void> _announceThisMachine() async {
    final session = ref.read(sessionControllerProvider).value;
    // Nothing to do on a till nobody has signed in: a display is registered
    // against a venue, and there is not one yet.
    if (session == null || !session.signedIn) return;

    final office = session.office ?? '';
    final terminalName = ref.read(terminalNameProvider);
    final pairing = ref.read(displayPairingProvider);

    await pairing.refreshGrants(
      office: office,
      terminalName: terminalName,
      venueName: session.venueName,
    );

    final registry = ref.read(deviceRegistryProvider);
    if (!registry.canRegister) return;

    await registry.register(
      describeDevices(
        terminalDeviceId: await terminalDeviceId(),
        terminalName: terminalName,
        appVersion: VesopaBrand.appVersion,
        signedInAs: session.email,
        displays: await pairing.paired(),
      ),
    );
  }

  @override
  void dispose() {
    _presence?.cancel();
    // Say the till has gone, so a display on this machine stops offering a code
    // the moment the till closes rather than twenty seconds later. Best effort:
    // a till that loses power says nothing, which is why the display judges by
    // the timestamp and not by whether this file exists.
    final deviceId = _presenceDeviceId;
    if (deviceId != null) {
      unawaited(ref.read(displayPairingProvider).withdrawPresence(deviceId));
    }
    _displayFeed?.cancel();
    // Put the customer's screen back to adverts rather than leaving the last
    // bill of the night on it.
    unawaited(_display.clear());
    super.dispose();
  }

  /// Follow [orderId] on the customer display.
  ///
  /// Re-subscribed rather than filtered, so switching to another table stops
  /// publishing the one before it immediately — a customer standing at the
  /// counter must never see the previous table's bill.
  void _followOnDisplay(String? orderId) {
    _displayFeed?.cancel();
    _displayFeed = null;

    if (orderId == null) {
      unawaited(_display.clear());
      return;
    }

    final repo = ref.read(orderRepositoryProvider);
    _displayFeed = repo
        .watchOrder(orderId)
        .asyncMap((order) async {
          final lines = await repo.watchLines(orderId).first;
          return snapshotFor(
            lines: lines,
            subtotalMinor: order.subtotalMinor,
            discountMinor: order.discountMinor,
            taxMinor: order.taxMinor,
            totalMinor: order.totalMinor,
          );
        })
        .listen(
          (snapshot) => unawaited(_display.publish(snapshot)),
          // A database stream that ends badly must not take the till's shell
          // down. The display stops updating; the sale carries on.
          onError: (Object _) {},
          cancelOnError: false,
        );
  }

  Future<void> _newOrder() async {
    try {
      final id = await ref.read(orderRepositoryProvider).openOrder();
      if (!mounted) return;
      setState(() {
        _orderId = id;
        _openFailure = null;
      });
      _followOnDisplay(id);
    } catch (e) {
      // The local database would not answer. Nothing else on this screen can
      // work without it, so say so and offer the repair rather than spin.
      if (mounted) setState(() => _openFailure = e);
    }
  }

  /// Sign out. The dialog verifies the password against the live server and
  /// refuses while this terminal still holds sales the server has never seen.
  Future<void> _logout() async {
    final done = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const LogoutDialog(),
    );

    if (done == true) {
      // Wipe this venue's cached catalogue and deals. Without this, a terminal
      // re-commissioned to another office would open showing the previous
      // office's products.
      final db = ref.read(databaseProvider);
      await db.delete(db.products).go();
      await db.delete(db.mixMatchProducts).go();
      await db.delete(db.mixMatchDeals).go();

      // Clearing the session drops the app back to the sign-in screen, which is
      // what the next person on this terminal should see.
      await ref.read(sessionControllerProvider.notifier).signOut();
    }
  }

  @override
  Widget build(BuildContext context) {
    // Pull the venue's receipt branding down once the till is running, so the
    // first receipt of the day already carries the logo and footer. Watched
    // here rather than at print time: printing must read a cache, never wait
    // on the network.
    ref.watch(brandingRefreshProvider);
    ref.watch(commerceRefreshProvider);

    // Registered here because ref.listen belongs in build(). It is idempotent
    // across rebuilds -- Riverpod replaces the subscription rather than adding
    // a second one.
    _watchCardRules();

    // Shown instead of the shell, not inside it: a till that cannot open a bill
    // cannot do anything the tabs offer either.
    if (_openFailure case final failure?) {
      return RecoveryPage(
        failure: failure,
        onRetry: () async {
          setState(() => _openFailure = null);
          await _newOrder();
        },
      );
    }

    // A bill a clerk has just brought with them from another terminal. The
    // shell is the only thing that can change which bill is on screen, and
    // sign-on happens in three places -- see broughtBasketProvider.
    //
    // Cleared before the switch, not after, so a rebuild mid-switch cannot fire
    // it twice.
    ref.listen<String?>(broughtBasketProvider, (_, next) {
      if (next == null) return;
      ref.read(broughtBasketProvider.notifier).taken();
      unawaited(_switchToOrder(next));
    });

    final orderId = _orderId;

    // Whether the side menu is fixed on screen or opens from the menu key is
    // the operator's choice now — see NavPanelMode. Default (auto) is fixed on
    // a desktop-width screen and tucked away below it.
    final navMode =
        ref.watch(navPanelControllerProvider).value ?? NavPanelMode.auto;
    final pinned = navMode.isPinnedOn(context.layout);

    // There used to be two bars here, one above the other, both saying who was
    // signed on and whether the till was online — and the venue asked for the
    // top one to go. It could only ever go on the Sale screen, because that is
    // the only place a programmed bar drew, and everywhere else it was the only
    // chrome there was: no shift name, no online state, and no way back to the
    // menu when the rail was tucked away.
    //
    // Now there is one bar. [TillTopBar] draws it on every section, with the
    // page selector pinned at its left where no layout can delete it, and the
    // Sale screen fills the middle of it with the venue's own top bar. See that
    // widget for what happened to everything the fixed strip was carrying.
    final saleScreen = navDestinations[_index].label == 'Sale';

    // The drawer, for when the rail is not fixed. A fixed rail costs ~208px of
    // width permanently, on the screen where the product grid and the bill are
    // already competing for room; behind a menu key it costs nothing until it
    // is wanted.
    //
    // Built only when it will be used: a Scaffold with a drawer it never opens
    // still swallows the edge swipe, which on the Sale screen is the gesture
    // that scrolls the category rail.
    // Staff sign-on is offered wherever there is somebody to sign on — that is,
    // wherever the venue has staff with PINs.
    //
    // It used to also require the idle screen's PIN lock to be on, which tied
    // two separate decisions together: a venue can perfectly well want its
    // sales attributed to whoever rang them up without wanting the screen to
    // lock between customers. What the check does still guard is the case with
    // no answer — a till with no staff list, where a Sign On key would open a
    // PIN pad that could never accept a PIN.
    final staffSession = ref.watch(staffSessionProvider);
    final usesSignOn = ref.watch(canSignOnProvider);
    final onSignOff = usesSignOn && staffSession.signedOn
        ? () => ref.read(staffSessionProvider.notifier).signOff()
        : null;
    // The same slot, carrying whichever of the pair currently applies.
    final onSignOn = usesSignOn && !staffSession.signedOn
        ? () => ref.read(staffSessionProvider.notifier).promptSignOn()
        : null;

    final drawer = pinned
        ? null
        : Drawer(
            child: SafeArea(
              child: PosNavRail(
                selected: _index,
                onSelect: (i) {
                  setState(() => _index = i);
                  Navigator.of(context).pop();
                },
                onLogout: () {
                  Navigator.of(context).pop();
                  _logout();
                },
              ),
            ),
          );

    // The fixed rail has no drawer to close, so selecting must not pop — that
    // would take the current route off the navigator instead.
    final fixedRail = PosNavRail(
      selected: _index,
      onSelect: (i) => setState(() => _index = i),
      onLogout: _logout,
    );

    // The one bar the till wears, around whatever is put in it.
    //
    // A closure built here rather than a method, because everything it needs —
    // whether the rail is pinned, which of the sign-on pair applies — is state
    // this build has already worked out, and a method would have to watch those
    // providers again from inside another widget's build.
    Widget topBarChrome({Widget? body, bool trailing = true}) => TillTopBar(
      section: navDestinations[_index],
      onSelectSection: (i) => setState(() => _index = i),
      // No menu key when the rail is already on screen: a button that opens a
      // copy of what is visible beside it is noise.
      onOpenMenu: pinned ? null : () => _scaffold.currentState?.openDrawer(),
      onSignOn: onSignOn,
      onSignOff: onSignOff,
      body: body,
      trailing: trailing,
    );

    final body = orderId == null
        ? const Center(child: CircularProgressIndicator())
        : _page(orderId, topBarChrome);

    // Drawn by the shell for every section except Sale, which draws its own —
    // it is the only section with a bill on it, and the venue's top bar is
    // allowed to say what that bill comes to. Both go through the same chrome,
    // so the page selector is in the same place on every screen.
    //
    // A phone is a till too. The AppBar this replaces carried a gear, a section
    // name and the same three badges — the same bar in Material's clothing —
    // and having two of those to keep in step is how the dark-bar-on-a-white-
    // page bug got in.
    //
    // Off the Sale screen the venue's own bar is drawn too, with the keys that
    // act on a bill dimmed — see [VenueTopBarBody]. A venue that has arranged
    // their chrome should meet it on Reports and Settings as well, which is the
    // whole of "one bar, everywhere".
    final venueBar = saleScreen ? null : VenueTopBarBody.of(ref);
    final topBar = saleScreen
        ? null
        : topBarChrome(
            trailing: venueBar == null,
            body: venueBar == null || orderId == null
                ? null
                : VenueTopBarBody(
                    bar: venueBar,
                    orderId: orderId,
                    sectionName: navDestinations[_index].label,
                    onSwitchOrder: _switchToOrder,
                    onNavigate: _goTo,
                  ),
          );

    if (context.useCompactNav && !pinned) {
      return _withCounterHardware(
        Scaffold(
          key: _scaffold,
          drawer: drawer,
          body: Column(
            children: [
              ?topBar,
              Expanded(child: body),
            ],
          ),
        ),
      );
    }

    return _withCounterHardware(
      Scaffold(
        key: _scaffold,
        drawer: drawer,
        body: Column(
          children: [
            ?topBar,
            Expanded(
              child: pinned
                  ? Row(
                      children: [
                        fixedRail,
                        VerticalDivider(
                          width: 1,
                          thickness: 1,
                          color: Theme.of(context).posLine,
                        ),
                        Expanded(child: body),
                      ],
                    )
                  : body,
            ),
          ],
        ),
      ),
    );
  }

  /// Listen for the card reader across the whole till.
  ///
  /// Wrapped around the shell rather than fitted to the sale screen, because a
  /// card is held out whenever a customer feels like holding one out: mid-sale,
  /// on the payment page, with a dialog open, or with the idle lock covering
  /// everything. The listener installs a keyboard handler, so it hears a swipe
  /// even while the lock screen is drawn on top of this — which is exactly the
  /// case a staff card exists for.
  ///
  /// [_orderId] is read inside the callback rather than captured, so a card
  /// swiped after the clerk has switched tables goes on the bill that is
  /// actually on screen.
  /// The till, with a card reader listening and a pairing request able to
  /// interrupt it.
  ///
  /// The order matters. The pairing sheet is *outside* the card listener, so a
  /// card swiped while the sheet is up is still read — a member of staff
  /// signing on to answer the prompt is exactly the sort of thing that happens
  /// on install day.
  Widget _withCounterHardware(Widget child) =>
      PairRequestOverlay(child: _hearingCards(child));

  Widget _hearingCards(Widget child) => SwipeCardListener(
    enabled: ref.watch(cardRepositoryProvider).settings.enabled,
    onCard: (card) =>
        handleSwipedCard(context, ref, card, orderId: _orderId),
    child: child,
  );

  /// Bring a parked bill onto the till and show it on the sale screen. Recalls
  /// it (flips it back to open) so it is no longer counted as a separate booked
  /// table while it is the active bill.
  Future<void> _switchToOrder(String id) async {
    // A bill another terminal is holding is taken over first. This is the one
    // funnel every route to a parked bill goes through -- the table plan, the
    // picker, the open-bills strip and a clerk bringing their own basket with
    // them -- so the check is here rather than in four places that could
    // disagree.
    final order = await ref.read(orderRepositoryProvider).orderOnce(id);
    if (order?.heldBy != null) {
      try {
        await ref.read(billSyncProvider).claim(id);
      } on TerminalUnavailable catch (e) {
        if (mounted) PosMessenger.error(context, e.message);
        return;
      }
    }

    await ref.read(tableRepositoryProvider).recall(id);
    if (!mounted) return;
    setState(() {
      _orderId = id;
      _index = navDestinations.indexWhere((d) => d.label == 'Sale');
    });
    _followOnDisplay(id);
  }

  Widget _page(
    String orderId,
    Widget Function({Widget? body, bool trailing}) topBarChrome,
  ) {
    // Routed by label rather than index, so adding a nav item cannot silently
    // shift what each screen points to.
    switch (navDestinations[_index].label) {
      case 'Sale':
        return SalePage(
          orderId: orderId,
          onNewOrder: _newOrder,
          onSwitchOrder: _switchToOrder,
          // The Sale screen is the only section that draws its own top bar,
          // because it is the only one with a bill on it and the venue's bar is
          // allowed to say what that bill comes to. It draws it in the shell's
          // chrome, so the page selector is in the same place on every screen
          // whichever of the two put it there.
          topBarChrome: topBarChrome,
          // So a programmed bar's `go_*` keys can leave the sale screen. The
          // shell owns which section is showing; the bar only names one.
          onNavigate: _goTo,
        );
      case 'Table':
        return TablesPage(currentOrderId: orderId, onRecall: _switchToOrder);
      case 'Receipts':
        return const ReceiptsPage();
      case 'Settings':
        return const SettingsPage();
      case 'Reports':
        return const ReportsPage();
      case 'Product':
        return const ProductsPage();
      case 'Functions':
        return FunctionsPage(
          orderId: orderId,
          onGoToReports: () => _goTo('Reports'),
          onGoToReceipts: () => _goTo('Receipts'),
          onGoToTables: () => _goTo('Table'),
        );
      default:
        return _sectionInfo(_index);
    }
  }

  /// Jump to another nav section by its label, from a button inside a page.
  void _goTo(String label) {
    final i = navDestinations.indexWhere((d) => d.label == label);
    if (i != -1) setState(() => _index = i);
  }

  /// Sections driven from the back office. Each explains what it does rather
  /// than showing an empty screen.
  Widget _sectionInfo(int index) {
    switch (navDestinations[index].label) {
      case 'Product':
        return PlaceholderPage(
          title: 'Products',
          icon: Icons.shopping_bag,
          description:
              'Your catalogue, synced from the back office and cached on this '
              'terminal so it keeps selling with no network. Tap a product on '
              'the Sale screen to add it to the bill.',
          points: const [
            'Assign products to specific buttons and colours',
            'Products with a picture show the picture on the button',
            'Set prices, VAT rates and stock levels',
            'Route items to a kitchen or bar printer',
          ],
          action: ('Go to Sale', () => _goTo('Sale')),
        );
      case 'Settings':
        return const PlaceholderPage(
          title: 'Settings',
          icon: Icons.settings,
          description: 'Printers, tax rates and terminal configuration.',
          points: [
            'Receipt printer: network (any platform) or serial (desktop only)',
            'Kitchen and bar printer routing',
            'Card terminal and tax rates',
          ],
        );
      case 'About':
        return const AboutPage();
      default:
        return PlaceholderPage(
          title: navDestinations[index].label,
          icon: navDestinations[index].icon,
          description: 'Managed from the Vesopa Back Office.',
        );
    }
  }
}

/// Who is on shift, and the key that ends or starts it.
///
/// Lives in the top bar, which is the one piece of chrome on every screen —
/// so Sign On and Sign Off are reachable from the Sale screen, the Tables
/// plan, Reports, Settings and everywhere else without going hunting. That was
/// the point of the request: a shift change happens wherever the person
/// handing over happens to be standing.
///
/// The name and the key are one control rather than two, because they answer
/// the same question. "Am I about to ring this onto my own name?" and "how do
/// I stop being the name?" are the same thought half a second apart, and
/// putting the answer anywhere but next to the name makes it a search.
///
/// Draws nothing when the terminal has nobody to sign on — see the note in the
/// shell's build about why that is the only case still guarded.
class StaffChip extends ConsumerWidget {
  const StaffChip({
    super.key,
    required this.onSignOn,
    required this.onSignOff,
    this.compact = false,
  });

  /// Exactly one of these is non-null when sign-on is available: whichever of
  /// the pair currently applies. Both null means this terminal has no staff
  /// list, and the chip draws nothing.
  final VoidCallback? onSignOn;
  final VoidCallback? onSignOff;

  /// The app-bar variant, which has less width to spend.
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (onSignOn == null && onSignOff == null) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final signedOn = onSignOff != null;
    final name = ref.watch(staffSessionProvider).name;

    // Signed on: the name, then a quiet Sign Off. Signed off: one lime key,
    // because at that moment starting a shift is the only thing the terminal
    // is for and it should look like the way forward.
    return Padding(
      padding: EdgeInsets.only(right: compact ? 4 : 12),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (signedOn && name != null) ...[
            Icon(
              Icons.how_to_reg_outlined,
              size: 15,
              color: theme.posBrandOnChrome,
            ),
            const SizedBox(width: 6),
            // Bounded so a long name cannot push the sync badge off a narrow
            // bar — the badge is the one thing here that must never vanish.
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: compact ? 90 : 160),
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.posOnChrome,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            const SizedBox(width: 8),
          ],
          _ShiftKey(
            label: signedOn ? 'Sign Off' : 'Sign On',
            icon: signedOn ? Icons.logout : Icons.login,
            // Sign Off is a quiet outline: it is pressed a handful of times a
            // shift and must not compete with the section it sits beside.
            filled: !signedOn,
            compact: compact,
            onTap: onSignOff ?? onSignOn!,
          ),
        ],
      ),
    );
  }
}

/// One key on the top bar, in the two weights [StaffChip] uses.
class _ShiftKey extends StatelessWidget {
  const _ShiftKey({
    required this.label,
    required this.icon,
    required this.filled,
    required this.compact,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool filled;
  final bool compact;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // On the lime fill the ink must be the dark one — see Pos.onBrand. On the
    // outline it follows the bar, which is white in Night and near-black in
    // Day.
    final ink = filled ? Pos.onBrand : theme.posOnChrome;

    return Material(
      color: filled ? Pos.brand : Colors.transparent,
      borderRadius: BorderRadius.circular(7),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(7),
        child: Container(
          height: 32,
          padding: EdgeInsets.symmetric(horizontal: compact ? 9 : 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(7),
            border: filled
                ? null
                : Border.all(color: theme.posOnChrome.withValues(alpha: 0.28)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 15, color: ink),
              // The label is dropped on a narrow app bar, where the two icons
              // are distinct enough on their own and the room is better spent
              // on the section title.
              if (!compact) ...[
                const SizedBox(width: 7),
                Text(
                  label,
                  style: TextStyle(
                    color: ink,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Online/offline + backlog indicator, driven by [syncStatusProvider].
///
/// Green when the terminal is live with the back office and nothing is queued;
/// amber while a backlog is draining; grey/red when offline. It reassures the
/// clerk that a sale rung up offline is safely queued and will sync, rather
/// than leaving them guessing whether the till is talking to the server.
class SyncStatusBadge extends ConsumerWidget {
  const SyncStatusBadge({super.key, this.compact = false});

  /// The slim variant for the desktop title bar; the app bar uses the fuller
  /// one with a label.
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Fall back to the service's current snapshot until the first stream event,
    // so the badge is never blank.
    final status =
        ref.watch(syncStatusProvider).value ??
        ref.watch(syncServiceProvider).currentStatus;

    final (color, label, icon) = switch (status) {
      SyncStatus(online: false) => (
        Pos.red,
        status.hasBacklog ? 'Offline · ${status.pending}' : 'Offline',
        Icons.cloud_off,
      ),
      SyncStatus(hasBacklog: true) => (
        Pos.amber,
        'Syncing ${status.pending}',
        Icons.cloud_sync,
      ),
      _ => (Pos.green, 'Online', Icons.cloud_done),
    };

    // The compact variant sits on the title bar, which is no longer always
    // dark — white here would be white-on-near-white in Day.
    final foreground = compact ? Theme.of(context).posOnChrome : color;

    return Tooltip(
      message: switch (status) {
        SyncStatus(online: false) when status.hasBacklog =>
          '${status.pending} sale(s) queued — will sync when back online.',
        SyncStatus(online: false) =>
          'Working offline. Sales are saved locally.',
        SyncStatus(hasBacklog: true) =>
          'Sending ${status.pending} queued sale(s) to the back office.',
        _ => 'Live with the back office. All sales synced.',
      },
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: compact ? 6 : 10,
          vertical: 4,
        ),
        decoration: BoxDecoration(
          color: compact ? null : color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: compact ? 13 : 16, color: foreground),
            SizedBox(width: compact ? 5 : 7),
            Text(
              label,
              style: TextStyle(
                color: foreground,
                fontSize: compact ? 11 : 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
