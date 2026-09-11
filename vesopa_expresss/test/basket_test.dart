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

  test('money reads like a menu', () {
    expect(money(0), '£0.00');
    expect(money(5), '£0.05');
    expect(money(2200), '£22.00');
    expect(money(123456), '£1234.56');
  });
}
