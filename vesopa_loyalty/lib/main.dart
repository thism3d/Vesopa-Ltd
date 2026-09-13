import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'data/api.dart';
import 'data/session.dart';
import 'ui/home.dart';
import 'ui/sign_in.dart';
import 'ui/venue_picker.dart';

/// Vesopa Loyalty: a venue's own loyalty app.
///
/// One build for every venue. The venue -- its name, logo, colours and fonts
/// -- is read from the back office when the app opens (Loyalty App in the back
/// office), so a venue's app is theirs without a build of its own. See
/// data/session.dart for how the app knows which venue it is.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ProviderScope(child: LoyaltyApp()));
}

class LoyaltyApp extends ConsumerWidget {
  const LoyaltyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    /*
     * WHICH VENUE, BEFORE ANYTHING ELSE.
     *
     * A browser reads it from the address. Windows, Android and an iPhone
     * have to be told once, and until they have been there is nothing to
     * fetch and no branding to draw -- so the picker comes first and every
     * provider below it is built from the answer.
     */
    final venue = ref.watch(venueProvider);
    if (venue.isLoading) {
      return const MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(body: Center(child: CircularProgressIndicator())),
      );
    }
    if ((venue.value ?? '').isEmpty) {
      return const MaterialApp(
        debugShowCheckedModeBanner: false,
        home: VenuePickerPage(),
      );
    }
    final brand = ref.watch(brandProvider);
    return brand.when(
      loading: () => const MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(body: Center(child: CircularProgressIndicator())),
      ),
      error: (e, _) => MaterialApp(
        debugShowCheckedModeBanner: false,
        home: _Notice(
          e is ApiError ? e.message : 'Could not open the app. Check you are online.',
          onRetry: () => ref.invalidate(brandProvider),
        ),
      ),
      data: (b) => MaterialApp(
        title: b.name,
        debugShowCheckedModeBanner: false,
        theme: b.theme(),
        home: const _Gate(),
      ),
    );
  }
}

/// Signed in or not.
class _Gate extends ConsumerWidget {
  const _Gate();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    return session.when(
      loading: () => const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (_, _) => const SignInPage(),
      data: (token) => token == null ? const SignInPage() : const HomePage(),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice(this.text, {this.onRetry});

  final String text;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(text, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              FilledButton(onPressed: onRetry, child: const Text('Try again')),
            ],
          ],
        ),
      ),
    ),
  );
}
