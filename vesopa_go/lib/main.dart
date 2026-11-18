/// Vesopa Go: take orders and payments anywhere, at the counter or the table.
///
/// One app, two ways a venue uses it, chosen after sign-in (SetupPage):
///
///   with Vesopa EPOS  beside the venue's tills: the counter, plus the floor,
///                     shared open bills, the kitchen screens
///   on its own        the counter only: no tills needed
///
/// Every sale goes to the venue's back office. Signed in with Vesopa Auth; card
/// payments through Dojo, on the phone (Tap to Pay) or the venue's card machine.
///
/// A showroom build (`--dart-define=GO_DEMO_ONLY=true`, the web demo) goes
/// straight into the demo venue, with no sign-in to a real one.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'counter/data/journal.dart';
import 'counter/data/lite_demo.dart';
import 'counter/data/lite_state.dart';
import 'counter/ui/brand.dart';
import 'counter/ui/shell.dart';
import 'counter/ui/start_pages.dart';
import 'data/demo_venue.dart';
import 'data/models.dart' show VenueMode;
import 'display/data/display_feed.dart';
import 'display/ui/display_mode_page.dart';
import 'kitchen/ui/kitchen_mode_page.dart';
import 'modes/device_mode.dart';
import 'modes/mode_chooser_page.dart';
import 'modes/terminal_mode_page.dart';
import 'payments/go_terminal.dart';
import 'data/session.dart';
import 'ui/accent.dart';
import 'ui/appearance.dart';
import 'ui/device_prefs.dart';
import 'ui/go_frame.dart';
import 'ui/sounds.dart';
import 'ui/splash.dart';
import 'ui/venue_font.dart';
import 'ui/pages/onboarding.dart' show OnboardingPage, onboardingGateProvider, holdForSignup;
import 'ui/pages/setup.dart';
import 'ui/theme.dart';
import 'ui/tv.dart';

const demoOnly = bool.fromEnvironment('GO_DEMO_ONLY');

void main() {
  // How the back office and the other terminals name this device.
  TapSession.product = appName;
  WidgetsFlutterBinding.ensureInitialized();
  GoSounds.load();
  DevicePrefs.load();
  // Whether this is a television, before the first frame: a TV draws its
  // focus ring from the start and opens on a code, not a sign-in page.
  GoTerminalChoice.load();
  GoDevice.load().whenComplete(() => runApp(const ProviderScope(child: GoApp())));
}

/// The demo venue: The Vesopa Kitchen's menu at the counter, and a floor of
/// tables, so both halves of the app can be tried.
void startGoDemo(WidgetRef ref) => ref.read(tapProvider.notifier).startDemo(
      venue: liteDemoVenue,
      staff: liteDemoClerks,
      categories: liteDemoCategories,
      products: liteDemoProducts,
      tables: demoTables,
    );

