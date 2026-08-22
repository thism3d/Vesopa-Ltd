import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:window_manager/window_manager.dart';

import 'config/constants.dart';
import 'data/kitchen_branding.dart';
import 'data/providers.dart';
import 'ui/kitchen_shell.dart';
import 'ui/sign_in_page.dart';
import 'ui/splash_screen.dart';
import 'ui/theme.dart';

/// A kitchen screen runs as a kiosk: full screen, and with no way to close or
/// minimise it from the title bar.
///
/// The same lock the till uses, for a sharper version of the same reason. A
/// till that gets minimised stops taking money and somebody notices within
/// seconds. A kitchen screen that gets minimised keeps *looking* like a
/// computer that is working, and the orders behind it are only discovered when
/// a customer asks where their food is.
///
/// There are two ways out, both in the header and both behind a question:
/// **Sign out**, which asks for the kitchen password because it throws the
/// token away and strands the screen, and **Settings › Exit application**,
/// which only asks to confirm because starting the app again brings the screen
/// straight back — the token is on the machine.
Future<void> _lockWindowToKiosk() async {
  if (!(Platform.isWindows || Platform.isMacOS || Platform.isLinux)) return;

  await windowManager.ensureInitialized();
  await windowManager.waitUntilReadyToShow(
    const WindowOptions(
      title: VesopaBrand.appName,
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
  runApp(const ProviderScope(child: VesopaKitchenApp()));
}

class VesopaKitchenApp extends ConsumerStatefulWidget {
  const VesopaKitchenApp({super.key});

  @override
  ConsumerState<VesopaKitchenApp> createState() => _VesopaKitchenAppState();
}

class _VesopaKitchenAppState extends ConsumerState<VesopaKitchenApp> {
  /// Whether the branded start screen is still up.
  ///
  /// State on the app rather than a page in the router, because the splash is a
  /// *layer over* the app and not a step before it: the board mounts, reads its
  /// cache and fires its first poll underneath this, so the hold costs the
  /// moment the orders are looked at rather than the moment they arrive. See
  /// the note at the top of ui/splash_screen.dart — the original objection to a
  /// splash here was two seconds of a kitchen not seeing its orders, and this
  /// is the shape that answers it.
  ///
  /// Shown once per launch. Signing out and back in does not replay it: that
  /// happens mid-service, in front of somebody who is waiting.
  bool _splashDone = false;

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(kitchenSessionProvider);

    // The venue's own, once it is known; the built-in look before that. A first
    // run has nothing cached and gets the Vesopa mark, which is correct — there
    // is no venue yet to be branded as.
    final branding = session.value?.branding ?? KitchenBranding.standard;

    return MaterialApp(
      title: VesopaBrand.appName,
      debugShowCheckedModeBanner: false,
      theme: Kds.theme(),
      builder: (context, child) => MediaQuery.withNoTextScaling(
        // The board's type sizes are chosen for a specific reading distance —
        // see `ui/theme.dart` — and a Windows display scale set for somebody's
        // desktop would reflow a card mid-service into something that no longer
        // fits. The screen's own settings decide how much fits, not the
        // operating system's.
        child: Stack(
          children: [
            child ?? const SizedBox.shrink(),
            if (!_splashDone && branding.splashEnabled)
              SplashScreen(
                branding: branding,
                onDone: () {
                  if (mounted) setState(() => _splashDone = true);
                },
              ),
          ],
        ),
      ),
      home: session.when(
        // Only ever seen for the instant it takes to read the stored session
        // off disk — and, on a normal launch, seen behind the start screen
        // rather than instead of it. This is deliberately still a bare spinner
        // and not a second piece of branding: the start screen is a layer over
        // the app (see the builder above), so whatever is underneath it is a
        // thing nobody looks at.
        loading: () => const _Booting(),
        error: (e, _) => _Booting(message: '$e'),
        // Keyed on the office, so signing out and into a *different* venue
        // builds a fresh shell rather than handing the new venue's board to the
        // old one's state — which would leave the previous kitchen's orders on
        // screen until the first poll landed.
        data: (data) => data.signedIn
            ? KitchenShell(key: ValueKey(data.office))
            : const SignInPage(),
      ),
    );
  }
}

class _Booting extends StatelessWidget {
  const _Booting({this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            if (message != null) ...[
              const SizedBox(height: 16),
              Text(message!, style: const TextStyle(color: Kds.inkMuted)),
            ],
          ],
        ),
      ),
    );
  }
}
