import 'dart:convert';

import 'package:http/http.dart' as http;

/// Money the till can take, beyond cash and card.
///
/// A gift card and a deposit are *held* money — the venue already has it, so
/// redeeming reduces what is left to pay without taking anything new. A
/// voucher and loyalty points are *discounts* — they reduce the bill itself.
/// The distinction decides what appears on the receipt and in the Z report,
/// so it is modelled explicitly rather than lumped into one "other" tender.
enum TenderKind {
  cash,
  card,
  manualCard,
  giftCard,
  voucher,
  deposit,
  points,
  account;

  String get label => switch (this) {
        TenderKind.cash => 'Cash',
        TenderKind.card => 'Card',
        TenderKind.manualCard => 'Manual card',
        TenderKind.giftCard => 'Gift card',
        TenderKind.voucher => 'Voucher',
        TenderKind.deposit => 'Deposit',
        TenderKind.points => 'Points',
        TenderKind.account => 'On account',
      };

  /// What goes in the `method` column, and therefore on the receipt.
  String get method => switch (this) {
        TenderKind.manualCard => 'card',
        TenderKind.giftCard => 'giftcard',
        _ => name.toLowerCase(),
      };
}

/// How the venue takes money: gratuity rules and the quick keys.
class TenderSettings {
  const TenderSettings({
    this.gratuityEnabled = true,
    this.gratuityMode = 'prompt',
    this.gratuityPresets = const [5.0, 10.0, 12.5, 15.0, 20.0],
    this.gratuityDefaultBp = 125,
    this.gratuityRemovable = true,
    this.gratuityMinCovers = 0,
    this.cashPresets = const [500, 1000, 2000],
    this.cashQuickRound = true,
    this.allowPartialCard = true,
    this.allowSplitBill = true,
  });

  final bool gratuityEnabled;

  /// 'off' | 'prompt' | 'auto'
  final String gratuityMode;

  /// Percentages offered as buttons.
  final List<double> gratuityPresets;

  /// Tenths of a percent: 12.5% is 125. Integer maths keeps it exact.
  final int gratuityDefaultBp;
  final bool gratuityRemovable;
  final int gratuityMinCovers;

  final List<int> cashPresets;
  final bool cashQuickRound;
  final bool allowPartialCard;
  final bool allowSplitBill;

  bool get autoGratuity => gratuityEnabled && gratuityMode == 'auto';
  bool get promptGratuity => gratuityEnabled && gratuityMode == 'prompt';

  /// Whether an automatic service charge applies to a table of [covers].
  bool autoAppliesTo(int? covers) {
    if (!autoGratuity) return false;
    if (gratuityMinCovers <= 0) return true;
    return (covers ?? 0) >= gratuityMinCovers;
  }

  /// Gratuity on [baseMinor] at [bp] tenths of a percent.
  static int gratuityOn(int baseMinor, int bp) =>
      (baseMinor * bp / 1000).round();

  static bool _flag(Object? v) => v == 1 || v == true || v == '1';

  static List<double> _percents(Object? v) {
    final text = (v as String?) ?? '';
    return text
        .split(',')
        .map((s) => double.tryParse(s.trim()))
        .whereType<double>()
        .toList();
  }

  static List<int> _amounts(Object? v) {
    final text = (v as String?) ?? '';
    return text
        .split(',')
        .map((s) => int.tryParse(s.trim()))
        .whereType<int>()
        .toList();
  }

  factory TenderSettings.fromJson(Map<String, dynamic> j) {
    final presets = _percents(j['gratuity_presets']);
    final cash = _amounts(j['cash_presets']);
    return TenderSettings(
      gratuityEnabled: _flag(j['gratuity_enabled']),
      gratuityMode: j['gratuity_mode'] as String? ?? 'prompt',
      // Fall back rather than showing a keypad with no keys on it.
      gratuityPresets:
          presets.isEmpty ? const [5.0, 10.0, 12.5, 15.0, 20.0] : presets,
      gratuityDefaultBp: (j['gratuity_default_bp'] as num?)?.toInt() ?? 125,
      gratuityRemovable: _flag(j['gratuity_removable']),
      gratuityMinCovers: (j['gratuity_min_covers'] as num?)?.toInt() ?? 0,
      cashPresets: cash.isEmpty ? const [500, 1000, 2000] : cash,
      cashQuickRound: _flag(j['cash_quick_round']),
      allowPartialCard: _flag(j['allow_partial_card']),
      allowSplitBill: _flag(j['allow_split_bill']),
    );
  }
}

