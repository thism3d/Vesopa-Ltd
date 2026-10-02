import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';
import 'package:vesopa_epos/ui/widgets/scheme_picker.dart';

/// Loyalty schemes on the till: "When creating a new customer on the till, it
/// should ask which Loyalty Scheme the customer wants to be part of", and the
/// scheme's discount follows its departments, days and hours.
void main() {
  // Friday 2 October 2026.
  final friday7pm = DateTime(2026, 10, 2, 19, 30);

  LoyaltyScheme scheme(Map<String, dynamic> over) => LoyaltyScheme.fromJson({
        'id': 1,
        'name': 'VIP',
        'reward_type': 'percent',
        'discount_value': 10,
        ...over,
      })!;

  group('the scheme itself', () {
    test('reads what the back office sends, lists as JSON text too', () {
      final s = scheme({
        'discount_departments': '["Beers","Ciders"]',
        'earn_points': 1,
        'is_default': '1',
        'offer_at_till': 0,
        'colour': '#7c5cd6',
      });
      expect(s.discountDepartments, ['Beers', 'Ciders']);
      expect(s.earnPoints, isTrue);
      expect(s.isDefault, isTrue);
      expect(s.offerAtTill, isFalse);
      expect(s.color.toARGB32(), 0xff7c5cd6);
      expect(s.rewardLabel, '10% off Beers and Ciders');
    });

    test('a copy on a bill reads back the same', () {
      final s = scheme({'discount_departments': ['Food'], 'days_of_week': '1111100'});
      final back = LoyaltyScheme.decode(s.encode())!;
      expect(back.discountDepartments, ['Food']);
      expect(back.daysOfWeek, '1111100');
      expect(LoyaltyScheme.decode('not json'), isNull);
      expect(LoyaltyScheme.decode(null), isNull);
    });

    test('the window follows days and hours, across midnight too', () {
      expect(scheme({}).activeAt(friday7pm), isTrue);
      expect(scheme({'days_of_week': '1111011'}).activeAt(friday7pm), isFalse);
      expect(
        scheme({'start_time': '17:00', 'end_time': '19:00'}).activeAt(friday7pm),
        isFalse,
      );
      final late = scheme({'start_time': '18:00', 'end_time': '02:00', 'days_of_week': '0000100'});
      expect(late.activeAt(friday7pm), isTrue);
      // 1am Saturday belongs to Friday night.
      expect(late.activeAt(DateTime(2026, 10, 3, 1, 0)), isTrue);
      // 1am Friday belongs to Thursday night, which is off.
      expect(late.activeAt(DateTime(2026, 10, 2, 1, 0)), isFalse);
      expect(scheme({'reward_type': 'none'}).activeAt(friday7pm), isFalse);
    });

    test('the discount covers only its departments', () {
      final s = scheme({'discount_departments': ['Beers']});
      final lines = [(pluId: 1, grossMinor: 1000), (pluId: 2, grossMinor: 1250)];
      final departments = {1: 'Beers', 2: 'Food'};
      expect(
        s.discountOn(lines, departments: departments, now: friday7pm),
        100,
      );
      expect(
        scheme({}).discountOn(lines, departments: departments, now: friday7pm),
        225,
      );
    });

    test('a fixed amount never comes to more than it covers', () {
      final s = scheme({'reward_type': 'amount', 'discount_value': 500, 'discount_departments': ['Beers']});
      expect(
        s.discountOn([(pluId: 1, grossMinor: 300)], departments: {1: 'Beers'}, now: friday7pm),
        300,
      );
    });

    test('a member short of the points asked for gets nothing yet', () {
      final s = scheme({'min_points_for_discount': 100});
      final lines = [(pluId: 1, grossMinor: 1000)];
      expect(s.discountOn(lines, departments: const {}, now: friday7pm, points: 99), 0);
      expect(s.discountOn(lines, departments: const {}, now: friday7pm, points: 100), 100);
    });

    test('points are earned on the departments that earn, net of discounts', () {
      final s = scheme({'earn_departments': ['Food']});
      final lines = [(pluId: 1, grossMinor: 1000), (pluId: 2, grossMinor: 1000)];
      expect(
        eligibleSpendMinor(s, lines, departments: {1: 'Beers', 2: 'Food'}, netGoodsMinor: 1800),
        900,
      );
      // Earning on everything sends nothing: the whole spend earns.
      expect(
        eligibleSpendMinor(scheme({}), lines, departments: const {}, netGoodsMinor: 1800),
        isNull,
      );
    });
  });

  group('asking which scheme', () {
    final schemes = [
      scheme({'id': 1, 'name': 'VIP', 'card_prefix': '9997'}),
      scheme({'id': 2, 'name': 'Member', 'card_prefix': '9998', 'is_default': 1}),
      scheme({'id': 3, 'name': 'Committee', 'offer_at_till': 0}),
    ];

    test('only the schemes the venue offers at the till', () {
      expect(tillSchemes(schemes).map((s) => s.name), ['VIP', 'Member']);
    });

    test("the card's own scheme is already picked, else the default", () {
      final offered = tillSchemes(schemes);
      expect(initialSchemeId(offered, cardNumber: '999700012'), 1);
      expect(initialSchemeId(offered, cardNumber: '999800012'), 2);
      expect(initialSchemeId(offered), 2);
      expect(initialSchemeId(const []), isNull);
    });
  });

  group('on a bill', () {
    late AppDatabase db;
    late OrderRepository repo;

    const lager = Product(
      pluId: 1,
      name: 'Lager',
      priceMinor: 520,
      price2Minor: 450,
      taxPercentage: 20,
      stockQuantity: 0,
      printToReceipt: true,
      renewsMembership: false,
      isModifier: false,
      departmentName: 'Beers',
    );
    const burger = Product(
      pluId: 2,
      name: 'Burger',
      priceMinor: 1250,
      taxPercentage: 20,
      stockQuantity: 0,
      printToReceipt: true,
      renewsMembership: false,
      isModifier: false,
      departmentName: 'Food',
    );

    setUp(() async {
      db = AppDatabase.forTesting(NativeDatabase.memory());
      repo = OrderRepository(db);
      await db.into(db.products).insert(lager);
      await db.into(db.products).insert(burger);
    });

    tearDown(() => db.close());

    test("a member's scheme discount comes off its departments only", () async {
      final id = await repo.openOrder();
      await repo.addLine(id, lager, qty: 2);
      await repo.addLine(id, burger);
      await repo.attachCustomer(
        id,
        id: 'c1',
        name: 'Sarah Jones',
        membershipExpiry: null,
        scheme: scheme({'discount_departments': ['Beers']}),
        memberNumber: '00012',
      );

      final order = await repo.watchOrder(id).first;
      expect(order.customerMemberNo, '00012');
      // 10% of £10.40 of lager, nothing off the burger.
      expect(order.totalMinor, 1040 + 1250 - 104);
    });

    test("the customer's own discount wins over the scheme", () async {
      final id = await repo.openOrder();
      await repo.addLine(id, burger);
      await repo.attachCustomer(
        id,
        id: 'c1',
        name: 'Sarah Jones',
        membershipExpiry: null,
        discountType: 'percent',
        discountValue: 20,
        scheme: scheme({}),
      );
      final order = await repo.watchOrder(id).first;
      expect(order.totalMinor, 1000);
    });

    test('a price-level scheme moves the bill to that level, and back', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, lager);
      await repo.attachCustomer(
        id,
        id: 'c1',
        name: 'Sarah Jones',
        membershipExpiry: null,
        scheme: scheme({'reward_type': 'price_level', 'price_level': 2}),
      );
      expect((await repo.watchLines(id).first).single.unitPriceMinor, 450);

      // And what is rung next is at the scheme's level too.
      await repo.addLine(id, lager, consolidate: false);
      final lines = await repo.watchLines(id).first;
      expect(lines.map((l) => l.unitPriceMinor), everyElement(450));

      await repo.clearCustomer(id);
      final after = await repo.watchLines(id).first;
      expect(after.map((l) => l.unitPriceMinor), everyElement(520));
    });

    test('a scheme with no rewards changes nothing', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, burger);
      await repo.attachCustomer(
        id,
        id: 'c1',
        name: 'Sarah Jones',
        membershipExpiry: null,
        scheme: scheme({'reward_type': 'none'}),
      );
      expect((await repo.watchOrder(id).first).totalMinor, 1250);
    });
  });
}
