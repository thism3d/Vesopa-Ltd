import 'dart:convert';

import 'package:http/http.dart' as http;

/// A receipt in the history list.
class ReceiptSummary {
  const ReceiptSummary({
    required this.id,
    required this.totalMinor,
    required this.taxMinor,
    required this.discountMinor,
    required this.closedAt,
    this.tableNumber,
    this.customerName,
    this.voucherCode,
    this.voucherMinor = 0,
    this.serviceMinor = 0,
    this.pointsEarned = 0,
    this.pointsRedeemed = 0,
    this.pointsBalance,
    this.clerkName,
    this.orderNote,
    this.covers,
  });

  final String id;
  final int totalMinor;
  final int taxMinor;
  final int discountMinor;
  final DateTime closedAt;
  final int? tableNumber;

  /// Receipt context. All optional: a walk-in cash sale has none of it, and
  /// sales taken before these were recorded still render.
  final String? customerName;
  final String? voucherCode;
  final int voucherMinor;
  final int serviceMinor;
  final int pointsEarned;

  /// Points spent on this sale, shown alongside what was earned.
  final int pointsRedeemed;
  final int? pointsBalance;
  final String? clerkName;
  final String? orderNote;
  final int? covers;

  bool get hasVoucher => voucherMinor > 0 || (voucherCode?.isNotEmpty ?? false);

  /// What the goods came to before discounts, vouchers and service.
  int get grossMinor =>
      totalMinor + discountMinor + voucherMinor - serviceMinor;

  // MySQL sends INTs as num; a value written by an older till may be absent.
  static int _int(Object? v) => (v as num?)?.toInt() ?? 0;

  factory ReceiptSummary.fromJson(Map<String, dynamic> j) => ReceiptSummary(
        id: j['id'] as String,
        totalMinor: _int(j['total_minor']),
        taxMinor: _int(j['tax_minor']),
        discountMinor: _int(j['discount_minor']),
        tableNumber: (j['table_number'] as num?)?.toInt(),
        closedAt:
            DateTime.tryParse(j['closed_at'] as String? ?? '') ?? DateTime.now(),
        customerName: j['customer_name'] as String?,
        voucherCode: j['voucher_code'] as String?,
        voucherMinor: _int(j['voucher_minor']),
        serviceMinor: _int(j['service_minor']),
        pointsEarned: _int(j['points_earned']),
        pointsRedeemed: _int(j['points_redeemed']),
        pointsBalance: (j['points_balance'] as num?)?.toInt(),
        clerkName: j['clerk_name'] as String?,
        orderNote: j['order_note'] as String? ?? j['notes'] as String?,
        covers: (j['covers'] as num?)?.toInt(),
      );
}

class ReceiptLine {
  const ReceiptLine({
    required this.name,
    required this.quantity,
    required this.unitPriceMinor,
    this.note,
    this.taxPercentage = 0,
  });

  final String name;
  final double quantity;
  final int unitPriceMinor;

  /// Kitchen instruction for this line ("no onions"). Prints indented under
  /// the item on both the customer receipt and the kitchen ticket.
  final String? note;

  /// Kept per line so the receipt can show a VAT breakdown by rate, which is
  /// what a VAT-registered venue's receipt has to do.
  final double taxPercentage;

  int get lineTotalMinor => (unitPriceMinor * quantity).round();

  factory ReceiptLine.fromJson(Map<String, dynamic> j) => ReceiptLine(
        name: j['name'] as String? ?? '',
        quantity: (j['quantity'] as num? ?? 1).toDouble(),
        unitPriceMinor: (j['unit_price_minor'] as num?)?.toInt() ?? 0,
        note: (j['note'] as String?)?.trim().isEmpty ?? true
            ? null
            : j['note'] as String,
        taxPercentage: (j['tax_percentage'] as num? ?? 0).toDouble(),
      );
}

class ReceiptTender {
  const ReceiptTender({
    required this.method,
    required this.amountMinor,
    this.cashBreakdown,
  });

  final String method;
  final int amountMinor;

  /// The notes counted in on the cash keys, as `2000x2,500x1`. Printed under
  /// the tender so the customer can check the receipt against what they
  /// actually handed over. Null for card, and for cash keyed as an amount.
  final String? cashBreakdown;

  factory ReceiptTender.fromJson(Map<String, dynamic> j) => ReceiptTender(
        method: j['method'] as String? ?? '',
        amountMinor: j['amount_minor'] as int? ?? 0,
        cashBreakdown: j['cash_breakdown'] as String?,
      );
}

/// A full receipt: header, lines, tenders.
class ReceiptDetail {
  const ReceiptDetail({
    required this.summary,
    required this.lines,
    required this.tenders,
  });

  final ReceiptSummary summary;
  final List<ReceiptLine> lines;
  final List<ReceiptTender> tenders;
}

/// Reads settled receipts back from the server for the history screen.
///
/// This is deliberately server-backed rather than local: history is a
/// look-back over everything the venue has taken, across all its terminals,
/// which no single till holds. It therefore needs the network — unlike taking a
/// sale, which never does.
class ReceiptRepository {
  ReceiptRepository({required this.apiBase, required this.office});

  final String apiBase;
  final String office;

  String get _officeParam => 'office=${Uri.encodeComponent(office)}';

  Future<List<ReceiptSummary>> list({DateTime? from, DateTime? to}) async {
    final params = [
      _officeParam,
      if (from != null) 'from=${_date(from)}',
      if (to != null) 'to=${_date(to)}',
    ].join('&');

    final res = await http
        .get(Uri.parse('$apiBase/till/receipts?$params'))
        .timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) {
      throw Exception('Could not load receipts (${res.statusCode}).');
    }
    return (jsonDecode(res.body) as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .map(ReceiptSummary.fromJson)
        .toList();
  }

  Future<ReceiptDetail> detail(String id) async {
    final res = await http
        .get(Uri.parse('$apiBase/till/receipts/$id?$_officeParam'))
        .timeout(const Duration(seconds: 12));
    if (res.statusCode != 200) {
      throw Exception('Could not load the receipt (${res.statusCode}).');
    }

    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return ReceiptDetail(
      summary: ReceiptSummary.fromJson(body['order'] as Map<String, dynamic>),
      lines: (body['lines'] as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .map(ReceiptLine.fromJson)
          .toList(),
      tenders: (body['payments'] as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .map(ReceiptTender.fromJson)
          .toList(),
    );
  }

  static String _date(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-'
      '${d.month.toString().padLeft(2, '0')}-'
      '${d.day.toString().padLeft(2, '0')}';
}