/// An offer that can reduce a line or a whole sale.
class Promotion {
  const Promotion({
    required this.id,
    required this.name,
    required this.kind,
    this.value = 0,
    this.buyQty = 0,
    this.freeQty = 0,
    this.dealPriceMinor = 0,
    this.scope = 'product',
    this.scopeValue,
    this.minSpendMinor = 0,
    this.daysOfWeek = '1111111',
    this.startTime,
    this.endTime,
    this.badgeText,
    this.badgeColour = '#d81b60',
    this.stackable = false,
    this.priority = 0,
    this.products = const [],
  });

  final int id;
  final String name;

  /// 'percent' | 'amount' | 'fixed_price' | 'multibuy' | 'bogof'
  final String kind;

  /// percent: tenths of a percent. amount/fixed_price: minor units.
  final int value;
  final int buyQty;
  final int freeQty;
  final int dealPriceMinor;

  /// 'product' | 'department' | 'group' | 'order'
  final String scope;
  final String? scopeValue;
  final int minSpendMinor;

  /// Mon-first 7-character mask, e.g. "1111100" for weekdays.
  final String daysOfWeek;
  final String? startTime;
  final String? endTime;

  final String? badgeText;
  final String badgeColour;
  final bool stackable;
  final int priority;
  final List<int> products;

  bool get isMultibuy => kind == 'multibuy' || kind == 'bogof';

  /// Whether this offer is live at [now]. Date range is filtered server-side;
  /// the day and time window has to be checked on the till, because a happy
  /// hour starts while the terminal is already running.
  bool activeAt(DateTime now) {
    // DateTime.weekday is 1=Monday, matching the mask's order.
    if (daysOfWeek.length == 7) {
      if (daysOfWeek[now.weekday - 1] != '1') return false;
    }
    final from = _minutes(startTime);
    final to = _minutes(endTime);
    if (from == null || to == null) return true;

    final nowMins = now.hour * 60 + now.minute;
    // A window that ends before it starts runs over midnight.
    return to >= from
        ? nowMins >= from && nowMins <= to
        : nowMins >= from || nowMins <= to;
  }

  static int? _minutes(String? hhmm) {
    if (hhmm == null || hhmm.isEmpty) return null;
    final parts = hhmm.split(':');
    if (parts.length < 2) return null;
    final h = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    if (h == null || m == null) return null;
    return h * 60 + m;
  }

  /// Whether this promotion covers a given product.
  bool covers({
    required int pluid,
    String? department,
    String? group,
  }) =>
      switch (scope) {
        'order' => true,
        'department' => scopeValue != null && department == scopeValue,
        'group' => scopeValue != null && group == scopeValue,
        _ => products.contains(pluid),
      };

  factory Promotion.fromJson(Map<String, dynamic> j) => Promotion(
        id: (j['id'] as num).toInt(),
        name: j['name'] as String? ?? '',
        kind: j['kind'] as String? ?? 'percent',
        value: (j['value'] as num?)?.toInt() ?? 0,
        buyQty: (j['buy_qty'] as num?)?.toInt() ?? 0,
        freeQty: (j['free_qty'] as num?)?.toInt() ?? 0,
        dealPriceMinor: (j['deal_price_minor'] as num?)?.toInt() ?? 0,
        scope: j['scope'] as String? ?? 'product',
        scopeValue: j['scope_value'] as String?,
        minSpendMinor: (j['min_spend_minor'] as num?)?.toInt() ?? 0,
        daysOfWeek: j['days_of_week'] as String? ?? '1111111',
        startTime: j['start_time'] as String?,
        endTime: j['end_time'] as String?,
        badgeText: j['badge_text'] as String?,
        badgeColour: j['badge_colour'] as String? ?? '#d81b60',
        stackable: j['stackable'] == 1 || j['stackable'] == true,
        priority: (j['priority'] as num?)?.toInt() ?? 0,
        products: ((j['products'] as List?) ?? const [])
            .map((p) => (p as num).toInt())
            .toList(),
      );
}

