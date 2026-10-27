/// What Lite keeps beside Go's session: the sale being rung up, and
/// the device's own settings.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';

/// The bill on the sale screen, or null before the first item. A counter
/// sale is a tab of its own, opened by the first press and gone when paid.
final currentSaleProvider = NotifierProvider<CurrentSale, String?>(CurrentSale.new);

class CurrentSale extends Notifier<String?> {
  @override
  String? build() => null;

  /// The open sale's id, opening one if there is none.
  String ensure() {
    final id = state;
    if (id != null && ref.read(tapProvider).bills.containsKey(id)) return id;
    final bill = ref.read(tapProvider.notifier).openTab('Sale');
    state = bill.id;
    return bill.id;
  }

  /// Ring [product] up [quantity] times with [choices]. Returns the sale's id.
  String add(Product product, {List<Choice> choices = const [], int quantity = 1}) {
    final id = ensure();
    final session = ref.read(tapProvider.notifier);
    final before = ref.read(tapProvider).bills[id]!.lines.length;
    session.addLine(id, product, choices: choices);
    final lines = ref.read(tapProvider).bills[id]!.lines;
    if (quantity > 1 && lines.length > before) session.changeQuantity(id, lines.last.id, quantity - 1);
    return id;
  }

  /// The customer walked away: nothing taken, nothing kept.
  void clear() {
    final id = state;
    if (id != null) ref.read(tapProvider.notifier).discard(id);
    state = null;
  }

  /// Paid: the next press starts a new sale.
  void finished() => state = null;
}

@immutable
class LiteSettings {
  const LiteSettings({this.allergenAlerts = true, this.cardVia = 'tap', this.cashButtons = const [500, 1000, 2000, 5000]});

  /// Warn when an item with allergens goes on a sale.
  final bool allergenAlerts;

  /// `tap`: this device reads the card (a phone, or a Dojo handheld).
  /// `machine`: the venue's Dojo card machine beside it.
  final String cardVia;

  /// The quick cash buttons, in pence.
  final List<int> cashButtons;

  LiteSettings copyWith({bool? allergenAlerts, String? cardVia}) =>
      LiteSettings(allergenAlerts: allergenAlerts ?? this.allergenAlerts, cardVia: cardVia ?? this.cardVia, cashButtons: cashButtons);
}

final liteSettingsProvider = NotifierProvider<LiteSettingsStore, LiteSettings>(LiteSettingsStore.new);

class LiteSettingsStore extends Notifier<LiteSettings> {
  static const _allergens = 'vesopa_lite_allergen_alerts';
  static const _via = 'vesopa_lite_card_via';

  @override
  LiteSettings build() {
    _load();
    return const LiteSettings();
  }

  Future<void> _load() async {
    try {
      final p = await SharedPreferences.getInstance();
      state = state.copyWith(allergenAlerts: p.getBool(_allergens), cardVia: p.getString(_via));
    } catch (_) {}
  }

  Future<void> set({bool? allergenAlerts, String? cardVia}) async {
    state = state.copyWith(allergenAlerts: allergenAlerts, cardVia: cardVia);
    try {
      final p = await SharedPreferences.getInstance();
      if (allergenAlerts != null) await p.setBool(_allergens, allergenAlerts);
      if (cardVia != null) await p.setString(_via, cardVia);
    } catch (_) {}
  }
}

/// Category ids to the names the reports show.
Map<String, String> categoryNames(TapState s) => {'quick': 'Quick sale', for (final c in s.categories) c.id: c.name};
