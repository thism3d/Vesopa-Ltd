/// Vesopa Customer Display.
///
/// The screen the customer looks at while their round is being rung up: their
/// bill on one half, the venue's adverts on the other, and the adverts across
/// the whole screen when the till has been quiet for a while.
///
/// **A separate application, on purpose.** It reads a small file the till
/// writes and has no other connection to it — no shared process, no plugin, no
/// port. A display doing video work cannot slow the till down, and a display
/// that falls over takes nothing with it: the till carries on selling and the
/// only thing anybody loses is the picture facing the customer.
///
/// It is also, in almost every venue, a second window on the *same PC* as the
/// till: one machine, two monitors, the till on one and this on the other. That
/// is why the window is put on its monitor before it is ever shown — see
/// `data/screens.dart`.
///
/// See `vesopa_epos/lib/data/customer_display.dart` for the other end of the
/// file, and `lib/data/basket_feed.dart` for how this one reads it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:media_kit/media_kit.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:window_manager/window_manager.dart';

import 'data/deep_links.dart';
import 'data/screens.dart';
import 'data/settings.dart';
import 'ui/display_page.dart';
import 'ui/settings_page.dart';
import 'ui/theme.dart';

/// [args] is the command line, which on Windows is how a deep link arrives:
/// the runner passes it straight through, so following `com.vesopa.display:`
/// from a browser starts this application with that URI as an argument.
///
/// See `data/deep_links.dart` for the scheme and why it is reverse DNS.
Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();

  // Whether somebody arrived here deliberately. A screen opened from a link is
  // one somebody is setting up right now, so it opens with its settings in
  // front of them rather than with whatever it happened to be showing.
  final fromLink = launchedByLink(args);

  // The advert player's own decoder, before anything can ask it to play. It is
  // bundled rather than borrowed from Windows — see `ui/advert_panel.dart` for
  // what depending on the machine's own codecs cost.
  MediaKit.ensureInitialized();

  await windowManager.ensureInitialized();

  // Positioned before it is shown, not after. The alternative is a window that
  // appears on the till's screen and jumps to the customer's a moment later,
  // which looks like a fault every time the machine is switched on.
  await windowManager.waitUntilReadyToShow(
    const WindowOptions(
      title: 'Vesopa Customer Display',
      // No title bar, the same as the till. This is a screen pointed at the
      // public: a customer reading a bill should not also be reading a close
      // button, and there is nothing on it anybody is meant to drag.
      titleBarStyle: TitleBarStyle.hidden,
      // The size the window falls back to whenever it is not full screen —
      // after Escape, or on a machine where full screen was turned off.
      size: Size(1280, 720),
      center: true,
    ),
    () async {
      await _placeFromSettings();
      await windowManager.show();
      await windowManager.focus();
    },
  );

  runApp(ProviderScope(child: VesopaDisplayApp(openSettings: fromLink)));
}

/// Read the chosen monitor straight out of preferences and move there.
///
/// Read here rather than through the Riverpod provider because this runs before
/// there is a widget tree to hold one, and because a window that is already on
/// screen cannot be moved without the customer seeing it happen. The provider
/// reads the same two keys a moment later for the settings screen.
Future<void> _placeFromSettings() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await placeWindow(
      screenKey: prefs.getString(keyScreen) ?? '',
      fullScreen: prefs.getBool(keyFullScreen) ?? true,
    );
  } catch (_) {
    // A window in the position Windows chose. See placeWindow.
  }
}

class VesopaDisplayApp extends StatelessWidget {
  const VesopaDisplayApp({this.openSettings = false, super.key});

  /// Start on the settings screen rather than the display.
  ///
  /// True only when this application was opened by following its own deep
  /// link — see `data/deep_links.dart`. Somebody who has just clicked a link to
  /// this screen is setting it up, and putting them on the setup page saves
  /// them hunting for the faint cog in the corner.
  final bool openSettings;

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Vesopa Customer Display',
    debugShowCheckedModeBanner: false,
    theme: buildDisplayTheme(),
    // One theme, not a light and a dark one. See ui/theme.dart: this screen
    // faces a customer across a counter and a white panel at that distance is
    // a lamp pointed at them.
    home: const DisplayPage(),
    // Pushed rather than swapped for the home, so Back still leads to the
    // display and a screen opened from a link cannot be left with no way to the
    // thing it exists to show.
    onGenerateInitialRoutes: openSettings
        ? (_) => [
            MaterialPageRoute<void>(builder: (_) => const DisplayPage()),
            MaterialPageRoute<void>(builder: (_) => const SettingsPage()),
          ]
        : null,
  );
}
