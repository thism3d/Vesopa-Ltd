/// Six prices per product, and which one a bill is charged at.
///
/// The rule everything here turns on is that an unset level falls back to
/// Price 1. Null at a level means "this product has no special price here", not
/// "this product is free — and the difference is money. A venue that switched
/// the till to Price 2 with a default of zero would start giving away every
/// product nobody had got round to filling in, silently, at the counter.
///
/// That is what makes the feature usable on a real catalogue: a happy hour is
/// six drinks with a second price and four hundred products left alone.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/price_levels.dart';

void main() {
  // A pint with a happy-hour price, and nothing else set.
  const pint = ProductPrices(priceMinor: 550, price2Minor: 400);

  // A dish the venue has never given a second price to.
  const curry = ProductPrices(priceMinor: 1200);

  group('what a product costs', () {
    test('Price 1 is what it has always been', () {
      expect(pint.at(1), 550);
      expect(curry.at(1), 1200);
    });

    test('a level the venue has set is charged', () {
      expect(pint.at(2), 400);
    });

    test('a level it has not set falls back to Price 1, never to nothing', () {
      // The whole design. Every one of these would be a giveaway if unset read
      // as zero.
      for (final level in [2, 3, 4, 5, 6]) {
        expect(curry.at(level), 1200, reason: 'level $level');
      }
      for (final level in [3, 4, 5, 6]) {
        expect(pint.at(level), 550, reason: 'level $level');
      }
    });

    test('a level of zero is a real price, and it is free', () {
      // Distinct from unset, and it has to be: a venue running a "first drink
      // on us" tariff has said something, and the till must not quietly charge
      // for it instead.
      const complimentary = ProductPrices(priceMinor: 550, price3Minor: 0);
      expect(complimentary.at(3), 0);
      expect(complimentary.at(2), 550);
    });

    test('a level outside the six is Price 1 rather than a crash', () {
      // A stored preference from another build, or a tier pointing at a level
      // a venue has since stopped using. Neither is a reason to stop selling.
      for (final level in [0, -1, 7, 99]) {
        expect(pint.at(level), 550, reason: 'level $level');
      }
    });
  });

  group('clamping', () {
    test('keeps a real level', () {
      for (final level in priceLevels) {
        expect(clampPriceLevel(level), level);
      }
    });

    test('and answers Price 1 for anything else', () {
      for (final value in [null, 0, 7, -3, '', 'two', 1.5]) {
        expect(clampPriceLevel(value), 1, reason: '$value');
      }
    });

    test('reading a level stored as text still works', () {
      // SharedPreferences and JSON both hand back strings often enough.
      expect(clampPriceLevel('4'), 4);
    });
  });

  group('what a level is called', () {
    test('Price 1 is Price 1, whatever anybody says', () {
      // A venue that renamed the first level would have a product form whose
      // first field agreed with nothing else in the system.
      final names = PriceLevelNames.parse('{"1":"Base","2":"Happy Hour"}');
      expect(names.nameFor(1), 'Price 1');
    });

    test('a named level uses the name', () {
      final names = PriceLevelNames.parse('{"2":"Happy Hour","5":"Staff"}');
      expect(names.nameFor(2), 'Happy Hour');
      expect(names.nameFor(5), 'Staff');
    });

    test('an unnamed one reads as its number', () {
      final names = PriceLevelNames.parse('{"2":"Happy Hour"}');
      expect(names.nameFor(3), 'Price 3');
      expect(names.nameFor(6), 'Price 6');
    });

    test('a venue that has named nothing gets numbers throughout', () {
      for (final level in priceLevels) {
        expect(PriceLevelNames.empty.nameFor(level), 'Price $level');
      }
    });

    test('and an unreadable setting is not a till that will not start', () {
      for (final broken in ['not json', '[]', '42', null, '{']) {
        final names = PriceLevelNames.parse(broken);
        expect(names.nameFor(2), 'Price 2', reason: '$broken');
      }
    });

    test('a blank name is no name', () {
      final names = PriceLevelNames.parse('{"2":"   ","3":"Trade"}');
      expect(names.nameFor(2), 'Price 2');
      expect(names.nameFor(3), 'Trade');
    });
  });

  group('reading prices off the wire', () {
    test('pounds become pence', () {
      expect(ProductPrices.minorFrom({'price_2': 4.5}, 'price_2'), 450);
      expect(ProductPrices.minorFrom({'price_2': '3.05'}, 'price_2'), 305);
    });

    test('absent stays absent, so it can mean "not set"', () {
      // A server that predates price levels sends no field. That must not
      // become a price of zero.
      expect(ProductPrices.minorFrom({}, 'price_2'), isNull);
      expect(ProductPrices.minorFrom({'price_2': null}, 'price_2'), isNull);
    });

    test('and zero survives as zero', () {
      expect(ProductPrices.minorFrom({'price_2': 0}, 'price_2'), 0);
    });
  });

  group('which level a bill is charged at', () {
    test('the till decides, ordinarily', () {
      expect(levelFor(tillLevel: 3), 3);
      expect(levelFor(tillLevel: 1, customerTierLevel: null), 1);
    });

    test("a member's tier overrides the room", () {
      // Somebody on a trade tariff is charged their tariff whether or not the
      // bar is on happy hour.
      expect(levelFor(tillLevel: 2, customerTierLevel: 4), 4);
      expect(levelFor(tillLevel: 4, customerTierLevel: 2), 2);
    });

    test('and a nonsense tier level does not strand the sale', () {
      expect(levelFor(tillLevel: 2, customerTierLevel: 99), 1);
    });
  });
}