class GoApp extends ConsumerWidget {
  const GoApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final phase = ref.watch(tapProvider.select((s) => s.phase));
    // The device's accent (Settings, Appearance), in place before any colour is read.
    Tp.palette = ref.watch(accentProvider);
    final asked = ref.watch(accentAskedProvider);
    // Read the day's sales from storage now, not at the first payment.
    ref.watch(journalProvider.select((j) => j.loaded));
    // Every paid bill, the counter's and the tables', goes in the day's journal
    // (the counter's Pay screen files its own first, with the change given).
    ref.listen(tapProvider.select((s) => s.lastClosed), (_, closed) {
      if (closed != null) {
        ref.read(journalProvider.notifier).recordOnce(closed, categoryNames: categoryNames(ref.read(tapProvider)));
      }
    });
    ref.listen(tapProvider.select((s) => s.phase), (_, next) {
      if (next == Phase.welcome && demoOnly) startGoDemo(ref);
    });
    // Signed in to a venue with tills: EPOS, Kitchen or Customer display, as
    // the back office set this device or as it chose (lib/modes).
    final venueMode = ref.watch(tapProvider.select((s) => s.venue?.mode));
    final demo = ref.watch(tapProvider.select((s) => s.demo));
    final device = ref.watch(deviceModeProvider);
    final signedOn = phase == Phase.locked || phase == Phase.ready;
    final modes = signedOn && !demo && venueMode == VenueMode.connected;
    if (signedOn) Future.microtask(() => ref.read(deviceModeProvider.notifier).load());
    Widget orMode(Widget epos) {
      if (!modes) return epos;
      if (!device.loaded) return const Scaffold(key: ValueKey('mode-boot'), body: Center(child: GoMark(size: 72)));
      return switch (device.mode) {
        null => const ModeChooserPage(key: ValueKey('mode-choose')),
        DeviceMode.kitchen => const KitchenModePage(key: ValueKey('mode-kitchen')),
        DeviceMode.display => const DisplayModePage(key: ValueKey('mode-display')),
        DeviceMode.terminal => const TerminalModePage(key: ValueKey('mode-terminal')),
        DeviceMode.epos => epos,
      };
    }
    // A venue that signed up in Go or on go.vesopa.com opens on its account
    // checks until they are finished and the owner's PIN is set: no PIN pad,
    // no EPOS, no other mode before then (owner, 2026-11-17).
    final signup = signedOn && !demo && holdForSignup(ref.watch(onboardingGateProvider).value);
    // The focus ring comes on with the first key from a remote (ui/tv.dart).
    return ValueListenableBuilder<bool>(
      valueListenable: GoDevice.remote,
      builder: (context, _, _) => MaterialApp(
      navigatorKey: goNavigator,
      // Signed on: the licence, offline and idle rules over every page.
      // The start animation over the first screen, then the frame's rules.
      builder: (context, child) => TvRemote(
        child: GoSplash(child: !signup && phase == Phase.ready && (!modes || device.mode == DeviceMode.epos) ? GoFrame(child: child!) : child!),
      ),
      title: appName,
      debugShowCheckedModeBanner: false,
      // In the venue's lettering once it has loaded, as the till is.
      theme: tvFocusTheme(Tp.theme(Brightness.light, font: ref.watch(venueFontProvider).value)),
      darkTheme: tvFocusTheme(Tp.theme(Brightness.dark, font: ref.watch(venueFontProvider).value)),
      // Light, dark or the device's own (Settings, Appearance).
      themeMode: ref.watch(appearanceProvider),
      home: AnimatedSwitcher(
        duration: const Duration(milliseconds: 250),
        child: signup
            ? const OnboardingPage(key: ValueKey('signup'), gate: true)
            : switch (phase) {
          Phase.booting => const Scaffold(key: ValueKey('boot'), body: Center(child: GoMark(size: 72))),
          Phase.welcome when demoOnly => const Scaffold(key: ValueKey('boot'), body: Center(child: GoMark(size: 72))),
          Phase.welcome => const LiteWelcomePage(key: ValueKey('welcome')),
          Phase.setup => const SetupPage(key: ValueKey('setup')),
          // The first time Go opens, before the PIN: pick a colour (dark, as the PIN pad).
          Phase.locked when asked == null => const Scaffold(key: ValueKey('boot'), body: Center(child: GoMark(size: 72))),
          Phase.locked when asked == false => Theme(key: const ValueKey('accent'), data: Tp.theme(Brightness.dark), child: const AccentWelcomePage()),
          // The PIN pad stays dark, as the till's.
          Phase.locked => orMode(Theme(key: const ValueKey('locked'), data: Tp.theme(Brightness.dark), child: const LiteLockPage())),
          // Beside tills, the sale also goes to any customer display following this device.
          Phase.ready => orMode(modes ? const GoDisplayFeed(key: ValueKey('ready'), child: Shell()) : const Shell(key: ValueKey('ready'))),
        },
      ),
    ));
  }
}
