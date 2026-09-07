import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/bill_rounds.dart';
import 'package:vesopa_epos/data/modifier_layout.dart';
import 'package:vesopa_epos/data/pricing_engine.dart';

PricedLine line(
  String id, {
  String name = 'Item',
  int price = 100,
  String? by,
  DateTime? at,
  String? parent,
}) =>
    PricedLine(
      id: id,
      pluid: 1,
      name: name,
      quantity: 1,
      unitPriceMinor: price,
      taxPercentage: 0,
      addedBy: by,
      addedAt: at,
      parentLineId: parent,
    );

void main() {
  group('cutting a bill into rounds', () {
    test('the table from the venue splits into two', () {
      // Table 1: Nicky served at 19:08, Muzahid at 15:21. One bill, two
      // customers, and the whole reason this exists.
      final rounds = roundsOf([
        line('a', name: 'Fish & Chips', price: 2900, by: 'Nicky',
            at: DateTime(2026, 9, 7, 19, 8)),
        line('b', name: 'Chips', price: 400, by: 'Nicky'),
        line('c', name: 'Chicken Wings', price: 750, by: 'Muzahid Islam',
            at: DateTime(2026, 9, 7, 15, 21)),
      ]);

      expect(rounds, hasLength(2));
      expect(rounds[0].who, 'Nicky');
      expect(rounds[0].lines, hasLength(2));
      expect(rounds[0].subtotalMinor, 3300);
      expect(rounds[1].who, 'Muzahid Islam');
      expect(rounds[1].subtotalMinor, 750);
    });

    test('a heading names the person and the time', () {
      final rounds = roundsOf([
        line('a', by: 'Nicky', at: DateTime(2026, 9, 7, 19, 8)),
      ]);
      expect(rounds.single.label, 'Nicky  ·  19:08');
    });

    test('a single-digit hour and minute are padded', () {
      final rounds = roundsOf([
        line('a', by: 'Sam', at: DateTime(2026, 9, 7, 9, 5)),
      ]);
      expect(rounds.single.label, 'Sam  ·  09:05');
    });

    test('an unattributed bill has no heading to draw', () {
      final rounds = roundsOf([line('a'), line('b')]);
      expect(rounds.single.label, isNull);
      expect(hasRounds(rounds), isFalse);
    });

    test('one round is not rounds', () {
      final rounds = roundsOf([line('a', by: 'Nicky'), line('b', by: 'Nicky')]);
      expect(rounds, hasLength(1));
      expect(hasRounds(rounds), isFalse);
    });

    test('serving, being relieved, and serving again is three rounds', () {
      // Not two. The third approach to the counter is a different customer
      // from the first, and merging them would put a stranger's drinks on
      // somebody's bill.
      final rounds = roundsOf([
        line('a', by: 'Nicky'),
        line('b', by: 'Sam'),
        line('c', by: 'Nicky'),
      ]);
      expect(rounds, hasLength(3));
      expect(hasRounds(rounds), isTrue);
    });

    test('a modifier never opens a round of its own', () {
      // A manager amending somebody else's line stamps their own name on the
      // modifier. That must not cut "No ice" off into a round containing one
      // word and no drink.
      final rounds = roundsOf([
        line('a', name: 'Vodka & Coke', price: 500, by: 'Nicky'),
        line('a-m', name: 'No ice', price: 0, by: 'Manager', parent: 'a'),
        line('b', name: 'IPA', price: 300, by: 'Nicky'),
      ]);
      expect(rounds, hasLength(1));
      expect(rounds.single.lines.map((l) => l.id), ['a', 'a-m', 'b']);
    });
  });

  group('picking rounds to pay', () {
    test('picking a round yields its lines', () {
      final lines = [
        line('a', by: 'Nicky'),
        line('b', by: 'Nicky'),
        line('c', by: 'Sam'),
      ];
      final rounds = roundsOf(lines);
      expect(lineIdsOfRounds([rounds[1]], lines), {'c'});
    });

    test('picking both rounds yields the whole bill', () {
      final lines = [line('a', by: 'Nicky'), line('c', by: 'Sam')];
      final rounds = roundsOf(lines);
      expect(lineIdsOfRounds(rounds, lines), {'a', 'c'});
    });
  });

  group('which line a modifier lands on', () {
    // Two keys arrive at this question from different directions — a MIXERS key
    // asking a venue's question, and a product flagged "can only be sold
    // attached to another item" being tapped. They must answer it the same way,
    // or "No ice" goes onto one line and "Dash Coke" onto another.
    String idOf(PricedLine l) => l.id;

    final items = [
      line('gin', name: 'Gin'),
      line('beer', name: 'IPA'),
      line('wine', name: 'House Red'),
    ];

    test('nothing selected means the last item', () {
      // "Gin, then no ice" is the order somebody actually presses the two keys
      // in. Requiring the gin to be selected first would add a step to the
      // common case in order to disambiguate the rare one.
      expect(modifierTarget(items, <String>{}, idOf: idOf)?.id, 'wine');
    });

    test('a selected line wins over the last one', () {
      expect(modifierTarget(items, {'gin'}, idOf: idOf)?.id, 'gin');
    });

    test('with two selected it takes the most recent', () {
      // Two lines picked out is not a thing this question has an answer for.
      // The later one is what the clerk was looking at.
      expect(modifierTarget(items, {'gin', 'beer'}, idOf: idOf)?.id, 'beer');
    });

    test('a selection left over from another bill is ignored', () {
      expect(modifierTarget(items, {'not-here'}, idOf: idOf)?.id, 'wine');
    });

    test('an empty bill has no answer, and must not invent one', () {
      // Ringing "No ice" onto nothing is always a mistake, and the caller has
      // to say so out loud rather than swallow it.
      expect(modifierTarget(<PricedLine>[], {'gin'}, idOf: idOf), isNull);
    });
  });

  group('a share can never hold an answer without its question', () {
    final lines = [
      line('gin', name: 'Gin', price: 400),
      line('m1', name: 'Dash Coke', price: 0, parent: 'gin'),
      line('m2', name: 'Extra shot', price: 150, parent: 'gin'),
      line('beer', name: 'IPA', price: 300),
    ];

    String idOf(PricedLine l) => l.id;
    String? parentOf(PricedLine l) => l.parentLineId;

    test('picking the drink brings both its modifiers', () {
      expect(
        withModifiersOf({'gin'}, lines, idOf: idOf, parentOf: parentOf),
        {'gin', 'm1', 'm2'},
      );
    });

    test('picking a modifier brings back the drink — and its siblings', () {
      // The second modifier sits *earlier* in the list than nothing, but the
      // parent it pulls in was not in the set when the first modifier was
      // considered. A single pass drops 'm1' here and the share is £1.50 light
      // with nothing on screen to say so.
      expect(
        withModifiersOf({'m2'}, lines, idOf: idOf, parentOf: parentOf),
        {'gin', 'm1', 'm2'},
      );
    });

    test('an unrelated item is left alone', () {
      expect(
        withModifiersOf({'beer'}, lines, idOf: idOf, parentOf: parentOf),
        {'beer'},
      );
    });

    test('a modifier whose parent is not on the bill stands on its own', () {
      // The re-fire case: the dish went to the kitchen an hour ago and only
      // the change is on this bill.
      final orphan = [line('m', name: 'Rare', price: 0, parent: 'gone')];
      expect(
        withModifiersOf({'m'}, orphan, idOf: idOf, parentOf: parentOf),
        {'m'},
      );
    });

    test('nothing picked stays nothing', () {
      expect(
        withModifiersOf(<String>{}, lines, idOf: idOf, parentOf: parentOf),
        isEmpty,
      );
    });
  });
}
