/// The day's sales, kept on the device: what the reports, the receipts and
/// refunds read, with or without a signal.
///
/// The back office has every sale too (each one goes up through vesopa_tap's
/// outbox as the till's own `/till/orders`), so this is the device's own copy
/// for the day, as TouchPoint keeps one. End of day (Z) files a summary and
/// starts a new day; the sales themselves stay in the back office.
///
/// A refund is money handed back and is not a negative sale (the till's rule,
/// vesopa_epos order_repository.dart logRefund): it is kept against the sale
/// it came off and goes on the Z beside the takings, never inside them.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_tap/data/models.dart';

@immutable
class SoldLine {
  const SoldLine({required this.name, required this.category, required this.quantity, required this.totalMinor, this.detail = ''});
  final String name;
  final String category;
  final int quantity;
  final int totalMinor;

  /// The portion and choices, as printed under the line: "Half · Coke".
  final String detail;

  Map<String, Object?> toJson() => {'n': name, 'c': category, 'q': quantity, 't': totalMinor, if (detail.isNotEmpty) 'd': detail};
  factory SoldLine.fromJson(Map<String, dynamic> j) => SoldLine(
        name: j['n'] as String,
        category: j['c'] as String? ?? '',
        quantity: (j['q'] as num).toInt(),
        totalMinor: (j['t'] as num).toInt(),
        detail: j['d'] as String? ?? '',
      );
}

@immutable
class Paid {
  const Paid({required this.kind, required this.amountMinor, this.tipMinor = 0, this.reference});

  /// `cash`, `tap` (on this device) or `machine` (a Dojo card machine).
  final String kind;
  final int amountMinor;
  final int tipMinor;

  /// Dojo's payment id, which a card refund goes back against.
  final String? reference;
  bool get isCard => kind != 'cash';

  Map<String, Object?> toJson() => {'k': kind, 'a': amountMinor, if (tipMinor > 0) 'tip': tipMinor, if (reference != null) 'r': reference};
  factory Paid.fromJson(Map<String, dynamic> j) =>
      Paid(kind: j['k'] as String, amountMinor: (j['a'] as num).toInt(), tipMinor: (j['tip'] as num?)?.toInt() ?? 0, reference: j['r'] as String?);
}

@immutable
class Refund {
  const Refund({required this.id, required this.amountMinor, required this.kind, required this.reason, required this.by, required this.at});
  final String id;
  final int amountMinor;

  /// `cash` or `card`.
  final String kind;
  final String reason;

  /// The manager who approved it.
  final String by;
  final DateTime at;

  Map<String, Object?> toJson() => {'id': id, 'a': amountMinor, 'k': kind, 'why': reason, 'by': by, 'at': at.toIso8601String()};
  factory Refund.fromJson(Map<String, dynamic> j) => Refund(
        id: j['id'] as String,
        amountMinor: (j['a'] as num).toInt(),
        kind: j['k'] as String,
        reason: j['why'] as String? ?? '',
        by: j['by'] as String? ?? '',
        at: DateTime.parse(j['at'] as String),
      );
}

/// One finished sale.
@immutable
class SaleRecord {
  const SaleRecord({
    required this.id,
    required this.number,
    required this.at,
    required this.clerk,
    required this.lines,
    required this.subtotalMinor,
    required this.discountMinor,
    required this.totalMinor,
    required this.payments,
    this.changeMinor = 0,
    this.refunds = const [],
  });

  /// The bill's id: the same id the back office files the sale under.
  final String id;

  /// The receipt number on this device today: 1, 2, 3...
  final int number;
  final DateTime at;
  final String clerk;
  final List<SoldLine> lines;
  final int subtotalMinor;
  final int discountMinor;
  final int totalMinor;
  final List<Paid> payments;

  /// Cash handed back over the total.
  final int changeMinor;
  final List<Refund> refunds;

  int get refundedMinor => refunds.fold(0, (s, r) => s + r.amountMinor);
  int get refundableMinor => totalMinor - refundedMinor;
  int get tipsMinor => payments.fold(0, (s, p) => s + p.tipMinor);

