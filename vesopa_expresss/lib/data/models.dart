/// What the back office tells a kiosk, as Dart.
///
/// Parsed defensively throughout: a field missing or of the wrong type reads as
/// its safe default rather than throwing, because a kiosk that cannot parse its
/// menu is a kiosk with a blank screen in front of a queue.
library;

import 'dart:ui' show Color;

import 'package:flutter/foundation.dart';

import 'passcode.dart';

int _int(Object? v, [int fallback = 0]) =>
    v is num ? v.toInt() : int.tryParse('$v') ?? fallback;

String? _str(Object? v) {
  if (v == null) return null;
  final s = '$v'.trim();
  return s.isEmpty ? null : s;
}

bool _bool(Object? v) => v == true || v == 1 || v == '1' || v == 'true';

Map<String, dynamic> _map(Object? v) =>
    v is Map ? v.cast<String, dynamic>() : const <String, dynamic>{};

List<Object?> _list(Object? v) => v is List ? v : const [];

/// A `#RRGGBB` from the venue's settings, or [fallback].
Color parseHex(String? hex, Color fallback) {
  final h = (hex ?? '').replaceFirst('#', '');
  if (h.length != 6) return fallback;
  final n = int.tryParse(h, radix: 16);
  return n == null ? fallback : Color(0xFF000000 | n);
}

@immutable
class KioskConfig {
  const KioskConfig({
    required this.enabled,
    required this.kioskId,
    required this.kioskName,
    required this.hasCardMachine,
    required this.venueName,
    required this.accent,
    this.logoUrl,
    this.bannerUrl,
    this.exit,
    this.eatIn = true,
    this.takeAway = true,
    this.payCard = false,
    this.payCounter = false,
    this.demo = false,
    this.sandbox = false,
    this.askName = false,
    this.idleSeconds = 60,
    this.welcomeTitle,
    this.welcomeSubtitle,
    this.welcomeImage,
  });

  final bool enabled;
  final String kioskId;
  final String kioskName;
  final bool hasCardMachine;
  final String venueName;
  final String? logoUrl;
  final String? bannerUrl;
  final Color accent;
  final ExitCheck? exit;
  final bool eatIn;
  final bool takeAway;
  final bool payCard;
  final bool payCounter;
  final bool demo;
  final bool sandbox;
  final bool askName;
  final int idleSeconds;
  final String? welcomeTitle;
  final String? welcomeSubtitle;
  final String? welcomeImage;

  /// Whether this kiosk has any way at all to take an order right now.
  bool get canTakeOrders => enabled && (eatIn || takeAway) && (payCard || payCounter || demo);

  factory KioskConfig.fromJson(Map<String, dynamic> j) {
    final kiosk = _map(j['kiosk']);
    final venue = _map(j['venue']);
    final types = _map(j['order_types']);
    final pay = _map(j['payments']);
    final welcome = _map(j['welcome']);
    return KioskConfig(
      enabled: _bool(j['enabled']),
      kioskId: _str(kiosk['id']) ?? '',
      kioskName: _str(kiosk['name']) ?? 'Kiosk',
      hasCardMachine: _bool(kiosk['has_card_machine']),
      venueName: _str(venue['name']) ?? '',
      logoUrl: _str(venue['logo_url']),
      bannerUrl: _str(venue['banner_url']),
      accent: parseHex(_str(venue['accent']), const Color(0xFFA5C715)),
      exit: ExitCheck.fromJson(j['exit']),
      eatIn: types.isEmpty ? true : _bool(types['eat_in']),
      takeAway: types.isEmpty ? true : _bool(types['take_away']),
      payCard: _bool(pay['card']),
      payCounter: _bool(pay['counter']),
      demo: _bool(pay['demo']),
      sandbox: _bool(pay['sandbox']),
      askName: _bool(j['ask_name']),
      idleSeconds: _int(j['idle_seconds'], 60).clamp(20, 600),
      welcomeTitle: _str(welcome['title']),
      welcomeSubtitle: _str(welcome['subtitle']),
      welcomeImage: _str(welcome['image_url']),
    );
  }
}

@immutable
class AddOnOption {
  const AddOnOption({
    required this.pluId,
    required this.name,
    required this.priceMinor,
    this.allergens = const [],
  });

  final int pluId;
  final String name;
  final int priceMinor;
  final List<String> allergens;

  factory AddOnOption.fromJson(Map<String, dynamic> j) => AddOnOption(
    pluId: _int(j['plu_id']),
    name: _str(j['name']) ?? '',
    priceMinor: _int(j['price_minor']),
    allergens: [for (final a in _list(j['allergens'])) '$a'],
  );
}

@immutable
class AddOnGroup {
  const AddOnGroup({
    required this.id,
    required this.name,
    required this.min,
    required this.max,
    required this.options,
  });

  final int id;
  final String name;
  final int min;
  final int max;
  final List<AddOnOption> options;

  bool get single => max == 1;

  factory AddOnGroup.fromJson(Map<String, dynamic> j) {
    final options = [
      for (final o in _list(j['options'])) AddOnOption.fromJson(_map(o)),
    ];
    final max = _int(j['max_select'], 1).clamp(1, options.isEmpty ? 1 : options.length);
    return AddOnGroup(
      id: _int(j['id']),
      name: _str(j['name']) ?? '',
      min: _int(j['min_select']).clamp(0, max),
      max: max,
      options: options,
    );
  }
}

