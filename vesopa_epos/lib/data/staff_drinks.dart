/// Staff drinks (2026-10-30).
///
/// Nicky: "a check box on the product to say Staff Item. If this box is
/// enabled when they sell that item it will print out a slip with a barcode
/// and voucher code. This is then for the member of staff to keep and scan or
/// tap the code in to redeem their drink. Basically there's a big scam with
/// staff saying they have drinks bought for them off customers."
///
/// So a product marked Staff item (back office, or the till's product editor)
/// prints one slip per drink once the bill is paid. The code is made here, so
/// the slip prints with the internet down, and the codes are sent to the back
/// office as soon as it answers (kept on this till until then). Redeeming asks
/// the back office, which lets each code through once, whichever till scans it.
library;

import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Every staff drink code starts with this, so a scan is known without asking
/// anybody: `SD` and eight letters and digits.
const staffDrinkPrefix = 'SD';

/// No 0/O or 1/I: a code is typed from a crumpled slip in a dark bar.
const _alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

final _shape = RegExp(r'^SD[A-Z0-9]{8}$');

/// A new code, as the barcode carries it: `SDK7Q2M9XA`.
String newStaffDrinkCode([Random? random]) {
  final r = random ?? Random.secure();
  return staffDrinkPrefix + List.generate(8, (_) => _alphabet[r.nextInt(_alphabet.length)]).join();
}

/// What was scanned or typed, as stored: upper case, no spaces or dashes.
String cleanStaffDrinkCode(String v) => v.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');

/// Whether this scan or entry is a staff drink slip's code.
bool isStaffDrinkCode(String v) => _shape.hasMatch(cleanStaffDrinkCode(v));

/// As printed under the barcode, easier to read out: `SD-K7Q2-M9XA`.
String formatStaffDrinkCode(String code) {
  final c = cleanStaffDrinkCode(code);
  if (c.length != 10) return c;
  return '${c.substring(0, 2)}-${c.substring(2, 6)}-${c.substring(6)}';
}

/// One slip.
class StaffDrink {
  const StaffDrink({
    required this.code,
    required this.productName,
    this.pluId,
    this.priceMinor = 0,
    this.issuedAt,
    this.soldBy,
    this.terminal,
    this.redeemedAt,
    this.redeemedBy,
    this.redeemedTerminal,
  });

  final String code;
  final String productName;
  final int? pluId;
  final int priceMinor;
  final DateTime? issuedAt;
  final String? soldBy;
  final String? terminal;
  final DateTime? redeemedAt;
  final String? redeemedBy;
  final String? redeemedTerminal;

  Map<String, Object?> toJson() => {
        'code': code,
        'product_name': productName,
        'plu_id': pluId,
        'price_minor': priceMinor,
        'issued_at': issuedAt?.toUtc().toIso8601String(),
      };

  static StaffDrink fromJson(Map<String, dynamic> j) {
    DateTime? at(Object? v) => v == null ? null : DateTime.tryParse('$v')?.toLocal();
    int n(Object? v) => v is num ? v.round() : int.tryParse('${v ?? ''}') ?? 0;
    return StaffDrink(
      code: '${j['code'] ?? ''}',
      productName: '${j['product_name'] ?? ''}',
      pluId: j['plu_id'] == null ? null : n(j['plu_id']),
      priceMinor: n(j['price_minor']),
      issuedAt: at(j['issued_at']),
      soldBy: j['sold_by'] as String?,
      terminal: j['terminal'] as String?,
      redeemedAt: at(j['redeemed_at']),
      redeemedBy: j['redeemed_by'] as String?,
      redeemedTerminal: j['redeemed_terminal'] as String?,
    );
  }
}

/// What a redeem came to.
sealed class StaffDrinkRedeem {
  const StaffDrinkRedeem();
}

/// Pour it.
class StaffDrinkOk extends StaffDrinkRedeem {
  const StaffDrinkOk(this.drink);
  final StaffDrink drink;
}

/// Used before: when, and where.
class StaffDrinkUsed extends StaffDrinkRedeem {
  const StaffDrinkUsed(this.drink);
  final StaffDrink drink;
}

