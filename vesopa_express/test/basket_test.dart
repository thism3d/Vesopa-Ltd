import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_express/data/basket.dart';
import 'package:vesopa_express/data/models.dart';

const cheese = AddOnOption(pluId: 104, name: 'Extra cheese', priceMinor: 100);
const bacon = AddOnOption(pluId: 106, name: 'Bacon', priceMinor: 150);
const burger = MenuItem(id: 1, pluId: 101, name: 'Cheeseburger', priceMinor: 850);
const fries = MenuItem(id: 2, pluId: 102, name: 'Fries', priceMinor: 300);

void main() {
  test('the same dish with the same extras is one line, whatever order they were ticked in', () {
    var b = const Basket().add(const BasketLine(item: burger, addOns: [cheese, bacon]));
    b = b.add(const BasketLine(item: burger, addOns: [bacon, cheese], qty: 2));
    expect(b.lines, hasLength(1));
    expect(b.lines.single.qty, 3);
  });

  test('different extras are different lines', () {
    final b = const Basket()
        .add(const BasketLine(item: burger, addOns: [cheese]))
        .add(const BasketLine(item: burger));
    expect(b.lines, hasLength(2));
    // The server overwrites a repeated key rather than adding it up, so the
    // basket must never send one twice.
    expect(b.lines.map((l) => l.key).toSet(), hasLength(2));
  });

  test('totals count the extras once per dish', () {
    final b = const Basket()
        .add(const BasketLine(item: burger, addOns: [cheese], qty: 2))
        .add(const BasketLine(item: fries));
    // 2 x (8.50 + 1.00) + 3.00, the same figure the server test charges.
    expect(b.totalMinor, 2200);
    expect(b.count, 3);
  });

  test('a quantity of zero takes the line away; a huge one is capped', () {
    var b = const Basket().add(const BasketLine(item: fries));
    final key = b.lines.single.key;
    expect(b.setQty(key, 0).isEmpty, isTrue);
    b = b.setQty(key, 500);
    expect(b.lines.single.qty, Basket.maxQty);
  });

  test('what is sent is ids and quantities, never prices', () {
    final b = const Basket().add(const BasketLine(item: burger, addOns: [cheese], qty: 2));
    expect(b.toRequest(), [
      {'item_id': 1, 'qty': 2, 'add_ons': [104]},
    ]);
  });

  group('a meal', () {
    const chips = AddOnOption(pluId: 302, name: 'Chips', priceMinor: 0);
    const large = AddOnOption(pluId: 303, name: 'Large fries', priceMinor: 60);
    const cola = AddOnOption(pluId: 304, name: 'Cola', priceMinor: 0);
    const meal = Meal(pluId: 301, name: 'Cheeseburger Meal', priceMinor: 1100);
    const big = Meal(pluId: 305, name: 'Cheeseburger Large Meal', priceMinor: 1200, label: 'Large');

    test('is priced from the meal, not the dish, plus its upgrades', () {
      const line = BasketLine(item: burger, meal: meal, addOns: [large, cola], qty: 2);
      expect(line.unitMinor, 1160);
      expect(line.totalMinor, 2320);
      expect(line.name, 'Cheeseburger Meal');
    });

    test('is its own line: never merged with the dish on its own, or with another size', () {
      final b = const Basket()
          .add(const BasketLine(item: burger))
          .add(const BasketLine(item: burger, meal: meal, addOns: [chips, cola]))
          .add(const BasketLine(item: burger, meal: big, addOns: [chips, cola]))
          .add(const BasketLine(item: burger, meal: meal, addOns: [cola, chips]));
      expect(b.lines, hasLength(3));
      expect(b.lines[1].qty, 2, reason: 'the same meal with the same answers is one line');
      expect(b.qtyOf(burger.id), 4);
    });

    test('is sent as the dish with the meal named, and ids only', () {
      final b = const Basket().add(const BasketLine(item: burger, meal: meal, addOns: [chips, cola]));
      expect(b.toRequest(), [
        {'item_id': 1, 'qty': 1, 'add_ons': [302, 304], 'meal_plu': 301},
      ]);
    });

    test('keeps its meal when the quantity changes', () {
      final b = const Basket().add(const BasketLine(item: burger, meal: meal, addOns: [chips]));
      final changed = b.setQty(b.lines.single.key, 3).lines.single;
      expect(changed.meal, meal);
      expect(changed.totalMinor, 3300);
    });
  });

  test('money reads like a menu', () {
    expect(money(0), '£0.00');
    expect(money(5), '£0.05');
    expect(money(2200), '£22.00');
    expect(money(123456), '£1234.56');
  });
}
