// Gift card receipts (Nicky, Pontardawe RFC, 2026-11-25: "When we top up or
// redeem a gift card can we have an automatic receipt please"): the card, what
// went on or came off it, and what it holds now, by its last four digits.
import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';
import 'package:vesopa_epos/printing/receipt_builder.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late AppDatabase db;
  late OrderRepository orders;
  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    orders = OrderRepository(db);
  });
  tearDown(() => db.close());

  Future<String> print(List<GiftCardBalance> cards) async {
    final id = await orders.openOrder();
    await orders.addLine(
      id,
      const Product(
        pluId: 1, name: 'Gift card top up', priceMinor: 2000, taxPercentage: 0,
        stockQuantity: 0, printToReceipt: true, renewsMembership: false, isModifier: false,
      ),
    );
    await orders.recalculate(id);
    await orders.settle(id, 'cash', 2000);
    final builder = await ReceiptBuilder.create(paperWidthMm: 80);
    final bytes = builder.receipt(
      order: (await orders.orderOnce(id))!,
      lines: await orders.linesOnce(id),
      payments: await orders.paymentsFor(id),
      giftCards: cards,
    );
    return latin1.decode(bytes, allowInvalid: true);
  }

  test('a top-up prints the card and its new balance', () async {
    final text = await print([
      const GiftCardBalance(code: 'GC-7731-4410', loadedMinor: 2000, balanceMinor: 3550),
    ]);
    expect(text, contains('GIFT CARD ****4410'));
    expect(text, contains('Topped up'));
    expect(text, contains('35.50'));
    expect(text, isNot(contains('7731')), reason: 'only the last four digits');
  });

  test('a spend prints what came off and what is left', () async {
    final text = await print([
      const GiftCardBalance(code: '99990001', spentMinor: 1200, balanceMinor: 800),
    ]);
    expect(text, contains('Spent'));
    expect(text, contains('Balance now'));
    expect(text, contains('8.00'));
  });

  test('no gift card, no gift card section', () async {
    expect(await print(const []), isNot(contains('GIFT CARD')));
  });
}
