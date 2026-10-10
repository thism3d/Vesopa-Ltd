import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_loyalty/data/brand.dart';
import 'package:vesopa_loyalty/data/session.dart';
import 'package:vesopa_loyalty/data/signin.dart';
import 'package:vesopa_loyalty/ui/sign_in.dart';

Brand _brand(Set<String> methods) => Brand(
  slug: 'pontardawe-rfc',
  name: 'Pontardawe RFC',
  venue: 'Pontardawe RFC',
  welcome: 'Members Discount',
  primary: const Color(0xFF8F0000),
  accent: const Color(0xFFC41414),
  background: const Color(0xFF8F0000),
  text: Colors.white,
  signIn: SignInConfig(offered: methods),
);

Future<void> _pump(WidgetTester tester, Set<String> methods) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [brandProvider.overrideWith((ref) async => _brand(methods))],
      child: const MaterialApp(home: _Wait()),
    ),
  );
  for (var i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// The sign-in page once the branding is in, as the app only ever shows it.
class _Wait extends ConsumerWidget {
  const _Wait();

  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      ref.watch(brandProvider).hasValue ? const SignInPage() : const SizedBox();
}

void main() {
  testWidgets('through Vesopa, Apple, Google, a passkey and the phone each have a button, and Vesopa none of its own', (tester) async {
    await _pump(tester, {'code_email', 'password', 'vesopa'});
    for (final label in ['Continue with Apple', 'Continue with Google', 'Use a passkey', 'Continue with your phone']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    // They are Continue with Vesopa; it has no button of its own.
    expect(find.text('Continue with Vesopa'), findsNothing);
    // The password is a form, so it stays a link.
    expect(find.text(signInLabel('password')), findsOneWidget);
  });

  testWidgets('a venue that texts codes itself does not send the phone through Vesopa', (tester) async {
    await _pump(tester, {'code_email', 'code_sms', 'vesopa'});
    expect(find.text('Continue with your phone'), findsNothing);
    expect(find.text('Continue with Google'), findsOneWidget);
  });

  testWidgets('without Vesopa there are no provider buttons', (tester) async {
    await _pump(tester, {'code_email', 'password'});
    expect(find.text('Continue with Google'), findsNothing);
    expect(find.text('Continue with Apple'), findsNothing);
  });
}
