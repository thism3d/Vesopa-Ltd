import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_tap/data/bill_math.dart';
import 'package:vesopa_tap/data/clerk_auth.dart';
import 'package:vesopa_tap/data/demo_venue.dart';
import 'package:vesopa_tap/data/models.dart';

Bill _bill() => Bill(id: 'b', name: 'Table 1', covers: 3, lines: [
      BillLine(id: 'l1', product: demoProducts[0], quantity: 2, seat: 1), // 2 × 5.50
      BillLine(id: 'l2', product: demoProducts[7], seat: 2), // 15.95
      BillLine(id: 'l3', product: demoProducts[5]), // 4.80, the table's
    ]);

void main() {
  group('splitting', () {
    test('equal shares add up to the penny', () {
      expect(splitEqually(1000, 3), [334, 333, 333]);
      expect(splitEqually(1000, 3).reduce((a, b) => a + b), 1000);
      expect(splitEqually(0, 2), [0, 0]);
    });

    test('by seat: own lines plus a share of the table\'s, exact', () {
      final b = _bill();
      final shares = splitBySeat(b, 3);
      expect(shares[1], 1100 + 160);
      expect(shares[2], 1595 + 160);
      expect(shares[3], 160);
      expect(shares.values.reduce((a, c) => a + c), b.totalMinor);
    });

    test('by seat with service charge still totals the bill', () {
      final b = _bill().copyWith(serviceChargePercent: 12.5);
      expect(splitBySeat(b, 3).values.reduce((a, c) => a + c), b.totalMinor);
    });

    test('by item, and never more than is left', () {
      final b = _bill();
      expect(priceOfItems(b, {'l1': 1, 'l3': 1}), 550 + 480);
      expect(() => priceOfItems(b, {'l2': 2}), throwsArgumentError);
    });

    test('tips round to the penny', () {
      expect(tipPercent(2450, 12.5), 306);
      expect(money(-1206), '-£12.06');
    });
  });

  group('members and vouchers', () {
    const jo = Member(id: 9, name: 'Jo', discountType: 'percent', discountValue: 10, earns: true, pointsPerPound: 2, minSpendMinor: 500);

    test('the discount comes off first, the service charge is on what is left', () {
      final b = _bill().copyWith(member: jo, voucherCode: 'SAVE5', voucherMinor: 500, serviceChargePercent: 12.5);
      expect(b.subtotalMinor, 3175);
      expect(b.memberDiscountMinor, 318);
      expect(b.discountMinor, 818);
      expect(b.serviceMinor, ((3175 - 818) * 0.125).round());
      expect(b.totalMinor, 3175 - 818 + b.serviceMinor);
    });

    test('splits still add up to the penny with a discount on', () {
      final b = _bill().copyWith(member: jo, voucherMinor: 500, serviceChargePercent: 10);
      expect(splitBySeat(b, 3).values.reduce((a, c) => a + c), b.totalMinor);
      expect(splitEqually(b.dueMinor, 4).reduce((a, c) => a + c), b.dueMinor);
    });

    test('a discount never makes a bill negative', () {
      final b = _bill().copyWith(voucherMinor: 999999);
      expect(b.totalMinor, 0);
    });

    test('points by the till\'s rule: whole pounds, a minimum spend', () {
      expect(jo.pointsFor(2499), 48);
      expect(jo.pointsFor(499), 0);
      expect(Member.fromJson({'id': 1, 'first_name': 'Al', 'last_name': 'B', 'points_balance': '12.50000', 'settings': {'earn_points': 1, 'points_per_pound': '1.5'}}).pointsFor(1000), 15);
    });
  });

  group('clerks', () {
    test('a PIN finds one person', () {
      expect(ClerkAuth.byPin(demoClerks, '2222')?.name, 'Alex');
      expect(ClerkAuth.byPin(demoClerks, '9999'), isNull);
      expect(ClerkAuth.byPin(demoClerks, '11'), isNull);
    });

    test('a staff card matches whatever its separators and case', () {
      expect(ClerkAuth.byCard(demoClerks, '04:a1:b2:c3:d4')?.name, 'Sam');
      expect(ClerkAuth.byCard(demoClerks, 'FFFF'), isNull);
      expect(ClerkAuth.byCard(demoClerks, ''), isNull);
    });
  });

  group('bills', () {
    test('a bill is due its total less what was paid', () {
      final b = _bill();
      final paid = b.copyWith(tenders: [Tender(id: 't', amountMinor: 1000, kind: 'tap', at: DateTime(2026))]);
      expect(paid.dueMinor, b.totalMinor - 1000);
      expect(b.hasUnsent, isTrue);
    });
  });
}
