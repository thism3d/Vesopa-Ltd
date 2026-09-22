import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';

/// Builds the payload the server actually sends, including the traps: MySQL
/// hands DECIMAL columns back as *strings*, and the tier a customer is on is
/// named on the customer but defined in the settings block.
Map<String, dynamic> _payload({
  int balance = 1000,
  String? tier,
  Object? multiplier = '1.00',
  int pointsPerPound = 1,
  int pointValueMinor = 1,
  int minRedeem = 100,
  int step = 100,
  int minSpend = 0,
  Object enabled = 1,
}) => {
      'id': 'cust-1',
      'name': 'R. Patel',
      'phone': '07700900456',
      'points_balance': balance,
      'points_value_minor': balance * pointValueMinor,
      'redeemable': balance >= minRedeem,
      'tier_name': tier,
      'settings': {
        'enabled': enabled,
        'points_per_pound': pointsPerPound,
        'point_value_minor': pointValueMinor,
        'min_redeem_points': minRedeem,
        'redeem_step_points': step,
        'min_spend_minor': minSpend,
        'tiers': [
          if (tier != null) {'name': tier, 'points_multiplier': multiplier},
        ],
      },
    };

void main() {
  group('earning', () {
    test('applies the scheme rate per whole pound', () {
      final c = LoyaltyCustomer.fromJson(_payload(pointsPerPound: 2));
      // £100 at 2/£.
      expect(c.pointsFor(10000), 200);
      // Part-pounds are dropped rather than rounded up: £1.99 is one whole
      // pound, so two points — not four.
      expect(c.pointsFor(199), 2);
      expect(c.pointsFor(99), 0);
    });

    test('applies the tier multiplier sent as a MySQL decimal string', () {
      final c = LoyaltyCustomer.fromJson(
        _payload(pointsPerPound: 2, tier: 'Platinum', multiplier: '2.00'),
      );
      // The regression this guards: `as num?` on "2.00" yields null, the
      // multiplier silently falls back to 1, and a Platinum member earns the
      // same as a walk-in.
      expect(c.tierMultiplier, 2.0);
      expect(c.pointsFor(10000), 400);
    });

    test('reads a numeric multiplier too', () {
      final c = LoyaltyCustomer.fromJson(
        _payload(tier: 'Gold', multiplier: 1.5),
      );
      expect(c.tierMultiplier, 1.5);
    });

    test('falls back to no multiplier when the tier is unknown', () {
      final c = LoyaltyCustomer.fromJson(_payload(tier: 'Ghost'));
      expect(c.tierMultiplier, 1.0);
    });

    test('earns nothing below the scheme minimum spend', () {
      final c = LoyaltyCustomer.fromJson(_payload(minSpend: 1000));
      expect(c.pointsFor(999), 0);
      expect(c.pointsFor(1000), 10);
    });

    test('earns nothing while the scheme is switched off', () {
      final c = LoyaltyCustomer.fromJson(_payload(enabled: 0));
      expect(c.pointsFor(10000), 0);
    });
  });

  group('redeeming', () {
    test('rounds down to a whole redemption step', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 1000, step: 100));
      // £1.37 of the bill is affordable, but the scheme redeems in hundreds.
      expect(c.maxRedeemableAgainst(137), 100);
    });

    test('never redeems more than the bill', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 100000));
      expect(c.maxRedeemableAgainst(500), 500);
    });

    test('never redeems more than the balance', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 300));
      expect(c.maxRedeemableAgainst(100000), 300);
    });

    test('refuses below the scheme floor', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 99, minRedeem: 100));
      expect(c.maxRedeemableAgainst(100000), 0);
    });

    test('refuses while the scheme is switched off', () {
      final c = LoyaltyCustomer.fromJson(_payload(enabled: false));
      expect(c.maxRedeemableAgainst(100000), 0);
    });

    test('offers every step up to the maximum, smallest first', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 450, step: 100));
      // A clerk should be able to agree £1, £2, £3 or £4 of points, not just
      // "all of it" — that is how these schemes are operated at a counter.
      expect(c.redemptionOptions(100000), [100, 200, 300, 400]);
    });

    test('includes the maximum when it does not land on a step', () {
      // A floor of 150 with a step of 100 puts the ceiling off-step.
      final c = LoyaltyCustomer.fromJson(
        _payload(balance: 480, minRedeem: 150, step: 100),
      );
      final options = c.redemptionOptions(100000);
      expect(options.first, 150);
      expect(options.last, c.maxRedeemableAgainst(100000));
    });

    test('offers nothing when nothing can be redeemed', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 50));
      expect(c.redemptionOptions(100000), isEmpty);
    });

    test('values points at the scheme rate', () {
      final c = LoyaltyCustomer.fromJson(_payload(pointValueMinor: 2));
      expect(c.valueOf(250), 500);
    });
  });
}
