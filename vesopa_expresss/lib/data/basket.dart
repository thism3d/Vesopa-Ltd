/// What the customer has chosen, before it is an order.
///
/// The prices here are for SHOWING. The server prices the basket again from
/// the catalogue when the order is placed and charges what it works out, never
/// what the kiosk says -- see priceBasket in vesopa_server/src/menu_core.js. The
/// two agree because both read the same catalogue; if a manager changes a price
/// while a basket is open, the customer sees the new total on the payment
/// screen before the card machine asks for it.
library;

import 'package:flutter/foundation.dart';

import 'models.dart';

@immutable
class BasketLine {
  const BasketLine({required this.item, this.addOns = const [], this.qty = 1});

  final MenuItem item;
  final List<AddOnOption> addOns;
  final int qty;

  /// Two burgers with the same extras are one line of two; with different
  /// extras they are two lines. The server merges on exactly this key, and a
  /// basket that sent the same key twice would have the second overwrite the
  /// first -- so it never does.
  String get key {
    final plus = addOns.map((a) => a.pluId).toList()..sort();
    return '${item.id}|${plus.join('+')}';
  }

  int get unitMinor => item.priceMinor + addOns.fold(0, (s, a) => s + a.priceMinor);

  int get totalMinor => unitMinor * qty;

  BasketLine withQty(int qty) => BasketLine(item: item, addOns: addOns, qty: qty);

  Map<String, Object> toRequest() => {
    'item_id': item.id,
    'qty': qty,
    'add_ons': [for (final a in addOns) a.pluId],
  };
}

@immutable
class Basket {
  const Basket([this.lines = const []]);

  final List<BasketLine> lines;

  /// A kitchen does not want a line of 400 chips from a child left alone with a
  /// kiosk. The server caps a line at 99 too.
  static const maxQty = 20;

  bool get isEmpty => lines.isEmpty;

  int get count => lines.fold(0, (s, l) => s + l.qty);

  int get totalMinor => lines.fold(0, (s, l) => s + l.totalMinor);

  bool containsItem(int itemId) => lines.any((l) => l.item.id == itemId);

  int qtyOf(int itemId) =>
      lines.where((l) => l.item.id == itemId).fold(0, (s, l) => s + l.qty);

  Basket add(BasketLine line) {
    final i = lines.indexWhere((l) => l.key == line.key);
    if (i < 0) return Basket([...lines, line.withQty(line.qty.clamp(1, maxQty))]);
    final merged = (lines[i].qty + line.qty).clamp(1, maxQty);
    return Basket([...lines]..[i] = lines[i].withQty(merged));
  }

  /// Zero takes the line away.
  Basket setQty(String key, int qty) {
    if (qty <= 0) return Basket(lines.where((l) => l.key != key).toList());
    return Basket([
      for (final l in lines) l.key == key ? l.withQty(qty.clamp(1, maxQty)) : l,
    ]);
  }

  List<Map<String, Object>> toRequest() => [for (final l in lines) l.toRequest()];
}

/// Pence as pounds, the way a menu writes them.
String money(int minor) {
  final negative = minor < 0;
  final abs = minor.abs();
  final pounds = abs ~/ 100;
  final pence = (abs % 100).toString().padLeft(2, '0');
  return '${negative ? '-' : ''}£$pounds.$pence';
}
