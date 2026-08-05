import 'package:drift/drift.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/mix_match_engine.dart';

OrderLine line(int plu, String name, int priceMinor, double qty) => OrderLine(
      id: '$plu-$name',
      orderId: 'o',
      pluId: plu,
      name: name,
      quantity: qty,
      unitPriceMinor: priceMinor,
      taxPercentage: 20,
      lineDiscountMinor: 0,
    );

MixMatchDeal deal(int id, String name, int trigger, int priceMinor) =>
    MixMatchDeal(
      id: id,
      name: name,
      triggerQty: trigger,
      dealPriceMinor: priceMinor,
      active: true,
    );

void main() {
  test('a 2-for-£3 deal fires once on two qualifying items', () {
    // Two £2 items = £4 normally; the deal makes them £3.
    final engine = MixMatchEngine(
      [deal(1, '2 for £3', 2, 300)],
      {1: {10, 11}},
    );

    final result = engine.apply([
      line(10, 'Cola', 200, 1),
      line(11, 'Lemonade', 200, 1),
    ]);

    expect(result.deals, hasLength(1));
    expect(result.deals.single.times, 1);
    expect(result.totalSavingMinor, 100);
  });

  test('fires as many whole times as the basket allows, remainder at full price',
      () {
    final engine = MixMatchEngine(
      [deal(1, '2 for £3', 2, 300)],
      {1: {10}},
    );

    // Five £2 colas: two pairs qualify (saving £1 each), the fifth is full price.
    final result = engine.apply([line(10, 'Cola', 200, 5)]);

    expect(result.deals.single.times, 2);
    expect(result.totalSavingMinor, 200);
  });

  test('takes the dearest qualifying items into the deal first', () {
    final engine = MixMatchEngine(
      [deal(1, '2 for £5', 2, 500)],
      {1: {10, 11, 12}},
    );

    // Dearest two are £4 + £4 = £8 -> £5, saving £3. Taking the cheap pair
    // instead would have saved the customer less.
    final result = engine.apply([
      line(10, 'Cheap', 200, 1),
      line(11, 'Pricey', 400, 1),
      line(12, 'Pricey2', 400, 1),
    ]);

    expect(result.totalSavingMinor, 300);
  });

  test('never fires when the deal costs more than the items already do', () {
    final engine = MixMatchEngine(
      [deal(1, '3 for £6', 3, 600)],
      {1: {10}},
    );

    // Three £1.50 items = £4.50. Charging £6 would rob the customer.
    final result = engine.apply([line(10, 'Cheap', 150, 3)]);

    expect(result.deals, isEmpty);
    expect(result.totalSavingMinor, 0);
  });

  test('an item is consumed by at most one deal', () {
    final engine = MixMatchEngine(
      [
        deal(1, 'Deal A', 2, 300),
        deal(2, 'Deal B', 2, 250),
      ],
      // Both deals cover the same two products.
      {
        1: {10, 11},
        2: {10, 11},
      },
    );

    // Only two units exist, so only one deal can fire — the other must not
    // discount the same items again.
    final result = engine.apply([
      line(10, 'Cola', 200, 1),
      line(11, 'Lemonade', 200, 1),
    ]);

    expect(result.deals, hasLength(1));
    // 400 - 300 = 100. If both fired, the saving would be wrong.
    expect(result.totalSavingMinor, 100);
  });

  test('an inactive deal never fires', () {
    final engine = MixMatchEngine(
      [
        MixMatchDeal(
          id: 1,
          name: 'Off',
          triggerQty: 2,
          dealPriceMinor: 100,
          active: false,
        ),
      ],
      {1: {10}},
    );

    expect(engine.apply([line(10, 'Cola', 200, 2)]).totalSavingMinor, 0);
  });

  test('a non-qualifying basket saves nothing', () {
    final engine = MixMatchEngine([deal(1, '2 for £3', 2, 300)], {1: {10}});
    // Only one qualifying unit — the deal needs two.
    expect(engine.apply([line(10, 'Cola', 200, 1)]).totalSavingMinor, 0);
    // Wrong product entirely.
    expect(engine.apply([line(99, 'Wine', 900, 4)]).totalSavingMinor, 0);
  });
}
