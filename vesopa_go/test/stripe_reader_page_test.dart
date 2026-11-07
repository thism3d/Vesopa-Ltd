import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/pages/stripe_reader_page.dart';

/// The card reader page, as an iPad at a Stripe venue sees it (2026-11-07).
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<void> show(WidgetTester tester, String body) async {
    final api = TapApi(base: 'https://office.test', client: MockClient((req) async => http.Response(body, 200)))
      ..token = 't'
      ..office = 'venue@example.com';
    await tester.pumpWidget(ProviderScope(
      overrides: [apiProvider.overrideWithValue(api)],
      child: const MaterialApp(home: Scaffold(body: StripeReaderPage())),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('a sandbox with no reader offers a test reader in one tap, and the guide', (tester) async {
    await show(tester, '{"environment": "test", "readers": []}');
    expect(find.byKey(const ValueKey('add-test-reader')), findsOneWidget);
    expect(find.text('Connect a Stripe reader'), findsOneWidget);
  });

  testWidgets("the venue's reader is ticked for this device without asking", (tester) async {
    await show(tester,
        '{"environment": "test", "readers": [{"id": "tmr_1", "label": "Bar", "device_type": "simulated_wisepos_e", "status": "online", "simulated": true}]}');
    expect(find.text('Bar'), findsOneWidget);
    expect(find.textContaining('Stripe test reader'), findsOneWidget);
    expect(find.byKey(const ValueKey('add-test-reader')), findsNothing);
    expect(await deviceStripeReader(), isNull, reason: 'shown ticked; stored only when somebody picks');
  });
}
