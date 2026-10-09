import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../data/activity_log.dart';
import 'payment_provider.dart';

/// One card event: a sale, a refund, a status check or a cancel, whatever its
/// result.
///
/// Dojo's feedback was that a failed payment left no trace: the till showed a
/// message and moved on, and nothing afterwards said what the machine had
/// answered. Every attempt now writes one of these, approved or not, with the
/// ids Dojo support ask for (intent, terminal session) and the machine's own
/// slip text when it sends one.
class CardLogEntry {
  const CardLogEntry({
    required this.at,
    required this.kind,
    required this.outcome,
    required this.amountMinor,
    this.intentId,
    this.sessionId,
    this.status,
    this.message,
    this.orderId,
    this.terminalId,
    this.softwareHouseId,
    this.resellerId,
    this.authCode,
    this.cardLast4,
    this.cardType,
    this.staff,
    this.receiptLines = const [],
    this.refundedMinor = 0,
  });

  final DateTime at;

  /// sale | refund | unlinked_refund | matched_refund | check | cancel
  final String kind;

  /// approved | declined | cancelled | busy | expired | unknown | failed |
  /// signature_rejected | recorded_manually
  final String outcome;
  final int amountMinor;
  final String? intentId;
  final String? sessionId;
  final String? status;
  final String? message;
  final String? orderId;
  final String? terminalId;
  final String? softwareHouseId;
  final String? resellerId;
  final String? authCode;
  final String? cardLast4;
  final String? cardType;
  final String? staff;
  final List<String> receiptLines;

  /// For a sale: how much of it has since been refunded from this till.
  final int refundedMinor;

  bool get approved => outcome == 'approved' || outcome == 'recorded_manually';

  /// A sale that money can still go back on.
  bool get refundable =>
      kind == 'sale' &&
      approved &&
      (intentId?.isNotEmpty ?? false) &&
      refundedMinor < amountMinor;

  CardLogEntry withRefunded(int minor) => CardLogEntry(
    at: at,
    kind: kind,
    outcome: outcome,
    amountMinor: amountMinor,
    intentId: intentId,
    sessionId: sessionId,
    status: status,
    message: message,
    orderId: orderId,
    terminalId: terminalId,
    softwareHouseId: softwareHouseId,
    resellerId: resellerId,
    authCode: authCode,
    cardLast4: cardLast4,
    cardType: cardType,
    staff: staff,
    receiptLines: receiptLines,
    refundedMinor: minor,
  );

  Map<String, dynamic> toJson() => {
    'at': at.toUtc().toIso8601String(),
    'kind': kind,
    'outcome': outcome,
    'amount_minor': amountMinor,
    'intent_id': intentId,
    'session_id': sessionId,
    'status': status,
    'message': message,
    'order_id': orderId,
    'terminal_id': terminalId,
    'software_house_id': softwareHouseId,
    'reseller_id': resellerId,
    'auth_code': authCode,
    'card_last4': cardLast4,
    'card_type': cardType,
    'staff': staff,
    'receipt_lines': receiptLines,
    'refunded_minor': refundedMinor,
  };

  factory CardLogEntry.fromJson(Map<String, dynamic> j) => CardLogEntry(
    at: DateTime.tryParse('${j['at']}')?.toLocal() ?? DateTime.now(),
    kind: '${j['kind'] ?? 'sale'}',
    outcome: '${j['outcome'] ?? 'unknown'}',
    amountMinor: (j['amount_minor'] as num?)?.toInt() ?? 0,
    intentId: j['intent_id'] as String?,
    sessionId: j['session_id'] as String?,
    status: j['status'] as String?,
    message: j['message'] as String?,
    orderId: j['order_id'] as String?,
    terminalId: j['terminal_id'] as String?,
    softwareHouseId: j['software_house_id'] as String?,
    resellerId: j['reseller_id'] as String?,
    authCode: j['auth_code'] as String?,
    cardLast4: j['card_last4'] as String?,
    cardType: j['card_type'] as String?,
    staff: j['staff'] as String?,
    receiptLines: [
      for (final l in (j['receipt_lines'] as List?) ?? const []) '$l',
    ],
    refundedMinor: (j['refunded_minor'] as num?)?.toInt() ?? 0,
  );

