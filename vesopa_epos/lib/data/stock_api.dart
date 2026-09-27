/// The back office's stock ledger, from the till (2026-09-27).
///
/// "All the features must reflect to the till as well." The till's Stock page
/// (stock takes, spot checks, wastage, adjustments) and its Products page
/// (case size, cost, supplier, GP, child products, recipes) talk to the same
/// routes the back office uses, mounted for tills at `/till/stock/...` and
/// signed with this terminal's token (server: `stockRoutes({ till: true })`).
///
/// There is no local copy of any of it on purpose. Stock is one ledger on the
/// server; a till that kept its own count would be a till whose number
/// differs from the back office's -- which is exactly the bug the old
/// "stock on hand" box on the Products page had. So these pages need the
/// network, and say so plainly when it is not there.
///
/// Also here: the cases-and-units arithmetic every quantity box uses, kept
/// pure so it is tested without a widget.
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../main.dart';

// ---------------------------------------------------------------------------
// Cases and units
// ---------------------------------------------------------------------------

/// Units in one case, or 1 when there is no real case.
double packUnitsOf(num? packUnits) =>
    (packUnits ?? 0) > 1 ? packUnits!.toDouble() : 1;

/// A unit count as whole cases and the units left over: 30 of a 24 is 1 and 6.
/// A negative count (an adjustment down) splits the same way, both negative.
({double cases, double units}) splitQty(double quantity, num? packUnits) {
  final pu = packUnitsOf(packUnits);
  if (pu == 1) return (cases: 0, units: quantity);
  final cases = (quantity / pu).truncateToDouble();
  final units = _round4(quantity - cases * pu);
  return (cases: cases, units: units);
}

/// Cases and units back to units. Null when both are blank.
double? joinQty(String cases, String units, num? packUnits) {
  final c = cases.trim();
  final u = units.trim();
  if (c.isEmpty && u.isEmpty) return null;
  final cn = c.isEmpty ? 0.0 : double.tryParse(c);
  final un = u.isEmpty ? 0.0 : double.tryParse(u);
  if (cn == null || un == null) return null;
  return _round4(cn * packUnitsOf(packUnits) + un);
}

/// "1 case + 6 units", "2 cases", "3 units".
String qtyWords(double quantity, num? packUnits) {
  final pu = packUnitsOf(packUnits);
  String n(double v) => v == v.roundToDouble() ? '${v.round()}' : v.toStringAsFixed(2);
  if (pu == 1) return '${n(quantity)} unit${quantity.abs() == 1 ? '' : 's'}';
  final s = splitQty(quantity, pu);
  final bits = <String>[
    if (s.cases != 0) '${n(s.cases)} case${s.cases.abs() == 1 ? '' : 's'}',
    if (s.units != 0 || s.cases == 0) '${n(s.units)} unit${s.units.abs() == 1 ? '' : 's'}',
  ];
  return bits.join(' + ');
}

double _round4(double v) => (v * 10000).roundToDouble() / 10000;

String fmtQty(num v) => v == v.roundToDouble() ? '${v.round()}' : v.toStringAsFixed(2);

// ---------------------------------------------------------------------------
// What the server sends
// ---------------------------------------------------------------------------

double? _d(Object? v) => switch (v) {
      final num n => n.toDouble(),
      final String s => double.tryParse(s),
      _ => null,
    };
int? _i(Object? v) => switch (v) {
      final int n => n,
      final num n => n.round(),
      final String s => int.tryParse(s),
      _ => null,
    };
bool _b(Object? v) => v == true || v == 1 || v == '1';

/// One product as Stock Control sees it (GET /till/stock/products).
class StockProduct {
  StockProduct(this.raw);

  final Map<String, dynamic> raw;

  int get id => _i(raw['id']) ?? 0;
  int get pluId => _i(raw['pluid']) ?? 0;
  String get name => (raw['product_name'] ?? '') as String;
  String get department => ((raw['department_name'] as String?)?.trim().isNotEmpty ?? false)
      ? (raw['department_name'] as String).trim()
      : 'Unassigned';
  String? get group => (raw['group_name'] as String?)?.trim().isNotEmpty ?? false
      ? (raw['group_name'] as String).trim()
      : null;

  /// "Bar › Draught" -- the heading a count is laid out under.
  String get shelf => group == null ? department : '$department › $group';

  int? get packSizeId => _i(raw['pack_size_id']);
  String? get packName => raw['pack_name'] as String?;
  double? get packUnits => _d(raw['pack_units']);
  bool get hasCase => (packUnits ?? 0) > 1;
  String get caseLabel =>
      packName == null ? 'No case size' : (hasCase ? '$packName (${fmtQty(packUnits!)})' : packName!);

