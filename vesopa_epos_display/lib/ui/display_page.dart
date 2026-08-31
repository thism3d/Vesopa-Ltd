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

  @override
  void initState() {
    super.initState();
    // A customer display has no business dimming or sleeping, and it is the one
    // screen in the building nobody is going to touch to wake up.
    unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersive));
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    unawaited(_baskets?.cancel());
    unawaited(_advertChanges?.cancel());
    unawaited(_feed?.dispose());
    unawaited(_library?.dispose());
    super.dispose();
  }

  /// (Re)build the feed and the advert library for [settings].
  void _rewire(DisplaySettings settings) {
    final signature = '${settings.basketPath}|${settings.advertFolder}';
    if (_builtFor == signature) return;
    _builtFor = signature;

    unawaited(_baskets?.cancel());
    unawaited(_advertChanges?.cancel());
    unawaited(_feed?.dispose());
    unawaited(_library?.dispose());

    final feed = BasketFeed(path: settings.basketPath);
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
    if (!settings.isConfigured) return const _NotSetUp();

    _rewire(settings);

    final adverts = AdvertPanel(
      adverts: _adverts,
      rotation: _rotation,
      dwell: settings.dwell,
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

                      // Side by side on a landscape screen, stacked on a
                      // portrait one. A pole display mounted upright is a real
                      // shape, and half of a tall screen is a usable bill where
                      // half of its width would not be.
                      return constraints.maxWidth >= constraints.maxHeight
                          ? Row(
                              children: [
                                Expanded(child: bill),
                                const VerticalDivider(
                                  width: 2,
                                  thickness: 2,
                                  color: Brand.line,
                                ),
                                Expanded(child: adverts),
                              ],
                            )
                          : Column(
                              children: [
                                Expanded(child: bill),
                                const Divider(
                                  height: 2,
                                  thickness: 2,
                                  color: Brand.line,
                                ),
                                Expanded(child: adverts),
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