  /// The log row for a finished payment attempt.
  factory CardLogEntry.fromResult(
    PaymentResult r, {
    required String kind,
    String? orderId,
    String? terminalId,
    String? softwareHouseId,
    String? resellerId,
    String? staff,
    String? outcome,
  }) => CardLogEntry(
    at: DateTime.now(),
    kind: kind,
    outcome: outcome ?? outcomeName(r.kind),
    amountMinor: r.amountMinor,
    intentId: r.reference,
    sessionId: r.sessionId,
    status: r.acquirerStatus,
    message: r.message,
    orderId: orderId,
    terminalId: terminalId,
    softwareHouseId: softwareHouseId,
    resellerId: resellerId,
    authCode: r.authCode,
    cardLast4: r.cardLast4,
    cardType: r.cardType,
    staff: staff,
    receiptLines: r.receiptLines,
  );

  static String outcomeName(CardOutcome o) => switch (o) {
    CardOutcome.signatureRejected => 'signature_rejected',
    _ => o.name,
  };
}

/// The till's card log: kept on the till (the last [_keep]) and sent to the
/// back office (vesopaepos.com/admin › Card payments), where every till in
/// the venue lands in one list.
///
/// Sending is best effort and queued: a till that is offline at the moment of
/// a decline still delivers the row when it is back. Nothing here ever throws
/// into the payment flow.
class CardLog {
  CardLog._();
  static final instance = CardLog._();

  static const _localKey = 'vesopa_card_log';
  static const _pendingKey = 'vesopa_card_log_pending';
  static const _keep = 200;

  String apiBase = '';
  String? Function() token = () => null;
  http.Client _client = http.Client();

  /// For tests.
  set client(http.Client c) => _client = c;

  final _changes = StreamController<void>.broadcast();

  /// Fires when the local list changes, so an open Card machine page redraws.
  Stream<void> get changes => _changes.stream;

  Future<List<CardLogEntry>> recent() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_localKey);
      if (raw == null) return const [];
      return [
        for (final j in jsonDecode(raw) as List)
          CardLogEntry.fromJson(j as Map<String, dynamic>),
      ];
    } catch (_) {
      return const [];
    }
  }

  /// Record one event: locally, in the activity log, and to the back office.
  Future<void> add(CardLogEntry e) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final list = [e, ...await recent()].take(_keep).toList();
      await prefs.setString(
        _localKey,
        jsonEncode([for (final x in list) x.toJson()]),
      );
      final pending = prefs.getStringList(_pendingKey) ?? <String>[];
      pending.add(jsonEncode(e.toJson()));
      // Bounded: a till offline for a month sends its newest 500, not all.
      await prefs.setStringList(
        _pendingKey,
        pending.length > 500 ? pending.sublist(pending.length - 500) : pending,
      );
    } catch (_) {}
    _changes.add(null);

    ActivityLog.instance.record(
      'card.${e.kind}',
      target: e.intentId,
      detail: {
        'outcome': e.outcome,
        'amount_minor': e.amountMinor,
        'status': e.status,
        'session_id': e.sessionId,
        'message': e.message,
        'software_house_id': e.softwareHouseId,
      },
    );
    unawaited(flush());
  }

  /// Mark a sale as (partly) refunded in the local list.
  Future<void> noteRefund(String intentId, int addMinor) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final list = [
        for (final x in await recent())
          x.kind == 'sale' && x.intentId == intentId
              ? x.withRefunded(x.refundedMinor + addMinor)
              : x,
      ];
      await prefs.setString(
        _localKey,
        jsonEncode([for (final x in list) x.toJson()]),
      );
    } catch (_) {}
    _changes.add(null);
  }

  bool _flushing = false;

  /// Send whatever has not reached the back office yet.
  Future<void> flush() async {
    if (_flushing || apiBase.isEmpty) return;
    final t = token();
    if (t == null || t.isEmpty) return;
    _flushing = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      final pending = prefs.getStringList(_pendingKey) ?? <String>[];
      if (pending.isEmpty) return;
      final batch = pending.take(50).toList();
      final res = await _client
          .post(
            Uri.parse('$apiBase/api/till/card-transactions'),
            headers: {
              'Authorization': 'Bearer $t',
              'Content-Type': 'application/json',
            },
            body: jsonEncode({
              'events': [for (final b in batch) jsonDecode(b)],
            }),
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode >= 200 && res.statusCode < 300) {
        final now = prefs.getStringList(_pendingKey) ?? <String>[];
        await prefs.setStringList(_pendingKey, now.skip(batch.length).toList());
      }
    } catch (_) {
      // Next event, or the next start, tries again.
    } finally {
      _flushing = false;
    }
  }
}
