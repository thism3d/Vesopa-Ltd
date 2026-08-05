import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/tender_engine.dart';

/// Partial payments and split bills. The invariant under all of it: the shares
/// must always add up to the bill, and money taken must never exceed what was
/// owed without that surplus being reported as change.
TenderState stateFor(int totalMinor, {List<PricedLine> lines = const []}) =>
    TenderState(
      totals: const PricingEngine().price(
        lines.isNotEmpty
            ? lines
            : [
                PricedLine(
                  id: 'l1',
                  pluid: 1,
                  name: 'Item',
                  quantity: 1,
                  unitPriceMinor: totalMinor,
                  taxPercentage: 0,
                ),
              ],
      ),
    );

TenderEntry cash(int minor) =>
    TenderEntry(kind: TenderKind.cash, amountMinor: minor);
TenderEntry card(int minor, {String mode = 'terminal'}) =>
    TenderEntry(kind: TenderKind.card, amountMinor: minor, entryMode: mode);

void main() {
  splitBillRegression();
  group('partial payment', () {
    test('a part payment leaves the rest outstanding', () {
      final s = stateFor(8000).addTender(card(3000));
      expect(s.paidMinor, 3000);
      expect(s.outstandingMinor, 5000);
      expect(s.settled, isFalse);
    });

    test('paying the rest settles the bill', () {
      final s = stateFor(8000).addTender(card(3000)).addTender(cash(5000));
      expect(s.outstandingMinor, 0);
      expect(s.settled, isTrue);
      expect(s.changeMinor, 0);
    });

    test('three tenders across card, gift card and cash', () {
      final s = stateFor(10000)
          .addTender(const TenderEntry(
              kind: TenderKind.giftCard, amountMinor: 2500, reference: 'GC1'))
          .addTender(card(5000))
          .addTender(cash(2500));
      expect(s.settled, isTrue);
      expect(s.tenders.length, 3);
    });

    test('overpaying in cash reports change', () {
      final s = stateFor(1750).addTender(cash(2000));
      expect(s.changeMinor, 250);
      expect(s.outstandingMinor, 0);
      expect(s.settled, isTrue);
    });

    test('outstanding never goes negative', () {
      final s = stateFor(1000).addTender(cash(5000));
      expect(s.outstandingMinor, 0);
    });

    test('a declined tender can be taken back off', () {
      final s = stateFor(5000).addTender(card(2000)).removeLastTender();
      expect(s.paidMinor, 0);
      expect(s.outstandingMinor, 5000);
    });

    test('removing from an empty list is harmless', () {
      expect(stateFor(5000).removeLastTender().paidMinor, 0);
    });

    test('a manually keyed card is recorded as such', () {
      final s = stateFor(5000).addTender(card(5000, mode: 'manual'));
      expect(s.tenders.single.entryMode, 'manual');
      // It still settles as a card payment on the receipt.
      expect(s.tenders.single.kind.method, 'card');
    });
  });

  group('split equally', () {
    test('four ways on a round bill', () {
      final s = stateFor(10000).splitEqually(4);
      expect(s.shares.length, 4);
      expect(s.shares.every((x) => x.amountMinor == 2500), isTrue);
    });

    test('odd pennies land on the first share and still sum to the bill', () {
      final s = stateFor(1001).splitEqually(4);
      expect(s.shares.map((x) => x.amountMinor).toList(), [251, 250, 250, 250]);
      expect(s.shares.fold<int>(0, (a, b) => a + b.amountMinor), 1001);
    });

    test('the till asks only for the active share', () {
      final s = stateFor(10000).splitEqually(4);
      expect(s.dueNowMinor, 2500);
    });

    test('paying a share moves on to the next', () {
      final s = stateFor(10000).splitEqually(4).addTender(card(2500));
      expect(s.activeShare, 1);
      expect(s.shares.first.settled, isTrue);
      expect(s.dueNowMinor, 2500);
    });

    test('all four shares settle the bill', () {
      var s = stateFor(10000).splitEqually(4);
      for (var i = 0; i < 4; i++) {
        s = s.addTender(card(2500));
      }
      expect(s.settled, isTrue);
      expect(s.outstandingMinor, 0);
    });

    test('a share paid partly stays active', () {
      final s = stateFor(10000).splitEqually(4).addTender(cash(1000));
      expect(s.activeShare, 0);
      expect(s.dueNowMinor, 1500);
    });

    test('splitting fewer than two ways is not a split', () {
      expect(stateFor(1000).splitEqually(1).isSplit, isFalse);
    });

    test('a split can be abandoned', () {
      final s = stateFor(10000).splitEqually(4).clearSplit();
      expect(s.isSplit, isFalse);
      expect(s.dueNowMinor, 10000);
    });

    test('the clerk can jump to another share', () {
      final s = stateFor(10000).splitEqually(4).selectShare(2);
      expect(s.activeShare, 2);
    });

    test('selecting a share that does not exist is ignored', () {
      final s = stateFor(10000).splitEqually(4).selectShare(9);
      expect(s.activeShare, 0);
    });
  });

  group('split by item', () {
    final lines = [
      const PricedLine(id: 'a', pluid: 1, name: 'Steak', quantity: 1,
          unitPriceMinor: 2400, taxPercentage: 0),
      const PricedLine(id: 'b', pluid: 2, name: 'Pasta', quantity: 1,
          unitPriceMinor: 1400, taxPercentage: 0),
      const PricedLine(id: 'c', pluid: 3, name: 'Wine', quantity: 1,
          unitPriceMinor: 2200, taxPercentage: 0),
    ];

    test('each share carries its own items', () {
      final s = stateFor(0, lines: lines).splitByItems([
        ['a'],
        ['b', 'c'],
      ]);
      expect(s.shares[0].amountMinor, 2400);
      expect(s.shares[1].amountMinor, 3600);
    });

    test('the shares add up to the whole bill', () {
      final s = stateFor(0, lines: lines).splitByItems([
        ['a'],
        ['b'],
        ['c'],
      ]);
      expect(s.shares.fold<int>(0, (a, b) => a + b.amountMinor), 6000);
    });

    test('unallocated money goes onto the first share', () {
      // 'c' is left out, so its £22 must not vanish from the bill.
      final s = stateFor(0, lines: lines).splitByItems([
        ['a'],
        ['b'],
      ]);
      expect(s.shares.fold<int>(0, (a, b) => a + b.amountMinor), 6000);
      expect(s.shares[0].amountMinor, 2400 + 2200);
    });

    test('one group is not a split', () {
      final s = stateFor(0, lines: lines).splitByItems([
        ['a', 'b', 'c'],
      ]);
      expect(s.isSplit, isFalse);
    });
  });

  group('cash suggestions', () {
    test('the exact amount is always offered', () {
      final s = stateFor(1750);
      expect(s.cashSuggestions(const [500, 1000, 2000, 5000]), contains(1750));
    });

    test('nothing below what is owed is ever suggested', () {
      final s = stateFor(1750);
      final keys = s.cashSuggestions(const [500, 1000, 2000, 5000]);
      expect(keys.where((k) => k < 1750), isEmpty);
    });

    test('the next round pound and five are offered', () {
      final s = stateFor(1750);
      final keys = s.cashSuggestions(const []);
      expect(keys, containsAll(<int>[1750, 1800, 2000]));
    });

    test('a settled bill suggests nothing', () {
      final s = stateFor(1000).addTender(cash(1000));
      expect(s.cashSuggestions(const [500, 1000]), isEmpty);
    });

    test('suggestions follow the active share when split', () {
      final s = stateFor(10000).splitEqually(4);
      expect(s.cashSuggestions(const []), contains(2500));
    });
  });

  group('gratuity on the bill', () {
    test('service is included in what has to be paid', () {
      final totals = const PricingEngine().price(
        [
          const PricedLine(id: 'l', pluid: 1, name: 'Meal', quantity: 1,
              unitPriceMinor: 8000, taxPercentage: 0),
        ],
        gratuityBp: 125,
        gratuityApplies: true,
      );
      final s = TenderState(totals: totals);
      expect(totals.gratuityMinor, 1000);
      expect(s.outstandingMinor, 9000);
    });
  });
}

