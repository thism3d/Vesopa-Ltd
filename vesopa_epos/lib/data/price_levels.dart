/// Six prices per product, and which of them this till is charging.
///
/// "Each product should have 6 price levels. Price 1, Price 2 etc. This can be
/// used for a loyalty scheme or a setting on the till in functions to swap
/// price levels."
///
/// AN UNSET LEVEL FALLS BACK TO PRICE 1
///
/// Null at a level means "this product has no special price here", not "this
/// product is free. That distinction is money: a default of zero would mean a
/// venue switching the till to Price 2 started giving everything away, silently,
/// at the counter, on every product nobody had got round to filling in.
///
/// So a venue can put a happy-hour price on the six drinks it applies to and
/// leave the other four hundred products alone. That is the only way the
/// feature is usable on a real catalogue.
///
/// TWO WAYS THE LEVEL IS CHOSEN
///
/// The till has one, set from Functions and remembered across restarts — that
/// is the "swap price levels" half. A loyalty tier can name one too, and it
/// wins for that customer's bill only: a member on a trade tariff is charged
/// their tariff whatever the room is on. See [levelFor].
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';

/// The lowest and highest level a venue can have.
const int minPriceLevel = 1;
const int maxPriceLevel = 6;

/// Every level, for a picker.
const List<int> priceLevels = [1, 2, 3, 4, 5, 6];

/// A level, clamped to one that exists.
///
/// Anything out of range becomes 1 rather than being refused. A stored
/// preference from a build that offered more levels, or a tier configured
/// against a level a venue later removed, must not stop the till selling — and
/// Price 1 is the price every product certainly has.
int clampPriceLevel(Object? value) {
  final level = value is int ? value : int.tryParse('${value ?? ''}');
  if (level == null || level < minPriceLevel || level > maxPriceLevel) {
    return minPriceLevel;
  }
  return level;
}

/// What a venue calls each level.
///
/// "Price 2" tells a clerk nothing and "Happy Hour" tells them everything, so
/// the back office lets a venue name levels 2 to 6. Level 1 is always "Price 1":
/// a venue that renamed it would have a product form whose first field agreed
/// with nothing else in the system.
@immutable
class PriceLevelNames {
  const PriceLevelNames(this._names);

  static const empty = PriceLevelNames(<int, String>{});

  final Map<int, String> _names;

  String nameFor(int level) {
    final clamped = clampPriceLevel(level);
    if (clamped == 1) return 'Price 1';
    final named = _names[clamped];
    return named == null || named.isEmpty ? 'Price $clamped' : named;
  }

  /// Read what the back office stored: `{"2":"Happy Hour","3":"Staff"}`.
  ///
  /// Unreadable is empty rather than an error. A venue whose names could not be
  /// parsed gets "Price 2" on the key, which is the state it was in before it
  /// named anything — not a till that will not start.
  static PriceLevelNames parse(Object? raw) {
    if (raw == null) return empty;
    try {
      final decoded = raw is String ? jsonDecode(raw) : raw;
      if (decoded is! Map) return empty;

      final names = <int, String>{};
      for (final entry in decoded.entries) {
        final level = int.tryParse('${entry.key}');
        final name = '${entry.value}'.trim();
        if (level == null || level < 2 || level > maxPriceLevel) continue;
        if (name.isNotEmpty) names[level] = name;
      }
      return PriceLevelNames(names);
    } catch (_) {
      return empty;
    }
  }

  @override
  bool operator ==(Object other) =>
      other is PriceLevelNames && mapEquals(other._names, _names);

  @override
  int get hashCode => Object.hashAllUnordered(
    _names.entries.map((e) => Object.hash(e.key, e.value)),
  );
}

/// The six prices one product carries.
@immutable
class ProductPrices {
  const ProductPrices({
    required this.priceMinor,
    this.price2Minor,
    this.price3Minor,
    this.price4Minor,
    this.price5Minor,
    this.price6Minor,
  });

  /// Price 1. Always set — it is the price a venue has always had.
  final int priceMinor;

  /// Levels 2 to 6, or null where the venue has not set one.
  final int? price2Minor;
  final int? price3Minor;
  final int? price4Minor;
  final int? price5Minor;
  final int? price6Minor;

  /// What to charge at [level], falling back to Price 1.
  ///
  /// The fallback is the whole design. See the note at the top of the file:
  /// null is "no special price here", and treating it as zero would give the
  /// product away.
  int at(int level) {
    final wanted = switch (clampPriceLevel(level)) {
      2 => price2Minor,
      3 => price3Minor,
      4 => price4Minor,
      5 => price5Minor,
      6 => price6Minor,
      _ => priceMinor,
    };
    return wanted ?? priceMinor;
  }

  /// Which levels this product actually carries a price for, level 1 included.
  ///
  /// For the products screen, so a manager can see at a glance which items a
  /// happy hour will change and which will not.
  List<int> get levelsSet => [
    1,
    for (final level in const [2, 3, 4, 5, 6])
      if (at(level) != priceMinor || _explicit(level)) level,
  ];

  bool _explicit(int level) => switch (level) {
    2 => price2Minor != null,
    3 => price3Minor != null,
    4 => price4Minor != null,
    5 => price5Minor != null,
    6 => price6Minor != null,
    _ => true,
  };

  /// Read one level out of what `/till/products` sent.
  ///
  /// The back office stores prices in pounds; the till holds pence everywhere,
  /// so this is where the conversion happens. Absent stays absent — a server
  /// that predates price levels sends no field, and that must mean "not set"
  /// rather than "zero".
  static int? minorFrom(Map<String, dynamic> raw, String key) {
    final value = raw[key];
    if (value == null) return null;
    if (value is num) return (value * 100).round();
    final parsed = double.tryParse('$value');
    return parsed == null ? null : (parsed * 100).round();
  }

  @override
  bool operator ==(Object other) =>
      other is ProductPrices &&
      other.priceMinor == priceMinor &&
      other.price2Minor == price2Minor &&
      other.price3Minor == price3Minor &&
      other.price4Minor == price4Minor &&
      other.price5Minor == price5Minor &&
      other.price6Minor == price6Minor;

  @override
  int get hashCode => Object.hash(
    priceMinor,
    price2Minor,
    price3Minor,
    price4Minor,
    price5Minor,
    price6Minor,
  );
}

/// Which level to charge this bill at.
///
/// The customer's tier wins over the till's setting, and only over it — a
/// member on a trade tariff is charged their tariff whether the room is on
/// happy hour or not. A tier with no level named leaves the till's setting
/// alone, which is every tier at every venue until somebody sets one.
int levelFor({required int tillLevel, int? customerTierLevel}) {
  if (customerTierLevel == null) return clampPriceLevel(tillLevel);
  return clampPriceLevel(customerTierLevel);
}
