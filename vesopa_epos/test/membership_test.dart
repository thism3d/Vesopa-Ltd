import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/commerce.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/membership.dart';

/// Memberships that run out, and the fee that renews them.
///
/// The decision under test is the one the venue asked for — "if the customer
/// have expired they card can't be used" — plus the two things that decide
/// whether the money and the date stay in step: what a renewal is rung up as,
/// and how the bill remembers that it renewed anything.
void main() {
  LoyaltyCustomer member({
    DateTime? expiry,
    String? photo,
    int fee = 1000,
    int term = 12,
    int? plu,
  }) => LoyaltyCustomer(
    id: 'c1',
    name: 'Nicky Tidbell',
    pointsBalance: 40,
    pointsValueMinor: 40,
    redeemable: false,
    membershipExpiry: expiry,
    photoUrl: photo,
    membershipFeeMinor: fee,
    membershipTermMonths: term,
    membershipPlu: plu,
  );

  DateTime today() {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day);
  }

  group('whether a card still works', () {
    test('yesterday has expired', () {
      expect(
        member(expiry: today().subtract(const Duration(days: 1)))
            .membershipExpired,
        isTrue,
      );
    });

    // The expiry day itself counts. A member told at the counter that their
    // card ran out today, on the day it says, is an argument no clerk should
    // have to have.
    test('today has not', () {
      expect(member(expiry: today()).membershipExpired, isFalse);
    });

    test('tomorrow has not', () {
      expect(
        member(expiry: today().add(const Duration(days: 1))).membershipExpired,
        isFalse,
      );
    });

    // Points customers and members share one table. Null means "not a
    // membership scheme", not "expired at the beginning of time" — reading it
    // the other way would refuse every ordinary loyalty card in the venue.
    test('a customer with no membership never expires', () {
      final c = member();
      expect(c.membershipExpired, isFalse);
      expect(c.isMember, isFalse);
    });
  });

  group('reading a member off the wire', () {
    test('a date-only expiry parses', () {
      final c = LoyaltyCustomer.fromJson({
        'id': 'c1',
        'name': 'A',
        'membership_expiry': '2027-03-31',
        'photo_url': '/uploads/face.png',
        'settings': {
          'membership_term_months': 6,
          'membership_fee_minor': 2500,
          'membership_plu': 4100,
        },
      });
      expect(c.membershipExpiry, DateTime(2027, 3, 31));
      expect(c.photoUrl, '/uploads/face.png');
      expect(c.membershipTermMonths, 6);
      expect(c.membershipFeeMinor, 2500);
      expect(c.membershipPlu, 4100);
    });

    test('a full timestamp parses too', () {
      final c = LoyaltyCustomer.fromJson({
        'id': 'c1',
        'name': 'A',
        'membership_expiry': '2027-03-31T00:00:00.000Z',
      });
      expect(c.membershipExpiry?.year, 2027);
    });

    // Guessing wrong in this direction turns a paid-up member away at the
    // counter, so anything unreadable is treated as no membership rather than
    // as an expired one.
    test('nonsense is read as no membership, not as an expired one', () {
      final c = LoyaltyCustomer.fromJson({
        'id': 'c1',
        'name': 'A',
        'membership_expiry': 'soon',
      });
      expect(c.membershipExpiry, isNull);
      expect(c.membershipExpired, isFalse);
    });

    test('an empty photo is no photo', () {
      final c = LoyaltyCustomer.fromJson({
        'id': 'c1',
        'name': 'A',
        'photo_url': '   ',
      });
      expect(c.photoUrl, isNull);
    });
  });

  group('what the fee is rung up as', () {
    test('a plain line when the venue has named no product', () {
      final p = membershipProduct(feeMinor: 1000);
      expect(p.pluId, membershipRenewalPlu);
      expect(p.name, membershipRenewalName);
      expect(p.priceMinor, 1000);
      // Never a guess. A till that invented 20% would be a till that misstates
      // a VAT return; the settings page says this out loud instead.
      expect(p.taxPercentage, 0);
    });

    test('the venue’s own product when it has named one', () {
      const real = Product(
        pluId: 4100,
        name: 'Club membership',
        priceMinor: 2500,
        taxPercentage: 20,
        stockQuantity: 0,
        printToReceipt: true,
        isModifier: false,
        renewsMembership: true,
      );
      final p = membershipProduct(feeMinor: 1000, plu: 4100, named: real);
      expect(p.name, 'Club membership');
      expect(p.priceMinor, 2500);
      expect(p.taxPercentage, 20);
    });

    // A negative PLU cannot collide with a catalogue one — the back office
    // will not accept a PLU that is not positive.
    test('the marker PLU cannot be a real product', () {
      expect(membershipRenewalPlu, lessThan(0));
    });
  });

  group('whether a bill renewed a membership', () {
    OrderLine line(int plu) => OrderLine(
      id: 'l$plu',
      orderId: 'o1',
      pluId: plu,
      name: 'x',
      quantity: 1,
      unitPriceMinor: 100,
      taxPercentage: 0,
      lineDiscountMinor: 0,
    );

    Product product(int plu, {required bool renews, int priceMinor = 1000}) =>
        Product(
          pluId: plu,
          name: 'PLU $plu',
          priceMinor: priceMinor,
          taxPercentage: 0,
          stockQuantity: 0,
          printToReceipt: true,
          isModifier: false,
          renewsMembership: renews,
        );

    test('a plain renewal line is spotted', () {
      final renewing = renewingPlus(const <Product>[]);
      expect(
        billRenewsMembership(
          [line(12), line(membershipRenewalPlu)],
          renewing: renewing,
        ),
        isTrue,
      );
    });

    // The change this release makes. The venue ticks products rather than
    // naming one PLU in the loyalty settings, because a club sells full,
    // concession, junior and social memberships — four products, one meaning.
    test('a product the venue has ticked renews', () {
      final renewing = renewingPlus([
        product(4100, renews: true),
        product(12, renews: false),
      ]);
      expect(
        billRenewsMembership([line(12), line(4100)], renewing: renewing),
        isTrue,
      );
    });

    test('more than one product may be ticked', () {
      final renewing = renewingPlus([
        product(4100, renews: true),
        product(4101, renews: true),
        product(4102, renews: true),
      ]);
      for (final plu in [4100, 4101, 4102]) {
        expect(
          billRenewsMembership([line(plu)], renewing: renewing),
          isTrue,
          reason: 'PLU $plu is ticked and should renew',
        );
      }
    });

    test('an ordinary bill renews nothing', () {
      final renewing = renewingPlus([product(4100, renews: true)]);
      expect(
        billRenewsMembership([line(12), line(13)], renewing: renewing),
        isFalse,
      );
    });

    // A venue whose back office has not been updated sends no flag on any
    // product and still names its old single PLU. That venue has to go on
    // renewing exactly as it did, or a Store rollout would stop a club taking
    // subscriptions until somebody deployed the server.
    test('the old single-PLU setting is still honoured', () {
      final renewing = renewingPlus(
        [product(4100, renews: false)],
        legacyPlu: 4100,
      );
      expect(billRenewsMembership([line(4100)], renewing: renewing), isTrue);
    });

    // The other direction, and the one that costs money if it is wrong: a
    // catalogue with nothing ticked and no legacy setting must renew nothing
    // but the marker line. A product wrongly counted here moves somebody's
    // membership on a year for buying a pint.
    test('with nothing ticked, only the marker counts', () {
      final renewing = renewingPlus([product(4100, renews: false)]);
      expect(billRenewsMembership([line(4100)], renewing: renewing), isFalse);
      expect(
        billRenewsMembership([line(membershipRenewalPlu)], renewing: renewing),
        isTrue,
      );
    });

    test('a zero or negative legacy PLU is not a product', () {
      // 0 is what a settings form sends for "no product", and the sentinel is
      // negative. Neither may become a catalogue PLU that renews.
      expect(renewingPlus(const <Product>[], legacyPlu: 0),
          equals({membershipRenewalPlu}));
      expect(renewingPlus(const <Product>[], legacyPlu: -5),
          equals({membershipRenewalPlu}));
    });
  });
}