/// Regression cover for the reported "split bill takes the first share then the
/// rest of the check disappears".
///
/// The cause was in the tables screen, not here: it created N line-less orders
/// and voided the one holding every item. That path is gone and the tables
/// screen now drives this engine instead, so these are the guarantees the
/// replacement rests on — the bill stays whole, and paying one share never
/// costs the others.
void splitBillRegression() {
  group('splitting a bill across several payers', () {
    test('shares always add back up to the bill', () {
      for (final ways in [2, 3, 4, 5, 6, 8]) {
        // 4001p deliberately does not divide by any of these.
        final split = stateFor(4001).splitEqually(ways);
        final summed =
            split.shares.fold<int>(0, (sum, s) => sum + s.amountMinor);

        expect(split.shares.length, ways);
        expect(summed, 4001, reason: '$ways ways must still total the bill');
      }
    });

    test('paying the first share leaves the rest of the check intact', () {
      final split = stateFor(2000).splitEqually(4);
      final afterFirst = split.addTender(cash(500));

      // The bill itself is untouched...
      expect(afterFirst.totals.totalMinor, 2000);
      // ...three shares are still owed...
      expect(afterFirst.shares.where((s) => !s.settled).length, 3);
      expect(afterFirst.outstandingMinor, 1500);
      // ...and the till has moved on to the next person.
      expect(afterFirst.activeShare, 1);
      expect(afterFirst.dueNowMinor, 500);
      // The sale is emphatically not finished.
      expect(afterFirst.settled, isFalse);
    });

    test('every share paid settles the bill exactly once', () {
      var state = stateFor(2000).splitEqually(4);
      for (var i = 0; i < 4; i++) {
        expect(state.settled, isFalse, reason: 'settled early at share $i');
        state = state.addTender(cash(state.dueNowMinor));
      }

      expect(state.settled, isTrue);
      expect(state.outstandingMinor, 0);
      expect(state.changeMinor, 0);
      expect(state.shares.every((s) => s.settled), isTrue);
    });

    test('overpaying one share in cash is change, not a loss to the others', () {
      // £20 four ways; the first person hands over a £10 note for their £5.
      final state = stateFor(2000).splitEqually(4).addTender(cash(1000));

      expect(state.outstandingMinor, 1000);
      // The remaining three shares are still £5 each and still owed.
      expect(state.shares.skip(1).every((s) => s.outstandingMinor == 500), isTrue);
      expect(state.dueNowMinor, 500);
    });

    test('abandoning a split leaves the whole bill payable', () {
      final state = stateFor(2000).splitEqually(4).clearSplit();

      expect(state.isSplit, isFalse);
      expect(state.shares, isEmpty);
      expect(state.dueNowMinor, 2000);
    });

    test('a split of fewer than two ways is simply not a split', () {
      for (final ways in [0, 1]) {
        final state = stateFor(2000).splitEqually(ways);
        expect(state.isSplit, isFalse);
        expect(state.dueNowMinor, 2000);
      }
    });
  });
}
