import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/data/dinein_orders.dart';
import 'package:vesopa_epos_kitchen/data/notifications.dart';
import 'package:vesopa_epos_kitchen/ui/widgets/on_screen_keyboard.dart';
import 'package:vesopa_epos_kitchen/ui/widgets/password_prompt.dart';

/// QR orders in the kitchen, and the rule about interrupting people.
///
/// Three separate things are checked here because three separate things were
/// asked for and each of them has a way of being quietly wrong:
///
///   * an order sent from a phone has a SHAPE — add-ons hang off dishes,
///     notes belong to one dish and not the order, and a count of "items" that
///     included the add-ons would tell a kitchen it has more plates to make
///     than it has;
///   * the difference between "nobody declared any allergens" and "this
///     contains none of the fourteen" survives the wire, because a board that
///     confuses them tells a chef something about food that is not true;
///   * a toast needs BOTH the back office and this machine to allow it, and no
///     single switch can override the other.
void main() {
  DineInOrder order(List<Map<String, Object?>> lines) => DineInOrder.fromJson({
    'id': 7,
    'public_id': 'abc',
    'table_label': 'Table 4',
    'status': 'placed',
    'total_minor': 1240,
    'placed_at': '2026-09-08T12:00:00Z',
    'customer_name': 'Sam',
    'lines': lines,
  })!;

  group('the shape of an order from a phone', () {
    final placed = order([
      {
        'id': 1,
        'name': 'IPA Pint',
        'qty': 2,
        'unit_price_minor': 300,
        'note': 'no ice',
        'is_modifier': 0,
        'unavailable_action': 'call',
        'allergens': ['gluten'],
        'allergens_declared': true,
      },
      {
        'id': 2,
        'name': 'Lemonade',
        'qty': 2,
        'unit_price_minor': 80,
        'parent_line_id': 1,
        'is_modifier': 1,
        'unavailable_action': 'call',
      },
      {
        'id': 3,
        'name': 'Chips',
        'qty': 1,
        'unit_price_minor': 350,
        'is_modifier': 0,
        'unavailable_action': 'remove',
      },
    ]);

    test('add-ons are not counted as dishes to cook', () {
      // Three lines, two dishes, three plates. A count that included the
      // Lemonade would tell the kitchen it has an extra thing to make.
      expect(placed.lines, hasLength(3));
      expect(placed.dishes.map((d) => d.name), ['IPA Pint', 'Chips']);
      expect(placed.itemCount, 3);
    });

    test('an add-on stays attached to the dish it was chosen for', () {
      final pint = placed.dishes.first;
      expect(placed.addOnsFor(pint).map((a) => a.name), ['Lemonade']);
      expect(placed.addOnsFor(placed.dishes.last), isEmpty);
    });

    test('a note belongs to its own dish, not to the order', () {
      expect(placed.dishes.first.note, 'no ice');
      expect(placed.dishes.last.note, isNull);
      expect(placed.note, isNull);
    });

    test('what to do if a dish is off is carried per line', () {
      expect(placed.dishes.first.unavailableAction, 'call');
      // The default, and the one that needs no saying on the card.
      expect(placed.dishes.last.unavailableAction, 'remove');
    });

    test('a line with no answer defaults to remove rather than to nothing', () {
      final bare = order([
        {'id': 1, 'name': 'Soup', 'qty': 1, 'unit_price_minor': 650},
      ]);
      expect(bare.lines.single.unavailableAction, 'remove');
    });

    test('every allergen on the order is gathered once, in order', () {
      final two = order([
        {
          'id': 1,
          'name': 'Soup',
          'qty': 1,
          'unit_price_minor': 650,
          'allergens': ['milk', 'celery'],
          'allergens_declared': true,
        },
        {
          'id': 2,
          'name': 'Bread',
          'qty': 1,
          'unit_price_minor': 300,
          'allergens': ['gluten', 'milk'],
          'allergens_declared': true,
        },
      ]);
      expect(two.allAllergens, ['celery', 'gluten', 'milk']);
    });

    test('unanswered and "contains none" are not the same fact', () {
      // The distinction the whole design rests on. Both arrive as an empty
      // list; only the flag says which, and a card that read the list alone
      // would print the same thing over both.
      final unanswered = order([
        {'id': 1, 'name': 'Soup', 'qty': 1, 'unit_price_minor': 650},
      ]).lines.single;
      final none = order([
        {
          'id': 1,
          'name': 'Soup',
          'qty': 1,
          'unit_price_minor': 650,
          'allergens': <String>[],
          'allergens_declared': true,
        },
      ]).lines.single;

      expect(unanswered.allergens, isEmpty);
      expect(unanswered.allergensDeclared, isFalse);
      expect(none.allergens, isEmpty);
      expect(none.allergensDeclared, isTrue);
    });
  });

  group('who may interrupt somebody', () {
    test('both layers must allow it, and neither can overrule the other', () {
      final n = AppNotifications();

      // Everything on.
      expect(n.allows(NotifyKind.dineInOrder), isTrue);
      expect(n.audible, isTrue);

      // The back office silences this class for the whole building. The
      // machine's own switch cannot bring it back.
      n.policy = const NotifyPolicy(kitchenDineInNew: false);
      n.local = const NotifyLocal(enabled: true);
      expect(n.allows(NotifyKind.dineInOrder), isFalse);
      // And a different class is unaffected: that is the point of having one
      // column per event rather than one "new order" switch.
      expect(n.allows(NotifyKind.kitchenTicket), isTrue);

      // The machine opts out of what it is allowed.
      n.policy = const NotifyPolicy();
      n.local = const NotifyLocal(enabled: false);
      expect(n.allows(NotifyKind.dineInOrder), isFalse);

      // The master switch beats everything.
      n.policy = const NotifyPolicy(master: false);
      n.local = const NotifyLocal(enabled: true);
      expect(n.allows(NotifyKind.dineInOrder), isFalse);
      expect(n.allows(NotifyKind.kitchenTicket), isFalse);
    });

    test('sound is decided separately from whether a toast appears', () {
      // A bar with music on wants the light and not the chime; a kitchen that
      // cannot hear over an extractor wants exactly the opposite.
      final n = AppNotifications()
        ..policy = const NotifyPolicy(kitchenSound: false)
        ..local = const NotifyLocal(enabled: true, sound: true);
      expect(n.allows(NotifyKind.dineInOrder), isTrue);
      expect(n.audible, isFalse);

      n
        ..policy = const NotifyPolicy()
        ..local = const NotifyLocal(enabled: true, sound: false);
      expect(n.allows(NotifyKind.dineInOrder), isTrue);
      expect(n.audible, isFalse);
    });

    test('a settings row a screen could not read leaves it working', () {
      // The defaults are ON. A screen that cannot reach the back office must
      // keep announcing orders — silence caused by a network blip is the exact
      // fault this feature exists to fix.
      final policy = NotifyPolicy.fromSettings(const {});
      expect(policy.master, isTrue);
      expect(policy.kitchenDineInNew, isTrue);
      expect(policy.kitchenSound, isTrue);
    });

    test('the columns are read however MySQL hands them over', () {
      // 0/1, "0"/"1" and false/true all reach here depending on the driver and
      // the JSON hop. All three have to mean the same thing.
      for (final off in [0, '0', false]) {
        final policy = NotifyPolicy.fromSettings({'notify_master': off});
        expect(policy.master, isFalse, reason: 'for $off');
      }
      for (final on in [1, '1', true]) {
        final policy = NotifyPolicy.fromSettings({'notify_master': on});
        expect(policy.master, isTrue, reason: 'for $on');
      }
    });
  });

  group('nothing takes focus on its own', () {
    testWidgets('the password prompt opens without raising the keyboard', (
      tester,
    ) async {
      // The venue's words: "it's focusing a field which shouldn't be done
      // anywhere in the kitchen app as we're working on a lower end device and
      // very low screen." On that panel the system keyboard covers half the
      // screen the moment a field takes focus.
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            home: Scaffold(
              body: Consumer(
                builder: (context, ref, _) => ElevatedButton(
                  onPressed: () => askForKitchenPassword(
                    context,
                    ref,
                    title: 'Sign out',
                    explanation: 'Enter the kitchen password.',
                    confirmLabel: 'Sign out',
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsOneWidget);

      final field = tester.widget<TextField>(find.byType(TextField));
      expect(
        field.autofocus,
        isFalse,
        reason: 'the field must not claim focus when the dialog opens',
      );
      expect(
        primaryFocus?.context?.widget,
        isNot(isA<EditableText>()),
        reason: 'no text field should hold focus before anybody has tapped one',
      );

      // And the dialog is still usable without it: the on-screen keyboard
      // writes straight into the controller, which is why removing autofocus
      // costs nothing here.
      expect(find.byType(OnScreenKeyboard), findsOneWidget);
    });
  });
}