  /// The card payment a refund goes back to, when the sale was paid by card.
  Paid? get cardPayment => payments.where((p) => p.isCard && p.reference != null).firstOrNull;

  SaleRecord withRefund(Refund r) => SaleRecord(
        id: id,
        number: number,
        at: at,
        clerk: clerk,
        lines: lines,
        subtotalMinor: subtotalMinor,
        discountMinor: discountMinor,
        totalMinor: totalMinor,
        payments: payments,
        changeMinor: changeMinor,
        refunds: [...refunds, r],
      );

  Map<String, Object?> toJson() => {
        'id': id,
        'no': number,
        'at': at.toIso8601String(),
        'clerk': clerk,
        'lines': [for (final l in lines) l.toJson()],
        'sub': subtotalMinor,
        'disc': discountMinor,
        'total': totalMinor,
        'pay': [for (final p in payments) p.toJson()],
        if (changeMinor > 0) 'change': changeMinor,
        if (refunds.isNotEmpty) 'refunds': [for (final r in refunds) r.toJson()],
      };

  factory SaleRecord.fromJson(Map<String, dynamic> j) => SaleRecord(
        id: j['id'] as String,
        number: (j['no'] as num).toInt(),
        at: DateTime.parse(j['at'] as String),
        clerk: j['clerk'] as String? ?? '',
        lines: [for (final l in j['lines'] as List) SoldLine.fromJson(Map<String, dynamic>.from(l as Map))],
        subtotalMinor: (j['sub'] as num).toInt(),
        discountMinor: (j['disc'] as num?)?.toInt() ?? 0,
        totalMinor: (j['total'] as num).toInt(),
        payments: [for (final p in j['pay'] as List) Paid.fromJson(Map<String, dynamic>.from(p as Map))],
        changeMinor: (j['change'] as num?)?.toInt() ?? 0,
        refunds: [for (final r in j['refunds'] as List? ?? const []) Refund.fromJson(Map<String, dynamic>.from(r as Map))],
      );

  /// A paid bill as the journal keeps it.
  factory SaleRecord.fromBill(Bill bill, {required int number, required Map<String, String> categoryNames, int changeMinor = 0, DateTime? at}) =>
      SaleRecord(
        id: bill.id,
        number: number,
        at: at ?? DateTime.now(),
        clerk: bill.clerk,
        lines: [
          for (final l in bill.lines)
            SoldLine(
              name: l.product.name,
              category: categoryNames[l.product.category] ?? l.product.category,
              quantity: l.quantity,
              totalMinor: l.totalMinor,
              detail: [for (final c in l.choices) c.name, if (l.note.isNotEmpty) l.note].join(' · '),
            ),
        ],
        subtotalMinor: bill.subtotalMinor,
        discountMinor: bill.discountMinor,
        totalMinor: bill.totalMinor,
        payments: [for (final t in bill.tenders) Paid(kind: t.kind, amountMinor: t.amountMinor, tipMinor: t.tipMinor, reference: t.reference)],
        changeMinor: changeMinor,
      );
}

/// What End of day files before starting a new day.
@immutable
class ZSummary {
  const ZSummary({required this.number, required this.from, required this.to, required this.sales, required this.netMinor, required this.cashMinor, required this.cardMinor, required this.refundsMinor, required this.by});
  final int number;
  final DateTime from;
  final DateTime to;
  final int sales;
  final int netMinor;
  final int cashMinor;
  final int cardMinor;
  final int refundsMinor;
  final String by;

  Map<String, Object?> toJson() => {
        'z': number,
        'from': from.toIso8601String(),
        'to': to.toIso8601String(),
        'sales': sales,
        'net': netMinor,
        'cash': cashMinor,
        'card': cardMinor,
        'refunds': refundsMinor,
        'by': by,
      };
  factory ZSummary.fromJson(Map<String, dynamic> j) => ZSummary(
        number: (j['z'] as num).toInt(),
        from: DateTime.parse(j['from'] as String),
        to: DateTime.parse(j['to'] as String),
        sales: (j['sales'] as num).toInt(),
        netMinor: (j['net'] as num).toInt(),
        cashMinor: (j['cash'] as num).toInt(),
        cardMinor: (j['card'] as num).toInt(),
        refundsMinor: (j['refunds'] as num).toInt(),
        by: j['by'] as String? ?? '',
      );
}

