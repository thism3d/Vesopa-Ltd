import 'commerce.dart';

/// A basket line as the pricing engine sees it.
class PricedLine {
  const PricedLine({
    required this.id,
    required this.pluid,
    required this.name,
    required this.quantity,
    required this.unitPriceMinor,
    this.taxPercentage = 0,
    this.department,
    this.group,
    this.note,
    this.discountMinor = 0,
    this.promotionName,
    this.promotionId,
    this.addedBy,
    this.addedAt,
  });

  final String id;
  final int pluid;
  final String name;
  final double quantity;
  final int unitPriceMinor;
  final double taxPercentage;
  final String? department;
  final String? group;
  final String? note;

  /// What the promotion took off this line. Always positive.
  final int discountMinor;
  final String? promotionName;
  final int? promotionId;

  /// Who put this item on the bill, and when. Carried through pricing untouched
  /// so the check view can group a parked table's items by the person who served
  /// them. Null on a venue that does not use staff sign-on.
  final String? addedBy;
  final DateTime? addedAt;

  /// Before any offer.
  int get grossMinor => (unitPriceMinor * quantity).round();

  /// What the customer actually pays for this line.
  int get netMinor => grossMinor - discountMinor;

  bool get discounted => discountMinor > 0;

  PricedLine withDiscount({
    required int discountMinor,
    String? promotionName,
    int? promotionId,
  }) =>
      PricedLine(
        id: id,
        pluid: pluid,
        name: name,
        quantity: quantity,
        unitPriceMinor: unitPriceMinor,
        taxPercentage: taxPercentage,
        department: department,
        group: group,
        note: note,
        discountMinor: discountMinor,
        promotionName: promotionName,
        promotionId: promotionId,
        addedBy: addedBy,
        addedAt: addedAt,
      );
}

/// The full money picture for a bill, in the order it appears on a receipt.
class BasketTotals {
  const BasketTotals({
    required this.lines,
    required this.grossMinor,
    required this.promoMinor,
    required this.manualDiscountMinor,
    this.customerDiscountMinor = 0,
    required this.voucherMinor,
    required this.pointsMinor,
    required this.gratuityMinor,
    required this.totalMinor,
    required this.taxMinor,
    this.gratuityBp = 0,
    this.appliedPromotions = const [],
  });

  final List<PricedLine> lines;

  /// Goods at full price.
  final int grossMinor;

  /// Taken off by automatic offers.
  final int promoMinor;

  /// Taken off by the clerk.
  final int manualDiscountMinor;

  /// The attached customer's standing entitlement — a staff rate, a member's
  /// 10%. Held apart from [manualDiscountMinor] so the receipt can say *why*
  /// the bill is lower; a clerk who cannot see the loyalty discount land
  /// reasonably concludes it is broken.
  final int customerDiscountMinor;

  final int voucherMinor;
  final int pointsMinor;
  final int gratuityMinor;
  final int gratuityBp;

  /// What the customer owes.
  final int totalMinor;

  /// VAT already inside [totalMinor].
  final int taxMinor;

  final List<String> appliedPromotions;

  /// Everything taken off, for the "you saved" line.
  int get savedMinor =>
      promoMinor +
      manualDiscountMinor +
      customerDiscountMinor +
      voucherMinor +
      pointsMinor;

  /// Goods after discounts but before service — what gratuity is charged on,
  /// and what loyalty points are earned on.
  int get netGoodsMinor =>
      grossMinor - promoMinor - manualDiscountMinor - customerDiscountMinor;

  static const empty = BasketTotals(
    lines: [],
    grossMinor: 0,
    promoMinor: 0,
    manualDiscountMinor: 0,
    voucherMinor: 0,
    pointsMinor: 0,
    gratuityMinor: 0,
    totalMinor: 0,
    taxMinor: 0,
  );
}

/// Applies promotions and works out what a bill comes to.
///
/// Deliberately pure and synchronous: the sale screen re-prices on every tap,
/// so this must be cheap and must never depend on the network. Offers are
/// fetched once and cached by [CommerceRepository]; this only decides how they
/// land on a particular basket.
///
/// Order of operations matters and is fixed:
///   goods → automatic promotions → manual discount → voucher → points →
///   gratuity.
/// Gratuity is charged on the discounted goods, never on the pre-discount
/// price, and never on the voucher or points already taken off — charging
/// service on money the customer did not spend is the kind of error that ends
/// up in a complaint.
class PricingEngine {
  const PricingEngine({this.promotions = const [], this.now});

  final List<Promotion> promotions;

  /// Injectable for tests, so a happy-hour offer can be exercised without
  /// waiting for 5pm.
  final DateTime? now;

  DateTime get _now => now ?? DateTime.now();

