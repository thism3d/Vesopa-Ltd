import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/ui/widgets/customer_card.dart';

Order order({
  String? customerId = 'c1',
  String? customerName = 'Nicky Tidball',
  String? phone,
  String? email,
  String? cardNumber,
  String discountType = 'none',
  int discountValue = 0,
}) =>
    Order(
      id: 'o1',
      status: 'open',
      subtotalMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
      customerId: customerId,
      customerName: customerName,
      customerPhone: phone,
      customerEmail: email,
      customerCardNumber: cardNumber,
      customerDiscountType: discountType,
      customerDiscountValue: discountValue,
      manualDiscountMinor: 0,
      createdAt: DateTime(2026, 9, 7),
    );

Future<void> pumpCard(
  WidgetTester tester,
  BillCustomer customer, {
  VoidCallback? onChange,
  VoidCallback? onRemove,
}) =>
    tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CustomerCard(
            customer: customer,
            onChange: onChange,
            onRemove: onRemove,
          ),
        ),
      ),
    );

void main() {
  group('reading a customer off a bill', () {
    test('an ordinary walk-in sale has no customer at all', () {
      expect(BillCustomer.of(order(customerId: null, customerName: null)),
          isNull);
      expect(BillCustomer.of(null), isNull);
    });

    test('a name of nothing but spaces is no customer', () {
      expect(BillCustomer.of(order(customerName: '   ')), isNull);
    });

    test('the contact details come off the order, not a lookup', () {
      // The whole reason they are stored there: the till has nowhere to look
      // them up, and a bill parked at seven has to name its customer at nine.
      final c = BillCustomer.of(order(
        phone: '07700 900123',
        email: 'nicky@example.com',
        cardNumber: '4471',
      ))!;
      expect(c.phone, '07700 900123');
      expect(c.contact, contains('nicky@example.com'));
      expect(c.contact, contains('Card 4471'));
    });

    test('the points balance is never read off the order', () {
      // A balance moves. A figure frozen onto a parked bill would be quoted
      // back to a customer as though it were current.
      expect(BillCustomer.of(order())!.pointsBalance, 0);
      expect(BillCustomer.of(order(), pointsBalance: 340)!.pointsBalance, 340);
    });
  });

  group('what the card says', () {
    test('a percentage discount reads as a percentage', () {
      final c = BillCustomer.of(
        order(discountType: 'percent', discountValue: 10),
      )!;
      expect(c.hasDiscount, isTrue);
      expect(c.discountLabel, '10% off');
    });

    test('an amount discount reads as money', () {
      final c = BillCustomer.of(
        order(discountType: 'amount', discountValue: 250),
      )!;
      expect(c.discountLabel, '£2.50 off');
    });

    test('a zero discount is no discount', () {
      final c = BillCustomer.of(
        order(discountType: 'percent', discountValue: 0),
      )!;
      expect(c.hasDiscount, isFalse);
    });

    test('initials are the first and last name', () {
      expect(BillCustomer.of(order())!.initials, 'NT');
      expect(BillCustomer.of(order(customerName: 'Sam'))!.initials, 'S');
      // First and last, not first and second: a middle name is not what
      // anyone would write on the disc.
      expect(
        BillCustomer.of(order(customerName: 'Ana Maria De Souza'))!.initials,
        'AS',
      );
    });

    test('a lapsed membership is worth saying, a live one is not', () {
      final lapsed = BillCustomer(
        name: 'X',
        membershipExpiry: DateTime(2020, 1, 1),
      );
      final live = BillCustomer(
        name: 'X',
        membershipExpiry: DateTime(2999, 1, 1),
      );
      expect(lapsed.membershipLapsed, isTrue);
      expect(live.membershipLapsed, isFalse);
      expect(live.isMember, isTrue);
    });
  });

  group('the card on screen', () {
    testWidgets('shows the name, the discount and the contact details',
        (tester) async {
      await pumpCard(
        tester,
        BillCustomer.of(
          order(
            phone: '07700 900123',
            email: 'nicky@example.com',
            discountType: 'percent',
            discountValue: 10,
          ),
          pointsBalance: 340,
        )!,
      );

      expect(find.text('Nicky Tidball'), findsOneWidget);
      expect(find.text('NT'), findsOneWidget);
      expect(find.text('10% off'), findsOneWidget);
      expect(find.text('340 points'), findsOneWidget);
      expect(
        find.text('07700 900123  ·  nicky@example.com'),
        findsOneWidget,
      );
    });

    testWidgets('a customer with nothing but a name is just a name',
        (tester) async {
      await pumpCard(tester, BillCustomer.of(order())!);
      expect(find.text('Nicky Tidball'), findsOneWidget);
      expect(find.textContaining('points'), findsNothing);
      expect(find.textContaining('off'), findsNothing);
    });

    testWidgets('tapping the card changes the customer', (tester) async {
      var changed = 0;
      await pumpCard(tester, BillCustomer.of(order())!,
          onChange: () => changed++);

      // The whole card, not a small pencil: on a counter the thing being
      // pressed is the thing being looked at.
      await tester.tap(find.text('Nicky Tidball'));
      await tester.pump();
      expect(changed, 1);
    });

    testWidgets('there is a way to take them off the bill', (tester) async {
      var removed = 0;
      await pumpCard(tester, BillCustomer.of(order())!,
          onRemove: () => removed++);

      await tester.tap(find.byIcon(Icons.person_remove_outlined));
      await tester.pump();
      expect(removed, 1);
    });

    testWidgets('no keys are offered once the bill may not be amended',
        (tester) async {
      await pumpCard(tester, BillCustomer.of(order())!);
      expect(find.byIcon(Icons.swap_horiz), findsNothing);
      expect(find.byIcon(Icons.person_remove_outlined), findsNothing);
    });
  });
}
