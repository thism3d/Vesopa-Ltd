import 'dart:convert';

import 'package:http/http.dart' as http;

/// A receipt in the history list.
/// What a practice receipt says, top and bottom. See data/training_mode.dart.
const trainingReceiptLine = 'TRAINING - NOT A VALID RECEIPT';

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
    this.training = false,
    this.methods = const [],
    this.hasCard = false,
    this.refundedMinor = 0,
    this.refundCount = 0,
    this.lastRefundAt,
    this.status = ReceiptStatus.paid,
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

  /// A practice bill, rung up in training mode. Printed with
  /// [trainingReceiptLine] top and bottom so it can never be passed off as a
  /// real receipt. Never true for a sale from the server: practice sales are
  /// not sent there.
  final bool training;

  /// How it was paid: cash, card, giftcard… (EPOS 1.17; empty from an older
  /// server, which reads as "paid").
  final List<String> methods;

  /// Paid, at least in part, on Dojo.
  final bool hasCard;

  /// What has gone back on this bill so far, from every till.
  final int refundedMinor;
  final int refundCount;
  final DateTime? lastRefundAt;
  final ReceiptStatus status;

  /// What can still be refunded.
  int get refundableMinor =>
      (totalMinor - refundedMinor).clamp(0, totalMinor < 0 ? 0 : totalMinor);

  bool get hasVoucher => voucherMinor > 0 || (voucherCode?.isNotEmpty ?? false);

  /// What the goods came to before discounts, vouchers and service.
  int get grossMinor =>
      totalMinor + discountMinor + voucherMinor - serviceMinor;

  // MySQL sends INTs as num, but DECIMAL columns (points_balance, prices
  // on some rows) as text ("0.00000"); a value from an older till may be
  // absent. Every number here goes through [_numOf], so a column that turns
  // into DECIMAL never again takes Last Bill down ("type 'String' is not a
  // subtype of type 'num'", 2026-10-30).
  static int _int(Object? v) => _numOf(v)?.toInt() ?? 0;

  factory ReceiptSummary.fromJson(Map<String, dynamic> j) => ReceiptSummary(
        id: j['id'] as String,
        totalMinor: _int(j['total_minor']),
        taxMinor: _int(j['tax_minor']),
        discountMinor: _int(j['discount_minor']),
        tableNumber: _numOf(j['table_number'])?.toInt(),
        closedAt:
            DateTime.tryParse(j['closed_at'] as String? ?? '') ?? DateTime.now(),
        customerName: j['customer_name'] as String?,
        voucherCode: j['voucher_code'] as String?,
        voucherMinor: _int(j['voucher_minor']),
        serviceMinor: _int(j['service_minor']),
        pointsEarned: _int(j['points_earned']),
        pointsRedeemed: _int(j['points_redeemed']),
        pointsBalance: _numOf(j['points_balance'])?.toInt(),
        clerkName: j['clerk_name'] as String?,
        orderNote: j['order_note'] as String? ?? j['notes'] as String?,
        covers: _numOf(j['covers'])?.toInt(),
        methods: [
          for (final m in (j['methods'] as List?) ?? const []) '$m',
        ],
        hasCard: j['has_card'] == true || j['has_card'] == 1,
        refundedMinor: _int(j['refunded_minor']),
        refundCount: _int(j['refund_count']),
        lastRefundAt: DateTime.tryParse('${j['last_refund_at'] ?? ''}')
            ?.toLocal(),
        status: ReceiptStatus.parse(j['status']),
      );

  /// The same receipt with what is now known to have gone back.
  ReceiptSummary withRefunds(int refunded, {int? count, DateTime? last}) =>
      ReceiptSummary(
        id: id,
        totalMinor: totalMinor,
        taxMinor: taxMinor,
        discountMinor: discountMinor,
        closedAt: closedAt,
        tableNumber: tableNumber,
        customerName: customerName,
        voucherCode: voucherCode,
        voucherMinor: voucherMinor,
        serviceMinor: serviceMinor,
        pointsEarned: pointsEarned,
        pointsRedeemed: pointsRedeemed,
        pointsBalance: pointsBalance,
        clerkName: clerkName,
        orderNote: orderNote,
        covers: covers,
        training: training,
        methods: methods,
        hasCard: hasCard,
        refundedMinor: refunded,
        refundCount: count ?? refundCount,
        lastRefundAt: last ?? lastRefundAt,
        status: ReceiptStatus.of(refunded, totalMinor),
      );
}

