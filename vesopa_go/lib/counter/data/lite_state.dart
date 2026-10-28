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
  String add(Product product, {List<Choice> choices = const [], int quantity = 1, String note = ''}) {
    final id = ensure();
    final session = ref.read(tapProvider.notifier);
    // The line it went on: a new one, or a stacked one already on the sale.
    final line = session.addLine(id, product, choices: choices, note: note);
    if (quantity > 1) session.changeQuantity(id, line, quantity - 1);
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
  const LiteSettings({this.allergenAlerts = true, this.cardVia = '', this.cashButtons = const [500, 1000, 2000, 5000]});

  /// Warn when an item with allergens goes on a sale.
  final bool allergenAlerts;

  /// `tap`: this device reads the card (a phone, or a Dojo handheld).
  /// `machine`: the venue's Dojo card machine beside it.
  /// Empty: the venue's choice for this kind of device (see [cardVia] below).
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

/// How this device takes a card: its own choice, else the venue's for the
/// platform (back office: Tap to Pay on iPhone and iPad, the Dojo machine on
/// Android). A Dojo Pocket is this device's own reader, so it is `tap`.
///
/// An iPad has no Tap to Pay (Apple offers it on iPhone only), so an iPad on
/// the venue's default goes to the card machine; [tablet] says which this is.
String cardVia(LiteSettings settings, TapConfig config, {bool tablet = false}) {
  // Teya's Tap to Pay is only in Teya's own app: a Teya venue pays on its machines.
  if (config.teya.enabled) return 'machine';
  if (settings.cardVia == 'tap' || settings.cardVia == 'machine') return settings.cardVia;
  if (tablet && defaultTargetPlatform == TargetPlatform.iOS) return 'machine';
  final venue = defaultTargetPlatform == TargetPlatform.iOS ? config.go.cardIos : config.go.cardAndroid;
  return venue == 'machine' ? 'machine' : 'tap';
}

/// Category ids to the names the reports show.
Map<String, String> categoryNames(TapState s) => {'quick': 'Quick sale', for (final c in s.categories) c.id: c.name};
