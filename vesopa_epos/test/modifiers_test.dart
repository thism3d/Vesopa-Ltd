/// Modifiers on the till: what lands on the bill, and what happens when it
/// comes off again.
///
/// The rules being pinned here are the ones that cost a venue money or send a
/// kitchen the wrong plate:
///
///   - a gin with coke and a gin with tonic are two lines, not one at qty 2;
///   - a modifier never outlives the item it modifies;
///   - the whole family is valued when a line is voided, so the void log shows
///     what the bill actually lost;
///   - and the answers read under the item they belong to, on the check, the
///     receipt and the kitchen ticket alike.
library;

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/modifier_layout.dart';
import 'package:vesopa_epos/data/modifiers.dart';
import 'package:vesopa_epos/data/order_repository.dart';

void main() {
  late AppDatabase db;
  late OrderRepository repo;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    repo = OrderRepository(db);
  });

  tearDown(() => db.close());

  const gin = Product(
    pluId: 10,
    name: 'Gin',
    priceMinor: 400,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
  );
  const coke = Product(
    pluId: 11,
    name: 'Dash Coke',
    priceMinor: 50,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
  );
  const tonic = Product(
    pluId: 12,
    name: 'Dash Tonic',
    priceMinor: 0,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
  );

  Future<List<OrderLine>> linesOf(String orderId) =>
      (db.select(db.orderLines)..where((l) => l.orderId.equals(orderId))).get();

  group('what lands on the bill', () {
    test('answers land as lines hanging off the item', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);

      final lines = await linesOf(id);
      expect(lines, hasLength(2));

      final parent = lines.firstWhere((l) => l.pluId == gin.pluId);
      final child = lines.firstWhere((l) => l.pluId == coke.pluId);
      expect(parent.parentLineId, isNull);
      expect(child.parentLineId, parent.id);
      // Priced as itself, which is the whole reason it is a line and not a note.
      expect(child.unitPriceMinor, 50);
    });

    test('a paid modifier is in the bill total', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);

      final order = await repo.watchOrder(id).first;
      expect(order.subtotalMinor, 450);
    });

    test('two of the same drink with different mixers stay apart', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);
      await repo.addLine(id, gin, modifiers: const [tonic]);

      final lines = await linesOf(id);
      final gins = lines.where((l) => l.pluId == gin.pluId).toList();
      // Merging these would quietly change what the first customer ordered.
      expect(gins, hasLength(2));
      for (final g in gins) {
        expect(g.quantity, 1);
      }
    });

    test('a plain repeat tap still merges, as it always did', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin);
      await repo.addLine(id, gin);

      final lines = await linesOf(id);
      expect(lines, hasLength(1));
      expect(lines.single.quantity, 2);
    });

    test('a plain tap does not merge into a drink that has a mixer', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);
      await repo.addLine(id, gin);

      final lines = await linesOf(id);
      final gins = lines.where((l) => l.pluId == gin.pluId).toList();
      // Otherwise the plain gin would silently acquire the first one's coke.
      expect(gins, hasLength(2));
    });

    test('the modifier follows the quantity of what it modifies', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, qty: 2, modifiers: const [coke]);

      final lines = await linesOf(id);
      final child = lines.firstWhere((l) => l.pluId == coke.pluId);
      // Two double gins want two dashes of coke.
      expect(child.quantity, 2);
    });
  });

  group('what happens when it comes off again', () {
    test('removing the item removes its answers', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke, tonic]);

      final parent =
          (await linesOf(id)).firstWhere((l) => l.parentLineId == null);
      await repo.removeLine(id, parent.id);

      // A "Dash Coke" left behind is a line nobody can account for.
      expect(await linesOf(id), isEmpty);
    });

    test('voiding the item voids its answers, and values them', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);

      final parent =
          (await linesOf(id)).firstWhere((l) => l.parentLineId == null);
      final voided = await repo.voidLines(
        id,
        lineIds: {parent.id},
        reason: 'Wrong drink',
      );

      expect(await linesOf(id), isEmpty);
      // £4.00 gin + 50p coke: the void log has to show what the bill lost.
      expect(voided, 450);
    });

    test('keying the quantity to zero takes the answers too', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);

      final parent =
          (await linesOf(id)).firstWhere((l) => l.parentLineId == null);
      await repo.setLineQuantity(id, parent.id, 0);

      expect(await linesOf(id), isEmpty);
    });

    test('changing the quantity carries the answers with it', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);

      final parent =
          (await linesOf(id)).firstWhere((l) => l.parentLineId == null);
      await repo.setLineQuantity(id, parent.id, 3);

      final lines = await linesOf(id);
      // A kitchen reading "3 Steak / 1 Rare" cannot tell which steak is which.
      expect(lines.firstWhere((l) => l.pluId == coke.pluId).quantity, 3);
    });
  });

  group('reading order', () {
    test('answers are put back under the item they belong to', () {
      const a = ('a', null), b = ('b', 'a'), c = ('c', null), d = ('d', 'a');
      // Deliberately shuffled: the database makes no promise about row order.
      final ordered = orderWithModifiers(
        [c, b, a, d],
        idOf: (r) => r.$1,
        parentOf: (r) => r.$2,
      );
      expect(ordered.map((r) => r.$1).toList(), ['c', 'a', 'b', 'd']);
    });

    test('an answer whose item is not in the list is kept, not dropped', () {
      // A kitchen ticket carries only the lines not yet fired, so a modifier
      // added to an item that went out earlier legitimately arrives alone.
      const orphan = ('b', 'a');
      final ordered = orderWithModifiers(
        [orphan],
        idOf: (r) => r.$1,
        parentOf: (r) => r.$2,
      );
      expect(ordered, hasLength(1));
    });

    test('a bill with no modifiers is handed back untouched', () {
      const rows = [('a', null), ('b', null)];
      expect(
        orderWithModifiers(rows, idOf: (r) => r.$1, parentOf: (r) => r.$2),
        same(rows),
      );
    });
  });

  group('the wiring the till reads', () {
    test('a product asks its questions in the order they were set', () {
      final set = ModifierSet.fromJson({
        'groups': [
          {'id': 4, 'name': 'Doubles', 'min_select': 1, 'max_select': 1},
          {'id': 12, 'name': 'Mixers', 'min_select': 0, 'max_select': 1},
        ],
        'products': {'10': [12, 4]},
      });
      // Order comes from the product's list, not from the group list.
      expect(set.forPlu(10).map((g) => g.name).toList(), ['Mixers', 'Doubles']);
    });

    test('a group the venue has deleted drops out rather than opening empty', () {
      final set = ModifierSet.fromJson({
        'groups': [
          {'id': 4, 'name': 'Doubles', 'min_select': 1, 'max_select': 1},
        ],
        'products': {'10': [4, 999]},
      });
      expect(set.forPlu(10).map((g) => g.id).toList(), [4]);
    });

    test('a product nobody wired up asks nothing', () {
      final set = ModifierSet.fromJson({'groups': [], 'products': {}});
      expect(set.forPlu(10), isEmpty);
    });

    test('the two numbers say how the box behaves', () {
      const compulsory = ModifierGroup(
        id: 1, name: 'Cooked how?', minSelect: 1, maxSelect: 1,
      );
      expect(compulsory.skippable, isFalse);
      expect(compulsory.closesOnFirstPick, isTrue);
      expect(compulsory.satisfiedBy(0), isFalse);
      expect(compulsory.satisfiedBy(1), isTrue);

      const optional = ModifierGroup(
        id: 2, name: 'Extras', minSelect: 0, maxSelect: 0,
      );
      expect(optional.skippable, isTrue);
      expect(optional.unlimited, isTrue);
      // No ceiling means another answer is always allowed.
      expect(optional.canTakeMore(99), isTrue);

      const upToTwo = ModifierGroup(
        id: 3, name: 'Sauces', minSelect: 0, maxSelect: 2,
      );
      expect(upToTwo.canTakeMore(1), isTrue);
      expect(upToTwo.canTakeMore(2), isFalse);
    });

    test('a feed round-trips through the cache unchanged', () {
      final set = ModifierSet.fromJson({
        'groups': [
          {'id': 4, 'name': 'Doubles', 'min_select': 1, 'max_select': 1,
           'screen_id': 40},
        ],
        'products': {'10': [4]},
      });
      // This is what is written to SharedPreferences and read back on a till
      // that opens offline; a lossy round trip means a venue's modifiers stop
      // working exactly when the network does.
      final again = ModifierSet.fromJson(set.toJson());
      expect(again.forPlu(10).single.screenId, 40);
      expect(again.forPlu(10).single.minSelect, 1);
    });
  });

  group('where a modifier goes', () {
    // Nobody routes "Rare" to the grill. It is not a dish; it is a thing said
    // about one. Left to its own routing it is dropped from every ticket, and
    // the failure is silent: the steak still prints, so the ticket looks
    // complete, and the only sign is a plate coming back.
    test('a modifier is routed wherever its dish is routed', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);
      final lines = await linesOf(id);

      final routes = routesByLine(lines, {
        gin.pluId: {'kp2'},
        coke.pluId: const <String>{}, // routed nowhere, as mixers are
      });

      final child = lines.firstWhere((l) => l.parentLineId != null);
      expect(routes[child.id], {'kp2'});
    });

    test('a dish keeps its own routing', () async {
      final id = await repo.openOrder();
      await repo.addLine(id, gin, modifiers: const [coke]);
      final lines = await linesOf(id);

      final routes = routesByLine(lines, {
        gin.pluId: {'kp2'},
        coke.pluId: {'kp5'},
      });

      final parent = lines.firstWhere((l) => l.parentLineId == null);
      expect(routes[parent.id], {'kp2'});
    });

    test('a modifier fired without its dish falls back to its own', () {
      // The re-fire case: the steak went to the kitchen earlier and only the
      // change is being sent now, so there is no parent to follow.
      const orphan = OrderLine(
        id: 'b',
        orderId: 'o',
        pluId: 11,
        name: 'Dash Coke',
        quantity: 1,
        unitPriceMinor: 50,
        taxPercentage: 20,
        lineDiscountMinor: 0,
        parentLineId: 'gone',
      );
      final routes = routesByLine([orphan], {
        11: {'kp3'},
      });
      expect(routes['b'], {'kp3'});
    });
  });
}
