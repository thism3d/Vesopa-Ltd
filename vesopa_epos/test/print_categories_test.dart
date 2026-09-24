/// A kitchen ticket comes out in the venue's own courses.
///
/// The venue's example, verbatim:
///
///     --- BREAKFAST ---
///     2 Large Breakfast
///     1 Small Breakfast
///     1 Pancakes
///     --- MAINS ---
///     2 Cod & Chips
///     1 Pizza
///
/// A ticket prints in the order things were rung up, which is the order the
/// customer said them — "two cod, oh and a pancake for the little one, and
/// another cod". A kitchen works in courses, and a chef re-reading a ticket
/// that alternates between the fryer and the griddle is a chef losing time at
/// the pass.
///
/// The two rules worth guarding are what does *not* move: within a category
/// the original order is untouched, and a modifier never leaves the dish it
/// belongs to.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/printing/print_categories.dart';

void main() {
  const breakfast = PrintCategory(name: 'Breakfast', sortOrder: 10);
  const mains = PrintCategory(name: 'Mains', sortOrder: 20);
  const desserts = PrintCategory(name: 'Desserts', sortOrder: 30);

  var seq = 0;
  OrderLine line(
    String name, {
    required int plu,
    double qty = 1,
    String? id,
    String? parent,
  }) {
    seq++;
    return OrderLine(
      id: id ?? 'line-$seq',
      orderId: 'order-1',
      pluId: plu,
      name: name,
      quantity: qty,
      unitPriceMinor: 500,
      taxPercentage: 20,
      lineDiscountMinor: 0,
      // A modifier is a line with a parent — that is the whole of it. See
      // OrderLines.parentLineId.
      parentLineId: parent,
    );
  }

  setUp(() => seq = 0);

  /// The lookup the print service builds from the catalogue.
  PrintCategory? Function(int) categories(Map<int, PrintCategory> byPlu) =>
      (plu) => byPlu[plu];

  /// Flatten a grouping the way the printer would read it.
  List<String> asPrinted(List<KitchenGroup> groups) => [
    for (final group in groups) ...[
      if (group.heading != null) kitchenHeading(group.heading!),
      for (final entry in group.lines)
        entry.isModifier
            ? '   > ${entry.line.name}'
            : '${entry.line.quantity.toStringAsFixed(0)} ${entry.line.name}',
    ],
  ];

  test("the venue's own example, in the venue's own order", () {
    // Rung up interleaved, exactly as a customer would say it.
    final lines = [
      line('Cod & Chips', plu: 20, qty: 2),
      line('Large Breakfast', plu: 10, qty: 2),
      line('Pizza', plu: 21),
      line('Small Breakfast', plu: 11),
      line('Pancakes', plu: 12),
    ];

    final groups = groupForKitchen(
      lines,
      categories({
        10: breakfast,
        11: breakfast,
        12: breakfast,
        20: mains,
        21: mains,
      }),
    );

    expect(asPrinted(groups), [
      '--- BREAKFAST ---',
      '2 Large Breakfast',
      '1 Small Breakfast',
      '1 Pancakes',
      '--- MAINS ---',
      '2 Cod & Chips',
      '1 Pizza',
    ]);
  });

  test('categories print in the order the venue set, not alphabetically', () {
    final lines = [
      line('Sticky Toffee', plu: 30),
      line('Steak', plu: 20),
      line('Toast', plu: 10),
    ];
    final groups = groupForKitchen(
      lines,
      categories({10: breakfast, 20: mains, 30: desserts}),
    );
    expect(
      groups.map((g) => g.heading),
      ['Breakfast', 'Mains', 'Desserts'],
    );
  });

  test('within a category, nothing is reordered', () {
    // Two cod rung ten minutes apart stay in the sequence the kitchen took
    // them. Grouping is the only rearrangement this does.
    final lines = [
      line('Cod & Chips', plu: 20),
      line('Pizza', plu: 21),
      line('Scampi', plu: 22),
    ];
    final groups = groupForKitchen(
      lines,
      categories({20: mains, 21: mains, 22: mains}),
    );
    expect(groups, hasLength(1));
    expect(
      groups.single.lines.map((e) => e.line.name),
      ['Cod & Chips', 'Pizza', 'Scampi'],
    );
  });

  group('what does not move', () {
    test('a modifier stays under its dish', () {
      final steak = line('Steak', plu: 20, id: 'steak');
      final lines = [
        steak,
        line('Rare', plu: 99, parent: 'steak'),
        line('Toast', plu: 10),
      ];

      // 99 is filed under Desserts on purpose: a modifier must follow its
      // parent, not its own product's category. "Rare" under Desserts would be
      // a ticket nobody could cook from.
      final groups = groupForKitchen(
        lines,
        categories({10: breakfast, 20: mains, 99: desserts}),
      );

      expect(asPrinted(groups), [
        '--- BREAKFAST ---',
        '1 Toast',
        '--- MAINS ---',
        '1 Steak',
        '   > Rare',
      ]);
    });

    test('and a modifier whose dish is uncategorised goes with it', () {
      final gin = line('Gin', plu: 40, id: 'gin');
      final lines = [
        line('Toast', plu: 10),
        gin,
        line('No ice', plu: 99, parent: 'gin'),
      ];
      final groups = groupForKitchen(
        lines,
        categories({10: breakfast, 99: desserts}),
      );
      expect(asPrinted(groups), [
        '--- BREAKFAST ---',
        '1 Toast',
        '1 Gin',
        '   > No ice',
      ]);
    });
  });

  group('products in no category', () {
    test('still print, last, under no heading', () {
      // A venue with three categories and four hundred products has not filed
      // them all. A ticket that dropped the unfiled ones would lose food.
      final lines = [
        line('Mystery Item', plu: 90),
        line('Large Breakfast', plu: 10, qty: 2),
      ];
      final groups = groupForKitchen(lines, categories({10: breakfast}));

      expect(asPrinted(groups), [
        '--- BREAKFAST ---',
        '2 Large Breakfast',
        '1 Mystery Item',
      ]);
      expect(groups.last.heading, isNull);
    });

    test('and a venue with no categories at all gets its old ticket', () {
      final lines = [
        line('Cod & Chips', plu: 20, qty: 2),
        line('Pizza', plu: 21),
      ];
      final groups = groupForKitchen(lines, (_) => null);

      expect(groups, hasLength(1));
      expect(groups.single.heading, isNull);
      expect(asPrinted(groups), ['2 Cod & Chips', '1 Pizza']);
    });

    test('a category named only in whitespace is no category', () {
      final lines = [line('Toast', plu: 10)];
      final groups = groupForKitchen(
        lines,
        categories({10: const PrintCategory(name: '   ', sortOrder: 1)}),
      );
      expect(groups.single.heading, isNull);
    });
  });

  group('edges', () {
    test('an empty ticket is empty, not a heading with nothing under it', () {
      expect(groupForKitchen(const [], (_) => null), isEmpty);
    });

    test('two categories sharing an order print in the order rung', () {
      // Never in hash order, which would print the same ticket differently
      // twice and be impossible to explain.
      const a = PrintCategory(name: 'Grill', sortOrder: 5);
      const b = PrintCategory(name: 'Fryer', sortOrder: 5);
      final lines = [line('Chips', plu: 21), line('Steak', plu: 20)];

      final groups = groupForKitchen(lines, categories({20: a, 21: b}));
      expect(groups.map((g) => g.heading), ['Fryer', 'Grill']);
    });

    test('the heading is fenced and shouted, so nobody tries to cook it', () {
      expect(kitchenHeading('Breakfast'), '--- BREAKFAST ---');
      expect(kitchenHeading('Cod & Chips'), '--- COD & CHIPS ---');
    });
  });
}
