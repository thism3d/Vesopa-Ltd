/// Loyalty schemes: a venue's groups of customers, each with its own rewards.
///
/// "We need the ability to create and manage different Loyalty Schemes. When
/// creating a new customer on the till, it should ask which Loyalty Scheme the
/// customer wants to be part of." VIP, Member, Players VIP, Committee: each is
/// either a group with no rewards or a discount (a percentage, a fixed amount
/// or a price level), limited to some departments, days and hours, and each may
/// earn points on some departments only.
///
/// The back office owns them (`src/loyalty_schemes.js`). The till reads the
/// list to ask the question, and copies the member's scheme onto the bill when
/// they are put on it, so the discount still applies to a bill parked at seven
/// and picked up at nine on a line that has since gone down -- the same reason
/// the name and the phone number are copied. See `Orders.customerScheme`.
library;

import 'dart:convert';

import 'package:flutter/painting.dart' show Color;

class LoyaltyScheme {
  const LoyaltyScheme({
    required this.id,
    required this.name,
    this.colour = '#a5c715',
    this.rewardType = 'none',
    this.discountValue = 0,
    this.priceLevel,
    this.discountDepartments = const [],
    this.startTime = '00:00',
    this.endTime = '23:59',
    this.daysOfWeek = '1111111',
    this.minPointsForDiscount = 0,
    this.earnPoints = false,
    this.earnDepartments = const [],
    this.welcomePoints = 0,
    this.cardPrefix = '',
    this.isDefault = false,
    this.offerAtTill = true,
    this.summary = '',
  });

  final int id;
  final String name;
  final String colour;

  /// 'none' | 'percent' | 'amount' | 'price_level'.
  final String rewardType;

  /// Whole percent for 'percent', pence for 'amount'.
  final int discountValue;

  /// 2 to 6 for 'price_level'.
  final int? priceLevel;

  /// Department names the discount covers. Empty is every department.
  final List<String> discountDepartments;
  final String startTime;
  final String endTime;

  /// Monday first, '1' for on -- as promotions store it.
  final String daysOfWeek;
  final int minPointsForDiscount;
  final bool earnPoints;

  /// Department names that earn points. Empty is every department.
  final List<String> earnDepartments;
  final int welcomePoints;
  final String cardPrefix;
  final bool isDefault;
  final bool offerAtTill;

  /// The scheme in a sentence, as the back office words it.
  final String summary;

  bool get hasDiscount =>
      (rewardType == 'percent' || rewardType == 'amount') && discountValue > 0;

  bool get setsPriceLevel =>
      rewardType == 'price_level' && (priceLevel ?? 0) >= 2;

  Color get color {
    final hex = colour.replaceFirst('#', '');
    final v = int.tryParse(hex.length == 6 ? 'ff$hex' : hex, radix: 16);
    return Color(v ?? 0xffa5c715);
  }

  /// The reward, short enough for a chip: "10% off Drinks", "Price 2".
  String get rewardLabel {
    final where = discountDepartments.isEmpty
        ? ''
        : ' ${discountDepartments.length <= 2 ? discountDepartments.join(' and ') : '${discountDepartments.length} departments'}';
    return switch (rewardType) {
      'percent' => '$discountValue% off$where',
      'amount' => '£${(discountValue / 100).toStringAsFixed(2)} off$where',
      'price_level' => 'Price ${priceLevel ?? 2}',
      _ => earnPoints ? 'Points' : 'No rewards',
    };
  }

  /// Whether the discount (or price level) is on at [now], by the till's clock.
  ///
  /// A window that ends before it starts runs past midnight: 18:00 to 02:00 is
  /// Friday evening and the small hours of Saturday, and the small hours belong
  /// to the day the evening started on.
  bool activeAt(DateTime now) {
    if (rewardType == 'none') return false;
    final start = _minutes(startTime, 0);
    final end = _minutes(endTime, 23 * 60 + 59);
    final minute = now.hour * 60 + now.minute;
    final today = (now.weekday - 1) % 7;
    bool dayOn(int d) => d < daysOfWeek.length && daysOfWeek[d] == '1';
    if (start <= end) return dayOn(today) && minute >= start && minute <= end;
    if (minute >= start) return dayOn(today);
    if (minute <= end) return dayOn((today + 6) % 7);
    return false;
  }

  static int _minutes(String hhmm, int fallback) {
    final parts = hhmm.split(':');
    if (parts.length != 2) return fallback;
    final h = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    if (h == null || m == null) return fallback;
    return h * 60 + m;
  }

  bool _covers(List<String> list, String? department) {
    if (list.isEmpty) return true;
    if (department == null) return false;
    final d = department.trim().toLowerCase();
    return list.any((x) => x.trim().toLowerCase() == d);
  }

  bool discountCovers(String? department) =>
      _covers(discountDepartments, department);

