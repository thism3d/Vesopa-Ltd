import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/receipt_repository.dart';
import 'package:vesopa_epos/data/refund_ledger.dart';

/// "Why can I refund the same order again and again?" A receipt now carries
/// what has gone back on it, from the server and from this till's own refunds
/// still in the outbox, and the refund screen reads that.
void main() {
  ReceiptSummary summary(Map<String, dynamic> extra) => ReceiptSummary.fromJson({
    'id': '11111111-1111-4111-8111-111111111111',
    'total_minor': 1000,
    'tax_minor': 167,
    'discount_minor': 0,
    'closed_at': '2026-10-12T10:00:00Z',
    ...extra,
  });

  test('numbers the server sends as text (DECIMAL columns) are read, not a crash', () {
    // Last Bill on the till, 2026-10-30: "type 'String' is not a subtype of
    // type 'num' in type cast" from points_balance: "0.00000".
    final r = summary({'points_balance': '0.00000', 'covers': '2', 'table_number': '7'});
    expect(r.pointsBalance, 0);
    expect(r.covers, 2);
    expect(r.tableNumber, 7);
    final l = ReceiptLine.fromJson({'name': 'Pint', 'quantity': '2', 'unit_price_minor': '400', 'tax_percentage': '20.00'});
    expect(l.quantity, 2);
    expect(l.unitPriceMinor, 400);
  });

  test('the list row carries how it was paid and its refund status', () {
    final r = summary({
      'methods': ['card'],
      'has_card': true,
      'refunded_minor': 400,
      'refund_count': 1,
      'status': 'part_refunded',
    });
    expect(r.methods, ['card']);
    expect(r.hasCard, isTrue);
    expect(r.status, ReceiptStatus.partRefunded);
    expect(r.refundableMinor, 600);
  });

  test('an older server says nothing and the receipt reads paid', () {
    final r = summary({});
    expect(r.status, ReceiptStatus.paid);
    expect(r.refundableMinor, 1000);
  });

  test("this till's unsent refund counts at once, and only once", () {
    final server = ReceiptDetail(
      summary: summary({'refunded_minor': 300, 'status': 'part_refunded'}),
      lines: const [],
      tenders: const [],
      refunds: [
        ReceiptRefund(id: 'a', amountMinor: 300, at: DateTime(2026, 10, 12), lineNos: const [0]),
      ],
    );
    final local = [
      ReceiptRefund(id: 'a', amountMinor: 300, at: DateTime(2026, 10, 12), lineNos: const [0]),
      ReceiptRefund(id: 'b', amountMinor: 700, at: DateTime(2026, 10, 12, 1), lineNos: const [1, 2]),
    ];
    final merged = server.withLocal(local);
    expect(merged.refunds.map((r) => r.id), ['a', 'b']);
    expect(merged.summary.refundedMinor, 1000);
    expect(merged.summary.status, ReceiptStatus.refunded);
    expect(merged.refundedLineNos, {0, 1, 2});
  });

  test('the ledger keeps refunds per receipt', () async {
    SharedPreferences.setMockInitialValues({});
    await RefundLedger.instance.add(
      'order-1',
      ReceiptRefund(id: 'x', amountMinor: 250, at: DateTime.now(), lineNos: const [3]),
    );
    final back = await RefundLedger.instance.forOrder('order-1');
    expect(back.single.amountMinor, 250);
    expect(back.single.lineNos, [3]);
    final totals = await RefundLedger.instance.totals();
    expect(totals['order-1']!.minor, 250);
    expect(await RefundLedger.instance.forOrder('order-2'), isEmpty);
  });

  test('line refund values add up to what was paid, after offers and points', () {
    // £4 + £4 pint with a 2-for-£7 offer (£1 off the second), a £2.50 burger,
    // and £1 of loyalty points off the bill: £9.50 paid.
    final detail = ReceiptDetail(
      summary: summary({'total_minor': 950, 'discount_minor': 100}),
      lines: [
        ReceiptLine.fromJson({'name': 'Pint', 'quantity': 1, 'unit_price_minor': 400}),
        ReceiptLine.fromJson({'name': 'Pint', 'quantity': 1, 'unit_price_minor': 400, 'discount_minor': 100}),
        ReceiptLine.fromJson({'name': 'Burger', 'quantity': 1, 'unit_price_minor': 250}),
        ReceiptLine.fromJson({'name': 'No onion', 'quantity': 1, 'unit_price_minor': 0, 'is_modifier': 1}),
      ],
      tenders: const [],
    );
    final values = detail.lineValues;
    expect(values.reduce((a, b) => a + b), 950);
    expect(values[3], 0);
    expect(values[0], greaterThan(values[1]));
  });

  test('a receipt with nothing off refunds each line at its price', () {
    final detail = ReceiptDetail(
      summary: summary({'total_minor': 700}),
      lines: [
        ReceiptLine.fromJson({'name': 'A', 'quantity': 2, 'unit_price_minor': 200}),
        ReceiptLine.fromJson({'name': 'B', 'quantity': 1, 'unit_price_minor': 300}),
      ],
      tenders: const [],
    );
    expect(detail.lineValues, [400, 300]);
  });
}
