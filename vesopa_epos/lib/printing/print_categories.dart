/// Grouping a kitchen ticket into courses.
///
/// "Printer Categories. This allows us to setup print category's so we can say
/// which order each category's prints. E.g. Breakfast, Mains, Desserts, Sides.
/// Kitchen printer would show
///
///     --- BREAKFAST ---
///     2 Large Breakfast
///     1 Small Breakfast
///     1 Pancakes
///     --- MAINS ---
///     2 Cod & Chips
///     1 Pizza"
///
/// WHY THE ORDER IS THE VENUE'S AND NOT THE CLERK'S
///
/// A ticket prints in the order things were rung up, which is the order the
/// customer said them — "two cod, oh and a pancake for the little one, and
/// another cod". A kitchen does not work in that order. It works in courses,
/// and a chef reading a ticket that alternates between the fryer and the
/// griddle four times is a chef re-reading the ticket.
///
/// So the venue says what order its categories print in, once, and every ticket
/// comes out that way.
///
/// WHAT KEEPS ITS ORDER
///
/// Within a category, the original order is preserved exactly. Grouping is the
/// only rearrangement — two cod rung ten minutes apart stay in the sequence
/// they were rung, because that is still the order the kitchen took them.
///
/// A modifier never moves away from the dish it belongs to. It is carried with
/// its parent into whatever group the parent lands in, whatever category the
/// modifier's own product might be in — "no ice" belongs under the drink, not
/// under Sides.
///
/// A PRODUCT IN NO CATEGORY STILL PRINTS
///
/// Last, under no heading. A venue that has set up three categories and has
/// four hundred products has not put them all in one, and a ticket that dropped
/// the uncategorised ones would lose food. They print exactly as they did
/// before categories existed, which is also what every venue that never sets
/// one up gets.
library;

import 'package:flutter/foundation.dart';

import '../data/local/database.dart';
import '../data/modifier_layout.dart';

/// A printing category, as the venue set it up.
@immutable
class PrintCategory {
  const PrintCategory({required this.name, required this.sortOrder});

  final String name;

  /// Where it prints. Lower first.
  final int sortOrder;

  @override
  bool operator ==(Object other) =>
      other is PrintCategory &&
      other.name == name &&
      other.sortOrder == sortOrder;

  @override
  int get hashCode => Object.hash(name, sortOrder);
}

/// One heading and the lines under it.
@immutable
class KitchenGroup {
  const KitchenGroup({required this.heading, required this.lines});

  /// The category's name, or null for the products in no category — which
  /// print last, under nothing.
  final String? heading;

  /// In reading order, modifiers already nested under their parents.
  final List<NestedLine> lines;

  @override
  String toString() => 'KitchenGroup(${heading ?? 'uncategorised'}, '
      '${lines.length} lines)';
}

/// Split [lines] into the groups a kitchen ticket should print.
///
/// [categoryOf] answers the category for a PLU, or null where the product is in
/// none. It is a callback rather than a map because the caller already holds
/// the catalogue and building a second index of it per ticket would be work
/// done at the pass.
///
/// Returns a single group with a null heading when the venue has no categories
/// at all — which is every venue until somebody sets one up, and which makes
/// the ticket identical to the one that printed before this existed.
List<KitchenGroup> groupForKitchen(
  List<OrderLine> lines,
  PrintCategory? Function(int pluId) categoryOf,
) {
  final nested = nestModifiers(lines);
  if (nested.isEmpty) return const [];

  // Keyed by name, because two categories with one name are one category as far
  // as a chef reading the heading is concerned.
  final groups = <String, List<NestedLine>>{};
  final order = <String, int>{};
  final firstSeen = <String, int>{};
  final loose = <NestedLine>[];

  String? currentHeading;
  var index = 0;

  for (final entry in nested) {
    // A modifier goes wherever its parent went. `nestModifiers` emits each
    // parent immediately before its children, so the last heading decided is
    // the right one — and this is what stops "no ice" being filed under Sides
    // because that is where its own product happens to live.
    if (entry.isModifier) {
      if (currentHeading == null) {
        loose.add(entry);
      } else {
        groups[currentHeading]!.add(entry);
      }
      continue;
    }

    final category = categoryOf(entry.line.pluId);
    if (category == null || category.name.trim().isEmpty) {
      currentHeading = null;
      loose.add(entry);
      continue;
    }

    final heading = category.name.trim();
    currentHeading = heading;
    groups.putIfAbsent(heading, () => []);
    order.putIfAbsent(heading, () => category.sortOrder);
    firstSeen.putIfAbsent(heading, () => index);
    groups[heading]!.add(entry);
    index++;
  }

  final headings = groups.keys.toList()
    // The venue's order first. Two categories sharing a sort order fall back to
    // whichever was rung first, which is stable and is what the ticket did
    // before there were categories — never to hash order, which would print the
    // same ticket differently twice.
    ..sort((a, b) {
      final byOrder = order[a]!.compareTo(order[b]!);
      return byOrder != 0 ? byOrder : firstSeen[a]!.compareTo(firstSeen[b]!);
    });

  return [
    for (final heading in headings)
      KitchenGroup(heading: heading, lines: groups[heading]!),
    // Last, and under no heading. See the note at the top.
    if (loose.isNotEmpty) KitchenGroup(heading: null, lines: loose),
  ];
}

/// `--- BREAKFAST ---`, exactly as the venue wrote it.
///
/// Upper-cased and fenced because a kitchen ticket is read at a glance from a
/// metre away, and a heading that looks like an item is a heading somebody
/// tries to cook.
String kitchenHeading(String name) => '--- ${name.toUpperCase()} ---';
