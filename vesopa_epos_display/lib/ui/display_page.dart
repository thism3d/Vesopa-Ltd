/// The screen the customer looks at.
///
/// Two states, and the whole feature is the rule that moves between them:
///
///   * **Split.** The bill on one half, adverts on the other. This is what is
///     on screen while a sale is happening.
///   * **Full screen.** Adverts across the whole display. This is what is on
///     screen when there is no sale, and when there has been no change to one
///     for however long the venue set.
///
/// The timer is on *changes*, not on the presence of a bill. A bill left on
/// screen because a clerk walked away is exactly the case the venue asked to be
/// covered: after the idle time it goes to adverts, and the moment anything is
/// rung up it comes straight back. Coming back is instant and uncrossfaded —
/// a customer whose pint has just been rung up should see it, not a two-second
/// dissolve.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/adverts.dart';
import '../data/basket_feed.dart';
import '../data/control.dart';
import '../data/deep_links.dart';
import '../data/pairing.dart';
import '../data/screens.dart';
import '../data/settings.dart';
import 'advert_panel.dart';
import 'bill_panel.dart';
import 'settings_page.dart';
import 'theme.dart';

class DisplayPage extends ConsumerStatefulWidget {
  const DisplayPage({super.key});

  @override
  ConsumerState<DisplayPage> createState() => _DisplayPageState();
}

/// Whether the adverts take the screen, rather than the bill.
///
/// Lifted out of the widget so it can be tested on its own: everything in here
/// is three booleans and a duration, and everything around it is a Flutter tree
/// that needs a monitor. The same trick the back office plays with its crop
/// geometry, for the same reason.
///
/// THE ORDER OF THESE THREE RULES IS THE WHOLE FUNCTION
///
/// A code the till has put up wins over all of it. That is the fix for the bug
/// that made "Show on the customer screen" look broken: the move it exists for
/// is a customer at the counter who cannot find their loyalty card, and that
/// conversation happens BEFORE anything is rung up. So the basket was empty,
/// the screen was idle, the adverts had the whole of it, and the code was
/// handed to a bill panel that was not on screen — while the till said "Take it
/// off their screen", because from the till's side the write had succeeded.
bool shouldShowAdverts({
  required bool hasSale,
  required String customerQr,
  required int idleSeconds,
  required Duration sinceChange,
}) {
  if (customerQr.isNotEmpty) return false;

  // Nothing rung up is not a quiet moment in a sale, it is no sale. Adverts
  // take the screen immediately rather than after the countdown.
  if (!hasSale) return true;

  // Zero means never: a screen beside a busy bar may want the bill up
  // permanently, and that is an answer rather than a mistake.
  if (idleSeconds <= 0) return false;

  return sinceChange >= Duration(seconds: idleSeconds);
}

class _DisplayPageState extends ConsumerState<DisplayPage> {
  BasketFeed? _feed;
  AdvertLibrary? _library;
  StreamSubscription<Basket>? _baskets;
  StreamSubscription<List<Advert>>? _advertChanges;

  /// Owned here rather than by the advert widget, so going full screen and
  /// coming back does not restart the loop at the first poster.
  final _rotation = AdvertRotation();

  Basket _basket = Basket.unknown;
  List<Advert> _adverts = const [];

  /// When the basket last changed in a way the customer would notice. The idle
  /// countdown is measured from here.
  DateTime _lastChange = DateTime.now();
  Timer? _tick;

  /// The settings these subscriptions were built for, so a save that changes
  /// nothing relevant does not tear down a playing advert.
  String? _builtFor;

  /// The till's basket file, as the till itself named it when the two were
  /// paired. See `data/pairing.dart`: this application no longer works it out.
  String _basketPath = '';
  Timer? _findTill;

  /// The till's end of the settings. See `data/control.dart`: when the till has
  /// said anything, it is the authority and this screen follows.
  TillControlChannel? _control;
  StreamSubscription<TillControl>? _controlChanges;

  /// The monitors attached here, reported to the till so its screen picker can
  /// offer them by name. Re-read on the same slow timer that looks for the
  /// till, because a screen plugged in mid-setup should appear on the till
  /// without anything being restarted.
  List<Screen> _screens = const [];
  Timer? _screenSweep;

