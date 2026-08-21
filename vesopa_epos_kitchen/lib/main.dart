import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:window_manager/window_manager.dart';

import 'config/constants.dart';
import 'data/providers.dart';
import 'ui/kitchen_shell.dart';
import 'ui/sign_in_page.dart';
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
/// The way out is Sign out, which asks first.
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

class VesopaKitchenApp extends ConsumerWidget {
  const VesopaKitchenApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(kitchenSessionProvider);

    return MaterialApp(
      title: VesopaBrand.appName,
      debugShowCheckedModeBanner: false,
      theme: Kds.theme(),
      home: session.when(
        // Only ever seen for the instant it takes to read the stored session
        // off disk. Not a splash screen: a wall-mounted panel that shows a logo
        // for two seconds on every restart is two seconds of a kitchen not
        // seeing its orders.
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
      builder: (context, child) => MediaQuery.withNoTextScaling(
        // The board's type sizes are chosen for a specific reading distance —
        // see `ui/theme.dart` — and a Windows display scale set for somebody's
        // desktop would reflow a card mid-service into something that no longer
        // fits. The screen's own settings decide how much fits, not the
        // operating system's.
        child: child ?? const SizedBox.shrink(),
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