/// A gift card as the till sees it.
class GiftCard {
  const GiftCard({
    required this.id,
    required this.code,
    required this.balanceMinor,
    required this.status,
    this.kind = 'smart',
    this.expired = false,
    this.recipientName,
  });

  final String id;
  final String code;
  final int balanceMinor;
  final String status;
  final String kind;
  final bool expired;
  final String? recipientName;

  bool get redeemable => status == 'active' && !expired && balanceMinor > 0;

  factory GiftCard.fromJson(Map<String, dynamic> j) => GiftCard(
        id: j['id'] as String? ?? '',
        code: j['code'] as String? ?? '',
        balanceMinor: (j['balance_minor'] as num?)?.toInt() ?? 0,
        status: j['status'] as String? ?? 'active',
        kind: j['kind'] as String? ?? 'smart',
        expired: j['expired'] == true,
        recipientName: j['recipient_name'] as String?,
      );
}

/// A deposit held against a booking.
class Deposit {
  const Deposit({
    required this.id,
    required this.reference,
    required this.amountMinor,
    required this.redeemedMinor,
    required this.status,
    this.customerName,
    this.description,
  });

  final String id;
  final String reference;
  final int amountMinor;
  final int redeemedMinor;
  final String status;
  final String? customerName;
  final String? description;

  int get remainingMinor => amountMinor - redeemedMinor;
  bool get redeemable => status == 'held' && remainingMinor > 0;

  factory Deposit.fromJson(Map<String, dynamic> j) => Deposit(
        id: j['id'] as String? ?? '',
        reference: j['reference'] as String? ?? '',
        amountMinor: (j['amount_minor'] as num?)?.toInt() ?? 0,
        redeemedMinor: (j['redeemed_minor'] as num?)?.toInt() ?? 0,
        status: j['status'] as String? ?? 'held',
        customerName: j['customer_name'] as String?,
        description: j['description'] as String?,
      );
}

/// A validated voucher and what it is worth against this bill.
class VoucherCheck {
  const VoucherCheck({
    required this.code,
    required this.valid,
    required this.discountMinor,
    this.name,
    this.reasons = const [],
    this.freeProductPluid,
  });

  final String code;
  final bool valid;
  final int discountMinor;
  final String? name;
  final List<String> reasons;
  final int? freeProductPluid;

  String get problem => reasons.isEmpty ? 'Not valid' : reasons.first;

  factory VoucherCheck.fromJson(Map<String, dynamic> j) => VoucherCheck(
        code: j['code'] as String? ?? '',
        valid: j['valid'] == true,
        discountMinor: (j['discount_minor'] as num?)?.toInt() ?? 0,
        name: j['name'] as String?,
        reasons: ((j['reasons'] as List?) ?? const []).cast<String>(),
        freeProductPluid: (j['free_product_pluid'] as num?)?.toInt(),
      );
}

/// A loyalty member and what their points are worth.
///
/// The scheme rules travel with the customer rather than being held separately,
/// because every question the till asks — can they redeem, how much is a point
/// worth, what will this sale earn — needs both, and a customer priced against
/// stale settings is a customer given the wrong discount.
class LoyaltyCustomer {
  const LoyaltyCustomer({
    required this.id,
    required this.name,
    required this.pointsBalance,
    required this.pointsValueMinor,
    required this.redeemable,
    this.phone,
    this.cardNumber,
    this.tierName,
    this.tierMultiplier = 1.0,
    this.visits = 0,
    this.enabled = true,
    this.minRedeemPoints = 100,
    this.redeemStepPoints = 100,
    this.pointValueMinor = 1,
    this.pointsPerPound = 1,
    this.minSpendMinor = 0,
  });

