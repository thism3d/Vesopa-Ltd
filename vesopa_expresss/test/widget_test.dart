import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_express/data/session.dart';
import 'package:vesopa_express/ui/app.dart';

/// A kiosk that has never been set up shows one thing: Continue with Vesopa.
void main() {
  testWidgets('a new kiosk asks to be set up, with the Vesopa button and nothing else', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.binding.setSurfaceSize(const Size(1080, 1920));
    await tester.pumpWidget(const ProviderScope(child: ExpressApp()));
    // Starting reads the disk; wait for the screen rather than for a time.
    for (var i = 0; i < 40 && find.text('Continue with Vesopa').evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    expect(find.text('Continue with Vesopa'), findsOneWidget);
    expect(find.text('Set up this kiosk'), findsOneWidget);
    // One way in: no email box, no password box, no "create an account".
    expect(find.byType(TextField), findsNothing);
    expect(find.textContaining('account?'), findsNothing);

    final container = ProviderScope.containerOf(tester.element(find.byType(ExpressApp)));
    expect(container.read(kioskSessionProvider).phase, Phase.setup);
  });
}