  @override
  void initState() {
    super.initState();
    // A customer display has no business dimming or sleeping, and it is the one
    // screen in the building nobody is going to touch to wake up.
    unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersive));
    HardwareKeyboard.instance.addHandler(_onKey);
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });

    // Keep the handshake turning. While this screen is unpaired that is what
    // puts its request in front of the till; once it is paired it is what picks
    // up a till that has moved — see `data/pairing.dart` for why the grant is
    // re-read rather than remembered.
    //
    // Three seconds, so that pressing Connect on the till lights this screen up
    // while the manager is still looking at it. It costs one small file read.
    _findTill = Timer.periodic(const Duration(seconds: 3), (_) {
      unawaited(ref.read(pairingProvider.notifier).refresh());
    });
    unawaited(_readScreens());
    _screenSweep = Timer.periodic(
      const Duration(seconds: 10),
      (_) => unawaited(_readScreens()),
    );
  }

  Future<void> _readScreens() async {
    final screens = await listScreens();
    if (mounted) setState(() => _screens = screens);
  }

  /// Escape leaves full screen.
  ///
  /// The way out, and the reason full screen can be the default at all. A full
  /// screen window has no title bar, no close button and nothing to drag, so a
  /// display pointed at the wrong monitor — the till's, on a machine with one
  /// screen — would otherwise need Task Manager to undo. It is not offered
  /// anywhere on screen because it is not for the customer or the clerk; it is
  /// for whoever is standing there when it has gone wrong.
  ///
  /// Returns false: this is a display nothing else is listening to keys on, and
  /// claiming the key would only hide it from anything added later.
  bool _onKey(KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.escape) {
      unawaited(leaveFullScreen());
    }
    return false;
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _tick?.cancel();
    _findTill?.cancel();
    _screenSweep?.cancel();
    unawaited(_controlChanges?.cancel());
    unawaited(_control?.dispose());
    unawaited(_baskets?.cancel());
    unawaited(_advertChanges?.cancel());
    unawaited(_feed?.dispose());
    unawaited(_library?.dispose());
    super.dispose();
  }

  /// (Re)build the feed and the advert library for [settings].
  void _rewire(DisplaySettings settings) {
    final signature = '$_basketPath|${settings.advertFolder}';
    if (_builtFor == signature) return;
    _builtFor = signature;

    unawaited(_baskets?.cancel());
    unawaited(_advertChanges?.cancel());
    unawaited(_feed?.dispose());
    unawaited(_library?.dispose());

    final feed = BasketFeed(path: _basketPath);
    _feed = feed;
    _baskets = feed.baskets.listen((basket) {
      if (!mounted) return;
      setState(() {
        // The clock is reset only when the customer would see a difference.
        // The till already skips writes that would draw the same screen, so
        // anything arriving here is a real change.
        _lastChange = DateTime.now();
        _basket = basket;
      });
    });
    feed.start();

    final library = AdvertLibrary(folder: settings.advertDirectory);
    _library = library;
    _advertChanges = library.changes.listen((adverts) {
      if (mounted) setState(() => _adverts = adverts);
    });
    library.start();
    _adverts = library.adverts;

    // The till's end of the settings, in the same folder as the basket. Rebuilt
    // with the feed because it is derived from the same path — see
    // `data/control.dart` for why that is derived rather than resolved twice.
    unawaited(_controlChanges?.cancel());
    unawaited(_control?.dispose());

    final control = TillControlChannel(basketPath: _basketPath);
    _control = control;
    _controlChanges = control.controls.listen(_applyFromTill);
    control.start();
  }

  /// Take what the till has set and make it this screen's settings.
  ///
  /// Saved locally as well as applied, so a display that is switched on before
  /// the till in the morning comes up on the right monitor with the right
  /// adverts rather than waiting for the till to tell it again.
  void _applyFromTill(TillControl control) {
    final current = ref.read(displaySettingsProvider).value;
    if (current == null) return;

    final next = current.copyWith(
      advertFolder: control.advertFolder,
      idleSeconds: control.idleSeconds,
      dwellSeconds: control.dwellSeconds,
      showPrices: control.showPrices,
      thankYou: control.thankYou,
      advertVolume: control.advertVolume,
      billOnRight: control.billOnRight,
      billShare: control.billShare,
      fillScreen: control.fillScreen,
      standingMessage: control.standingMessage,
      customerQr: control.customerQr,
      customerQrCaption: control.customerQrCaption,
      screenKey: control.screenKey,
      fullScreen: control.fullScreen,
    );

    unawaited(ref.read(displaySettingsProvider.notifier).save(next));

    // Only when it has actually changed. placeWindow leaves and re-enters full
    // screen, and doing that on every poll would be a screen that flickers at
    // the customer twice a second.
    if (control.screenKey != current.screenKey ||
        control.fullScreen != current.fullScreen) {
      unawaited(
        placeWindow(
          screenKey: control.screenKey,
          fullScreen: control.fullScreen,
        ),
      );
    }
  }

  /// Whether the adverts should have the whole screen.
  bool _isIdle(DisplaySettings settings) => shouldShowAdverts(
    hasSale: _basket.hasSale,
    customerQr: settings.customerQr,
    idleSeconds: settings.idleSeconds,
    sinceChange: DateTime.now().difference(_lastChange),
  );

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(displaySettingsProvider).value;
    final pairing = ref.watch(pairingProvider).value;
    if (settings == null || pairing == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    // Until a till has handed this screen a file there is nothing to draw a
    // bill from, and — since this application stopped guessing — nothing to
    // guess at either. The pairing card takes the whole screen, because asking
    // to be connected is the only thing anybody can usefully do here.
    if (!pairing.isPaired) return _PairingCard(state: pairing);

    // Just connected. Held for a few seconds before the bill takes over, so the
    // person who pressed Connect on the till sees that it worked from this side
    // of the counter too.
    if (pairing.justConnected) {
      return _ConnectedNow(name: pairing.pairing?.terminalName ?? '');
    }

    _basketPath = pairing.basketPath;

    // Tell the till what this screen is doing, every build. Cheap — it is
    // assigning a record; the channel writes it on its own two-second timer —
    // and it keeps the till's screen picker and its "connected" badge honest
    // without a second source of truth to keep in step.
    _control?.report = DisplayStatusReport(
      appVersion: appVersion,
      following: _basketPath,
      screens: [
        for (final screen in _screens) (key: screen.key, label: screen.label),
      ],
      screenKey: settings.screenKey,
      fullScreen: settings.fullScreen,
      advertCount: _adverts.length,
    );

    _rewire(settings);

    final adverts = AdvertPanel(
      adverts: _adverts,
      rotation: _rotation,
      dwell: settings.dwell,
      volume: settings.advertVolume,
      fillPanel: settings.fillScreen,
      standingMessage: settings.standingMessage,
    );

    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: _isIdle(settings)
                ? adverts
                : LayoutBuilder(
                    builder: (context, constraints) {
                      final bill = BillPanel(
                        basket: _basket,
                        showPrices: settings.showPrices,
                        thankYou: settings.thankYou,
                        customerQr: settings.customerQr,
                        customerQrCaption: settings.customerQrCaption,
                      );

                      // The bill's share of the screen, and which side it is
                      // on, are both the venue's. A room where the customer
                      // stands to the left of the till wants the mirror image
                      // of one where they stand to the right, and a venue
                      // whose adverts are portrait posters wants a narrower
                      // bill than one ringing up long rounds.
                      final billFlex = (settings.billFraction * 1000).round();
                      final advertFlex = 1000 - billFlex;

                      final panels = <Widget>[
                        Expanded(flex: billFlex, child: bill),
                        Expanded(flex: advertFlex, child: adverts),
                      ];
                      if (settings.billOnRight) {
                        panels.insert(0, panels.removeLast());
                      }

                      // Side by side on a landscape screen, stacked on a
                      // portrait one. A pole display mounted upright is a real
                      // shape, and half of a tall screen is a usable bill
                      // where half of its width would not be.
                      return constraints.maxWidth >= constraints.maxHeight
                          ? Row(
                              children: [
                                panels.first,
                                const VerticalDivider(
                                  width: 2,
                                  thickness: 2,
                                  color: Brand.line,
                                ),
                                panels.last,
                              ],
                            )
                          : Column(
                              children: [
                                panels.first,
                                const Divider(
                                  height: 2,
                                  thickness: 2,
                                  color: Brand.line,
                                ),
                                panels.last,
                              ],
                            );
                    },
                  ),
          ),

          // The way back to Settings, on a screen with no menu bar and nothing
          // else to press. Deliberately small and in a corner a customer does
          // not look at, and deliberately present: a display that cannot be
          // reconfigured without a keyboard is one that gets unplugged.
          Positioned(
            top: 0,
            right: 0,
            child: SafeArea(
              child: Opacity(
                opacity: 0.25,
                child: IconButton(
                  icon: const Icon(Icons.settings, color: Brand.ink),
                  tooltip: 'Settings',
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const SettingsPage(),
                    ),
                  ),
                ),
              ),
            ),
          ),

          // Said quietly, and only when it is true for long enough to matter.
          // A till that has been switched off at the end of the night should
          // not put an error over the adverts.
          if (_feed?.isStale ?? false)
            const Positioned(
              left: 12,
              bottom: 12,
              child: _StaleBadge(),
            ),
        ],
      ),
    );
  }
}

