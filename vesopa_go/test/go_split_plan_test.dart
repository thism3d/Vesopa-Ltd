import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/counter/ui/split_sheet.dart';
import 'package:vesopa_go/data/demo_venue.dart';
import 'package:vesopa_go/data/models.dart';

/// Go's split screen (2026-11-07): every way of splitting adds up to what the
/// bill still owes, to the penny.
Bill _bill() => Bill(id: 'b', name: 'Table 1', covers: 3, lines: [
      BillLine(id: 'l1', product: demoProducts[0], quantity: 2), // 2 x 5.50
      BillLine(id: 'l2', product: demoProducts[7]), // 15.95
      BillLine(id: 'l3', product: demoProducts[5]), // 4.80
    ]);

int _sum(List<int> v) => v.fold(0, (a, b) => a + b);

void main() {
  test('by item: each share its items, the pool a share of its own', () {
    final b = _bill();
    final plan = GoSplitPlan()..shares.add(GoShare(items: {'l1': 1}));
    final amounts = plan.amounts(b);
    expect(amounts.first, 550);
    expect(amounts.length, 2, reason: 'what is still in the pool');
    expect(_sum(amounts), b.dueMinor);
  });

  test('by item, everything on shares: the last share takes what is owed', () {
    final b = _bill();
    final plan = GoSplitPlan()
      ..shares.add(GoShare(items: {'l1': 2}))
      ..shares.add(GoShare(items: {'l2': 1, 'l3': 1}));
    final amounts = plan.amounts(b);
    expect(amounts, [1100, 2075]);
    expect(_sum(amounts), b.dueMinor);
    expect(plan.itemsOf(1), {'l2': 1, 'l3': 1});
  });

  test('equally and by amount add up to the bill', () {
    final b = _bill();
    final eq = GoSplitPlan(method: GoSplitMethod.equally, ways: 3);
    expect(_sum(eq.amounts(b)), b.dueMinor);
    final amt = GoSplitPlan(method: GoSplitMethod.amount)..shares.add(GoShare(name: 'Carys', amountMinor: 1000));
    expect(amt.amounts(b), [1000, b.dueMinor - 1000]);
    expect(amt.labelOf(0), 'Carys');
    expect(amt.itemsOf(0), isEmpty);
  });
}
