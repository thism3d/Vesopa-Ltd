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

  group('redeeming (money, fractional points 2026-10-22)', () {
    test('clears the exact bill, not a stepped amount', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 1000, step: 100));
      // The whole point of the change: redeem clears the exact £1.37, not £1.
      expect(c.maxRedeemMinor(137), 137);
    });

    test('never redeems more than the bill', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 100000));
      expect(c.maxRedeemMinor(500), 500);
    });

    test('never redeems more than the balance is worth', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 300));
      expect(c.maxRedeemMinor(100000), 300);
    });

    test('refuses below the scheme floor', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 99, minRedeem: 100));
      expect(c.maxRedeemMinor(100000), 0);
    });

    test('refuses while the scheme is switched off', () {
      final c = LoyaltyCustomer.fromJson(_payload(enabled: false));
      expect(c.maxRedeemMinor(100000), 0);
    });

    test('clears any price point with fractional points (Newbridge)', () {
      // Pontardawe: 7p a point. A £4.10 item used to leave 6p to find.
      final c = LoyaltyCustomer.fromJson(
        _payload(balance: 1000, pointValueMinor: 7, minRedeem: 1, step: 1),
      );
      // The bill clears to the penny...
      expect(c.maxRedeemMinor(410), 410);
      // ...and the points spent are fractional, to five decimals.
      expect(c.pointsForMinor(410), closeTo(58.57143, 0.000005));
      // The remainder stays on the card.
      expect(c.pointsBalance - c.pointsForMinor(410), closeTo(941.42857, 0.00001));
    });

    test('points spent never exceed the balance', () {
      final c = LoyaltyCustomer.fromJson(
        _payload(balance: 10, pointValueMinor: 7, minRedeem: 1),
      );
      // 70p is all they have; asking for the £0.70 worth spends exactly 10.
      expect(c.maxRedeemMinor(100000), 70);
      expect(c.pointsForMinor(70), 10);
    });

    test('offers the clearing amount and round pounds below it', () {
      final c = LoyaltyCustomer.fromJson(
        _payload(balance: 1000, pointValueMinor: 1, minRedeem: 1, step: 1),
      );
      // Bill £4.50 -> options are round pounds up to, and including, £4.50.
      final options = c.redeemAmountOptions(450);
      expect(options.last, 450);
      expect(options, containsAll([100, 200, 300, 400, 450]));
    });

    test('offers nothing when nothing can be redeemed', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 50));
      expect(c.redeemAmountOptions(100000), isEmpty);
    });

    test('values points at the scheme rate', () {
      final c = LoyaltyCustomer.fromJson(_payload(pointValueMinor: 2));
      expect(c.valueOf(250), 500);
    });

    test('a fractional balance reads trimmed', () {
      final c = LoyaltyCustomer.fromJson(_payload(balance: 1000, pointValueMinor: 7, minRedeem: 1));
      expect(c.pointsLabel, '1000');
    });
  });
}
