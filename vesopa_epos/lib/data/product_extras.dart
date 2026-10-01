/// What the product form's newer steps say about a product (2026-10-01).
///
/// The back office's product form became Newbridge-style steps with an
/// Allergens step and an Information step, and the till's product wizard
/// shows the same. Those fields reach the till in the catalogue
/// (`GET /till/products`) and are kept as one JSON column on the product
/// (`Products.extras`), because the till only reads them in two places: the
/// product wizard, and the weight prompt for a product sold by weight.
library;

import 'dart:convert';

/// The fourteen allergens, in the FSA's order. The labels come from the
/// server (`allergenLabelsProvider`); this is the fallback for a till that
/// has never been online, and mirrors `src/allergens.js`.
const allergenFallback = <String, String>{
  'celery': 'Celery',
  'gluten': 'Cereals containing gluten',
  'crustaceans': 'Crustaceans',
  'eggs': 'Eggs',
  'fish': 'Fish',
  'lupin': 'Lupin',
  'milk': 'Milk',
  'molluscs': 'Molluscs',
  'mustard': 'Mustard',
  'peanuts': 'Peanuts',
  'sesame': 'Sesame',
  'soya': 'Soya',
  'sulphites': 'Sulphur dioxide and sulphites',
  'tree_nuts': 'Tree nuts',
};

/// Diet labels. Mirrors DIETARY in `src/product_info.js`.
const dietaryLabels = <String, String>{
  'vegetarian': 'Vegetarian',
  'vegan': 'Vegan',
  'gluten_free': 'Gluten free',
  'dairy_free': 'Dairy free',
  'halal': 'Halal',
};

class ProductExtras {
  const ProductExtras({
    this.shortDescription,
    this.description,
    this.calories,
    this.mayContain,
    this.dietary,
    this.isWeighted = false,
    this.manualWeight = false,
    this.supplierCode,
    this.minStock,
    this.maxStock,
  });

  final String? shortDescription;

  /// A little HTML, cleaned by the server.
  final String? description;
  final int? calories;

  /// Null is "nobody has said"; empty is "none".
  final List<String>? mayContain;
  final List<String>? dietary;
  final bool isWeighted;
  final bool manualWeight;
  final String? supplierCode;
  final double? minStock;
  final double? maxStock;

  static const none = ProductExtras();

  /// The keys the server sends, which are the keys stored.
  static const _keys = [
    'short_description', 'description', 'calories', 'may_contain', 'dietary',
    'is_weighted', 'manual_weight', 'supplier_code', 'min_stock', 'max_stock',
  ];

  /// What to store for one catalogue row: the fields it carries, as JSON, or
  /// null when it carries none of them (a server without the migration).
  static String? encodeFrom(Map<String, dynamic> raw) {
    final kept = <String, Object?>{
      for (final k in _keys)
        if (raw.containsKey(k) && raw[k] != null) k: raw[k],
    };
    return kept.isEmpty ? null : jsonEncode(kept);
  }

  static ProductExtras decode(String? stored) {
    if (stored == null || stored.isEmpty) return none;
    try {
      final m = jsonDecode(stored);
      if (m is! Map) return none;
      return ProductExtras(
        shortDescription: _s(m['short_description']),
        description: _s(m['description']),
        calories: switch (m['calories']) {
          final num n => n.round(),
          final String s => int.tryParse(s),
          _ => null,
        },
        mayContain: _codes(m['may_contain']),
        dietary: _codes(m['dietary']),
        isWeighted: _b(m['is_weighted']),
        manualWeight: _b(m['manual_weight']),
        supplierCode: _s(m['supplier_code']),
        minStock: _d(m['min_stock']),
        maxStock: _d(m['max_stock']),
      );
    } catch (_) {
      return none;
    }
  }

  static String? _s(Object? v) {
    final s = v?.toString().trim();
    return s == null || s.isEmpty ? null : s;
  }

  static bool _b(Object? v) => v == true || v == 1 || v == '1' || v == 'true';

  static double? _d(Object? v) => switch (v) {
        final num n => n.toDouble(),
        final String s => double.tryParse(s),
        _ => null,
      };

  /// Allergen or diet codes as the server stores them (a JSON array).
  static List<String>? decodeCodes(String? v) => _codes(v);

  /// A JSON array of codes, stored either as a string or as a list.
  static List<String>? _codes(Object? v) {
    Object? list = v;
    if (list is String) {
      try {
        list = jsonDecode(list);
      } catch (_) {
        return null;
      }
    }
    if (list is! List) return null;
    return [for (final c in list) '$c'];
  }

  /// The description as plain text, for a text box and a summary.
  static String plain(String? html) => (html ?? '')
      .replaceAll(RegExp(r'<(br|/p|/li|/h3|/h4)\s*/?>', caseSensitive: false), '\n')
      .replaceAll(RegExp(r'<[^>]*>'), '')
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&amp;', '&')
      .replaceAll(RegExp(r'\n{3,}'), '\n\n')
      .trim();

  /// Plain text typed on the till, as the paragraphs the server keeps.
  static String toHtml(String text) {
    String esc(String s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return text
        .trim()
        .split(RegExp(r'\n\s*\n'))
        .where((p) => p.trim().isNotEmpty)
        .map((p) => '<p>${esc(p.trim()).replaceAll('\n', '<br>')}</p>')
        .join();
  }
}