  bool earnsOn(String? department) => _covers(earnDepartments, department);

  /// What this scheme takes off [lines] at [now].
  ///
  /// Each line is its PLU and its shelf value; [departments] says which
  /// department each PLU is in. A member below [minPointsForDiscount] gets
  /// nothing yet. A fixed amount never comes to more than what it covers.
  int discountOn(
    Iterable<({int pluId, int grossMinor})> lines, {
    required Map<int, String?> departments,
    required DateTime now,
    int? points,
  }) {
    if (!hasDiscount || !activeAt(now)) return 0;
    if (minPointsForDiscount > 0 && (points ?? 0) < minPointsForDiscount) {
      return 0;
    }
    var eligible = 0;
    for (final l in lines) {
      if (discountCovers(departments[l.pluId])) eligible += l.grossMinor;
    }
    if (eligible <= 0) return 0;
    return switch (rewardType) {
      'percent' => (eligible * discountValue / 100).round(),
      'amount' => discountValue < eligible ? discountValue : eligible,
      _ => 0,
    };
  }

  static List<String> _list(Object? raw) {
    if (raw is List) return raw.map((e) => '$e').where((e) => e.isNotEmpty).toList();
    if (raw is String && raw.trim().startsWith('[')) {
      try {
        return _list(jsonDecode(raw));
      } catch (_) {
        return const [];
      }
    }
    return const [];
  }

  static bool _flag(Object? v, {bool fallback = false}) => switch (v) {
        null => fallback,
        final bool b => b,
        final num n => n != 0,
        final String s => s == '1' || s == 'true',
        _ => fallback,
      };

  static LoyaltyScheme? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final j = raw.cast<String, dynamic>();
    final id = (j['id'] as num?)?.toInt();
    if (id == null) return null;
    return LoyaltyScheme(
      id: id,
      name: j['name'] as String? ?? '',
      colour: j['colour'] as String? ?? '#a5c715',
      rewardType: j['reward_type'] as String? ?? 'none',
      discountValue: (j['discount_value'] as num?)?.toInt() ?? 0,
      priceLevel: (j['price_level'] as num?)?.toInt(),
      discountDepartments: _list(j['discount_departments']),
      startTime: j['start_time'] as String? ?? '00:00',
      endTime: j['end_time'] as String? ?? '23:59',
      daysOfWeek: j['days_of_week'] as String? ?? '1111111',
      minPointsForDiscount:
          (j['min_points_for_discount'] as num?)?.toInt() ?? 0,
      earnPoints: _flag(j['earn_points']),
      earnDepartments: _list(j['earn_departments']),
      welcomePoints: (j['welcome_points'] as num?)?.toInt() ?? 0,
      cardPrefix: j['card_prefix'] as String? ?? '',
      isDefault: _flag(j['is_default']),
      offerAtTill: _flag(j['offer_at_till'], fallback: true),
      summary: j['summary'] as String? ?? '',
    );
  }

  /// The copy that travels on a bill. Only what pricing and the check read.
  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'colour': colour,
        'reward_type': rewardType,
        'discount_value': discountValue,
        'price_level': priceLevel,
        'discount_departments': discountDepartments,
        'start_time': startTime,
        'end_time': endTime,
        'days_of_week': daysOfWeek,
        'min_points_for_discount': minPointsForDiscount,
        'earn_points': earnPoints ? 1 : 0,
        'earn_departments': earnDepartments,
      };

  /// The scheme copied onto a bill, or null for none or a copy that will not
  /// read -- which prices the bill as if no scheme were on it, never refuses it.
  static LoyaltyScheme? decode(String? stored) {
    if (stored == null || stored.isEmpty) return null;
    try {
      return fromJson(jsonDecode(stored));
    } catch (_) {
      return null;
    }
  }

  String encode() => jsonEncode(toJson());
}

/// The spend that earns points under [scheme], out of [netGoodsMinor].
///
/// The net is shared out across the lines by their shelf value, so a discount
/// is borne by every line in proportion rather than all by the ones that earn.
/// Null when the scheme earns on everything, which the server reads as "the
/// whole spend" -- what every till sent before schemes existed.
int? eligibleSpendMinor(
  LoyaltyScheme? scheme,
  Iterable<({int pluId, int grossMinor})> lines, {
  required Map<int, String?> departments,
  required int netGoodsMinor,
}) {
  if (scheme == null || scheme.earnDepartments.isEmpty) return null;
  var gross = 0;
  var earning = 0;
  for (final l in lines) {
    gross += l.grossMinor;
    if (scheme.earnsOn(departments[l.pluId])) earning += l.grossMinor;
  }
  if (gross <= 0 || earning <= 0) return 0;
  return (netGoodsMinor * earning / gross).round().clamp(0, netGoodsMinor);
}
