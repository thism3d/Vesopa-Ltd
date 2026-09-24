// Signs a real till in against the server, through the sign-in form.
//
//     flutter test integration_test/sign_in_test.dart -d windows \
//       --dart-define=EPOS_TEST_EMAIL=... --dart-define=EPOS_TEST_PASSWORD=...
//
// It talks to whichever server config/constants.dart points at, and a
// successful run takes a till seat at that venue, as any sign-in does.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:vesopa_epos/main.dart' as app;
import 'package:vesopa_epos/ui/shell.dart';
import 'package:vesopa_epos/ui/sign_in_page.dart';

const _email = String.fromEnvironment('EPOS_TEST_EMAIL');
const _password = String.fromEnvironment('EPOS_TEST_PASSWORD');

Future<void> _pumpUntil(WidgetTester tester, Finder f,
    {Duration timeout = const Duration(seconds: 60)}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 250));
    if (f.evaluate().isNotEmpty) return;
  }
  final onScreen = find
      .byType(Text)
      .evaluate()
      .map((e) => (e.widget as Text).data ?? (e.widget as Text).textSpan?.toPlainText())
      .whereType<String>()
      .join(' | ');
  throw TestFailure('timed out waiting for $f\nOn screen: $onScreen');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('a back office account signs the till in', (tester) async {
    expect(_email, isNotEmpty, reason: 'pass --dart-define=EPOS_TEST_EMAIL');
    expect(_password, isNotEmpty, reason: 'pass --dart-define=EPOS_TEST_PASSWORD');

    // Start signed out, whatever this machine did last.
    (await SharedPreferences.getInstance()).remove('session');

    await app.main();
    await _pumpUntil(tester, find.byType(SignInPage));

    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), _email);
    await tester.enterText(fields.at(1), _password);
    await tester.tap(find.text('Sign in'));

    await _pumpUntil(tester, find.byType(PosShell));

    final raw = (await SharedPreferences.getInstance()).getString('session');
    final saved = jsonDecode(raw!) as Map<String, dynamic>;
    // ignore: avoid_print
    print('SIGNED IN: ${saved['email']} at ${saved['officeName']} '
        '(office ${saved['office']}), terminal token: '
        '${(saved['terminalToken'] as String?)?.isNotEmpty == true}');
    expect(saved['terminalToken'], isNotNull);
  });
}
