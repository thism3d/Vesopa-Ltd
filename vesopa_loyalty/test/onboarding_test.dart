import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_loyalty/ui/onboarding.dart';

/// The welcome in front of a stand-in sign-in page.
Widget _app({required Future<bool> Function() ask, Key? key}) => MaterialApp(
  home: OnboardingGate(
    key: key,
    slug: 'pontardawerfc',
    venueName: 'Pontardawe RFC',
    wallet: false,
    askPermission: ask,
    child: const Scaffold(body: Text('sign in')),
  ),
);

/// Frame by frame: the kick at the posts never settles, so pumpAndSettle would wait forever.
Future<void> _wait(WidgetTester tester, [int ms = 800]) async {
  for (var t = 0; t < ms; t += 50) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  testWidgets('the welcome shows once and asks for notifications on its own page', (tester) async {
    SharedPreferences.setMockInitialValues({});
    var asked = 0;
    Future<bool> ask() async {
      asked++;
      return true;
    }

    await tester.pumpWidget(_app(ask: ask));
    await _wait(tester);
    expect(find.text('Welcome to Pontardawe RFC'), findsOneWidget);
    expect(find.text('sign in'), findsNothing);

    // Welcome, then the card, then the notifications page.
    await tester.tap(find.text('Next'));
    await _wait(tester);
    expect(find.text('Your card at the bar'), findsOneWidget);
    await tester.tap(find.text('Next'));
    await _wait(tester);
    expect(find.text('Club news as it happens'), findsOneWidget);
    expect(asked, 0);

    await tester.tap(find.text('Turn on notifications'));
    await _wait(tester);
    expect(asked, 1);
    // The yes is the member's choice, for the first start after signing in.
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('push_on_pontardawerfc'), isTrue);

    // No wallet here, so the notifications page was the last: answered, it
    // goes on to sign-in.
    expect(find.text('sign in'), findsOneWidget);

    // Opened again: straight to sign-in.
    await tester.pumpWidget(_app(ask: ask, key: UniqueKey()));
    await _wait(tester);
    expect(find.text('sign in'), findsOneWidget);
    expect(find.text('Welcome to Pontardawe RFC'), findsNothing);
  });

  testWidgets('Not now leaves notifications off and never asks', (tester) async {
    SharedPreferences.setMockInitialValues({});
    var asked = 0;
    await tester.pumpWidget(_app(ask: () async => ++asked > 0));
    await _wait(tester);
    await tester.tap(find.text('Next'));
    await _wait(tester);
    await tester.tap(find.text('Next'));
    await _wait(tester);
    await tester.tap(find.text('Not now'));
    await _wait(tester);
    expect(asked, 0);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('push_on_pontardawerfc'), isNull);
    expect(find.text('sign in'), findsOneWidget);
  });

  testWidgets('Skip goes straight to sign-in', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(_app(ask: () async => true));
    await _wait(tester);
    await tester.tap(find.text('Skip'));
    await _wait(tester);
    expect(find.text('sign in'), findsOneWidget);
    expect((await SharedPreferences.getInstance()).getBool('welcome_seen'), isTrue);
  });
}