  /// Null when the product's count is not kept.
  double? get stock => _d(raw['stock_quantity']);
  String get level => (raw['level'] ?? 'untracked') as String;
  bool get tracked => level != 'untracked';
  String get stockDisplay => (raw['stock_display'] ?? '') as String;

  bool get stockItem => _b(raw['stock_item']);
  bool get nonStock => _b(raw['non_stock']);
  bool get isLinked => _b(raw['is_linked']);
  bool get isRecipe => _b(raw['is_recipe']);
  int? get parentPlu => _i(raw['stock_parent_pluid']);
  double? get ratio => _d(raw['stock_ratio']);

  int get unitCostMinor => _i(raw['unit_cost_minor']) ?? 0;
  double? get costPrice => _d(raw['cost_price']);
  double? get packCost => _d(raw['pack_cost']);
  double get price => _d(raw['price']) ?? 0;
  double get taxPercentage => _d(raw['tax_percentage']) ?? 0;
  double? get targetGp => _d(raw['target_gp']);
  int? get supplierId => _i(raw['supplier_id']);
  String? get supplierName => raw['supplier_name'] as String?;
  String? get barcode => raw['barcode'] as String?;
  double? get minStock => _d(raw['min_stock']);
  double? get maxStock => _d(raw['max_stock']);

  bool matches(String query) {
    final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty);
    if (words.isEmpty) return true;
    final hay = '$name $pluId ${barcode ?? ''} $department ${group ?? ''}'.toLowerCase();
    return words.every(hay.contains);
  }
}

class PackSize {
  PackSize(this.id, this.name, this.units);
  final int id;
  final String name;
  final double units;
  String get label => units > 1 ? '$name (${fmtQty(units)})' : name;
}

class Supplier {
  Supplier(this.id, this.name, this.active);
  final int id;
  final String name;
  final bool active;
}

/// A stock document's kind, and how the till words it.
enum StockDocKind {
  stocktake('stocktake', 'Stock take', 'Counted', counting: true),
  spotCheck('spot_check', 'Spot check', 'Counted', counting: true),
  wastage('wastage', 'Wastage', 'Wasted', reason: true),
  adjustment('adjustment', 'Adjustment', 'Adjust by', reason: true, signed: true);

  const StockDocKind(this.key, this.title, this.qtyLabel,
      {this.counting = false, this.reason = false, this.signed = false});
  final String key;
  final String title;
  final String qtyLabel;
  final bool counting;
  final bool reason;
  final bool signed;
}

/// One line of a document being filled in on the till.
class StockLine {
  StockLine(this.product);
  final StockProduct product;
  String cases = '';
  String units = '';
  String reason = '';

  /// Adjustments only: taking off rather than adding.
  bool takeOff = false;

  double? get quantity {
    final q = joinQty(cases, units, product.packUnits);
    if (q == null) return null;
    return takeOff ? -q : q;
  }
}

