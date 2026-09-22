import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/data/ticket.dart';

/// Crossing items off a ticket.
///
/// The rule the kitchen asked for is one sentence — tap an item to cross it
/// off, and when every item is crossed the ticket is done — but it sits on top
/// of the per-station model, and the two disagree in a way that loses orders if
/// it is got wrong. On a kitchen with two screens the grill finishing its own
/// items must close the grill and leave the fryer alone; on a kitchen with one
/// screen, "all of it" is the only reading there is.
void main() {
  TicketLine line(String id, String name, Set<String> stations) => TicketLine(
    id: id,
    seq: 0,
    quantity: 1,
    name: name,
    stations: stations,
  );

  Ticket ticket({required List<TicketLine> lines, Set<String> stations = const {'kp1'}}) => Ticket(
    id: 't1',
    orderId: 'o1',
    kind: TicketKind.sale,
    placedAt: DateTime(2026, 8, 24, 12),
    lines: lines,
    stations: [
      for (final s in stations) TicketStation(station: s, done: false),
    ],
  );

  group('crossing one item off', () {
    test('marks only that line', () {
      final t = ticket(
        lines: [line('a', 'Chips', {'kp1'}), line('b', 'Burger', {'kp1'})],
      );

      final after = t.lineMade('a', true, by: 'Sam');

      expect(after.lines.firstWhere((l) => l.id == 'a').made, isTrue);
      expect(after.lines.firstWhere((l) => l.id == 'b').made, isFalse);
      expect(after.lines.firstWhere((l) => l.id == 'a').madeBy, 'Sam');
    });

    test('can be put back, because a wet finger hits the wrong line', () {
      final t = ticket(lines: [line('a', 'Chips', {'kp1'})]);

      final crossed = t.lineMade('a', true);
      final undone = crossed.lineMade('a', false);

      expect(undone.lines.single.made, isFalse);
      expect(undone.lines.single.madeAt, isNull);
      expect(undone.lines.single.madeBy, isNull);
    });

    test('leaves station progress alone — that is the bump\'s job', () {
      final t = ticket(lines: [line('a', 'Chips', {'kp1'})]);

      final after = t.lineMade('a', true);

      expect(after.isComplete, isFalse);
      expect(after.isOpenFor(const {}), isTrue);
    });
  });

  group('when the ticket is finished', () {
    test('every item crossed means done', () {
      final t = ticket(
        lines: [line('a', 'Chips', {'kp1'}), line('b', 'Burger', {'kp1'})],
      );

      expect(t.allMadeFor(const {}), isFalse);
      expect(t.lineMade('a', true).allMadeFor(const {}), isFalse);
      expect(
        t.lineMade('a', true).lineMade('b', true).allMadeFor(const {}),
        isTrue,
      );
    });

    test('a board only answers for the items it can see', () {
      // The grill has the chips; the fryer has the wings. The grill crossing
      // off its own item has finished *its* work, and must not be told the
      // fryer is done too.
      final t = ticket(
        lines: [line('a', 'Chips', {'kp1'}), line('b', 'Wings', {'kp2'})],
        stations: {'kp1', 'kp2'},
      );

      final grillDone = t.lineMade('a', true);

      expect(grillDone.allMadeFor(const {'kp1'}), isTrue);
      expect(grillDone.allMadeFor(const {'kp2'}), isFalse);
      // And the pass, watching everything, still has work outstanding.
      expect(grillDone.allMadeFor(const {}), isFalse);
    });

    test('a board with no items on this ticket has not finished it', () {
      // Otherwise a screen would auto-complete a ticket carrying nothing of
      // its own, the instant it appeared.
      final t = ticket(
        lines: [line('a', 'Chips', {'kp1'})],
        stations: {'kp1', 'kp2'},
      );

      expect(t.allMadeFor(const {'kp2'}), isFalse);
    });
  });

  group('recall', () {
    test('un-crosses every item as well as re-opening the stations', () {
      // A ticket that comes back with everything struck through tells the
      // kitchen there is nothing to cook, which is the opposite of what
      // recalling it meant.
      final t = ticket(
        lines: [line('a', 'Chips', {'kp1'}), line('b', 'Burger', {'kp1'})],
      ).lineMade('a', true).lineMade('b', true).bumped(const {});

      expect(t.isComplete, isTrue);

      final back = t.recalled();

      expect(back.isComplete, isFalse);
      expect(back.lines.every((l) => !l.made), isTrue);
      expect(back.allMadeFor(const {}), isFalse);
    });
  });

  group('over the wire', () {
    test('made state survives a round trip through JSON', () {
      // The board caches itself to preferences and re-reads it on launch. A
      // tick that does not survive that is a tick the chef watches vanish.
      final t = ticket(lines: [line('a', 'Chips', {'kp1'})]).lineMade(
        'a',
        true,
        by: 'Sam',
        at: DateTime(2026, 8, 24, 12, 30),
      );

      final back = Ticket.fromJson(t.toJson());

      expect(back.lines.single.made, isTrue);
      expect(back.lines.single.madeBy, 'Sam');
      expect(back.lines.single.madeAt, DateTime(2026, 8, 24, 12, 30));
    });

    test('a line the server has never marked reads as not made', () {
      final back = TicketLine.fromJson({
        'id': 'a',
        'seq': 0,
        'quantity': 1,
        'name': 'Chips',
        'stations': ['kp1'],
      });

      expect(back.made, isFalse);
      expect(back.madeAt, isNull);
    });
  });
}
