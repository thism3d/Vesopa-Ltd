/// Orders customers have sent from their own phones, as the kitchen sees them.
///
/// WHY THE KITCHEN SEES THEM AT ALL
///
/// Until now a QR order was a till concern: it arrived, a clerk pressed Accept,
/// and only then did it become a bill and a kitchen ticket. That works in a pub
/// where the till is three feet from the pass. It does not work in the venue
/// that asked for this, where the kitchen is the room watching and the till is
/// behind a bar somebody has to walk to — so an order could sit unaccepted
/// while the customer who sent it watched a tracker that said nothing had
/// happened.
///
/// So the kitchen can accept one too. Deliberately the SAME server route the
/// till uses (`/api/kitchen/dinein/orders/:id/:action`, the same handler as
/// `/till/dinein/orders/...`), which is what makes the two rooms agree: the
/// allowed transitions, the ETA stamped on acceptance, and the refusal when
/// another screen got there first are one piece of code, not two.
///
/// WHAT ACCEPTING MEANS HERE, AND WHAT IT DOES NOT
///
/// Accepting from the kitchen moves the ORDER to `accepted` and tells the
/// customer. It does not create a bill on a till — a kitchen screen has no
/// sale, no drawer and no takings, and inventing one from here would be putting
/// money through a machine nobody is standing at. The till's own Accept still
/// does that. In practice a venue picks one room to accept in; both are
/// offered because which room that is differs by venue, and the server refuses
/// the second acceptance either way.
library;

import 'package:flutter/foundation.dart';

/// One line of a customer's order.
@immutable
class DineInLine {
  const DineInLine({
    required this.id,
    required this.name,
    required this.qty,
    required this.unitPriceMinor,
    this.note,
    this.parentLineId,
    this.isModifier = false,
    this.unavailableAction = 'remove',
    this.allergens = const [],
    this.allergensDeclared = false,
  });

  final int id;
  final String name;
  final int qty;
  final int unitPriceMinor;

  /// What the customer typed about THIS dish — "no mayo" — rather than about
  /// the order. It is why the special-instructions box exists per line on the
  /// menu: a ticket cannot be split by a note that covers everything.
  final String? note;

  /// The line this one is an answer to, when it is an add-on.
  final int? parentLineId;
  final bool isModifier;

  /// What the customer asked to happen if this dish turns out to be off:
  /// `remove`, `call` or `refund`. Shown on the card so whoever is looking at
  /// it knows what to do without ringing anybody to ask.
  final String unavailableAction;

  /// Allergen codes, read from the catalogue when the order was fetched.
  final List<String> allergens;

  /// Whether anybody has answered the question at all. An unanswered dish and
  /// a dish that contains none of the fourteen both arrive as an empty list.
  final bool allergensDeclared;

  int get totalMinor => unitPriceMinor * qty;

  static DineInLine fromJson(Map<String, Object?> raw) => DineInLine(
    id: _int(raw['id']),
    name: _str(raw['name']),
    qty: _int(raw['qty'], 1),
    unitPriceMinor: _int(raw['unit_price_minor']),
    note: _nullableStr(raw['note']),
    parentLineId: raw['parent_line_id'] == null
        ? null
        : _int(raw['parent_line_id']),
    isModifier: raw['is_modifier'] == 1 || raw['is_modifier'] == true,
    unavailableAction: _str(raw['unavailable_action']).isEmpty
        ? 'remove'
        : _str(raw['unavailable_action']),
    allergens: [for (final a in (raw['allergens'] as List?) ?? const []) '$a'],
    allergensDeclared:
        raw['allergens_declared'] == true || raw['allergens_declared'] == 1,
  );
}

/// One order, as the kitchen sees it.
@immutable
class DineInOrder {
  const DineInOrder({
    required this.id,
    required this.publicId,
    required this.tableLabel,
    required this.status,
    required this.totalMinor,
    required this.placedAt,
    required this.lines,
    this.customerName,
    this.note,
  });

  final int id;
  final String publicId;

  /// What the table was called when the order was placed. A string, because a
  /// venue may call its tables "Booth 3" or "The snug".
  final String tableLabel;

  /// placed | accepted | ready | served | rejected | cancelled.
  final String status;

  final int totalMinor;
  final DateTime placedAt;
  final List<DineInLine> lines;

  final String? customerName;

  /// Anything the customer said about the whole order.
  final String? note;

  /// Waiting for somebody to press Accept.
  bool get isWaiting => status == 'placed';

  /// The dishes, without the add-ons that hang off them. What "3 items" means
  /// to somebody who has to cook it.
  Iterable<DineInLine> get dishes => lines.where((l) => !l.isModifier);

  int get itemCount => dishes.fold(0, (sum, line) => sum + line.qty);

  /// The add-ons chosen for [line], in the order they were sent.
  List<DineInLine> addOnsFor(DineInLine line) =>
      lines.where((l) => l.parentLineId == line.id).toList();

  /// Every allergen anywhere on this order, so a card can warn before it is
  /// opened. Sorted, so two identical orders read identically.
  List<String> get allAllergens {
    final seen = <String>{for (final l in lines) ...l.allergens};
    final out = seen.toList()..sort();
    return out;
  }

  static DineInOrder? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = raw.cast<String, Object?>();
    final id = _int(map['id']);
    if (id == 0) return null;

    return DineInOrder(
      id: id,
      publicId: _str(map['public_id']),
      tableLabel: _str(map['table_label']).isEmpty
          ? _str(map['table_number'])
          : _str(map['table_label']),
      status: _str(map['status']),
      totalMinor: _int(map['total_minor']),
      placedAt: _time(map['placed_at']) ?? DateTime.now(),
      customerName: _nullableStr(map['customer_name']),
      note: _nullableStr(map['note']),
      lines: [
        for (final l in (map['lines'] as List?) ?? const [])
          if (l is Map) DineInLine.fromJson(l.cast<String, Object?>()),
      ],
    );
  }
}

int _int(Object? v, [int fallback = 0]) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  return int.tryParse('$v') ?? fallback;
}

String _str(Object? v) => v == null ? '' : '$v';

String? _nullableStr(Object? v) {
  final s = _str(v).trim();
  return s.isEmpty ? null : s;
}

DateTime? _time(Object? v) {
  if (v == null) return null;
  return DateTime.tryParse('$v')?.toLocal();
}