/// Where a settled bill stands now.
enum ReceiptStatus {
  paid('Paid'),
  partRefunded('Part refunded'),
  refunded('Refunded');

  const ReceiptStatus(this.label);
  final String label;

  static ReceiptStatus parse(Object? v) => switch ('$v') {
    'refunded' => refunded,
    'part_refunded' => partRefunded,
    _ => paid,
  };

  static ReceiptStatus of(int refundedMinor, int totalMinor) =>
      refundedMinor <= 0
      ? paid
      : refundedMinor >= totalMinor
      ? refunded
      : partRefunded;
}

/// One refund already given against a receipt.
class ReceiptRefund {
  const ReceiptRefund({
    required this.id,
    required this.amountMinor,
    required this.at,
    this.staffName,
    this.reason,
    this.lineNos = const [],
  });

  final String id;
  final int amountMinor;
  final DateTime at;
  final String? staffName;
  final String? reason;

  /// The receipt lines it gave back, by position. Empty for a refund made
  /// before EPOS 1.17, which recorded only the amount.
  final List<int> lineNos;

  factory ReceiptRefund.fromJson(Map<String, dynamic> j) => ReceiptRefund(
    id: '${j['id']}',
    amountMinor: _numOf(j['amount_minor'])?.toInt() ?? 0,
    at: DateTime.tryParse('${j['at'] ?? ''}')?.toLocal() ?? DateTime.now(),
    staffName: j['staff_name'] as String?,
    reason: j['reason'] as String?,
    lineNos: [
      for (final n in (j['line_nos'] as List?) ?? const [])
        if (n is num) n.toInt(),
    ],
  );
}

class ReceiptLine {
  const ReceiptLine({
    required this.name,
    required this.quantity,
    required this.unitPriceMinor,
    this.note,
    this.taxPercentage = 0,
    this.isModifier = false,
    this.discountMinor = 0,
  });

  final String name;
  final double quantity;
  final int unitPriceMinor;

  /// What came off this line itself: an offer, a line discount. Order-wide
  /// money (a bill discount, a voucher, points) is not in here; see
  /// [ReceiptDetail.lineValues].
  final int discountMinor;

  /// Kitchen instruction for this line ("no onions"). Prints indented under
  /// the item on both the customer receipt and the kitchen ticket.
  final String? note;

  /// Kept per line so the receipt can show a VAT breakdown by rate, which is
  /// what a VAT-registered venue's receipt has to do.
  final double taxPercentage;

  /// Whether this line is a modifier hanging off the one above it — the mixer
  /// with the gin, how the steak is cooked. Printed indented under its item.
  ///
  /// Position, not identity: lines arrive in the order they were rung and a
  /// modifier always follows what it modifies. See
  /// vesopa_server/schema_screens_modifiers_lines.sql.
  final bool isModifier;

  int get lineTotalMinor => (unitPriceMinor * quantity).round();

  factory ReceiptLine.fromJson(Map<String, dynamic> j) => ReceiptLine(
        name: j['name'] as String? ?? '',
        quantity: (_numOf(j['quantity']) ?? 1).toDouble(),
        unitPriceMinor: _numOf(j['unit_price_minor'])?.toInt() ?? 0,
        note: (j['note'] as String?)?.trim().isEmpty ?? true
            ? null
            : j['note'] as String,
        taxPercentage: (_numOf(j['tax_percentage']) ?? 0).toDouble(),
        // Absent on a sale recorded before modifiers existed, which was an
        // item in its own right — so the default is the truth, not a guess.
        isModifier: _numOf(j['is_modifier']) == 1 || j['is_modifier'] == true,
        discountMinor: _numOf(j['discount_minor'])?.toInt() ?? 0,
      );
}

class ReceiptTender {
  const ReceiptTender({
    required this.method,
    required this.amountMinor,
    this.cashBreakdown,
    this.reference,
    this.entryMode,
  });

  final String method;
  final int amountMinor;

  /// The acquirer's id for a card payment — Dojo's `pi_…` intent id — which
  /// is what a refund off this receipt goes back against.
  final String? reference;

  /// terminal | manual | hosted | native, for card.
  final String? entryMode;

  /// A card payment Dojo can refund.
  bool get isDojo => reference?.startsWith('pi_') ?? false;

  /// Taken on a Teya card machine (payments/teya_provider.dart).
  bool get isTeya => reference?.startsWith('teya:') ?? false;

  /// The notes counted in on the cash keys, as `2000x2,500x1`. Printed under
  /// the tender so the customer can check the receipt against what they
  /// actually handed over. Null for card, and for cash keyed as an amount.
  final String? cashBreakdown;