class _StaleBadge extends StatelessWidget {
  const _StaleBadge();

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: 0.5,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Brand.panelSoft,
        borderRadius: BorderRadius.circular(6),
      ),
      child: const Text(
        'Waiting for the till',
        style: TextStyle(fontSize: 12, color: Brand.inkSoft),
      ),
    ),
  );
}

/// A screen that has been mounted and switched on and not yet connected.
///
/// This is what replaced "point this at a folder". There is nothing to fill in
/// and nothing to browse to.
///
/// FIVE STATES, BECAUSE THERE ARE FIVE DIFFERENT JOBS
///
/// "No code yet" has four causes and each one sends the person standing here
/// somewhere different: install the till, start the till, sign the till in, or
/// read the code out to whoever is at it. One message for all four would send
/// most of them to do the wrong thing, and the person mounting a display is
/// very often not the person who knows the till.
///
/// So each state says the one thing that is true and offers the one action that
/// helps — including a way to check again, because somebody who has just gone
/// and started the till should not have to stand here waiting for a timer they
/// cannot see.
class _PairingCard extends ConsumerWidget {
  const _PairingCard({required this.state});

  final PairingState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    body: Center(
      child: SingleChildScrollView(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Image.asset(
                  'assets/brand/vesopa_logo_on_dark.png',
                  width: 200,
                  errorBuilder: (_, _, _) => const SizedBox.shrink(),
                ),
                const SizedBox(height: 24),
                const Text(
                  'Customer Display',
                  style: TextStyle(
                    fontSize: 26,
                    fontWeight: FontWeight.w700,
                    color: Brand.ink,
                  ),
                ),
                const SizedBox(height: 22),

                switch (state.stage) {
                  PairingStage.unavailable => const _Unavailable(),
                  PairingStage.tillMissing => const _TillMissing(),
                  PairingStage.tillIdle => const _TillIdle(),
                  PairingStage.tillSignedOut => _TillSignedOut(state: state),
                  PairingStage.waiting => _Waiting(state: state),
                  // Only reachable for the moment between the grant landing and
                  // the display page rebuilding. Drawn rather than left blank
                  // so that moment is never an empty screen.
                  PairingStage.paired => const _ConnectedNow(name: ''),
                },

                const SizedBox(height: 24),
                if (state.stage != PairingStage.unavailable)
                  TextButton.icon(
                    icon: const Icon(Icons.refresh, size: 18),
                    label: const Text('Check again'),
                    onPressed: () => unawaited(
                      ref.read(pairingProvider.notifier).checkNow(),
                    ),
                  ),
                TextButton.icon(
                  icon: const Icon(Icons.settings, size: 18),
                  label: const Text('Settings'),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => const SettingsPage()),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// Vesopa EPOS is not on this PC.
class _TillMissing extends StatefulWidget {
  const _TillMissing();

  @override
  State<_TillMissing> createState() => _TillMissingState();
}

class _TillMissingState extends State<_TillMissing> {
  /// Set when Windows refused the Store link. Worth showing: on a managed till
  /// with the Store removed the button does nothing, and a button that appears
  /// broken is worse than one that explains itself.
  bool _storeRefused = false;

  @override
  Widget build(BuildContext context) => Column(
    children: [
      const Text(
        'Vesopa EPOS is not installed on this PC',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 19, fontWeight: FontWeight.w600, color: Brand.ink),
      ),
      const SizedBox(height: 12),
      const Text(
        'This screen shows the bill from a till running on the same computer. '
        'Install Vesopa EPOS here, start it, and this screen will find it.',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 14.5, height: 1.5, color: Brand.inkSoft),
      ),
      const SizedBox(height: 22),
      FilledButton.icon(
        icon: const Icon(Icons.storefront_outlined),
        label: const Text('Get Vesopa EPOS'),
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 16),
        ),
        onPressed: () async {
          final opened = await openTillInStore();
          if (mounted) setState(() => _storeRefused = !opened);
        },
      ),
      if (_storeRefused) ...[
        const SizedBox(height: 12),
        const Text(
          'The Microsoft Store would not open on this machine. Search the '
          'Store for "Vesopa EPOS", or install it the way the rest of this '
          'venue was set up.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, height: 1.4, color: Brand.inkSoft),
        ),
      ],
    ],
  );
}

