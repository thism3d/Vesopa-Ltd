import 'dart:convert';

import 'package:http/http.dart' as http;

/// A `DATE` from the back office, as a plain calendar day on this terminal.
///
/// `DateTime.parse('2027-08-31')` gives midnight in the LOCAL zone, which is
/// what is wanted -- but the server also sends full timestamps in some shapes,
/// and `DateTime.parse` on one of those ending in `Z` gives a UTC moment that
/// is the previous evening in British summer time. Comparing that against
/// today expires a member a day early, only between March and October, which
/// is the worst way for a date bug to behave: it works all winter.
///
/// So only the day is read, and it is rebuilt as local midnight.
DateTime? parseMembershipDay(Object? raw) {
  if (raw == null) return null;
  final text = raw.toString().trim();
  if (text.isEmpty) return null;
  final day = DateTime.tryParse(text.substring(0, text.length.clamp(0, 10)));
  if (day == null) return null;
  return DateTime(day.year, day.month, day.day);
}

/// A customer as seen by the till.
class TillCustomer {
  const TillCustomer({
    required this.id,
    required this.name,
    this.phone,
    this.email,
    this.cardNumber,
    this.discountType = 'none',
    this.discountValue = 0,
    this.pointsBalance = 0,
    this.membershipExpiry,
    this.photoUrl,
  });

  final String id;
  final String name;
  final String? phone;
  final String? email;
  final String? cardNumber;
  final String discountType;
  final int discountValue;

  /// What they have saved up, for the screen facing them.
  final int pointsBalance;

  /// The last day this member's card works, or null for somebody who is not on
  /// a membership scheme at all -- an ordinary points customer, who never
  /// expires.
  ///
  /// THIS IS WHY THE CUSTOMER KEY USED TO LET AN EXPIRED CARD THROUGH. The
  /// server has held this column for as long as memberships have existed and
  /// `/till/customers` did not send it, so the picker had no way to know. A
  /// clerk who swiped the card was stopped and a clerk who picked the same
  /// person off the list was not, which is exactly what the venue reported.
  final DateTime? membershipExpiry;

  /// A photograph of the member, as a path under the back office.
  ///
  /// Same story: `MemberFace` has drawn one since 1.6.8.0 and falls back to
  /// initials when there is none -- which is what every row looked like, because
  /// the column was not being sent.
  final String? photoUrl;

  /// Whether the card has run out, as of this terminal's own clock.
  ///
  /// THE EXPIRY DAY ITSELF COUNTS. A card that says 31 March works all of the
  /// 31st. A member told at the counter that their card ran out today, on the
  /// day it says, is an argument no clerk should have to have.
  ///
  /// Compared as calendar days rather than as moments, which is the other half
  /// of getting this right: the server sends a DATE, and anything that parses
  /// it into a UTC midnight and compares against `DateTime.now()` decides a
  /// British member expired the evening before, every summer.
  ///
  /// A customer with no expiry is never expired. Points customers and members
  /// share this table, and null means "not on a membership" rather than
  /// "expired at the beginning of time".
  bool get membershipExpired {
    final expiry = membershipExpiry;
    if (expiry == null) return false;
    final now = DateTime.now();
    return expiry.isBefore(DateTime(now.year, now.month, now.day));
  }

  bool get hasDiscount => discountType != 'none' && discountValue > 0;

  String get discountLabel => switch (discountType) {
        'percent' => '$discountValue% off',
        'amount' => '£${(discountValue / 100).toStringAsFixed(2)} off',
        _ => '',
      };

  factory TillCustomer.fromJson(Map<String, dynamic> j) => TillCustomer(
        id: j['id'] as String,
        name: j['name'] as String? ?? '',
        phone: j['phone'] as String?,
        email: j['email'] as String?,
        cardNumber: j['card_number'] as String?,
        discountType: j['discount_type'] as String? ?? 'none',
        discountValue: j['discount_value'] as int? ?? 0,
        pointsBalance: (j['points_balance'] as num?)?.toInt() ?? 0,
        // Absent on a server that has not been updated, which reads as "no
        // membership" -- the state the till was in before this shipped. A till
        // ahead of its server carries on exactly as it did rather than
        // refusing every customer it cannot check.
        membershipExpiry: parseMembershipDay(j['membership_expiry']),
        photoUrl: j['photo_url'] as String?,
      );
}

/// Customer lookup and creation from the till. Server-backed and scoped to the
/// venue — customers belong to the business, not to one terminal.
class CustomerRepository {
  CustomerRepository({required this.apiBase, required this.office});

  final String apiBase;
  final String office;

  Future<List<TillCustomer>> search(String query) async {
    final params = [
      'office=${Uri.encodeComponent(office)}',
      if (query.trim().isNotEmpty) 'q=${Uri.encodeComponent(query.trim())}',
    ].join('&');

    final res = await http
        .get(Uri.parse('$apiBase/till/customers?$params'))
        .timeout(const Duration(seconds: 10));
    if (res.statusCode != 200) {
      throw Exception('Customer search failed (${res.statusCode}).');
    }
    return (jsonDecode(res.body) as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .map(TillCustomer.fromJson)
        .toList();
  }

  /// Add a customer. Returns the new id.
  Future<String> create({
    required String name,
    String? phone,
    String? email,
    String discountType = 'none',
    int discountValue = 0,
  }) async {
    final res = await http
        .post(
          Uri.parse('$apiBase/till/customers'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({
            'office': office,
            'name': name,
            'phone': phone,
            'email': email,
            'discount_type': discountType,
            'discount_value': discountValue,
          }),
        )
        .timeout(const Duration(seconds: 10));
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw Exception('Could not add the customer (${res.statusCode}).');
    }
    return (jsonDecode(res.body) as Map<String, dynamic>)['id'] as String;
  }
}