@immutable
class JournalState {
  const JournalState({this.sales = const [], this.zs = const [], this.dayStarted, this.loaded = false});

  /// Today's sales, newest first.
  final List<SaleRecord> sales;

  /// Past End of days, newest first (the last 60).
  final List<ZSummary> zs;
  final DateTime? dayStarted;
  final bool loaded;

  int get nextNumber => sales.isEmpty ? 1 : sales.first.number + 1;
  int get nextZ => zs.isEmpty ? 1 : zs.first.number + 1;
}

final journalProvider = NotifierProvider<Journal, JournalState>(Journal.new);

class Journal extends Notifier<JournalState> {
  static const _salesKey = 'vesopa_lite_sales';
  static const _zKey = 'vesopa_lite_z';
  static const _dayKey = 'vesopa_lite_day';

  /// False in tests and the demo's first frame: nothing is read or written.
  static bool persist = true;

  /// The read from storage. A sale can be paid before it finishes (the
  /// journal's first use may be the Pay screen), so the read merges into
  /// what is already here, and nothing is written until it is done.
  Future<void> _loading = Future.value();

  @override
  JournalState build() {
    if (persist) _loading = _load();
    return const JournalState();
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final stored = [
        for (final s in jsonDecode(prefs.getString(_salesKey) ?? '[]') as List) SaleRecord.fromJson(Map<String, dynamic>.from(s as Map)),
      ];
      final zs = [
        for (final z in jsonDecode(prefs.getString(_zKey) ?? '[]') as List) ZSummary.fromJson(Map<String, dynamic>.from(z as Map)),
      ];
      final day = prefs.getString(_dayKey);
      // Sales recorded while the read was under way, renumbered after the stored ones.
      var next = stored.isEmpty ? 1 : stored.first.number + 1;
      final ids = {for (final s in stored) s.id};
      final early = [
        for (final s in state.sales.reversed)
          if (!ids.contains(s.id)) SaleRecord.fromJson({...s.toJson(), 'no': next++}),
      ].reversed;
      state = JournalState(
        sales: [...early, ...stored],
        zs: zs,
        dayStarted: day == null ? state.dayStarted : DateTime.tryParse(day),
        loaded: true,
      );
    } catch (_) {
      state = JournalState(sales: state.sales, dayStarted: state.dayStarted, loaded: true);
    }
  }

  Future<void> _save() async {
    if (!persist) return;
    await _loading;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_salesKey, jsonEncode([for (final s in state.sales) s.toJson()]));
      await prefs.setString(_zKey, jsonEncode([for (final z in state.zs) z.toJson()]));
      if (state.dayStarted != null) await prefs.setString(_dayKey, state.dayStarted!.toIso8601String());
    } catch (_) {
      // a full or locked store: the back office still has every sale
    }
  }

  /// A bill paid in full. Returns the record, with its receipt number.
  SaleRecord record(Bill bill, {required Map<String, String> categoryNames, int changeMinor = 0}) {
    final rec = SaleRecord.fromBill(bill, number: state.nextNumber, categoryNames: categoryNames, changeMinor: changeMinor);
    state = JournalState(sales: [rec, ...state.sales], zs: state.zs, dayStarted: state.dayStarted ?? rec.at, loaded: state.loaded);
    _save();
    return rec;
  }

  void addRefund(String saleId, Refund refund) {
    state = JournalState(
      sales: [for (final s in state.sales) s.id == saleId ? s.withRefund(refund) : s],
      zs: state.zs,
      dayStarted: state.dayStarted,
      loaded: state.loaded,
    );
    _save();
  }

  /// End of day: file the summary and start a new day.
  ZSummary endOfDay({required ZSummary summary}) {
    state = JournalState(sales: const [], zs: [summary, ...state.zs].take(60).toList(), dayStarted: DateTime.now(), loaded: state.loaded);
    _save();
    return summary;
  }
}
