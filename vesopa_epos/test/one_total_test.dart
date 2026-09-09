/// A bill comes to one number, and every surface reads that number.
///
/// THE BILL THE VENUE FILMED. Two Negroni at £10, sweet potato fries at £4.80
/// and an Espresso Martini at £10.50 — £35.30 of goods — against a venue that
/// runs a 10% offer and a "2 Cocktails for £16" deal.
///
/// The check panel read TOTAL £31.77 and the Pay key beside it read £30.80, at
/// the same moment, on the same bill. Neither was right: the panel's engine
/// applied the promotion and knew nothing about the deal, and the engine that
/// wrote the stored total applied the deal and knew nothing about the
/// promotion. The customer was charged the panel's figure, so the deal the
/// venue advertises was never actually given.
///
/// These pin the arithmetic. `recalculate` is exercised separately in
/// order_repository_test.dart; what is proved here is that one basket has one
/// answer and that every reduction reaches it.
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';

PricedLine line(
  int plu,
  String name,
  int unitMinor, {
  double qty = 1,
  int keyed = 0,
  double vat = 20,
}) =>
    PricedLine(
      id: 'l$plu-$name',
      pluid: plu,
      name: name,
      quantity: qty,
      unitPriceMinor: unitMinor,
      taxPercentage: vat,
      lineDiscountMinor: keyed,
    );

/// The venue's 10% off the whole sale.
const tenPercent = Promotion(
  id: 1,
  name: '10% off',
  kind: 'percent',
  // Tenths of a percent — 100 is 10%.
  value: 100,
  scope: 'order',
);

/// The basket in the recording.
List<PricedLine> filmedBasket() => [
      line(1, 'Negroni', 1000, qty: 2),
      line(2, 'Sweet Potato Fries', 480),
      line(3, 'Espresso Martini', 1050),
    ];

void main() {
  group('the bill the venue filmed', () {
    test('the goods are £35.30', () {
      final t = PricingEngine().price(filmedBasket(), dealMinor: 0);
      expect(t.grossMinor, 3530);
    });

    // "2 Cocktails for £16" takes the two dearest cocktails — the Espresso
    // Martini at £10.50 and one Negroni at £10.00, £20.50 for £16.00.
    test('the deal and the offer BOTH come off, which is the whole fault', () {
      final t = PricingEngine(promotions: const [tenPercent])
          .price(filmedBasket(), dealMinor: 450);

      expect(t.dealMinor, 450, reason: 'the deal has to reach the total');
      // Ten per cent of what is left after the deal — £30.80 — not of the
      // shelf price. An offer on money the customer is not paying takes off
      // more than the offer promises.
      expect(t.promoMinor, 308);
      expect(t.totalMinor, 3530 - 450 - 308);
      expect(t.totalMinor, 2772);
    });

    test('neither of the two old answers survives', () {
      final t = PricingEngine(promotions: const [tenPercent])
          .price(filmedBasket(), dealMinor: 450);

      // What the check panel used to say: the offer and no deal.
      expect(t.totalMinor, isNot(3177));
      // What the Pay key used to say: the deal and no offer.
      expect(t.totalMinor, isNot(3080));
    });

    test('with no deals the answer is the panel’s old one', () {
      // A venue that runs offers and no mix & match is unaffected by any of
      // this, and that has to stay true.
      final t = PricingEngine(promotions: const [tenPercent])
          .price(filmedBasket(), dealMinor: 0);
      expect(t.totalMinor, 3177);
    });

    test('with no offers the answer is the Pay key’s old one', () {
      final t = PricingEngine().price(filmedBasket(), dealMinor: 450);
      expect(t.totalMinor, 3080);
    });
  });

  group('a clerk’s per-line discount', () {
    test('reaches the total, which it never did on the payment screen', () {
      final t = PricingEngine().price(
        [line(1, 'Negroni', 1000, qty: 2, keyed: 100)],
        dealMinor: 0,
      );
      expect(t.lineDiscountMinor, 100);
      expect(t.totalMinor, 1900);
    });

    test('cannot make a line pay the customer', () {
      final t = PricingEngine().price(
        [line(1, 'Negroni', 1000, keyed: 9999)],
        dealMinor: 0,
      );
      expect(t.totalMinor, 0);
      expect(t.lineDiscountMinor, 1000);
    });
  });

  group('nothing can drive a bill below nothing', () {
    test('a deal larger than the basket is clamped', () {
      final t = PricingEngine().price(
        [line(1, 'Negroni', 1000)],
        dealMinor: 5000,
      );
      expect(t.dealMinor, 1000);
      expect(t.totalMinor, 0);
    });

    test('a deal, an offer and a keyed discount together', () {
      final t = PricingEngine(promotions: const [tenPercent]).price(
        [line(1, 'Negroni', 1000, qty: 2, keyed: 200)],
        dealMinor: 400,
      );
      // 2000 gross, 400 deal, 200 keyed, then 10% of the 1400 that is left.
      expect(t.totalMinor, 2000 - 400 - 200 - 140);
      expect(t.savedMinor, 400 + 200 + 140);
    });
  });

  group('VAT follows the money actually taken', () {
    test('a deal reduces the VAT with it', () {
      final full = PricingEngine().price(
        [line(1, 'Negroni', 1000, qty: 2)],
        dealMinor: 0,
      );
      final dealt = PricingEngine().price(
        [line(1, 'Negroni', 1000, qty: 2)],
        dealMinor: 400,
      );
      expect(dealt.taxMinor, lessThan(full.taxMinor),
          reason: 'VAT on a price nobody paid overstates the return');
      // 20% inclusive on £16.00 is £2.67.
      expect(dealt.taxMinor, 267);
    });
  });
}