/// Installed, and not running.
class _TillIdle extends StatelessWidget {
  const _TillIdle();

  @override
  Widget build(BuildContext context) => const Column(
    children: [
      Text(
        'Vesopa EPOS is not running',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 19, fontWeight: FontWeight.w600, color: Brand.ink),
      ),
      SizedBox(height: 12),
      Text(
        'It is installed on this PC. Start it, and this screen will offer a '
        'code to connect the two.',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 14.5, height: 1.5, color: Brand.inkSoft),
      ),
    ],
  );
}

/// Running, and nobody has signed in.
class _TillSignedOut extends StatelessWidget {
  const _TillSignedOut({required this.state});

  final PairingState state;

  @override
  Widget build(BuildContext context) {
    final name = state.till?.terminalName ?? 'The till';
    return Column(
      children: [
        Text(
          '$name is running, but nobody is signed in',
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.w600,
            color: Brand.ink,
          ),
        ),
        const SizedBox(height: 12),
        const Text(
          'A customer display belongs to a venue, so the till has to be signed '
          'in before it can connect one. Sign in at the till and this screen '
          'will show a code.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 14.5, height: 1.5, color: Brand.inkSoft),
        ),
      ],
    );
  }
}

/// Running, signed in, and asking. The code is up.
class _Waiting extends StatelessWidget {
  const _Waiting({required this.state});

