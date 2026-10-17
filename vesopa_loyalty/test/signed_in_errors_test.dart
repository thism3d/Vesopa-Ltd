// A signed-in member whose server answers with an error sees the error and a
// way out at once, not a spinner. Found on Pontardawe RFC 1.3.0 (12): after
// the update the card and account pages span for good, and there was no
// sign-out without the Account page.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_loyalty/data/session.dart';
import 'package:vesopa_loyalty/ui/widgets.dart';

const _slug = 'test-club';

/// A page like the card's: the member, or what went wrong.
class _MePage extends ConsumerWidget {
  const _MePage();

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    body: ref.watch(meProvider).when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => LoadFailed(error: e, onRetry: () => ref.invalidate(meProvider)),
      data: (me) => Text('Hello ${me['name']}'),
    ),
  );
}

Future<void> _pump(WidgetTester tester, {required int status, required String body}) async {
  SharedPreferences.setMockInitialValues({
    'loyalty_venue_slug': _slug,
    'loyalty_token_$_slug': 'a-token',
  });
  await http.runWithClient(() async {
    await tester.pumpWidget(
      // As main.dart: no automatic retries.
      ProviderScope(retry: (_, _) => null, child: const MaterialApp(home: _MePage())),
    );
    for (var i = 0; i < 10; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump(const Duration(milliseconds: 50));
    }
  }, () => MockClient((req) async => http.Response(body, status, headers: {'content-type': 'application/json'})));
}

void main() {
  testWidgets('a lapsed membership says so, with Try again and Sign out, without spinning', (tester) async {
    await _pump(tester, status: 403, body: jsonEncode({'error': 'Your membership has lapsed. Please renew at the club.', 'members_only': true}));
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('Your membership has lapsed. Please renew at the club.'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(find.text('Sign out'), findsOneWidget);
  });

  testWidgets('Sign out on the error page forgets the token on this device', (tester) async {
    await _pump(tester, status: 500, body: jsonEncode({'error': 'Something went wrong. Please try again.'}));
    expect(find.text('Sign out'), findsOneWidget);
    await http.runWithClient(() async {
      await tester.tap(find.text('Sign out'));
      for (var i = 0; i < 10; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump(const Duration(milliseconds: 50));
      }
    }, () => MockClient((req) async => http.Response('{}', 200)));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('loyalty_token_$_slug'), isNull);
  });

  testWidgets('signed out by the server: the token is forgotten without a tap', (tester) async {
    await _pump(tester, status: 401, body: jsonEncode({'error': 'Please sign in again.'}));
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('loyalty_token_$_slug'), isNull);
  });
}