@immutable
class MenuItem {
  const MenuItem({
    required this.id,
    required this.pluId,
    required this.name,
    required this.priceMinor,
    this.description,
    this.imageUrl,
    this.available = true,
    this.popular = false,
    this.featured = false,
    this.diet,
    this.allergens = const [],
    this.allergensDeclared = false,
    this.addOns = const [],
  });

  final int id;
  final int pluId;
  final String name;
  final int priceMinor;
  final String? description;
  final String? imageUrl;
  final bool available;
  final bool popular;
  final bool featured;
  final String? diet;
  final List<String> allergens;
  final bool allergensDeclared;
  final List<AddOnGroup> addOns;

  factory MenuItem.fromJson(Map<String, dynamic> j) => MenuItem(
    id: _int(j['id']),
    pluId: _int(j['plu_id']),
    name: _str(j['name']) ?? '',
    priceMinor: _int(j['price_minor']),
    description: _str(j['description']),
    imageUrl: _str(j['image_url']),
    available: j['available'] == null ? true : _bool(j['available']),
    popular: _bool(j['popular']),
    featured: _bool(j['featured']),
    diet: _str(j['diet']),
    allergens: [for (final a in _list(j['allergens'])) '$a'],
    allergensDeclared: _bool(j['allergens_declared']),
    addOns: [
      for (final g in _list(j['add_ons'])) AddOnGroup.fromJson(_map(g)),
    ].where((g) => g.options.isNotEmpty).toList(),
  );
}

@immutable
class MenuSection {
  const MenuSection({
    required this.id,
    required this.name,
    required this.items,
    this.blurb,
    this.imageUrl,
  });

  final int id;
  final String name;
  final String? blurb;
  final String? imageUrl;
  final List<MenuItem> items;

  factory MenuSection.fromJson(Map<String, dynamic> j) => MenuSection(
    id: _int(j['id']),
    name: _str(j['name']) ?? '',
    blurb: _str(j['blurb']),
    imageUrl: _str(j['image_url']),
    items: [for (final i in _list(j['items'])) MenuItem.fromJson(_map(i))],
  );
}

@immutable
class KioskMenu {
  const KioskMenu({required this.sections, this.upsell = const []});

  final List<MenuSection> sections;
  final List<int> upsell;

  static const empty = KioskMenu(sections: []);

  bool get isEmpty => sections.every((s) => s.items.isEmpty);

  Iterable<MenuItem> get items => sections.expand((s) => s.items);

  List<MenuItem> get popular => items.where((i) => i.popular && i.available).toList();

  MenuItem? itemById(int id) {
    for (final i in items) {
      if (i.id == id) return i;
    }
    return null;
  }

  factory KioskMenu.fromJson(Map<String, dynamic> j) => KioskMenu(
    sections: [
      for (final s in _list(j['sections'])) MenuSection.fromJson(_map(s)),
    ].where((s) => s.items.isNotEmpty).toList(),
    upsell: [for (final u in _list(j['upsell'])) _int(u)],
  );
}

/// Where a payment has got to, in the kiosk's own words. See paymentStage in
/// vesopa_server/src/express_kiosk.js, which decides it.
enum PayStage {
  starting,
  presentCard,
  processing,
  declined,
  uncertain,
  unavailable,
  paid,
  cancelled,
  counter,
  demo;

  static PayStage parse(String? raw) => switch (raw) {
    'present_card' => presentCard,
    'processing' => processing,
    'declined' => declined,
    'uncertain' => uncertain,
    'unavailable' => unavailable,
    'paid' => paid,
    'cancelled' => cancelled,
    'counter' => counter,
    'demo' => demo,
    _ => starting,
  };

  /// A verdict the customer has to act on.
  bool get needsAnswer => this == declined || this == uncertain || this == unavailable;

  /// The order is finished, one way or another, from the kiosk's side.
  bool get finished => this == paid || this == counter || this == demo;
}

@immutable
class OrderLineView {
  const OrderLineView({
    required this.name,
    required this.qty,
    required this.unitMinor,
    required this.isModifier,
  });

  final String name;
  final int qty;
  final int unitMinor;
  final bool isModifier;

  factory OrderLineView.fromJson(Map<String, dynamic> j) => OrderLineView(
    name: _str(j['name']) ?? '',
    qty: _int(j['qty'], 1),
    unitMinor: _int(j['unit']),
    isModifier: _bool(j['isModifier']),
  );
}

@immutable
class OrderView {
  const OrderView({
    required this.publicId,
    required this.number,
    required this.status,
    required this.stage,
    required this.totalMinor,
    this.orderType = 'take_away',
    this.payment = 'card',
    this.customerName,
    this.taxMinor = 0,
    this.message,
    this.lines = const [],
  });

  final String publicId;
  final int number;
  final String status;
  final PayStage stage;
  final int totalMinor;
  final String orderType;
  final String payment;
  final String? customerName;
  final int taxMinor;
  final String? message;
  final List<OrderLineView> lines;

  factory OrderView.fromJson(Map<String, dynamic> j) => OrderView(
    publicId: _str(j['public_id']) ?? '',
    number: _int(j['number']),
    status: _str(j['status']) ?? '',
    stage: PayStage.parse(_str(j['stage'])),
    totalMinor: _int(j['total_minor']),
    orderType: _str(j['order_type']) ?? 'take_away',
    payment: _str(j['payment']) ?? 'card',
    customerName: _str(j['customer_name']),
    taxMinor: _int(j['tax_minor']),
    message: _str(j['message']),
    lines: [for (final l in _list(j['lines'])) OrderLineView.fromJson(_map(l))],
  );
}
