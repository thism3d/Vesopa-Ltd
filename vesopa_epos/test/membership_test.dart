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

    test('a plain renewal line is spotted', () {
      expect(billRenewsMembership([line(12), line(membershipRenewalPlu)]),
          isTrue);
    });

    test('so is the venue’s own membership product', () {
      expect(billRenewsMembership([line(12), line(4100)], plu: 4100), isTrue);
    });

    test('an ordinary bill renews nothing', () {
      expect(billRenewsMembership([line(12), line(13)], plu: 4100), isFalse);
    });

    // The setting is read at settle time, and a till that could not reach the
    // server answers null for it. A bill carrying the venue's own product then
    // has to fall through rather than being renewed by accident.
    test('with no setting, only the marker counts', () {
      expect(billRenewsMembership([line(4100)]), isFalse);
      expect(billRenewsMembership([line(membershipRenewalPlu)]), isTrue);
    });
  });
}
