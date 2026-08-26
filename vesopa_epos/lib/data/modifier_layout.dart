/// Putting modifiers back under the item they belong to.
///
/// A modifier is a real order line with `parentLineId` set — that is what lets
/// it price, tax, void and report as what it actually is (see
/// OrderLines.parentLineId). The cost of that choice is paid here: the lines
/// come out of the database flat, and every place that *shows* them — the
/// check, the printed receipt, the kitchen ticket — has to put them back in
/// order.
///
/// So it is done once, here, rather than three times slightly differently. A
/// receipt that nests and a kitchen ticket that does not is a ticket the
/// kitchen reads as two separate items.
library;

import 'local/database.dart';

/// One line, and whether it is hanging off the one above it.
typedef NestedLine = ({OrderLine line, bool isModifier});

/// [lines] in the order they should be read: each item followed immediately by
/// the answers chosen about it.
///
/// Order among items is preserved exactly as given — the bill reads in the
/// order things were rung, which is the order the customer watched them go on.
///
/// A modifier whose parent is not in [lines] is kept, at the position it
/// already held, and reported as an ordinary line. That is not tidiness: a
/// kitchen ticket carries only the lines that have not been fired yet, so an
/// item fired earlier and a modifier added since will legitimately arrive here
/// on its own. Dropping it would lose the change; showing it indented under
/// nothing would be a widow. It goes out as itself, and reads as an
/// instruction.
List<NestedLine> nestModifiers(List<OrderLine> lines) {
  if (lines.isEmpty) return const [];

  final present = {for (final l in lines) l.id};

  // Children, kept in the order they were given, under the parent they name.
  final children = <String, List<OrderLine>>{};
  for (final line in lines) {
    final parent = line.parentLineId;
    if (parent != null && present.contains(parent)) {
      (children[parent] ??= []).add(line);
    }
  }

  final out = <NestedLine>[];
  for (final line in lines) {
    final parent = line.parentLineId;
    // Already emitted under its parent below.
    if (parent != null && present.contains(parent)) continue;

    out.add((line: line, isModifier: false));
    for (final child in children[line.id] ?? const <OrderLine>[]) {
      out.add((line: child, isModifier: true));
    }
  }
  return out;
}

/// The same ordering as [nestModifiers], for anything line-shaped.
///
/// The check on screen works in the pricing engine's `PricedLine`, not in the
/// database's `OrderLine`, and both have to nest the same way — so the rule
/// lives once and is handed whatever it needs to read an id and a parent.
///
/// Returns a flat list in reading order. Callers tell a modifier by its own
/// parent link, which they already have.
List<T> orderWithModifiers<T>(
  List<T> lines, {
  required String Function(T) idOf,
  required String? Function(T) parentOf,
}) {
  if (lines.isEmpty) return lines;

  final present = {for (final l in lines) idOf(l)};
  final children = <String, List<T>>{};
  for (final line in lines) {
    final parent = parentOf(line);
    if (parent != null && present.contains(parent)) {
      (children[parent] ??= []).add(line);
    }
  }
  if (children.isEmpty) return lines;

  final out = <T>[];
  for (final line in lines) {
    final parent = parentOf(line);
    if (parent != null && present.contains(parent)) continue;
    out.add(line);
    out.addAll(children[idOf(line)] ?? const []);
  }
  return out;
}

/// Where each line actually goes, keyed by line id.
///
/// A modifier follows the item it modifies, whatever its own product is routed
/// to. This is not a convenience — it is the difference between a kitchen
/// getting a steak with a temperature on it and a kitchen getting a steak.
///
/// Routing is per product, and the products behind modifiers — "Rare", "Dash
/// Coke", "No ice" — are exactly the ones nobody routes anywhere. They are not
/// dishes; they are things said about dishes. Left to their own routing they
/// are dropped from every ticket, and the failure is silent and in the worst
/// possible place: the item still prints, so the ticket looks complete, and the
/// only sign anything is wrong is a plate coming back.
///
/// A modifier whose parent is not in [lines] keeps its own routing. That is the
/// re-fire case — the dish went to the kitchen earlier and only the change is
/// being sent now — where there is no parent to follow.
Map<String, Set<String>> routesByLine(
  List<OrderLine> lines,
  Map<int, Set<String>> routesByPlu,
) {
  final own = <String, Set<String>>{
    for (final l in lines) l.id: routesByPlu[l.pluId] ?? const <String>{},
  };

  final out = <String, Set<String>>{};
  for (final line in lines) {
    final parent = line.parentLineId;
    out[line.id] = parent != null && own.containsKey(parent)
        ? own[parent]!
        : own[line.id]!;
  }
  return out;
}

/// Just the items, with their modifiers left out.
///
/// For the places that count things rather than list them — "how many items on
/// this bill" should say two drinks, not two drinks and the three answers given
/// about them.
List<OrderLine> itemsOnly(List<OrderLine> lines) =>
    [for (final l in lines) if (l.parentLineId == null) l];
