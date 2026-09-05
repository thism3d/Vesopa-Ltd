/// What the person signed on to this till may do.
///
/// WHY THE TILL DECIDES, AND NOT THE SERVER
///
/// A manager approving a void at eight on a Friday cannot wait for the
/// broadband, and a till that could only check a permission online would refuse
/// every one of them the moment the line dropped — which is the worst possible
/// time for it to start saying no. So the group's switches travel down with the
/// staff list, are cached beside the PIN, and every check is a local read.
///
/// It is the same argument the PIN itself is cached under, and it has the same
/// answer to the same objection: a terminal that is already trusted with the
/// venue's catalogue and its takings is not made less safe by also knowing who
/// may press Refund.
///
/// AN EMPTY GROUP MEANS EVERY KEY
///
/// Not "no keys". Every member of staff at every venue trading today has no
/// permission group, because groups did not exist until now — so a missing
/// group has to mean what it has always meant, or the feature ships by taking
/// the refund key off the entire country overnight. See src/permissions.js in
/// the back office, which makes the same promise from the other end.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';

/// The eleven keys a venue can withhold.
///
/// Matches `TILL_PERMISSIONS` in the back office exactly, in the same order and
/// under the same names, because the two are the same list and the wire format
/// between them is these names.
enum TillPermission {
  isManager('is_manager', 'a manager'),
  refund('can_refund', 'refund'),
  voidLine('can_void', 'void'),
  discount('can_discount', 'discount'),
  noSale('can_no_sale', 'open the drawer'),
  setPrice('can_set_price', 'change a price'),
  xReport('can_x_report', 'read an X report'),
  zReport('can_z_report', 'run a Z report'),
  unlockTables('can_unlock_tables', 'take over a table'),
  expense('can_expense', 'record an expense'),
  wastage('can_wastage', 'record wastage');

  const TillPermission(this.key, this.verb);

  /// The column name the back office stores it under, and the field name it
  /// arrives in.
  final String key;

  /// How the refusal reads: "Alex is not allowed to `verb`."
  final String verb;

  static TillPermission? byKey(String key) {
    for (final p in TillPermission.values) {
      if (p.key == key) return p;
    }
    return null;
  }
}

/// One member of staff's keys, as the till holds them.
@immutable
class TillPermissions {
  const TillPermissions._(this._granted, this.restricted);

  /// Somebody in no group. Every key, exactly as before groups existed.
  static const unrestricted = TillPermissions._(<TillPermission>{}, false);

  final Set<TillPermission> _granted;

  /// False for somebody in no group, where [_granted] is not consulted at all.
  final bool restricted;

  bool can(TillPermission permission) =>
      !restricted || _granted.contains(permission);

  /// Read what the back office sent with the staff list.
  ///
  /// An empty or unreadable value is [unrestricted], deliberately. A till that
  /// failed to parse a permissions blob must not respond by refusing to let
  /// anybody do anything — the failure would present as the whole venue losing
  /// its keys at once, mid-service, for a reason nobody at the counter can see.
  static TillPermissions parse(String? stored) {
    if (stored == null || stored.trim().isEmpty) return unrestricted;
    try {
      final raw = jsonDecode(stored);
      if (raw is! Map) return unrestricted;

      final granted = <TillPermission>{};
      for (final entry in raw.entries) {
        final permission = TillPermission.byKey('${entry.key}');
        if (permission != null && entry.value == true) granted.add(permission);
      }
      return TillPermissions._(granted, true);
    } catch (_) {
      return unrestricted;
    }
  }

  /// What to store from `/till/staff`.
  ///
  /// Returns empty for a clerk with no group, so the column's emptiness and
  /// "unrestricted" stay the same fact rather than two that could disagree.
  static String encode(Object? permissions, {required bool grouped}) {
    if (!grouped || permissions is! Map) return '';
    final out = <String, bool>{};
    for (final p in TillPermission.values) {
      out[p.key] = permissions[p.key] == true;
    }
    return jsonEncode(out);
  }

  @override
  bool operator ==(Object other) =>
      other is TillPermissions &&
      other.restricted == restricted &&
      setEquals(other._granted, _granted);

  @override
  int get hashCode => Object.hash(restricted, Object.hashAllUnordered(_granted));

  @override
  String toString() => restricted
      ? 'TillPermissions(${_granted.map((p) => p.key).join(', ')})'
      : 'TillPermissions(unrestricted)';
}
