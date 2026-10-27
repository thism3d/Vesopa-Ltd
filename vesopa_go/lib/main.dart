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
import 'data/session.dart';
import 'ui/pages/setup.dart';
import 'ui/theme.dart';

const demoOnly = bool.fromEnvironment('GO_DEMO_ONLY');

void main() {
  // How the back office and the other terminals name this device.
  TapSession.product = appName;
  runApp(const ProviderScope(child: GoApp()));
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
    return MaterialApp(
      title: appName,
      debugShowCheckedModeBanner: false,
      theme: Tp.theme(Brightness.light),
      darkTheme: Tp.theme(Brightness.dark),
      // A till behind a bar: ink unless the device is set otherwise.
      themeMode: ThemeMode.dark,
      home: AnimatedSwitcher(
        duration: const Duration(milliseconds: 250),
        child: switch (phase) {
          Phase.booting => const Scaffold(key: ValueKey('boot'), body: Center(child: GoMark(size: 72))),
          Phase.welcome when demoOnly => const Scaffold(key: ValueKey('boot'), body: Center(child: GoMark(size: 72))),
          Phase.welcome => const LiteWelcomePage(key: ValueKey('welcome')),
          Phase.setup => const SetupPage(key: ValueKey('setup')),
          Phase.locked => const LiteLockPage(key: ValueKey('locked')),
          Phase.ready => const Shell(key: ValueKey('ready')),
        },
      ),
    );
  }
}
