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

  /// The till's basket file, as most recently resolved.
  ///
  /// Held here rather than recomputed, because resolving it reads the disk —
  /// the till's note, then a couple of known folders, then a sweep — and that
  /// is not something to do on every frame of a screen that plays video.
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

    // Look for the till now, and keep looking until it is found. A display is
    // switched on at the wall with the rest of the counter, and there is no
    // saying whether it or the till gets there first.
    _findTill = Timer.periodic(const Duration(seconds: 10), (_) {
      _locateTill();
      unawaited(_readScreens());
    });
    unawaited(_readScreens());
  }

  Future<void> _readScreens() async {
    final screens = await listScreens();
    if (mounted) setState(() => _screens = screens);
  }

  /// Re-resolve the till's file, unless this display is already following it.
  ///
  /// Left alone once a basket has been read: that path is the till, and a
  /// display that kept re-deciding could be pulled onto a stale file left by an
  /// older install halfway through somebody's round.
  ///
  /// Resumed when the feed goes stale, which is ten minutes of silence. That is
  /// the till having been shut down for the night — in which case nothing
  /// changes, because it will announce the same path in the morning — or the
  /// till having been reinstalled somewhere else, which is the case this exists
  /// for.
  void _locateTill() {
    final settings = ref.read(displaySettingsProvider).value;
    if (settings == null) return;

    final feed = _feed;
    if (feed != null && feed.hasRead && !feed.isStale) return;

    final found = settings.resolveBasketPath();
    if (found == _basketPath || !mounted) return;
    setState(() => _basketPath = found);
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
  bool _isIdle(DisplaySettings settings) {
    // Nothing rung up is not a quiet moment in a sale, it is no sale. Adverts
    // take the screen immediately rather than after the countdown.
    if (!_basket.hasSale) return true;
    // Zero means never: a screen beside a busy bar may want the bill up
    // permanently, and that is an answer rather than a mistake.
    if (settings.idleSeconds <= 0) return false;
    return DateTime.now().difference(_lastChange) >= settings.idleAfter;
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(displaySettingsProvider).value;
    if (settings == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    // The first resolution, before anything is drawn. After this the timer
    // owns it.
    if (_basketPath.isEmpty) _basketPath = settings.resolveBasketPath();
    if (_basketPath.isEmpty) return const _NotSetUp();

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

/// A screen that has been mounted and switched on and told nothing.
class _NotSetUp extends StatelessWidget {
  const _NotSetUp();

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Image.asset(
                'assets/brand/vesopa_logo_on_dark.png',
                width: 240,
                errorBuilder: (_, _, _) => const SizedBox.shrink(),
              ),
              const SizedBox(height: 28),
              const Text(
                'Customer Display',
                style: TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w700,
                  color: Brand.ink,
                ),
              ),
              const SizedBox(height: 10),
              const Text(
                'Point this screen at the till it belongs to, and choose a '
                'folder of adverts to play.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 15, color: Brand.inkSoft),
              ),
              const SizedBox(height: 28),
              Builder(
                builder: (context) => FilledButton.icon(
                  icon: const Icon(Icons.settings),
                  label: const Text('Set this screen up'),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const SettingsPage(),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
