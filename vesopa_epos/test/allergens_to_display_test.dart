import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/customer_display.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/notifications.dart';

/// What is in the food, on the screen the customer is looking at.
///
/// This is the last hop of the allergen chain — back office to catalogue to
/// till to the file the display reads — and it is the hop with the sharpest
/// edge on it, because the display is offline by design. It cannot look
/// anything up, so whatever this side sends is exactly what a customer with an
/// allergy reads.
///
/// Two rules are tested here rather than assumed:
///
///   * WORDS cross the boundary, never codes. A screen facing a queue showing
///     `tree_nuts` is worse than showing nothing.
///   * Silence is silence. A product nobody has filled in produces no line at
///     all, and nothing anywhere claims a dish is free of anything.
void main() {
  OrderLine line(String id, String name, int pluId, {String? parentId}) =>
      OrderLine(
        id: id,
        orderId: 'o1',
        pluId: pluId,
        name: name,
        quantity: 1,
        unitPriceMinor: 500,
        taxPercentage: 0,
        lineDiscountMinor: 0,
        parentLineId: parentId,
      );

  group('allergens on the customer display', () {
    test('the words reach the file, in the order they were declared', () {
      final snapshot = snapshotFor(
        lines: [line('a', 'Soup of the Day', 144)],
        allergensByPlu: const {
          144: ['Celery', 'Cereals containing gluten', 'Milk'],
        },
        totalMinor: 500,
      );

      expect(snapshot.lines.single.allergens, [
        'Celery',
        'Cereals containing gluten',
        'Milk',
      ]);

      final written =
          jsonDecode(jsonEncode(snapshot.toJson())) as Map<String, Object?>;
      final first = (written['lines']! as List).first as Map<String, Object?>;
      expect(first['allergens'], [
        'Celery',
        'Cereals containing gluten',
        'Milk',
      ]);
    });

    test('a product nobody has declared writes nothing at all', () {
      // Not an empty list, not the key with nothing in it: the field is absent.
      // A display that found an empty array could reasonably draw "Contains:"
      // with nothing after it, and a customer reading that over an unanswered
      // question is the one failure this must not have.
      final snapshot = snapshotFor(
        lines: [line('a', 'Chips', 12)],
        totalMinor: 350,
      );
      expect(snapshot.lines.single.allergens, isEmpty);

      final written =
          jsonDecode(jsonEncode(snapshot.toJson())) as Map<String, Object?>;
      final first = (written['lines']! as List).first as Map<String, Object?>;
      expect(first.containsKey('allergens'), isFalse);
    });

    test('only the products on the bill are described', () {
      final snapshot = snapshotFor(
        lines: [line('a', 'Chips', 12), line('b', 'Soup', 144)],
        allergensByPlu: const {
          144: ['Milk'],
          999: ['Peanuts'],
        },
        totalMinor: 850,
      );
      expect(snapshot.lines.first.allergens, isEmpty);
      expect(snapshot.lines.last.allergens, ['Milk']);
    });

    test('a modifier carries its own, because it is its own product', () {
      // "Dash Coke" under a double gin is a real order line with a real PLU,
      // and if the venue has declared something on it the customer is owed it.
      final snapshot = snapshotFor(
        lines: [
          line('a', 'Chicken Burger', 20),
          line('b', 'Brioche bun', 21, parentId: 'a'),
        ],
        allergensByPlu: const {
          21: ['Cereals containing gluten', 'Eggs'],
        },
        totalMinor: 1000,
      );
      expect(snapshot.lines.first.allergens, isEmpty);
      expect(snapshot.lines.last.isModifier, isTrue);
      expect(snapshot.lines.last.allergens, [
        'Cereals containing gluten',
        'Eggs',
      ]);
    });

    test('the display is told whether it may raise a toast, and it is off', () {
      // A screen facing a queue is the one surface that should not interrupt
      // anybody, so the flag has to travel and it has to default to off.
      expect(
        snapshotFor(lines: [line('a', 'Chips', 12)]).notifyDisplay,
        isFalse,
      );
      expect(
        snapshotFor(lines: const [], notifyDisplay: true).notifyDisplay,
        isTrue,
        reason: 'an idle screen still has to be told what it is allowed to do',
      );
      final on = snapshotFor(
        lines: [line('a', 'Chips', 12)],
        notifyDisplay: true,
      );
      expect(on.toJson()['notify_display'], isTrue);
    });
  });

  group('who may interrupt somebody at the till', () {
    test('both layers must allow it, and neither can overrule the other', () {
      final n = AppNotifications();
      expect(n.allows(NotifyKind.dineInOrder), isTrue);

      // The back office silences it for every terminal in the building.
      n.policy = const NotifyPolicy(tillDineInNew: false);
      expect(n.allows(NotifyKind.dineInOrder), isFalse);

      // This terminal opts out of what it is allowed.
      n.policy = const NotifyPolicy();
      n.local = const NotifyLocal(enabled: false);
      expect(n.allows(NotifyKind.dineInOrder), isFalse);

      // And the master switch beats both.
      n.local = const NotifyLocal(enabled: true);
      n.policy = const NotifyPolicy(master: false);
      expect(n.allows(NotifyKind.dineInOrder), isFalse);
    });

    test('a settings row that could not be read leaves the till announcing', () {
      final policy = NotifyPolicy.fromSettings(const {});
      expect(policy.master, isTrue);
      expect(policy.tillDineInNew, isTrue);
      expect(policy.tillSound, isTrue);
    });

    test('the columns are read however they arrive', () {
      for (final off in [0, '0', false]) {
        expect(
          NotifyPolicy.fromSettings({'notify_till_sound': off}).tillSound,
          isFalse,
          reason: 'for $off',
        );
      }
    });
  });
}
