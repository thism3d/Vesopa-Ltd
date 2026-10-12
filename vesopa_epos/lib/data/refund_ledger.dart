import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'receipt_repository.dart';

/// Refunds this till has given off receipts, kept until the server has them.
///
/// A refund goes up through the outbox like everything else, so for a moment
/// (or for an afternoon, on a till that has lost the internet) the server does
/// not know about it. Without this the refund screen would offer the same
/// lines again the second the first refund was done: exactly "I can refund the
/// same order again and again". The receipt the clerk opens is the server's
/// answer plus these, matched by the event id the outbox sends, so nothing is
/// counted twice once it lands.
class RefundLedger {
  RefundLedger._();
  static final instance = RefundLedger._();

  static const _key = 'vesopa_refund_ledger';

  /// Long enough for any outbox to drain; short enough to stay small.
  static const _keep = Duration(days: 30);

  Future<Map<String, List<Map<String, dynamic>>>> _read() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null) return {};
      final j = jsonDecode(raw) as Map<String, dynamic>;
      return {
        for (final e in j.entries)
          e.key: [for (final r in e.value as List) r as Map<String, dynamic>],
      };
    } catch (_) {
      return {};
    }
  }

  /// Note a refund just given against [orderId].
  Future<void> add(String orderId, ReceiptRefund r) async {
    try {
      final all = await _read();
      final cutoff = DateTime.now().subtract(_keep);
      all.removeWhere(
        (_, list) =>
            list.every((x) => (DateTime.tryParse('${x['at']}') ?? cutoff)
                .isBefore(cutoff)),
      );
      (all[orderId] ??= []).add({
        'id': r.id,
        'amount_minor': r.amountMinor,
        'at': r.at.toUtc().toIso8601String(),
        'staff_name': r.staffName,
        'reason': r.reason,
        'line_nos': r.lineNos,
      });
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, jsonEncode(all));
    } catch (_) {}
  }

  /// What this till has refunded against [orderId].
  Future<List<ReceiptRefund>> forOrder(String orderId) async {
    final list = (await _read())[orderId] ?? const [];
    return [for (final j in list) ReceiptRefund.fromJson(j)];
  }

  /// Refunded totals per order, for the receipt list.
  Future<Map<String, ({int minor, List<String> ids})>> totals() async {
    final all = await _read();
    return {
      for (final e in all.entries)
        e.key: (
          minor: e.value.fold<int>(
            0,
            (s, r) => s + ((r['amount_minor'] as num?)?.toInt() ?? 0),
          ),
          ids: [for (final r in e.value) '${r['id']}'],
        ),
    };
  }
}
