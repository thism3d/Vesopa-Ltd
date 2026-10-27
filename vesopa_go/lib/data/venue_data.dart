/// The venue's own menu and floor, read from the back office in the shapes
/// the tills read them, so a price changed in the back office is the same
/// price on a till and on a phone.
///
///   GET /till/products?office=   every product (price in pounds, allergens
///                                as a comma list, printer routes = stations)
///   GET /api/till/modifiers?office=  groups (min/max, a screen of choices) and
///                                which products ask which groups
///   GET /api/till/screens?office=    the screens those choices sit on
///   GET /till/floor?office=      rooms and their tables
library;

import 'dart:convert';

import 'models.dart';

const _palette = [0xFF2F80ED, 0xFFF2994A, 0xFFA5C715, 0xFFBB6BD9, 0xFF2BB673, 0xFFE5484D, 0xFF56CCF2, 0xFFF5B301];

/// "1.5", 1.5 or null as pence. mysql2 sends DECIMAL as a string.
int pence(Object? pounds) {
  final v = pounds is num ? pounds.toDouble() : double.tryParse('${pounds ?? ''}') ?? 0;
  return (v * 100).round();
}

double _num(Object? v) => v is num ? v.toDouble() : double.tryParse('${v ?? ''}') ?? 0;

/// A course from the department or group name: what Send and Fire act on.
int courseOf(String department, String group) {
  final s = '$department $group'.toLowerCase();
  if (RegExp(r'starter|appeti|small plate|soup').hasMatch(s)) return 1;
  if (RegExp(r'dessert|pudding|sweet').hasMatch(s)) return 3;
  if (RegExp(r'main|grill|burger|pizza|food|kitchen|sunday|roast|pasta|fish').hasMatch(s)) return 2;
  return 0;
}

class VenueMenu {
  const VenueMenu({required this.categories, required this.products});
  final List<MenuCategory> categories;
  final List<Product> products;
}

/// Products, modifiers and screens as Tap's menu. Modifier products (the
/// answers, not the dishes) are not shown as dishes.
VenueMenu menuFrom({required List<dynamic> products, Map<String, dynamic>? modifiers, List<dynamic>? screens}) {
  final byPlu = <int, Map<String, dynamic>>{};
  for (final p in products) {
    final m = p as Map<String, dynamic>;
    final plu = (m['pluid'] as num?)?.toInt();
    if (plu != null) byPlu[plu] = m;
  }

  // Each modifier group's choices are the product buttons on its screen.
  final choicesByScreen = <String, List<Choice>>{};
  for (final s in screens ?? const []) {
    final screen = s as Map<String, dynamic>;
    final list = <Choice>[];
    for (final b in (screen['buttons'] as List? ?? const [])) {
      final button = b as Map<String, dynamic>;
      final plu = (button['pluId'] as num?)?.toInt();
      if (plu == null) continue;
      final prod = byPlu[plu];
      final label = '${button['label'] ?? prod?['product_name'] ?? ''}'.trim();
      if (label.isEmpty) continue;
      list.add(Choice(label, prod == null ? 0 : pence(prod['price']), plu));
    }
    choicesByScreen['${screen['id']}'] = list;
  }
  final groups = <String, OptionGroup>{};
  for (final g in (modifiers?['groups'] as List? ?? const [])) {
    final group = g as Map<String, dynamic>;
    final choices = choicesByScreen['${group['screen_id']}'] ?? const <Choice>[];
    if (choices.isEmpty) continue;
    groups['${group['id']}'] = OptionGroup(
      name: '${group['name'] ?? 'Choose'}',
      choices: choices,
      required: ((group['min_select'] as num?) ?? 0) > 0,
    );
  }
  final groupsByPlu = (modifiers?['products'] as Map<String, dynamic>?) ?? const {};

  final categories = <String, MenuCategory>{};
  final out = <Product>[];
  for (final m in byPlu.values) {
    final modifierOnly = m['is_modifier'] == 1 || m['is_modifier'] == true;
    if (modifierOnly) continue;
    final dept = '${m['department_name'] ?? m['group_name'] ?? 'Menu'}'.trim();
    final group = '${m['group_name'] ?? ''}'.trim();
    final catId = dept.isEmpty ? 'menu' : dept.toLowerCase();
    categories.putIfAbsent(catId, () => MenuCategory(id: catId, name: dept.isEmpty ? 'Menu' : dept, colour: _palette[categories.length % _palette.length]));
    final plu = (m['pluid'] as num).toInt();
    final allergens = allergensOf(m['allergens']);
    final routes = '${m['printer_routes'] ?? m['printer_route'] ?? ''}'.split(',').map((s) => s.trim().toLowerCase())
        .where((s) => RegExp(r'^kp[1-6]$').hasMatch(s)).toList();
    out.add(Product(
      id: 'plu$plu',
      plu: plu,
      name: '${m['product_name'] ?? 'Item'}',
      priceMinor: pence(m['price']),
      category: catId,
      allergens: allergens,
      taxPercent: _num(m['tax_percentage']),
      stations: routes,
      imageUrl: '${m['image_url'] ?? ''}'.trim(),
      course: courseOf(dept, group),
      outOfStock: m['available'] == false || m['available'] == 0,
      options: [
        for (final gid in (groupsByPlu['$plu'] as List? ?? const []))
          if (groups['$gid'] != null) groups['$gid']!,
      ],
    ));
  }
  return VenueMenu(categories: categories.values.toList(), products: out);
}

/// Rooms and tables from the floor designer.
List<TableInfo> tablesFrom(List<dynamic> rooms) => [
      for (final r in rooms)
        for (final t in ((r as Map<String, dynamic>)['tables'] as List? ?? const []))
          TableInfo(
            id: 'table-${(t as Map<String, dynamic>)['id']}',
            name: '${t['label'] ?? ''}'.trim().isNotEmpty ? '${t['label']}' : 'Table ${t['table_number']}',
            area: '${r['name'] ?? 'Floor'}',
            seats: (t['seats'] as num?)?.toInt() ?? 4,
            number: (t['table_number'] as num?)?.toInt(),
            roomId: (r['id'] as num?)?.toInt(),
            x: (t['pos_x'] as num?)?.toInt() ?? 0,
            y: (t['pos_y'] as num?)?.toInt() ?? 0,
            width: ((t['width'] as num?)?.toInt() ?? 2).clamp(1, 40),
            height: ((t['height'] as num?)?.toInt() ?? 2).clamp(1, 40),
            round: t['shape'] == 'circle',
            colour: t['colour'] as String?,
          ),
    ];

/// A product's allergens as names. The back office stores them as a JSON list
/// (`["celery","milk"]`); older rows hold a comma list. Either reads as
/// `Celery`, `Milk`, never the brackets and quotes.
List<String> allergensOf(Object? raw) {
  Iterable<Object?> items;
  if (raw is List) {
    items = raw;
  } else {
    final text = '${raw ?? ''}'.trim();
    if (text.isEmpty) return const [];
    try {
      final parsed = jsonDecode(text);
      items = parsed is List ? parsed : [parsed];
    } catch (_) {
      items = text.split(',');
    }
  }
  final out = <String>[];
  for (final item in items) {
    final name = '${item ?? ''}'.replaceAll(RegExp(r'["\[\]]'), '').trim();
    if (name.isEmpty) continue;
    final nice = name[0].toUpperCase() + name.substring(1);
    if (!out.contains(nice)) out.add(nice);
  }
  return out;
}
