/// What the commissioning screen offers, and what it must not.
///
/// "Do not forget to implement the (Vesopa icon) Continue with Vesopa to the
/// softwares removing any other login and registration feature."
///
/// Two shapes, and the difference between them is a flag the back office
/// answers rather than a build — so both are drawn here. The one that would
/// otherwise be found at a venue is the second: a page that says it is Vesopa
/// only and still has a password box on it.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:vesopa_epos/data/session_controller.dart';
import 'package:vesopa_epos/ui/sign_in_page.dart';
import 'package:vesopa_epos/ui/widgets/vesopa_mark.dart';

Future<void> pumpSignIn(WidgetTester tester, VesopaOption option) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        vesopaOptionProvider.overrideWith((ref) async => option),
      ],
      child: const MaterialApp(home: SignInPage()),
    ),
  );
  // Once for the frame, once for the provider settling.
  await tester.pump();
  await tester.pump();
}

const _live = VesopaOption(
  enabled: true,
  only: false,
  issuer: 'https://auth.vesopa.com',
  clientId: 'test-client',
);

const _only = VesopaOption(
  enabled: true,
  only: true,
  issuer: 'https://auth.vesopa.com',
  clientId: 'test-client',
);

void main() {
  group('the commissioning screen', () {
    testWidgets('offers Continue with Vesopa, with the mark on it', (tester) async {
      await pumpSignIn(tester, _live);

      // The words the owner chose, to the letter, and the brand's own mark
      // rather than an open-in-new arrow. All three products say the same
      // thing: a sign-in button's job is being recognised without being read,
      // and two spellings across three apps defeats that.
      expect(find.text('Continue with Vesopa'), findsOneWidget);
      expect(find.byType(VesopaMark), findsOneWidget);
    });

    testWidgets('keeps the password form while both doors are open', (tester) async {
      await pumpSignIn(tester, _live);

      // A venue that has not moved over yet must not be locked out by a flag
      // somebody has not set.
      expect(find.text('Email'), findsOneWidget);
      expect(find.text('Password'), findsOneWidget);
      expect(find.text('Sign in'), findsOneWidget);
    });

    testWidgets('Vesopa only means no password box at all', (tester) async {
      await pumpSignIn(tester, _only);

      // The whole of the request. A page that still asks for a password is a
      // page that has not removed the other way in.
      expect(find.text('Email'), findsNothing);
      expect(find.text('Password'), findsNothing);
      expect(find.text('Sign in'), findsNothing);
      expect(find.text('Continue with Vesopa'), findsOneWidget);
    });

    testWidgets('and no "or" rule, because there is nothing to separate',
        (tester) async {
      await pumpSignIn(tester, _only);
      expect(find.text('or'), findsNothing);
    });

    testWidgets('there is no way to register from a till', (tester) async {
      await pumpSignIn(tester, _only);

      // Staff are made by a manager in the back office. A till that offered to
      // create an account would be a till that could enrol somebody into a
      // venue from the shop floor.
      for (final word in ['Register', 'Sign up', 'Create account', 'Forgot']) {
        expect(
          find.textContaining(word, findRichText: true),
          findsNothing,
          reason: 'the sign-in screen must not offer "$word"',
        );
      }
    });

    testWidgets('a back office that has not been updated is unaffected',
        (tester) async {
      await pumpSignIn(tester, const VesopaOption.off());

      // `only` cannot turn itself on: with Vesopa sign-in off there would be
      // no way in at all.
      expect(find.text('Email'), findsOneWidget);
      expect(find.text('Password'), findsOneWidget);
      expect(find.text('Continue with Vesopa'), findsNothing);
    });
  });
}
