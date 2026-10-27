import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/counter/data/day_report.dart';
import 'package:vesopa_go/counter/data/journal.dart';
import 'package:vesopa_go/data/models.dart';

const _pint = Product(id: 'p', name: 'Fosters', priceMinor: 420, category: 'draught');
const _half = Choice('Half', -230);

SaleRecord _sale(int no, List<BillLine> lines, List<Tender> tenders, {double discount = 0, int change = 0, String clerk = 'Sam', int hour = 18}) {
  final bill = Bill(id: 's$no', name: 'Sale', clerk: clerk, lines: lines, tenders: tenders, discountPercent: discount);
  return SaleRecord.fromBill(bill, number: no, categoryNames: const {'draught': 'Draught'}, changeMinor: change, at: DateTime(2026, 10, 26, hour));
}

Tender _t(int minor, String kind) => Tender(id: '$kind$minor', amountMinor: minor, kind: kind, at: DateTime(2026), reference: kind == 'cash' ? null : 'pi_$minor');

void main() {
  test('a half is the pint less the portion, on the sale and the record', () {
    final l = BillLine(id: 'a', product: _pint, choices: const [_half], quantity: 2);
    expect(l.totalMinor, 380);
    final rec = _sale(1, [l], [_t(380, 'cash')]);
    expect(rec.lines.single.detail, 'Half');
    expect(rec.totalMinor, 380);
  });

  test('a sale discount comes off the total and is reported as a discount', () {
    final bill = Bill(id: 'b', name: 'Sale', lines: [const BillLine(id: 'a', product: _pint, quantity: 5)], discountPercent: 10);
    expect(bill.subtotalMinor, 2100);
    expect(bill.discountMinor, 210);
    expect(bill.totalMinor, 1890);
    final fixed = bill.copyWith(discountPercent: 0, discountFixedMinor: 5000);
    expect(fixed.totalMinor, 0, reason: 'never more than the bill');
  });

  test('the day: net, cash and card, refunds beside the takings, cash in the drawer', () {
    final a = _sale(1, [const BillLine(id: 'a', product: _pint, quantity: 5)], [_t(1890, 'cash')], discount: 10, change: 110);
    final b = _sale(2, [const BillLine(id: 'b', product: _pint, quantity: 2)], [_t(500, 'cash'), _t(340, 'tap')], clerk: 'Alex', hour: 19);
    final refunded = a.withRefund(Refund(id: 'r', amountMinor: 420, kind: 'cash', reason: 'Wrong item', by: 'Sam', at: DateTime(2026)));
    final r = DayReport.of([refunded, b]);
    expect(r.sales, 2);
    expect(r.grossMinor, 2940);
    expect(r.discountMinor, 210);
    expect(r.netMinor, 2730);
    expect(r.cashMinor, 2390);
    expect(r.cardMinor, 340);
    expect(r.refundsMinor, 420);
    expect(r.cashInDrawerMinor, 1970);
    expect(r.netMinor, 2730, reason: 'a refund does not rewrite the takings');
    expect(r.byCategory.single.label, 'Draught');
    expect(r.byClerk.first.label, 'Sam');
    expect(r.byHour, {18: 1890, 19: 840});
  });

  test('a record survives the trip through storage', () {
    final a = _sale(7, [const BillLine(id: 'a', product: _pint, choices: [_half])], [_t(190, 'tap')]);
    final back = SaleRecord.fromJson(a.toJson());
    expect(back.number, 7);
    expect(back.cardPayment?.reference, 'pi_190');
    expect(back.lines.single.detail, 'Half');
  });
}
