import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/counter/data/lite_state.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/payments/payment_service.dart';
import 'package:vesopa_go/payments/stripe_tap.dart';
import 'package:vesopa_go/ui/gateway_mark.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('each payment service names its own gateway', () {
    expect(gatewayOf(StripeTapToPay(TapApi())), CardGateway.stripe);
    expect(gatewayOf(DojoTapToPay(TapApi())), CardGateway.dojo);
    expect(gatewayOf(DemoPayments()), isNull);
  });

  test('every logo is in the app', () async {
    for (final g in CardGateway.values) {
      expect((await rootBundle.load(g.asset)).lengthInBytes, greaterThan(0), reason: g.label);
    }
  });

  testWidgets('the badge shows the gateway, and nothing in the demo', (tester) async {
    Future<void> show(CardGateway? g) => tester.pumpWidget(ProviderScope(
          key: UniqueKey(),
          overrides: [cardGatewayProvider.overrideWithValue(g)],
          child: const MaterialApp(home: Scaffold(body: GatewayBadge())),
        ));

    await show(CardGateway.stripe);
    expect(find.text('Paid with'), findsOneWidget);
    expect(find.byKey(const ValueKey('gateway-stripe')), findsOneWidget);

    await show(null);
    expect(find.text('Paid with'), findsNothing);
  });

  test('a Stripe venue always takes Tap to Pay on the device', () {
    const stripe = TapConfig(tapProvider: 'stripe');
    expect(cardVia(const LiteSettings(cardVia: 'machine'), stripe, tablet: true), 'tap');
    expect(cardVia(const LiteSettings(cardVia: 'machine'), const TapConfig()), 'machine');
  });
}
