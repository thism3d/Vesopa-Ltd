import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/demo_venue.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';

void main() {
  late ProviderContainer box;
  late TapSession tap;
  TapState s() => box.read(tapProvider);

  setUp(() async {
    FlutterSecureStorage.setMockInitialValues({});
    SharedPreferences.setMockInitialValues({});
    box = ProviderContainer();
    box.read(tapProvider);
    await Future<void>.delayed(Duration.zero);
    tap = box.read(tapProvider.notifier)..startDemo();
    tap.signOn(demoClerks[1]); // Alex, Floor: not a manager
  });
  tearDown(() => box.dispose());

  Product p(String name) => demoProducts.firstWhere((x) => x.name == name);

  test('hold the mains, send the rest, fire the mains later', () {
    final bill = tap.openTable(demoTables.first, covers: 2);
    tap.addLine(bill.id, p('Soup of the Day'));
    tap.addLine(bill.id, p('Fish & Chips'), hold: true);
    expect(s().bills[bill.id]!.hasHeld, isTrue);
    expect(tap.send(bill.id), 1, reason: 'the soup goes, the fish waits');
    expect(s().bills[bill.id]!.lines.last.sent, isFalse);
    expect(tap.fire(bill.id), 1);
    expect(s().bills[bill.id]!.lines.every((l) => l.sent), isTrue);
    expect(s().tableState(demoTables.first.id), TableState.mains);
  });

  test('a sent line comes off only with a manager, and the void is kept', () {
    final bill = tap.openTable(demoTables[1]);
    tap.addLine(bill.id, p('Pint of Lager'));
    tap.send(bill.id);
    final line = s().bills[bill.id]!.lines.single;
    tap.changeQuantity(bill.id, line.id, -1);
    expect(s().bills[bill.id]!.lines.single.quantity, 1, reason: 'minus does nothing to a sent line');
    expect(tap.managerByPin('2222'), isNull, reason: 'Alex is not a manager');
    final sam = tap.managerByPin('1111')!;
    tap.voidLine(bill.id, line.id, quantity: 1, reason: 'Wrong item', approvedBy: sam);
    final after = s().bills[bill.id]!;
    expect(after.lines, isEmpty);
    expect(after.voids.single.toString(), contains('approved by Sam'));
    expect(after.voids.single.by, 'Alex');
  });

  test('a table held on another till is claimed before it is changed', () async {
    final bill = tap.openTable(demoTables[2]);
    // As pullBills mirrors a till's bill:
    box.read(tapProvider.notifier).state = s().copyWith(bills: {...s().bills, bill.id: bill.copyWith(heldBy: 'Till 1')});
    expect(s().bills[bill.id]!.heldBy, 'Till 1');
    expect(await tap.claim(bill.id), isTrue);
    expect(s().bills[bill.id]!.heldBy, isNull);
  });

  test('paid in full closes the bill and lists the card payment for refunds', () {
    final bill = tap.openTable(demoTables[3]);
    tap.addLine(bill.id, p('Cola'));
    tap.addTender(bill.id, Tender(id: 'pay-1', amountMinor: 320, tipMinor: 30, kind: 'tap', at: DateTime.now(), clerk: 'Alex'));
    expect(s().bills.containsKey(bill.id), isFalse);
    expect(s().recent.single.totalMinor, 350);
    tap.refunded('pay-1', 100);
    expect(s().recent.single.refundedMinor, 100);
  });

  test('tips come from the venue, on by default', () {
    expect(s().config.tips, isTrue);
    expect(s().config.tipPercents, [10, 12.5, 15]);
    final off = TapConfig.fromJson({'tips': false, 'tip_percents': [5], 'service_percents': [0], 'allow_cash': false});
    expect(off.tips, isFalse);
    expect(off.allowCash, isFalse);
  });
}
