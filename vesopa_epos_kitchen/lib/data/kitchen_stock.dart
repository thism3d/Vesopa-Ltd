/// Stock, on the kitchen screen (2026-09-27).
///
/// "Stocks and other options also need to be shared to the kitchen as well,
/// think ideal world solution." The screen over the pass gets the back
/// office's stock ledger (`/api/kitchen/stock/...`, on this screen's token):
///
///   * how many more of each dish can still be made -- a burger limited by its
///     buns, a half by the keg -- shown beside the Counts board's to-make
///     numbers ("7 ordered · 5 left");
///   * Sold out, which is the QR menu's own switch: one tap takes a dish off
///     the QR menu and the kiosk, and back;
///   * wastage recorded from the kitchen, by the case or the unit, into the
///     same ledger as the till's;
///   * a dish's recipe measures under its line on a ticket, so it is made the
///     way it is costed.
///
/// Refreshed on a stock push, when the board moves (a sale is stock going),
/// and every minute whatever the socket does.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import 'providers.dart';

double? _d(Object? v) => switch (v) {
      final num n => n.toDouble(),
      final String s => double.tryParse(s),
      _ => null,
    };

String fmtQty(num v) => v == v.roundToDouble() ? '${v.round()}' : v.toStringAsFixed(2);

class RecipeMeasure {
  const RecipeMeasure(this.name, this.quantity, this.unit);
  final String name;
  final double quantity;
  final String? unit;

  /// "50 ml Rum", "1 × Bun".
  String get label => unit == null || unit!.isEmpty ? '${fmtQty(quantity)} × $name' : '${fmtQty(quantity)} $unit $name';
}

class KitchenStockItem {
  KitchenStockItem(Map<String, dynamic> raw)
      : pluId = (raw['pluid'] as num?)?.toInt() ?? 0,
        name = (raw['product_name'] ?? '') as String,
        level = (raw['level'] ?? 'untracked') as String,
        stock = _d(raw['stock_quantity']),
        canMake = _d(raw['can_make']),
        onMenu = raw['on_menu'] == true,
        soldOut = raw['sold_out'] == true,
        packName = raw['pack_name'] as String?,
        packUnits = _d(raw['pack_units']),
        routes = {
          for (final r in ((raw['printer_routes'] as String?) ?? '').split(','))
            if (r.trim().isNotEmpty) r.trim().toLowerCase(),
        },
        recipe = [
          for (final l in (raw['recipe'] as List? ?? const []).cast<Map<String, dynamic>>())
            RecipeMeasure((l['product_name'] ?? '') as String, _d(l['quantity']) ?? 0, l['stock_unit'] as String?),
        ];

  final int pluId;
  final String name;
  final String level;
  final double? stock;
  final double? canMake;
  final bool onMenu;
  final bool soldOut;
  final String? packName;
  final double? packUnits;
  final Set<String> routes;
  final List<RecipeMeasure> recipe;

  bool get hasCase => (packUnits ?? 0) > 1;

  /// Worth a chef's attention: sold out, none left, or low.
  bool get needsAttention => soldOut || (canMake != null && canMake! <= 0) || level == 'low' || level == 'out';
}

class KitchenStockState {
  const KitchenStockState({this.items = const [], this.loaded = false, this.error});
  final List<KitchenStockItem> items;
  final bool loaded;
  final String? error;

  /// By name, lower-cased: a kitchen ticket line carries the product's name,
  /// not its PLU.
  KitchenStockItem? byName(String name) {
    final key = name.trim().toLowerCase();
    for (final i in items) {
      if (i.name.trim().toLowerCase() == key) return i;
    }
    return null;
  }
}

class KitchenStock extends Notifier<KitchenStockState> {
  Timer? _poll;
  bool _busy = false;

  @override
  KitchenStockState build() {
    ref.onDispose(() => _poll?.cancel());
    _poll = Timer.periodic(const Duration(minutes: 1), (_) => unawaited(refresh()));
    Future.microtask(refresh);
    return const KitchenStockState();
  }

  http.Client get _client => ref.read(kitchenHttpClientProvider);

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (ref.read(kitchenApiProvider).token != null) 'Authorization': 'Bearer ${ref.read(kitchenApiProvider).token}',
      };

  Uri _uri(String path) => Uri.parse('${ref.read(apiBaseProvider)}/api/kitchen/stock$path');

  Future<void> refresh() async {
    if (_busy || ref.read(kitchenApiProvider).token == null) return;
    _busy = true;
    try {
      final res = await _client.get(_uri('/availability'), headers: _headers).timeout(const Duration(seconds: 12));
      if (res.statusCode != 200) {
        state = KitchenStockState(items: state.items, loaded: state.loaded, error: _error(res));
        return;
      }
      final rows = (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
      state = KitchenStockState(items: [for (final r in rows) KitchenStockItem(r)], loaded: true);
    } catch (_) {
      state = KitchenStockState(items: state.items, loaded: state.loaded, error: 'The back office cannot be reached right now.');
    } finally {
      _busy = false;
    }
  }

  static String _error(http.Response res) {
    try {
      final m = (jsonDecode(res.body) as Map)['error'];
      if (m is String && m.isNotEmpty) return m;
    } catch (_) {}
    return 'The back office refused that (HTTP ${res.statusCode}).';
  }

  Future<void> _post(String path, Map<String, Object?> body) async {
    final res = await _client.post(_uri(path), headers: _headers, body: jsonEncode(body)).timeout(const Duration(seconds: 12));
    if (res.statusCode < 200 || res.statusCode >= 300) throw KitchenStockError(_error(res));
  }

  /// Sold out, or back on -- the QR menu's own switch.
  Future<void> setSoldOut(KitchenStockItem item, bool soldOut) async {
    await _post('/sold-out', {'pluid': item.pluId, 'sold_out': soldOut});
    await refresh();
  }

  /// Record wastage from the kitchen: [quantity] in units.
  Future<void> waste(KitchenStockItem item, double quantity, String reason) async {
    await _post('/docs', {
      'kind': 'wastage',
      'complete': true,
      'notes': 'From the kitchen screen',
      'lines': [
        {'pluid': item.pluId, 'quantity': quantity, 'reason': reason},
      ],
    });
    await refresh();
  }
}

class KitchenStockError implements Exception {
  KitchenStockError(this.message);
  final String message;
  @override
  String toString() => message;
}

/// The HTTP client stock calls go through; a test swaps it.
final kitchenHttpClientProvider = Provider<http.Client>((_) => http.Client());

final kitchenStockProvider = NotifierProvider<KitchenStock, KitchenStockState>(KitchenStock.new);

/// Cases and units back to units; null when both are blank.
double? joinQty(String cases, String units, double? packUnits) {
  final c = cases.trim();
  final u = units.trim();
  if (c.isEmpty && u.isEmpty) return null;
  final cn = c.isEmpty ? 0.0 : double.tryParse(c);
  final un = u.isEmpty ? 0.0 : double.tryParse(u);
  if (cn == null || un == null) return null;
  final pu = (packUnits ?? 0) > 1 ? packUnits! : 1.0;
  return cn * pu + un;
}