  final String id;
  final String name;
  final int pointsBalance;
  final int pointsValueMinor;
  final bool redeemable;
  final String? phone;
  final String? cardNumber;
  final String? tierName;

  /// What this tier multiplies earnings by — the reason for having tiers at
  /// all. 1.0 when the customer is not on one.
  final double tierMultiplier;
  final int visits;

  /// Whether the venue's scheme is switched on. A retired scheme still has
  /// members and balances; it just stops moving points.
  final bool enabled;

  final int minRedeemPoints;
  final int redeemStepPoints;
  final int pointValueMinor;
  final int pointsPerPound;

  /// Spend below this earns nothing.
  final int minSpendMinor;

  int get _step => redeemStepPoints > 0 ? redeemStepPoints : 1;

  /// The most this customer can take off a bill of [outstandingMinor].
  ///
  /// Rounded down to a whole redemption step: a scheme that redeems in
  /// hundreds must not hand back 137 points' worth.
  int maxRedeemableAgainst(int outstandingMinor) {
    if (!enabled || !redeemable || pointValueMinor <= 0) return 0;
    final affordable = outstandingMinor ~/ pointValueMinor;
    final usable = affordable < pointsBalance ? affordable : pointsBalance;
    final stepped = (usable ~/ _step) * _step;
    return stepped >= minRedeemPoints ? stepped : 0;
  }

  /// Every amount the clerk may redeem against a bill, smallest first.
  ///
  /// Redeeming is a conversation — "put £5 of your points against it" — not an
  /// all-or-nothing button, which is how UK schemes are actually operated. The
  /// steps come from the scheme so a till can never offer a redemption the back
  /// office would refuse.
  List<int> redemptionOptions(int outstandingMinor) {
    final max = maxRedeemableAgainst(outstandingMinor);
    if (max <= 0) return const [];
    return [
      for (var points = minRedeemPoints; points <= max; points += _step) points,
      // The floor may not itself be a multiple of the step, so the top of the
      // range is added explicitly rather than assumed to fall on one.
      if ((max - minRedeemPoints) % _step != 0) max,
    ];
  }

  /// What [points] are worth as money.
  int valueOf(int points) => points * pointValueMinor;

  /// Points a spend of [spendMinor] would earn, including this customer's tier
  /// multiplier — the same arithmetic the server does, so the receipt promises
  /// what the ledger will actually award.
  int pointsFor(int spendMinor) {
    if (!enabled || spendMinor < minSpendMinor) return 0;
    return ((spendMinor ~/ 100) * pointsPerPound * tierMultiplier).round();
  }

  /// Read a MySQL DECIMAL, which arrives over JSON as a string rather than a
  /// number. Every multiplier and rate in the loyalty settings is one of these.
  static double _decimal(Object? value, double fallback) => switch (value) {
        final num n => n.toDouble(),
        final String s => double.tryParse(s) ?? fallback,
        _ => fallback,
      };

