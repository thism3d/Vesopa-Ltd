import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_tap/data/models.dart';
import 'package:vesopa_tap/data/session.dart';
import 'package:vesopa_tap/ui/theme.dart';

import 'data/journal.dart';
import 'ui/brand.dart';
import 'ui/shell.dart';
import 'ui/start_pages.dart';

void main() {
  // How the back office and the other terminals name this device.
  TapSession.product = appName;
  runApp(const ProviderScope(child: LiteApp()));
}

class LiteApp extends ConsumerWidget {
  const LiteApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final phase = ref.watch(tapProvider.select((s) => s.phase));
    // Read the day's sales from storage now, not at the first payment.
    ref.watch(journalProvider.select((j) => j.loaded));
    // Lite is always a counter till on its own: skip Tap's "how is this
    // phone used" question and settle it.
    ref.listen(tapProvider.select((s) => s.phase), (_, next) {
      if (next == Phase.setup) ref.read(tapProvider.notifier).chooseMode(VenueMode.standalone);
    });
    return MaterialApp(
      title: appName,
      debugShowCheckedModeBanner: false,
      theme: Tp.theme(Brightness.light),
      darkTheme: Tp.theme(Brightness.dark),
      // A till behind a bar: ink unless the venue's device is set otherwise.
      themeMode: ThemeMode.dark,
      home: AnimatedSwitcher(
        duration: const Duration(milliseconds: 250),
        child: switch (phase) {
          Phase.booting || Phase.setup => const Scaffold(key: ValueKey('boot'), body: Center(child: LiteMark(size: 72))),
          Phase.welcome => const LiteWelcomePage(key: ValueKey('welcome')),
          Phase.locked => const LiteLockPage(key: ValueKey('locked')),
          Phase.ready => const Shell(key: ValueKey('ready')),
        },
      ),
    );
  }
}
