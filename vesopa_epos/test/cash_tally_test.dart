import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/cash_tally.dart';

/// The tally is what the customer is watching as they hand notes over, and what
/// the receipt reproduces afterwards, so counting and round-tripping both have
/// to be exact.
void main() {
  group('counting', () {
    test('four taps on £5 is £20, as four notes', () {
      var tally = CashTally.empty;
      for (var i = 0; i < 4; i++) {
        tally = tally.add(500);
      }

      expect(tally.counts[500], 4);
      expect(tally.totalMinor, 2000);
      expect(tally.pieceCount, 4);
    });

    test('mixed notes add up', () {
      final tally = CashTally.empty.add(2000, 2).add(1000).add(500, 3);

      expect(tally.totalMinor, 2000 * 2 + 1000 + 500 * 3);
      expect(tally.pieceCount, 6);
    });

    test('removing the last of a note drops it rather than leaving a zero', () {
      final tally = CashTally.empty.add(500).remove(500);

      expect(tally.counts.containsKey(500), isFalse);
      expect(tally.isEmpty, isTrue);
      expect(tally.totalMinor, 0);
    });

    test('a count can never go negative', () {
      final tally = CashTally.empty.add(500).remove(500).remove(500);

      expect(tally.totalMinor, 0);
      expect(tally.counts, isEmpty);
    });

    test('biggest note first — the order a drawer is counted in', () {
      final tally = CashTally.empty.add(500).add(5000).add(1000);

      expect(tally.descending.map((e) => e.key).toList(), [5000, 1000, 500]);
    });

    test('clear empties everything', () {
      expect(CashTally.empty.add(2000, 3).clear().isEmpty, isTrue);
    });
  });

  group('encoding', () {
    test('round-trips through the payments column', () {
      final tally = CashTally.empty.add(2000, 2).add(500);

      expect(tally.encode(), '2000x2,500x1');
      expect(CashTally.decode(tally.encode()).counts, tally.counts);
    });

    test('an empty tally encodes to nothing and back', () {
      expect(CashTally.empty.encode(), '');
      expect(CashTally.decode('').isEmpty, isTrue);
      expect(CashTally.decode(null).isEmpty, isTrue);
    });

    test('junk in the column yields an empty tally, never an exception', () {
      // A receipt has to print even if this column has been corrupted.
      for (final junk in ['nonsense', '2000x', 'x2', '2000x0', '-5x2', ',,,']) {
        expect(CashTally.decode(junk).isEmpty, isTrue, reason: junk);
      }
    });

    test('a malformed part is skipped without losing the good ones', () {
      expect(CashTally.decode('2000x2,rubbish,500x1').counts, {
        2000: 2,
        500: 1,
      });
    });
  });

  group('describing', () {
    test('reads as the notes that were handed over', () {
      final tally = CashTally.empty.add(2000, 2).add(500);

      expect(tally.describe(), '2 x £20, 1 x £5');
    });

    test('uses the back office labels when it has them', () {
      final tally = CashTally.empty.add(2000).add(50);

      expect(
        tally.describe({2000: 'Twenty', 50: 'Fifty pence'}),
        '1 x Twenty, 1 x Fifty pence',
      );
    });

    test('falls back to pounds and pence for an odd value', () {
      expect(CashTally.empty.add(250).describe(), '1 x £2.50');
    });
  });
}
