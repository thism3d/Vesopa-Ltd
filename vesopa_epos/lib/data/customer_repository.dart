import 'dart:convert';

import 'package:http/http.dart' as http;

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
  });

  final String id;
  final String name;
  final String? phone;
  final String? email;
  final String? cardNumber;
  final String discountType;
  final int discountValue;

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