  final PairingState state;

  @override
  Widget build(BuildContext context) {
    final till = state.till;

    return Column(
      children: [
        Text(
          till == null
              ? 'Ready to connect'
              : 'Connect this screen to ${till.terminalName}',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w600, color: Brand.ink),
        ),
        const SizedBox(height: 20),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 16),
          decoration: BoxDecoration(
            color: Brand.panelSoft,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Brand.line, width: 2),
          ),
          child: Column(
            children: [
              const Text(
                'CODE',
                style: TextStyle(
                  fontSize: 11,
                  letterSpacing: 2.4,
                  fontWeight: FontWeight.w700,
                  color: Brand.inkSoft,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                state.identity.code,
                style: const TextStyle(
                  fontSize: 52,
                  height: 1.05,
                  letterSpacing: 9,
                  fontWeight: FontWeight.w700,
                  color: Brand.lime,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        const Text(
          'The till is showing a request with this code on it. Check the '
          'numbers match and press Connect there.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 14.5, height: 1.45, color: Brand.inkSoft),
        ),
        const SizedBox(height: 10),
        const Text(
          'If it is not on screen, open Settings on the till and choose '
          'Customer display.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12.5, height: 1.4, color: Brand.inkSoft),
        ),
      ],
    );
  }
}

/// The moment after a pairing lands.
///
/// Somebody has just pressed a button on a machine facing the other way. This
/// is the only confirmation they get on this side of the counter, and a screen
/// that went straight to adverts would leave them wondering whether it worked.
class _ConnectedNow extends StatelessWidget {
  const _ConnectedNow({required this.name});

  /// The till's name, or empty during the instant before it is known.
  final String name;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.check_circle, size: 76, color: Brand.lime),
            const SizedBox(height: 22),
            const Text(
              'Connected',
              style: TextStyle(
                fontSize: 34,
                fontWeight: FontWeight.w700,
                color: Brand.ink,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              name.isEmpty
                  ? 'This screen is now showing the till.'
                  : 'This screen is now showing $name.',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 17, color: Brand.inkSoft),
            ),
            const SizedBox(height: 16),
            const Text(
              'It stays connected through updates and reinstalls.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13.5, color: Brand.inkSoft),
            ),
          ],
        ),
      ),
    ),
  );
}

/// No ProgramData to meet the till in — which in practice means this build is
/// running somewhere it was never meant to.
class _Unavailable extends StatelessWidget {
  const _Unavailable();

  @override
  Widget build(BuildContext context) => const Text(
    'This screen cannot reach the folder it shares with the till, so it has '
    'no way to be connected on this machine.',
    textAlign: TextAlign.center,
    style: TextStyle(fontSize: 15, height: 1.45, color: Brand.inkSoft),
  );
}
