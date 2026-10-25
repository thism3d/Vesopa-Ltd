import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_tap/main.dart';

/// A whole service in the demo venue: sign on with a PIN, seat Table 1, order
/// a burger (with its two choices) and a pint, send, and take the bill by tap.
void main() {
  testWidgets('demo: PIN, table, order, send, pay', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    FlutterSecureStorage.setMockInitialValues({}); // a new phone: nothing stored

    await tester.pumpWidget(const ProviderScope(child: TapApp()));
    await tester.pumpAndSettle();
    expect(find.text('Continue with Vesopa'), findsOneWidget);

    await tester.tap(find.text('Try the demo'));
    await tester.pumpAndSettle();
    expect(find.text('Enter your PIN'), findsOneWidget);
    for (final d in ['1', '1', '1', '1']) {
      await tester.tap(find.text(d).first);
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.text('Sam'), findsOneWidget, reason: 'signed on as Sam');

    await tester.tap(find.text('Table 1'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('2'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Pint of Lager'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Mains'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Mains'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Vesopa Burger'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Medium'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Chips'));
    await tester.pumpAndSettle();

    expect(find.text('Send 2'), findsOneWidget);
    await tester.tap(find.text('Send 2'));
    await tester.pumpAndSettle();
    expect(find.text('All sent'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('open-bill')));
    await tester.pumpAndSettle();
    expect(find.text('Take £20.45'), findsOneWidget);
    await tester.tap(find.text('Take £20.45'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Tap to pay on this phone'));
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(find.text('Paid £20.45'), findsOneWidget);
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.text('Paid and closed'), findsNothing);
  });
}
