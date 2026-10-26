/// The numbers on the Reports screen and the End of day, worked out from the
/// day's sales. Pure, so the same figures are tested and shown.
///
///   gross      what was rung up, before discounts
///   net        what the customers paid (gross less discounts); tips are
///              on top and counted apart, as they are the staff's
///   refunds    money handed back, beside the takings and never inside them
///   cash in drawer   cash taken less cash refunded: what a count should find
library;

import 'package:flutter/foundation.dart';

import 'journal.dart';

@immutable
class Slice {
  const Slice(this.label, this.minor, {this.count = 0});
  final String label;
  final int minor;
  final int count;
}

@immutable
class DayReport {
  const DayReport({
    required this.sales,
    required this.grossMinor,
    required this.discountMinor,
    required this.netMinor,
    required this.cashMinor,
    required this.cardMinor,
    required this.tipsMinor,
    required this.refundCashMinor,
    required this.refundCardMinor,
    required this.refundCount,
    required this.byCategory,
    required this.byProduct,
    required this.byClerk,
    required this.byHour,
    this.from,
    this.to,
  });

  final int sales;
  final int grossMinor;
  final int discountMinor;
  final int netMinor;
  final int cashMinor;
  final int cardMinor;
  final int tipsMinor;
  final int refundCashMinor;
  final int refundCardMinor;
  final int refundCount;

  /// Biggest first.
  final List<Slice> byCategory;
  final List<Slice> byProduct;
  final List<Slice> byClerk;

  /// Net by hour of the day (0..23), for the shape of the day.
  final Map<int, int> byHour;
  final DateTime? from;
  final DateTime? to;

  int get refundsMinor => refundCashMinor + refundCardMinor;
  int get averageMinor => sales == 0 ? 0 : (netMinor / sales).round();
  int get cashInDrawerMinor => cashMinor - refundCashMinor;

  factory DayReport.of(List<SaleRecord> sales) {
    var gross = 0, discount = 0, net = 0, cash = 0, card = 0, tips = 0, rCash = 0, rCard = 0, rCount = 0;
    final cat = <String, (int, int)>{};
    final prod = <String, (int, int)>{};
    final clerk = <String, (int, int)>{};
    final hour = <int, int>{};
    DateTime? from, to;
    for (final s in sales) {
      gross += s.subtotalMinor;
      discount += s.discountMinor;
      net += s.totalMinor;
      for (final p in s.payments) {
        if (p.isCard) {
          card += p.amountMinor;
        } else {
          cash += p.amountMinor;
        }
        tips += p.tipMinor;
      }
      for (final r in s.refunds) {
        rCount++;
        if (r.kind == 'cash') {
          rCash += r.amountMinor;
        } else {
          rCard += r.amountMinor;
        }
      }
      for (final l in s.lines) {
        final c = l.category.isEmpty ? 'Other' : l.category;
        final a = cat[c] ?? (0, 0);
        cat[c] = (a.$1 + l.totalMinor, a.$2 + l.quantity);
        final b = prod[l.name] ?? (0, 0);
        prod[l.name] = (b.$1 + l.totalMinor, b.$2 + l.quantity);
      }
      final who = s.clerk.isEmpty ? 'Unknown' : s.clerk;
      final k = clerk[who] ?? (0, 0);
      clerk[who] = (k.$1 + s.totalMinor, k.$2 + 1);
      hour[s.at.hour] = (hour[s.at.hour] ?? 0) + s.totalMinor;
      if (from == null || s.at.isBefore(from)) from = s.at;
      if (to == null || s.at.isAfter(to)) to = s.at;
    }
    List<Slice> sorted(Map<String, (int, int)> m) =>
        [for (final e in m.entries) Slice(e.key, e.value.$1, count: e.value.$2)]..sort((a, b) => b.minor.compareTo(a.minor));
    return DayReport(
      sales: sales.length,
      grossMinor: gross,
      discountMinor: discount,
      netMinor: net,
      cashMinor: cash,
      cardMinor: card,
      tipsMinor: tips,
      refundCashMinor: rCash,
      refundCardMinor: rCard,
      refundCount: rCount,
      byCategory: sorted(cat),
      byProduct: sorted(prod),
      byClerk: sorted(clerk),
      byHour: hour,
      from: from,
      to: to,
    );
  }
}