  factory LoyaltyCustomer.fromJson(Map<String, dynamic> j) {
    final settings = (j['settings'] as Map?)?.cast<String, dynamic>() ?? {};
    final tierName = j['tier_name'] as String?;
    final tiers = ((settings['tiers'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final tier = tiers.where((t) => t['name'] == tierName).firstOrNull;

    return LoyaltyCustomer(
      id: j['id'] as String? ?? '',
      name: j['name'] as String? ?? 'Guest',
      phone: j['phone'] as String?,
      cardNumber: j['card_number'] as String?,
      pointsBalance: (j['points_balance'] as num?)?.toInt() ?? 0,
      pointsValueMinor: (j['points_value_minor'] as num?)?.toInt() ?? 0,
      redeemable: j['redeemable'] == true,
      tierName: tierName,
      // MySQL sends DECIMAL as a *string* ("1.50"), not a number, so a plain
      // `as num?` cast silently yields null and every tier quietly earns ×1.
      tierMultiplier: _decimal(tier?['points_multiplier'], 1.0),
      visits: (j['visits'] as num?)?.toInt() ?? 0,
      enabled: settings['enabled'] != 0 && settings['enabled'] != false,
      minRedeemPoints: (settings['min_redeem_points'] as num?)?.toInt() ?? 100,
      redeemStepPoints: (settings['redeem_step_points'] as num?)?.toInt() ?? 100,
      pointValueMinor: (settings['point_value_minor'] as num?)?.toInt() ?? 1,
      pointsPerPound: (settings['points_per_pound'] as num?)?.toInt() ?? 1,
      minSpendMinor: (settings['min_spend_minor'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Talks to the commerce endpoints.
///
/// Read paths (promotions, tender settings) are cached so the till keeps
/// selling and keeps applying offers when the network is down. Write paths
/// (redeeming a card, spending points) are deliberately *not* cached or
/// queued: they move money that another terminal can also move, so they must
/// reach the server and be confirmed before the till treats them as done.
class CommerceRepository {
  CommerceRepository({
    required this.apiBase,
    required this.office,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;
  final String office;
  final http.Client _client;

  static const _timeout = Duration(seconds: 10);

  TenderSettings? _tender;
  List<Promotion>? _promotions;

  TenderSettings get tenderSettings => _tender ?? const TenderSettings();
  List<Promotion> get promotions => _promotions ?? const [];

  String get _officeParam => 'office=${Uri.encodeComponent(office)}';

  Future<TenderSettings> loadTenderSettings() async {
    try {
      final res = await _client
          .get(Uri.parse('$apiBase/api/tender-settings/public?$_officeParam'))
          .timeout(_timeout);
      if (res.statusCode != 200) return tenderSettings;
      return _tender = TenderSettings.fromJson(
          jsonDecode(res.body) as Map<String, dynamic>);
    } catch (_) {
      return tenderSettings;
    }
  }

  Future<List<Promotion>> loadPromotions() async {
    try {
      final res = await _client
          .get(Uri.parse('$apiBase/api/promotions/public?$_officeParam'))
          .timeout(_timeout);
      if (res.statusCode != 200) return promotions;
      return _promotions = (jsonDecode(res.body) as List)
          .cast<Map<String, dynamic>>()
          .map(Promotion.fromJson)
          .toList();
    } catch (_) {
      return promotions;
    }
  }

  /// Look up a gift card. Throws with a readable message so the till can show
  /// the clerk why a card was refused.
  Future<GiftCard> giftCard(String code) async {
    final res = await _client
        .get(Uri.parse(
            '$apiBase/api/gift-cards/lookup?$_officeParam&code=${Uri.encodeComponent(code)}'))
        .timeout(_timeout);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw CommerceException(body['error'] as String? ?? 'No such gift card');
    }
    return GiftCard.fromJson(body);
  }

  Future<GiftCard> redeemGiftCard({
    required String code,
    required int amountMinor,
    String? orderId,
    String? clerkName,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$apiBase/api/gift-cards/redeem'),
          headers: const {'Content-Type': 'application/json'},
          body: jsonEncode({
            'office': office,
            'code': code,
            'amount_minor': amountMinor,
            'order_id': orderId,
            'clerk_name': clerkName,
          }),
        )
        .timeout(_timeout);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw CommerceException(body['error'] as String? ?? 'Could not redeem');
    }
    return GiftCard.fromJson(body);
  }

  Future<Deposit> deposit(String reference) async {
    final res = await _client
        .get(Uri.parse(
            '$apiBase/api/deposits/lookup?$_officeParam&reference=${Uri.encodeComponent(reference)}'))
        .timeout(_timeout);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw CommerceException(body['error'] as String? ?? 'No such deposit');
    }
    return Deposit.fromJson(body);
  }

  Future<int> redeemDeposit({
    required String reference,
    int? amountMinor,
    String? orderId,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$apiBase/api/deposits/redeem'),
          headers: const {'Content-Type': 'application/json'},
          body: jsonEncode({
            'office': office,
            'reference': reference,
            'amount_minor': ?amountMinor,
            'order_id': orderId,
          }),
        )
        .timeout(_timeout);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw CommerceException(body['error'] as String? ?? 'Could not redeem');
    }
    return (body['applied_minor'] as num?)?.toInt() ?? 0;
  }

  Future<VoucherCheck> checkVoucher({
    required String code,
    required int subtotalMinor,
  }) async {
    final res = await _client
        .get(Uri.parse(
            '$apiBase/api/vouchers/validate?$_officeParam'
            '&code=${Uri.encodeComponent(code)}&subtotal_minor=$subtotalMinor'))
        .timeout(_timeout);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw CommerceException(body['error'] as String? ?? 'No such voucher');
    }
    return VoucherCheck.fromJson(body);
  }

  Future<void> redeemVoucher(String code) async {
    await _client
        .post(
          Uri.parse('$apiBase/api/vouchers/redeem'),
          headers: const {'Content-Type': 'application/json'},
          body: jsonEncode({'office': office, 'code': code}),
        )
        .timeout(_timeout);
  }

  /// Find members by name, phone, card number or email.
  ///
  /// A regular is known by name and a card scheme is claimed by scanning, so
  /// exact-phone lookup alone left the clerk unable to find a customer standing
  /// in front of them. Returns an empty list rather than throwing when nothing
  /// matches — no match is an answer, not a failure.
  Future<List<LoyaltyCustomer>> searchLoyalty(String query) async {
    final res = await _client
        .get(Uri.parse(
            '$apiBase/api/loyalty/search?$_officeParam'
            '&q=${Uri.encodeComponent(query)}'))
        .timeout(_timeout);
    if (res.statusCode != 200) return const [];
    return (jsonDecode(res.body) as List)
        .cast<Map<String, dynamic>>()
        .map(LoyaltyCustomer.fromJson)
        .toList();
  }

  Future<LoyaltyCustomer> loyaltyByPhone(String phone) async {
    final res = await _client
        .get(Uri.parse(
            '$apiBase/api/loyalty/customer?$_officeParam&phone=${Uri.encodeComponent(phone)}'))
        .timeout(_timeout);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw CommerceException(
          body['error'] as String? ?? 'No customer with that number');
    }
    return LoyaltyCustomer.fromJson(body);
  }

  Future<LoyaltyCustomer> enrol({
    required String phone,
    required String name,
    String? email,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$apiBase/api/loyalty/customer'),
          headers: const {'Content-Type': 'application/json'},
          body: jsonEncode({
            'office': office,
            'phone': phone,
            'name': name,
            'email': email,
          }),
        )
        .timeout(_timeout);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw CommerceException(body['error'] as String? ?? 'Could not enrol');
    }
    // The create response is a bare customer row without the settings block,
    // so re-read it to get the redemption rules with it.
    return loyaltyByPhone(phone);
  }

  /// Award or spend points. Returns the new balance.
  Future<int> movePoints({
    required String customerId,
    required String kind,
    int? points,
    int spendMinor = 0,
    String? orderId,
  }) async {
    final res = await _client
        .post(
          Uri.parse('$apiBase/api/loyalty/points'),
          headers: const {'Content-Type': 'application/json'},
          body: jsonEncode({
            'office': office,
            'customer_id': customerId,
            'kind': kind,
            'points': ?points,
            'spend_minor': spendMinor,
            'order_id': orderId,
          }),
        )
        .timeout(_timeout);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw CommerceException(body['error'] as String? ?? 'Could not update points');
    }
    return (body['points_balance'] as num?)?.toInt() ?? 0;
  }
}

/// A refusal the clerk needs to see, as opposed to a bug.
class CommerceException implements Exception {
  const CommerceException(this.message);
  final String message;
  @override
  String toString() => message;
}
