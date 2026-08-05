import 'local/database.dart';

/// One deal that fired on the basket.
class AppliedDeal {
  const AppliedDeal({
    required this.name,
    required this.times,
    required this.savingMinor,
  });

  final String name;

  /// How many times the deal fired — 5 qualifying items on a "2 for £3" deal
  /// fires twice, with one item left at full price.
  final int times;
  final int savingMinor;
}

class MixMatchResult {
  const MixMatchResult({required this.deals, required this.totalSavingMinor});

  final List<AppliedDeal> deals;
  final int totalSavingMinor;

  static const none = MixMatchResult(deals: [], totalSavingMinor: 0);
}

/// Works out what the basket saves under the back office's deals.
///
/// The rules, which matter because they decide what a customer is charged:
///
///  * A deal fires as many whole times as the basket allows; the remainder is
///    sold at full price.
///  * When several items qualify, the *dearest* are taken into the deal first.
///    That gives the customer the biggest saving, which is what they expect and
///    what a trading standards officer would consider fair.
///  * A deal that would cost the customer more than the items already do never
///    fires — a "3 for £6" is not applied to three items worth £5.
///  * Each item is consumed by at most one deal, so two overlapping promotions
///    cannot discount the same bottle twice.
class MixMatchEngine {
  const MixMatchEngine(this.deals, this.membership);

  final List<MixMatchDeal> deals;

  /// dealId -> the PLUs that qualify for it.
  final Map<int, Set<int>> membership;

  MixMatchResult apply(List<OrderLine> lines) {
    if (deals.isEmpty || lines.isEmpty) return MixMatchResult.none;

    // Expand the basket into individual units: a line of 3 is three chances to
    // qualify, not one.
    final units = <_Unit>[];
    for (final line in lines) {
      final qty = line.quantity.floor();
      for (var i = 0; i < qty; i++) {
        units.add(_Unit(line.pluId, line.unitPriceMinor));
      }
    }

    final consumed = <int>{};
    final applied = <AppliedDeal>[];
    var totalSaving = 0;

    // Best-paying deals first, so the customer is not left with a weak deal
    // having eaten the items a stronger one needed.
    final ordered = [...deals]
      ..sort((a, b) => b.dealPriceMinor.compareTo(a.dealPriceMinor));

    for (final deal in ordered) {
      if (!deal.active || deal.triggerQty < 1) continue;

      final qualifying = membership[deal.id] ?? const <int>{};
      if (qualifying.isEmpty) continue;

      // Candidates, dearest first.
      final candidates = <int>[];
      for (var i = 0; i < units.length; i++) {
        if (consumed.contains(i)) continue;
        if (qualifying.contains(units[i].pluId)) candidates.add(i);
      }
      candidates.sort(
        (a, b) => units[b].priceMinor.compareTo(units[a].priceMinor),
      );

      var times = 0;
      var saving = 0;
      var offset = 0;

      while (candidates.length - offset >= deal.triggerQty) {
        final group = candidates.sublist(offset, offset + deal.triggerQty);
        final normal = group.fold<int>(0, (s, i) => s + units[i].priceMinor);

        // Never charge more than the shelf price.
        if (deal.dealPriceMinor >= normal) break;

        saving += normal - deal.dealPriceMinor;
        consumed.addAll(group);
        times++;
        offset += deal.triggerQty;
      }

      if (times > 0) {
        applied.add(
          AppliedDeal(name: deal.name, times: times, savingMinor: saving),
        );
        totalSaving += saving;
      }
    }

    return MixMatchResult(deals: applied, totalSavingMinor: totalSaving);
  }
}

class _Unit {
  const _Unit(this.pluId, this.priceMinor);
  final int pluId;
  final int priceMinor;
}