  factory ReceiptTender.fromJson(Map<String, dynamic> j) => ReceiptTender(
        method: j['method'] as String? ?? '',
        amountMinor: _numOf(j['amount_minor'])?.toInt() ?? 0,
        cashBreakdown: j['cash_breakdown'] as String?,
        reference: j['reference'] as String?,
        entryMode: j['entry_mode'] as String?,
      );
}

/// A full receipt: header, lines, tenders.
class ReceiptDetail {
  const ReceiptDetail({
    required this.summary,
    required this.lines,
    required this.tenders,
    this.refunds = const [],
    this.cardRefundedMinor = const {},
  });

  final ReceiptSummary summary;
  final List<ReceiptLine> lines;
  final List<ReceiptTender> tenders;

  /// Every refund given against it so far, oldest first.
  final List<ReceiptRefund> refunds;

  /// Approved Dojo refunds per payment intent, from every till's card log.
  final Map<String, int> cardRefundedMinor;

  /// What each line is worth back to the customer, in receipt order.
  ///
  /// The receipt's total, shared across its lines: each line's price less its
  /// own offer, then scaled so offers, bill discounts, vouchers, points and
  /// service on the whole bill are shared out too. The values always add up to
  /// exactly the receipt total, so refunding every line gives back what was
  /// paid and the refund page and the receipt show the same balance. Pennies
  /// left by rounding go to the largest lines.
  List<int> get lineValues {
    final weights = [
      for (final l in lines)
        (l.lineTotalMinor - l.discountMinor).clamp(0, 1 << 62),
    ];
    final total = summary.totalMinor < 0 ? 0 : summary.totalMinor;
    final sum = weights.fold<int>(0, (a, b) => a + b);
    if (lines.isEmpty) return const [];
    if (sum == 0) return List.filled(lines.length, 0);
    final values = [for (final w in weights) w * total ~/ sum];
    var left = total - values.fold<int>(0, (a, b) => a + b);
    final order = [for (var i = 0; i < lines.length; i++) i]
      ..sort((a, b) {
        final ra = weights[a] * total % sum;
        final rb = weights[b] * total % sum;
        return rb != ra ? rb.compareTo(ra) : weights[b].compareTo(weights[a]);
      });
    for (final i in order) {
      if (left <= 0) break;
      if (weights[i] == 0) continue;
      values[i]++;
      left--;
    }
    return values;
  }

  /// Receipt lines already given back.
  Set<int> get refundedLineNos => {for (final r in refunds) ...r.lineNos};

  /// This receipt with refunds this till made that the server has not seen
  /// yet (still in the outbox). Matched by id, so nothing counts twice.
  ReceiptDetail withLocal(List<ReceiptRefund> local) {
    final known = {for (final r in refunds) r.id};
    final extra = [
      for (final r in local)
        if (!known.contains(r.id)) r,
    ];
    if (extra.isEmpty) return this;
    final all = [...refunds, ...extra]..sort((a, b) => a.at.compareTo(b.at));
    final events = all.fold<int>(0, (s, r) => s + r.amountMinor);
    final refunded = events > summary.refundedMinor
        ? events
        : summary.refundedMinor;
    return ReceiptDetail(
      summary: summary.withRefunds(
        refunded,
        count: all.length,
        last: all.last.at,
      ),
      lines: lines,
      tenders: tenders,
      refunds: all,
      cardRefundedMinor: cardRefundedMinor,
    );
  }
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
    final status = body['status'] as Map<String, dynamic>?;
    return ReceiptDetail(
      summary: ReceiptSummary.fromJson({
        ...body['order'] as Map<String, dynamic>,
        // The order row is the sale; the status is what has happened since.
        if (status != null) ...{
          'methods': status['methods'],
          'has_card': status['has_card'],
          'refunded_minor': status['refunded_minor'],
          'refund_count': status['refund_count'],
          'last_refund_at': status['last_refund_at'],
          'status': status['status'],
        },
      }),
      refunds: [
        for (final r in (status?['refunds'] as List?) ?? const [])
          ReceiptRefund.fromJson(r as Map<String, dynamic>),
      ],
      cardRefundedMinor: {
        for (final e
            in ((status?['card_refunds'] as Map?) ?? const {}).entries)
          '${e.key}': _numOf(e.value)?.toInt() ?? 0,
      },
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

/// A number from the server whether it came as a number or as text.
num? _numOf(Object? v) => v is num ? v : (v == null ? null : num.tryParse('$v'));
