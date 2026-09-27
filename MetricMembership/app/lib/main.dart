import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'brand.dart';
import 'data/api.dart';
import 'data/session.dart';
import 'ui/home.dart';
import 'ui/sign_in.dart';
import 'ui/system_bars.dart';
import 'ui/widgets.dart';

/// Metric Membership: Metric Group's own membership app.
///
/// A member signs in with Continue with Vesopa, registers their cars by
/// registration, and Metric's ANPR cameras open the barrier for those cars on
/// the way in and out. Built the way the Vesopa loyalty app is (Riverpod,
/// one API client, Continue with Vesopa on every platform), branded for
/// Metric, and served from metric.vesopa.com.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await loadSavedBarTheme();
  runApp(const ProviderScope(child: MetricApp()));
  _appearance();
  // Staff can change Appearance at any time: look again whenever the app
  // comes back to the front.
  AppLifecycleListener(onResume: _appearance);
}

/// Staff's choices from the console (Appearance). The app draws with the last
/// ones it saw until they arrive, and keeps them if the server can't be reached.
void _appearance() {
  MetricApi().brand().then((b) {
    final style = b['plateStyle'];
    if (style is String) plateStyle.value = style;
    final theme = b['theme'];
    if (theme is Map<String, dynamic>) setBarTheme(theme);
  }).catchError((_) {});
}

class MetricApp extends StatelessWidget {
  const MetricApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: MetricBrand.appName,
    debugShowCheckedModeBanner: false,
    theme: MetricBrand.theme(),
    builder: (context, child) => SystemBars(child: child ?? const SizedBox.shrink()),
    home: const _Gate(),
  );
}

class _Gate extends ConsumerWidget {
  const _Gate();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    return session.when(
      loading: () => const _Splash(),
      error: (_, _) => const SignInPage(),
      data: (token) => token == null ? const SignInPage() : const HomePage(),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Image.asset(MetricBrand.icon, width: 88, height: 88),
          const SizedBox(height: 24),
          const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 3)),
        ],
      ),
    ),
  );
}
