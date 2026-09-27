import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'brand.dart';
import 'data/session.dart';
import 'ui/home.dart';
import 'ui/sign_in.dart';

/// Metric Membership: Metric Group's own membership app.
///
/// A member signs in with Continue with Vesopa, registers their cars by
/// registration, and Metric's ANPR cameras open the barrier for those cars on
/// the way in and out. Built the way the Vesopa loyalty app is (Riverpod,
/// one API client, Continue with Vesopa on every platform), branded for
/// Metric, and served from metric.vesopa.com.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ProviderScope(child: MetricApp()));
}

class MetricApp extends StatelessWidget {
  const MetricApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: MetricBrand.appName,
    debugShowCheckedModeBanner: false,
    theme: MetricBrand.theme(),
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