/// Not one of this venue's slips, or the back office could not be asked.
class StaffDrinkRefused extends StaffDrinkRedeem {
  const StaffDrinkRefused(this.message);
  final String message;
}

class StaffDrinksApi {
  StaffDrinksApi({required this.apiBase, this.terminalToken, http.Client? client})
      : _client = client ?? http.Client();

  final String apiBase;
  final String? terminalToken;
  final http.Client _client;

  static const _pendingKey = 'staff_drinks_pending';
  static const _timeout = Duration(seconds: 10);

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if ((terminalToken ?? '').isNotEmpty) 'Authorization': 'Bearer $terminalToken',
      };

  /// Send a paid bill's slips; kept on this till and sent later when the back
  /// office cannot be reached. Never throws: the drinks are paid for.
  Future<void> issue({
    required String orderId,
    required List<StaffDrink> drinks,
    String? soldBy,
    String? terminal,
  }) async {
    if (drinks.isEmpty) return;
    final prefs = await SharedPreferences.getInstance();
    final pending = _read(prefs)
      ..add({
        'order_id': orderId,
        'sold_by': soldBy,
        'terminal': terminal,
        'drinks': [for (final d in drinks) d.toJson()],
      });
    await prefs.setString(_pendingKey, jsonEncode(pending));
    await flush();
  }

  /// Send whatever is still waiting. Codes are unique, so sending one twice
  /// does no harm.
  Future<void> flush() async {
    final prefs = await SharedPreferences.getInstance();
    final pending = _read(prefs);
    if (pending.isEmpty) return;
    final left = <Map<String, dynamic>>[];
    for (final batch in pending) {
      try {
        final res = await _client
            .post(Uri.parse('$apiBase/api/till/staff-drinks'), headers: _headers, body: jsonEncode(batch))
            .timeout(_timeout);
        // A refusal that will never change (a bad body) is dropped rather than
        // retried for ever; anything else waits for the next try.
        if (res.statusCode >= 500 || res.statusCode == 401 || res.statusCode == 404 || res.statusCode == 429) {
          left.add(batch);
        }
      } catch (_) {
        left.add(batch);
      }
    }
    await prefs.setString(_pendingKey, jsonEncode(left));
  }

  /// The slips this till has printed and not yet sent.
  Future<int> waiting() async => _read(await SharedPreferences.getInstance()).length;

  List<Map<String, dynamic>> _read(SharedPreferences prefs) {
    try {
      final v = jsonDecode(prefs.getString(_pendingKey) ?? '[]');
      return v is List ? [for (final e in v) if (e is Map) Map<String, dynamic>.from(e)] : [];
    } catch (_) {
      return [];
    }
  }

  /// Redeem a slip, once. Unsent codes go first so a slip printed a moment
  /// ago on this till is known.
  Future<StaffDrinkRedeem> redeem(String code, {String? by, String? terminal}) async {
    final c = cleanStaffDrinkCode(code);
    if (!isStaffDrinkCode(c)) {
      return const StaffDrinkRefused('That is not a staff drink code. They start SD and have eight more letters and numbers.');
    }
    await flush();
    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/api/till/staff-drinks/redeem'),
            headers: _headers,
            body: jsonEncode({'code': c, 'by': by, 'terminal': terminal}),
          )
          .timeout(_timeout);
      final body = jsonDecode(res.body);
      final map = body is Map ? Map<String, dynamic>.from(body) : const <String, dynamic>{};
      final drink = map['drink'] is Map ? StaffDrink.fromJson(Map<String, dynamic>.from(map['drink'] as Map)) : null;
      if (res.statusCode == 200 && drink != null) return StaffDrinkOk(drink);
      if (res.statusCode == 409 && drink != null) return StaffDrinkUsed(drink);
      return StaffDrinkRefused('${map['error'] ?? 'The slip could not be checked (${res.statusCode}).'}');
    } catch (_) {
      return const StaffDrinkRefused(
        'The back office cannot be reached, so the slip cannot be checked. Try again in a moment.',
      );
    }
  }
}
