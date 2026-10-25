import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'config/constants.dart';
import 'data/session.dart';
import 'ui/pages/clerk_lock.dart';
import 'ui/pages/home.dart';
import 'ui/pages/setup.dart';
import 'ui/pages/welcome.dart';
import 'ui/theme.dart';

void main() => runApp(const ProviderScope(child: TapApp()));

class TapApp extends ConsumerWidget {
  const TapApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final phase = ref.watch(tapProvider.select((s) => s.phase));
    return MaterialApp(
      title: appName,
      debugShowCheckedModeBanner: false,
      theme: Tp.theme(Brightness.light),
      darkTheme: Tp.theme(Brightness.dark),
      home: AnimatedSwitcher(
        duration: const Duration(milliseconds: 250),
        child: switch (phase) {
          Phase.booting => const Scaffold(key: ValueKey('boot'), body: Center(child: TapMark())),
          Phase.welcome => const WelcomePage(key: ValueKey('welcome')),
          Phase.setup => const SetupPage(key: ValueKey('setup')),
          Phase.locked => const ClerkLockPage(key: ValueKey('locked')),
          Phase.ready => const HomePage(key: ValueKey('ready')),
        },
      ),
    );
  }
}