/// Keep a count in shelf order: department, sub-department, then name --
/// "can we order them in sub departments" (2026-09-24). Wastage and
/// adjustments keep the order they were entered.
void sortForCount(List<StockLine> lines) {
  lines.sort((a, b) {
    final d = a.product.department.compareTo(b.product.department);
    if (d != 0) return d;
    final g = (a.product.group ?? '￿').compareTo(b.product.group ?? '￿');
    if (g != 0) return g;
    return a.product.name.toLowerCase().compareTo(b.product.name.toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

class StockApiException implements Exception {
  StockApiException(this.message);
  final String message;
  @override
  String toString() => message;
}

class StockApi {
  StockApi({required this.base, required this.token, required this.staff, http.Client? client})
      : _client = client ?? http.Client();

  final String base;
  final String? token;
  final String? staff;
  final http.Client _client;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null && token!.isNotEmpty) 'Authorization': 'Bearer $token',
        if (staff != null && staff!.isNotEmpty) 'X-Vesopa-Staff': staff!,
      };

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    if (token == null || token!.isEmpty) {
      throw StockApiException('This terminal is not commissioned, so it cannot reach Stock Control.');
    }
    final uri = Uri.parse('$base/till$path');
    late http.Response res;
    try {
      final req = http.Request(method, uri)..headers.addAll(_headers);
      if (body != null) req.body = jsonEncode(body);
      res = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 15)));
    } catch (_) {
      throw StockApiException('Could not reach the back office. Stock needs the network, so nothing was changed.');
    }
    dynamic json;
    try {
      json = res.body.isEmpty ? null : jsonDecode(res.body);
    } catch (_) {
      json = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      final why = json is Map ? json['error'] as String? : null;
      throw StockApiException(why ?? 'The back office said no (${res.statusCode}).');
    }
    return json;
  }

  Future<List<StockProduct>> products() async => [
        for (final r in (await _send('GET', '/stock/products') as List).cast<Map<String, dynamic>>()) StockProduct(r),
      ];

  Future<List<PackSize>> packSizes() async => [
        for (final r in (await _send('GET', '/stock/pack-sizes') as List).cast<Map<String, dynamic>>())
          PackSize(_i(r['id']) ?? 0, (r['name'] ?? '') as String, _d(r['units']) ?? 1),
      ];

  Future<List<Supplier>> suppliers() async => [
        for (final r in (await _send('GET', '/stock/suppliers') as List).cast<Map<String, dynamic>>())
          Supplier(_i(r['id']) ?? 0, (r['name'] ?? '') as String, r['active'] == null || _b(r['active'])),
      ];

  /// Change some of a product's stock settings; only the named fields move.
  Future<void> patchProduct(int id, Map<String, Object?> fields) =>
      _send('PATCH', '/stock/products/$id', fields);

  /// The same change on many products: case size, supplier or non-stock.
  Future<({int updated, List<String> refused})> patchMany(List<int> ids, Map<String, Object?> fields) async {
    final r = await _send('PATCH', '/stock/products', {'ids': ids, 'fields': fields}) as Map;
    return (
      updated: _i(r['updated']) ?? 0,
      refused: [for (final x in (r['refused'] as List? ?? const [])) '${(x as Map)['error']}'],
    );
  }

  Future<List<Map<String, dynamic>>> docs(StockDocKind kind) async =>
      (await _send('GET', '/stock/docs?kind=${kind.key}') as List).cast<Map<String, dynamic>>();

  Future<Map<String, dynamic>> doc(String id) async => (await _send('GET', '/stock/docs/$id') as Map).cast<String, dynamic>();

  /// Write a document and, when [complete], apply it to the ledger at once.
  Future<Map<String, dynamic>> createDoc({
    required StockDocKind kind,
    required List<StockLine> lines,
    String? notes,
    bool complete = true,
  }) async {
    final body = {
      'kind': kind.key,
      'notes': (notes ?? '').trim().isEmpty ? null : notes!.trim(),
      'complete': complete,
      'lines': [
        for (final l in lines)
          {'pluid': l.product.pluId, 'quantity': l.quantity, 'reason': l.reason.trim().isEmpty ? null : l.reason.trim()},
      ],
    };
    return (await _send('POST', '/stock/docs', body) as Map).cast<String, dynamic>();
  }

  Future<Map<String, dynamic>> recipe(int pluId) async =>
      (await _send('GET', '/stock/recipes/$pluId') as Map).cast<String, dynamic>();

  Future<void> saveRecipe(int pluId, List<({int pluId, double quantity})> lines) => _send('PUT', '/stock/recipes/$pluId', {
        'lines': [for (final l in lines) {'pluid': l.pluId, 'quantity': l.quantity}],
      });

  Future<void> deleteRecipe(int pluId) => _send('DELETE', '/stock/recipes/$pluId');

  /// A one-line document applied at once: a delivery booked in, or a count
  /// set -- the till's Products page's stock button, which used to change
  /// only this till's copy and never reached the back office.
  Future<void> quickDoc({required String kind, required int pluId, required double quantity, String? note}) => _send('POST', '/stock/docs', {
        'kind': kind,
        'complete': true,
        'notes': note,
        'lines': [
          {'pluid': pluId, 'quantity': quantity, 'reason': note},
        ],
      });

  /// Change a product's details or printing on the server (PATCH
  /// /till/products/:pluid); every till picks it up on the next refresh.
  Future<void> updateProduct(int pluId, Map<String, Object?> fields) => _send('PATCH', '/products/$pluId', fields);

  /// A new product with no barcode -- a child product made from the editor.
  /// Returns its row id (for the stock routes) and PLU.
  Future<({int id, int pluId})> createProduct(Map<String, Object?> fields) async {
    final r = await _send('POST', '/products/new', fields) as Map;
    return (id: _i(r['id']) ?? 0, pluId: _i(r['pluid']) ?? 0);
  }
}

/// GP on the ex-VAT price, and the price that would make [targetGp]:
/// the back office's calculator, to the penny, rounded up to 5p.
({double? gp, double recommended}) gpFor({required double price, required double vatPercent, required double unitCost, double targetGp = 70}) {
  final vat = 1 + vatPercent / 100;
  final net = price / vat;
  final gp = net > 0 ? (net - unitCost) / net * 100 : null;
  final t = targetGp.clamp(0, 99) / 100;
  final rec = ((unitCost / (1 - t)) * vat * 100 / 5).ceil() * 5 / 100;
  return (gp: gp, recommended: rec);
}

/// The API as this terminal and the member of staff at it would use it.
final stockApiProvider = Provider<StockApi>((ref) {
  return StockApi(
    base: ref.watch(apiBaseProvider),
    token: ref.watch(sessionProvider).terminalToken,
    staff: ref.watch(servedByProvider),
  );
});
