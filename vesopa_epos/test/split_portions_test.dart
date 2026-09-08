import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';
import 'package:vesopa_epos/data/split_portions.dart';
import 'package:vesopa_epos/data/tender_engine.dart';

/// Dividing one line of a bill between several payers.
///
/// The fault: "If there is 3 x Prosecco you can't split them off, someone must
/// pay for the 3 glasses if you get what i mean." Three drinks rung together
/// are one line, and a share could only take a whole line.
///
/// What is pinned here is the arithmetic, because that is the half that has to
/// be right in front of a table. Every test that adds anything up asserts on
/// the whole bill as well as on the piece — a split that is a penny out is
/// worse than one that will not work, because nobody notices it.
void main() {
  PricedLine drink({
    String id = 'l1',
    double quantity = 3,
    int unitPriceMinor = 700,
    int discountMinor = 0,
    String? parentLineId,
    String name = 'Prosecco',
  }) => PricedLine(
    id: id,
    pluid: 42,
    name: name,
    quantity: quantity,
    unitPriceMinor: unitPriceMinor,
    discountMinor: discountMinor,
    parentLineId: parentLineId,
  );

  TenderState stateOf(List<PricedLine> lines, {int manualDiscountMinor = 0}) =>
      TenderState(
        totals: const PricingEngine()
            .price(lines, manualDiscountMinor: manualDiscountMinor),
      );

  group('reading a portion id', () {
    test('a portion says which line and which unit it is', () {
      final id = portionId('abc-123', 2);
      expect(isPortion(id), isTrue);
      expect(baseLineId(id), 'abc-123');
      expect(portionIndex(id), 2);
    });

    test('a whole line is left exactly as it is', () {
      expect(isPortion('abc-123'), isFalse);
      expect(baseLineId('abc-123'), 'abc-123');
      expect(portionIndex('abc-123'), 0);
    });

    // The ids the till mints are UUID-shaped — hex and hyphens — so the mark
    // cannot occur inside one. If that ever changes, this is the test that
    // says so before a line id gets truncated in the field.
    test('a UUID carries nothing that reads as a portion mark', () {
      const uuid = '9f3c1b2e-77a1-4d2f-8c55-0f1e2d3c4b5a';
      expect(uuid.contains(portionMark), isFalse);
      expect(baseLineId(uuid), uuid);
    });
  });

  group('what one of them is worth', () {
    test('a round number divides evenly', () {
      expect([for (var i = 1; i <= 3; i++) portionValue(2100, 3, i)],
          [700, 700, 700]);
    });

    test('the odd penny goes to the first, and only there', () {
      final parts = [for (var i = 1; i <= 3; i++) portionValue(500, 3, i)];
      expect(parts, [168, 166, 166]);
      expect(parts.fold<int>(0, (s, v) => s + v), 500);
    });

    test('the portions always add back to the line', () {
      for (final total in [1, 7, 99, 500, 4001, 123457]) {
        for (final count in [2, 3, 4, 5, 7, 12]) {
          final summed = [
            for (var i = 1; i <= count; i++) portionValue(total, count, i),
          ].fold<int>(0, (s, v) => s + v);
          expect(summed, total, reason: '$total across $count');
        }
      }
    });

    test('and hold for a line whose discount exceeds its gross', () {
      final parts = [for (var i = 1; i <= 3; i++) portionValue(-500, 3, i)];
      expect(parts.fold<int>(0, (s, v) => s + v), -500);
    });

    test('one way is the whole thing', () {
      expect(portionValue(999, 1, 1), 999);
    });
  });

  group('the engine values a share made of portions', () {
    test('three glasses on three cards is three sevens', () {
      final state = stateOf([drink()]);
      final split = state.splitByItems([
        [portionId('l1', 1)],
        [portionId('l1', 2)],
        [portionId('l1', 3)],
      ]);

      expect(split.shares.map((s) => s.amountMinor), [700, 700, 700]);
      expect(
        split.shares.fold<int>(0, (s, x) => s + x.amountMinor),
        state.outstandingMinor,
      );
    });

    test('one glass on one card and two on another', () {
      final state = stateOf([drink()]);
      final split = state.splitByItems([
        [portionId('l1', 1)],
        [portionId('l1', 2), portionId('l1', 3)],
      ]);

      expect(split.shares.map((s) => s.amountMinor), [700, 1400]);
      expect(
        split.shares.fold<int>(0, (s, x) => s + x.amountMinor),
        state.outstandingMinor,
      );
    });

    // The case the whole penny rule exists for: £5.00 across three glasses.
    test('a line that will not divide still adds up to the bill', () {
      final state = stateOf([
        drink(unitPriceMinor: 500, quantity: 3, discountMinor: 1000),
      ]);
      final split = state.splitByItems([
        [portionId('l1', 1)],
        [portionId('l1', 2)],
        [portionId('l1', 3)],
      ]);

      expect(
        split.shares.fold<int>(0, (s, x) => s + x.amountMinor),
        state.outstandingMinor,
      );
      // And the arrangement of the glasses does not change the bill.
      final other = state.splitByItems([
        [portionId('l1', 2)],
        [portionId('l1', 1), portionId('l1', 3)],
      ]);
      expect(
        other.shares.fold<int>(0, (s, x) => s + x.amountMinor),
        state.outstandingMinor,
      );
    });

    test('portions mix with whole lines on the same share', () {
      final state = stateOf([
        drink(),
        drink(id: 'l2', name: 'Crisps', quantity: 1, unitPriceMinor: 150),
      ]);
      final split = state.splitByItems([
        [portionId('l1', 1), 'l2'],
        [portionId('l1', 2), portionId('l1', 3)],
      ]);

      expect(split.shares.first.amountMinor, 850);
      expect(
        split.shares.fold<int>(0, (s, x) => s + x.amountMinor),
        state.outstandingMinor,
      );
    });

    // A bill-wide offer is spread pro rata across shares, and that arithmetic
    // has to keep working now that a share's own value comes from portions.
    test('a bill-wide discount still lands proportionally', () {
      final state = stateOf([drink()], manualDiscountMinor: 210);
      final split = state.splitByItems([
        [portionId('l1', 1)],
        [portionId('l1', 2), portionId('l1', 3)],
      ]);

      expect(
        split.shares.fold<int>(0, (s, x) => s + x.amountMinor),
        state.outstandingMinor,
      );
      // Twice the drink, twice the discount taken off it.
      expect(split.shares[1].amountMinor, greaterThan(split.shares[0].amountMinor));
    });

    test('an id for a line that is not on the bill is worth nothing', () {
      final state = stateOf([drink()]);
      final split = state.splitByItems([
        [portionId('gone', 1)],
        ['l1'],
      ]);
      expect(split.shares.first.amountMinor, 0);
    });
  });
}
