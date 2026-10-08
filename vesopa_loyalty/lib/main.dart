import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import 'data/activity_log.dart';
import 'data/app_update.dart';
import 'data/api.dart';
import 'data/session.dart';
import 'ui/home.dart';
import 'ui/sign_in.dart';
import 'ui/venue_intro.dart';
import 'ui/venue_picker.dart';

/// Vesopa Loyalty: a venue's own loyalty app.
///
/// One build for every venue. The venue -- its name, logo, colours and fonts
/// -- is read from the back office when the app opens (Loyalty App in the back
/// office), so a venue's app is theirs without a build of its own. See
/// data/session.dart for how the app knows which venue it is.
/// This build's version, for the activity log. Keep in step with pubspec.yaml.
const loyaltyAppVersion = '1.0.11.0';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // An update somebody chose to take "On next start" runs now, before
  // anything else opens (data/app_update.dart). Returns at once otherwise.
  await Updater.applyPending(loyaltyAppVersion);
  // The activity log: taps, screens and errors, to the back office's Activity
  // Log once the customer is signed in (and to a local file off the web). The
  // server fills in the venue and the customer from the sign-in token.
  ActivityLog.instance
    ..configure(app: 'loyalty', appVersion: loyaltyAppVersion)
    ..installErrorHandlers();
  // A venue's own build opens on its crest (ui/venue_intro.dart), which
  // decodes the crest before the first frame is let through.
  if (VenueIntro.enabled) VenueIntro.holdFirstFrame();
  runApp(const ProviderScope(child: VenueIntro.enabled ? _IntroHost() : LoyaltyApp()));
}

/// The app under a venue build's opening, which lifts away once the app has
/// its venue's branding (or has failed to get it, and says so).
class _IntroHost extends ConsumerWidget {
  const _IntroHost();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final venue = ref.watch(venueProvider);
    final ready = !venue.isLoading && ((venue.value ?? '').isEmpty || !ref.watch(brandProvider).isLoading);
    return VenueIntro(ready: ready, child: const LoyaltyApp());
  }
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
      data: (b) {
        // Sent with the customer's own token, read at send time, to the same
        // server the app already talks to.
        final api = ref.watch(apiProvider);
        ActivityLog.instance
          ..apiBase = api.base
          ..token = (() => api.token);
        return MaterialApp(
          title: b.name,
          debugShowCheckedModeBanner: false,
          theme: b.theme(),
          navigatorObservers: [ActivityLog.instance.observer],
          builder: (context, child) => ActivityLog.instance.wrap(child ?? const SizedBox.shrink()),
          home: const _Gate(),
        );
      },
    );
  }
}

/// The version every member's copy is set to on admin.vesopa.com (Versions),
/// when it is not this one. Loyalty has no venue credential, so it asks the
/// open check rather than the licence one, every half hour, and only a copy
/// from our own installer ever asks (a Store copy is updated by the Store).
final loyaltyUpdateProvider = FutureProvider<AppUpdate?>((ref) async {
  final recheck = Timer(const Duration(minutes: 30), ref.invalidateSelf);
  ref.onDispose(recheck.cancel);
  if (kIsWeb) return null;
  final me = await Installation.current(loyaltyAppVersion);
  if (!me.updatable) return null;
  try {
    final res = await http
        .get(Uri.parse('${AppConfig.apiBase}/loyalty/v1/app-update'), headers: me.headers)
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) return null;
    return AppUpdate.fromJson((jsonDecode(res.body) as Map<String, dynamic>)['update']);
  } catch (_) {
    return null;
  }
});

/// Signed in or not.
class _Gate extends ConsumerWidget {
  const _Gate();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    ref.listen(loyaltyUpdateProvider, (_, next) {
      unawaited(offerUpdate(context, update: next.value, appName: 'this app', builtVersion: loyaltyAppVersion));
    });
    /*
     * SIGNED OUT OF THE STORE APP MEANS BACK TO CONTINUE WITH VESOPA.
     *
     * A venue's own sign-in page -- an emailed code and the rest -- belongs to
     * the browser, which is always at one venue's address. The Store app has
     * one way in, so a member who signs out (or is signed out from another
     * device) forgets the venue and meets Continue with Vesopa again. A build
     * made for one venue (LOYALTY_SLUG) keeps its venue's page.
     */
    final storeApp = !kIsWeb && AppConfig.buildSlug.isEmpty;
    Widget signedOut() {
      if (!storeApp) return const SignInPage();
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(venueProvider.notifier).forget());
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return session.when(
      loading: () => const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (_, _) => signedOut(),
      data: (token) => token == null ? signedOut() : const HomePage(),
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
