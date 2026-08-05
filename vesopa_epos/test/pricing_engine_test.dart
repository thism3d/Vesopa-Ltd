import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';

/// Money maths. Every case here is one a venue actually rings up, and the
/// invariant behind all of them is that a bill can never go below zero and a
/// customer can never be charged service on money they did not spend.
PricedLine line({
  int pluid = 1,
  String name = 'Item',
  double qty = 1,
  int unit = 1000,
  double tax = 20,
  String? department,
  String? group,
}) =>
    PricedLine(
      id: 'l$pluid-$qty',
      pluid: pluid,
      name: name,
      quantity: qty,
      unitPriceMinor: unit,
      taxPercentage: tax,
      department: department,
      group: group,
    );

Promotion promo({
  int id = 1,
  String name = 'Offer',
  String kind = 'percent',
  int value = 0,
  int buyQty = 0,
  int freeQty = 0,
  int dealPrice = 0,
  String scope = 'product',
  String? scopeValue,
  int minSpend = 0,
  List<int> products = const [1],
  int priority = 0,
  String days = '1111111',
  String? start,
  String? end,
}) =>
    Promotion(
      id: id,
      name: name,
      kind: kind,
      value: value,
      buyQty: buyQty,
      freeQty: freeQty,
      dealPriceMinor: dealPrice,
      scope: scope,
      scopeValue: scopeValue,
      minSpendMinor: minSpend,
      products: products,
      priority: priority,
      daysOfWeek: days,
      startTime: start,
      endTime: end,
    );