  /// Prices a basket.
  ///
  /// [manualDiscountMinor], [voucherMinor] and [pointsMinor] are what the
  /// clerk has already agreed; this clamps them so the bill can never go
  /// below zero however they combine.
  BasketTotals price(
    List<PricedLine> rawLines, {
    int manualDiscountMinor = 0,
    int customerDiscountMinor = 0,
    int voucherMinor = 0,
    int pointsMinor = 0,
    int gratuityBp = 0,
    bool gratuityApplies = false,
  }) {
    final live = promotions.where((p) => p.activeAt(_now)).toList()
      // Highest priority first, so a specific offer beats a general one.
      ..sort((a, b) => b.priority.compareTo(a.priority));

    final gross = rawLines.fold<int>(0, (s, l) => s + l.grossMinor);

    final priced = <PricedLine>[];
    final applied = <String>{};

    for (final line in rawLines) {
      var best = 0;
      Promotion? bestPromo;

      for (final promo in live) {
        if (promo.scope == 'order') continue; // handled after the lines
        if (!promo.covers(
          pluid: line.pluid,
          department: line.department,
          group: line.group,
        )) {
          continue;
        }
        if (promo.minSpendMinor > 0 && gross < promo.minSpendMinor) continue;

        final discount = _discountFor(promo, line);
        // Best-for-the-customer wins among non-stacking offers. Two 10%
        // promotions on one item is a pricing mistake, not a double discount.
        if (discount > best) {
          best = discount;
          bestPromo = promo;
        }
      }

      if (bestPromo != null && best > 0) {
        applied.add(bestPromo.name);
        priced.add(line.withDiscount(
          discountMinor: best,
          promotionName: bestPromo.name,
          promotionId: bestPromo.id,
        ));
      } else {
        priced.add(line);
      }
    }

    var promoTotal = priced.fold<int>(0, (s, l) => s + l.discountMinor);

    // Whole-sale offers, applied to what is left after line offers.
    final afterLines = gross - promoTotal;
    for (final promo in live.where((p) => p.scope == 'order')) {
      if (promo.minSpendMinor > 0 && afterLines < promo.minSpendMinor) continue;
      final discount = switch (promo.kind) {
        'percent' => (afterLines * promo.value / 1000).round(),
        'amount' => promo.value,
        _ => 0,
      };
      if (discount > 0) {
        // Never take off more than is left on the bill at this point.
        final headroom = gross - promoTotal;
        promoTotal += discount.clamp(0, headroom);
        applied.add(promo.name);
        // Only the best whole-sale offer applies unless it stacks.
        if (!promo.stackable) break;
      }
    }
    promoTotal = promoTotal.clamp(0, gross);

    // Each reduction is clamped against what is actually left, so the running
    // total cannot pass through zero and come back as change owed.
    var remaining = gross - promoTotal;
    final manual = manualDiscountMinor.clamp(0, remaining);
    remaining -= manual;
    // The customer's standing discount sits with the manual one: both are
    // reductions on the goods, before vouchers and points are spent against
    // what is left.
    final customer = customerDiscountMinor.clamp(0, remaining);
    remaining -= customer;
    final voucher = voucherMinor.clamp(0, remaining);
    remaining -= voucher;
    final points = pointsMinor.clamp(0, remaining);
    remaining -= points;

    final gratuity = gratuityApplies && gratuityBp > 0
        ? TenderSettings.gratuityOn(remaining, gratuityBp)
        : 0;

    final total = remaining + gratuity;

    // VAT is inside the price. It is apportioned across the *discounted* line
    // values: a discount reduces the VAT due with it, so working it out from
    // the gross would over-report tax.
    var tax = 0;
    final discountable = gross - promoTotal;
    for (final line in priced) {
      if (line.taxPercentage <= 0) continue;
      // This line's share of the reductions that came after promotions.
      final share = discountable <= 0
          ? 0
          : ((manual + customer + voucher + points) * line.netMinor /
                  discountable)
              .round();
      final taxable = line.netMinor - share;
      if (taxable <= 0) continue;
      tax += (taxable - taxable / (1 + line.taxPercentage / 100)).round();
    }

    return BasketTotals(
      lines: priced,
      grossMinor: gross,
      promoMinor: promoTotal,
      manualDiscountMinor: manual,
      customerDiscountMinor: customer,
      voucherMinor: voucher,
      pointsMinor: points,
      gratuityMinor: gratuity,
      gratuityBp: gratuityApplies ? gratuityBp : 0,
      totalMinor: total,
      taxMinor: tax,
      appliedPromotions: applied.toList(),
    );
  }

  /// What one promotion is worth on one line.
  int _discountFor(Promotion promo, PricedLine line) {
    final qty = line.quantity;
    final gross = line.grossMinor;

    switch (promo.kind) {
      case 'percent':
        return (gross * promo.value / 1000).round();

      case 'amount':
        // Per unit, so "50p off" on three items is £1.50.
        return (promo.value * qty).round().clamp(0, gross);

      case 'fixed_price':
        final deal = (promo.value * qty).round();
        return (gross - deal).clamp(0, gross);

      case 'multibuy':
        // "3 for £10": every complete group of `buy_qty` is charged the deal
        // price; the remainder stays at full price.
        if (promo.buyQty <= 0 || qty < promo.buyQty) return 0;
        final groups = qty ~/ promo.buyQty;
        final normal = (line.unitPriceMinor * promo.buyQty * groups).round();
        final deal = promo.dealPriceMinor * groups;
        return (normal - deal).clamp(0, gross);

      case 'bogof':
        // "Buy 2 get 1 free": the cheapest items in each complete group are
        // free. Lines are single-product here, so that is `free_qty` units.
        if (promo.buyQty <= 0 || promo.freeQty <= 0) return 0;
        final blockSize = promo.buyQty + promo.freeQty;
        if (qty < blockSize) return 0;
        final blocks = qty ~/ blockSize;
        return (line.unitPriceMinor * promo.freeQty * blocks)
            .round()
            .clamp(0, gross);

      default:
        return 0;
    }
  }

  /// The badge to paint on a product button, if any offer covers it now.
  Promotion? badgeFor({
    required int pluid,
    String? department,
    String? group,
  }) {
    final live = promotions
        .where((p) =>
            p.activeAt(_now) &&
            (p.badgeText?.isNotEmpty ?? false) &&
            p.covers(pluid: pluid, department: department, group: group))
        .toList()
      ..sort((a, b) => b.priority.compareTo(a.priority));
    return live.isEmpty ? null : live.first;
  }
}