void main() {
  group('no promotions', () {
    test('a plain basket totals its lines', () {
      final t = const PricingEngine().price([line(qty: 2, unit: 895)]);
      expect(t.grossMinor, 1790);
      expect(t.totalMinor, 1790);
      expect(t.promoMinor, 0);
    });

    test('VAT is backed out of an inclusive price', () {
      final t = const PricingEngine().price([line(unit: 1200, tax: 20)]);
      // £12.00 inc 20% = £10.00 net + £2.00 VAT.
      expect(t.taxMinor, 200);
    });

    test('zero-rated lines contribute no VAT', () {
      final t = const PricingEngine().price([line(unit: 1200, tax: 0)]);
      expect(t.taxMinor, 0);
    });
  });

  group('percentage and amount offers', () {
    test('10% off a line', () {
      final e = PricingEngine(promotions: [promo(kind: 'percent', value: 100)]);
      final t = e.price([line(unit: 1000)]);
      expect(t.promoMinor, 100);
      expect(t.totalMinor, 900);
      expect(t.lines.single.promotionName, 'Offer');
    });

    test('amount off is per unit', () {
      final e = PricingEngine(promotions: [promo(kind: 'amount', value: 50)]);
      final t = e.price([line(qty: 3, unit: 1000)]);
      expect(t.promoMinor, 150);
      expect(t.totalMinor, 2850);
    });

    test('an amount off cannot exceed the line', () {
      final e = PricingEngine(promotions: [promo(kind: 'amount', value: 5000)]);
      final t = e.price([line(unit: 1000)]);
      expect(t.promoMinor, 1000);
      expect(t.totalMinor, 0);
    });

    test('fixed price replaces the unit price', () {
      final e = PricingEngine(
          promotions: [promo(kind: 'fixed_price', value: 700)]);
      final t = e.price([line(qty: 2, unit: 1000)]);
      // Two at £7 instead of two at £10.
      expect(t.promoMinor, 600);
      expect(t.totalMinor, 1400);
    });
  });

  group('multi-buy', () {
    test('3 for £10 on exactly three', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'multibuy', buyQty: 3, dealPrice: 1000),
      ]);
      final t = e.price([line(qty: 3, unit: 400)]);
      // £12 becomes £10.
      expect(t.promoMinor, 200);
      expect(t.totalMinor, 1000);
    });

    test('the remainder past a complete group stays full price', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'multibuy', buyQty: 3, dealPrice: 1000),
      ]);
      final t = e.price([line(qty: 4, unit: 400)]);
      // Three for £10, one at £4.
      expect(t.totalMinor, 1400);
    });

    test('two complete groups both get the deal', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'multibuy', buyQty: 3, dealPrice: 1000),
      ]);
      final t = e.price([line(qty: 6, unit: 400)]);
      expect(t.totalMinor, 2000);
    });

    test('below the trigger quantity nothing applies', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'multibuy', buyQty: 3, dealPrice: 1000),
      ]);
      final t = e.price([line(qty: 2, unit: 400)]);
      expect(t.promoMinor, 0);
      expect(t.totalMinor, 800);
    });

    test('buy 2 get 1 free', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'bogof', buyQty: 2, freeQty: 1),
      ]);
      final t = e.price([line(qty: 3, unit: 500)]);
      // One of the three is free.
      expect(t.promoMinor, 500);
      expect(t.totalMinor, 1000);
    });

    test('bogof needs a whole block', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'bogof', buyQty: 2, freeQty: 1),
      ]);
      final t = e.price([line(qty: 2, unit: 500)]);
      expect(t.promoMinor, 0);
    });
  });

  group('choosing between offers', () {
    test('the offer worth most to the customer wins', () {
      final e = PricingEngine(promotions: [
        promo(id: 1, name: 'Small', kind: 'percent', value: 100),
        promo(id: 2, name: 'Big', kind: 'percent', value: 250),
      ]);
      final t = e.price([line(unit: 1000)]);
      expect(t.promoMinor, 250);
      expect(t.lines.single.promotionName, 'Big');
    });

    test('an offer scoped to a department covers its products', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'percent', value: 100, scope: 'department',
            scopeValue: 'Drinks', products: const []),
      ]);
      final t = e.price([line(unit: 1000, department: 'Drinks')]);
      expect(t.promoMinor, 100);
    });

    test('a department offer leaves other departments alone', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'percent', value: 100, scope: 'department',
            scopeValue: 'Drinks', products: const []),
      ]);
      final t = e.price([line(unit: 1000, department: 'Food')]);
      expect(t.promoMinor, 0);
    });

    test('a minimum spend that is not met blocks the offer', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'percent', value: 100, minSpend: 5000),
      ]);
      final t = e.price([line(unit: 1000)]);
      expect(t.promoMinor, 0);
    });

    test('a whole-sale offer applies to the bill', () {
      final e = PricingEngine(promotions: [
        promo(kind: 'percent', value: 100, scope: 'order', products: const []),
      ]);
      final t = e.price([line(unit: 1000), line(pluid: 2, unit: 2000)]);
      expect(t.promoMinor, 300);
      expect(t.totalMinor, 2700);
    });
  });

  group('time windows', () {
    test('an offer outside its days does not apply', () {
      // Monday-only offer, priced on a Saturday.
      final e = PricingEngine(
        promotions: [promo(kind: 'percent', value: 500, days: '1000000')],
        now: DateTime(2026, 7, 18), // a Saturday
      );
      expect(e.price([line(unit: 1000)]).promoMinor, 0);
    });

    test('an offer inside its days applies', () {
      final e = PricingEngine(
        promotions: [promo(kind: 'percent', value: 500, days: '0000010')],
        now: DateTime(2026, 7, 18), // Saturday is index 5
      );
      expect(e.price([line(unit: 1000)]).promoMinor, 500);
    });

    test('happy hour applies only inside its window', () {
      final promos = [
        promo(kind: 'percent', value: 500, start: '17:00', end: '19:00'),
      ];
      final inside = PricingEngine(
          promotions: promos, now: DateTime(2026, 7, 18, 18));
      final outside = PricingEngine(
          promotions: promos, now: DateTime(2026, 7, 18, 20));
      expect(inside.price([line(unit: 1000)]).promoMinor, 500);
      expect(outside.price([line(unit: 1000)]).promoMinor, 0);
    });

    test('a window that crosses midnight still applies after midnight', () {
      final e = PricingEngine(
        promotions: [promo(kind: 'percent', value: 500, start: '22:00', end: '02:00')],
        now: DateTime(2026, 7, 18, 1),
      );
      expect(e.price([line(unit: 1000)]).promoMinor, 500);
    });
  });

  group('discounts, vouchers and points', () {
    test('they apply in order and stack down to the total', () {
      final t = const PricingEngine().price(
        [line(unit: 5000)],
        manualDiscountMinor: 500,
        voucherMinor: 1000,
        pointsMinor: 250,
      );
      expect(t.totalMinor, 3250);
      expect(t.savedMinor, 1750);
    });

    test('a bill can never go below zero however much is taken off', () {
      final t = const PricingEngine().price(
        [line(unit: 1000)],
        manualDiscountMinor: 900,
        voucherMinor: 5000,
        pointsMinor: 5000,
      );
      expect(t.totalMinor, 0);
      // The voucher is worth only what was left after the discount.
      expect(t.voucherMinor, 100);
      expect(t.pointsMinor, 0);
    });

    test('a voucher larger than the bill is capped at the bill', () {
      final t = const PricingEngine()
          .price([line(unit: 800)], voucherMinor: 2000);
      expect(t.voucherMinor, 800);
      expect(t.totalMinor, 0);
    });
  });

  group('gratuity', () {
    test('12.5% is charged on the discounted goods, not the gross', () {
      final t = const PricingEngine().price(
        [line(unit: 10000)],
        manualDiscountMinor: 2000,
        gratuityBp: 125,
        gratuityApplies: true,
      );
      // Service on £80, not £100.
      expect(t.gratuityMinor, 1000);
      expect(t.totalMinor, 9000);
    });

    test('no gratuity when it does not apply', () {
      final t = const PricingEngine().price(
        [line(unit: 10000)],
        gratuityBp: 125,
        gratuityApplies: false,
      );
      expect(t.gratuityMinor, 0);
      expect(t.totalMinor, 10000);
    });

    test('gratuity is not charged on voucher or points value', () {
      final t = const PricingEngine().price(
        [line(unit: 10000)],
        voucherMinor: 5000,
        gratuityBp: 100,
        gratuityApplies: true,
      );
      // 10% of the £50 actually being paid.
      expect(t.gratuityMinor, 500);
    });

    test('the helper rounds tenths of a percent correctly', () {
      expect(TenderSettings.gratuityOn(5040, 125), 630);
      expect(TenderSettings.gratuityOn(1000, 100), 100);
    });
  });

  group('VAT with discounts', () {
    test('a discount reduces the VAT due with it', () {
      final plain = const PricingEngine().price([line(unit: 1200, tax: 20)]);
      final discounted = const PricingEngine()
          .price([line(unit: 1200, tax: 20)], manualDiscountMinor: 600);
      expect(plain.taxMinor, 200);
      // Half the bill discounted means half the VAT.
      expect(discounted.taxMinor, 100);
    });

    test('mixed rates are each computed on their own line', () {
      final t = const PricingEngine().price([
        line(pluid: 1, unit: 1200, tax: 20),
        line(pluid: 2, unit: 500, tax: 0),
      ]);
      expect(t.taxMinor, 200);
      expect(t.totalMinor, 1700);
    });
  });

  group('badges', () {
    test('a covered product gets its badge', () {
      final e = PricingEngine(promotions: [
        Promotion(id: 1, name: 'Deal', kind: 'percent', value: 100,
            products: const [7], badgeText: '10% OFF'),
      ]);
      expect(e.badgeFor(pluid: 7)?.badgeText, '10% OFF');
    });

    test('an uncovered product gets none', () {
      final e = PricingEngine(promotions: [
        Promotion(id: 1, name: 'Deal', kind: 'percent', value: 100,
            products: const [7], badgeText: '10% OFF'),
      ]);
      expect(e.badgeFor(pluid: 8), isNull);
    });
  });

  group('loyalty redemption maths', () {
    const customer = LoyaltyCustomer(
      id: 'c1',
      name: 'A. Khan',
      pointsBalance: 750,
      pointsValueMinor: 750,
      redeemable: true,
      minRedeemPoints: 100,
      redeemStepPoints: 100,
      pointValueMinor: 1,
    );

    test('redemption is rounded down to a whole step', () {
      // 750 points is worth £7.50, but steps of 100 cap it at 700.
      expect(customer.maxRedeemableAgainst(10000), 700);
    });

    test('never redeems more than the bill', () {
      expect(customer.maxRedeemableAgainst(300), 300);
    });

    test('below the minimum, nothing is redeemable', () {
      expect(customer.maxRedeemableAgainst(50), 0);
    });

    test('points earned come from whole pounds spent', () {
      expect(customer.pointsFor(4599), 45);
      expect(customer.pointsFor(99), 0);
    });
  });
}
