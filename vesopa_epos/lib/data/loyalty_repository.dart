import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import 'local/database.dart';

/// Loyalty points and memberships.
class LoyaltyRepository {
  LoyaltyRepository(this._db, {this.pointsPerPound = 1, this.pencePerPoint = 1});

  final AppDatabase _db;
  static const _uuid = Uuid();

  /// Points earned per whole pound spent.
  final int pointsPerPound;

  /// What a point is worth when redeemed.
  final int pencePerPoint;

  Future<List<Customer>> search(String query) {
    final q = '%$query%';
    return (_db.select(_db.customers)
          ..where((c) =>
              c.name.like(q) | c.phone.like(q) | c.cardNumber.like(q))
          ..limit(20))
        .get();
  }

  Future<Customer?> byCard(String cardNumber) async {
    final rows = await (_db.select(_db.customers)
          ..where((c) => c.cardNumber.equals(cardNumber))
          ..limit(1))
        .get();
    return rows.isEmpty ? null : rows.first;
  }

  Future<String> create({
    required String name,
    String? phone,
    String? email,
    String? cardNumber,
    DateTime? membershipExpiry,
  }) async {
    final id = _uuid.v4();
    await _db.into(_db.customers).insert(
          CustomersCompanion.insert(
            id: id,
            name: name,
            phone: Value(phone),
            email: Value(email),
            cardNumber: Value(cardNumber),
            membershipExpiry: Value(membershipExpiry),
          ),
        );
    return id;
  }

  /// A membership is valid up to and including its expiry date.
  bool isMembershipActive(Customer customer) {
    final expiry = customer.membershipExpiry;
    if (expiry == null) return false;
    return !expiry.isBefore(DateUtils.dateOnly(DateTime.now()));
  }

  /// Renew from the till. Extends from the current expiry when the membership
  /// is still live, so renewing early does not throw away the remaining days;
  /// otherwise it runs from today.
  Future<DateTime> renewMembership(String customerId, {int months = 12}) async {
    final customer =
        await (_db.select(_db.customers)..where((c) => c.id.equals(customerId)))
            .getSingle();

    final today = DateUtils.dateOnly(DateTime.now());
    final from = (customer.membershipExpiry != null &&
            !customer.membershipExpiry!.isBefore(today))
        ? customer.membershipExpiry!
        : today;

    final expiry = DateTime(from.year, from.month + months, from.day);

    await (_db.update(_db.customers)..where((c) => c.id.equals(customerId)))
        .write(CustomersCompanion(membershipExpiry: Value(expiry)));

    return expiry;
  }

  /// Award points for a settled sale. Earned on what was actually paid, after
  /// discount — otherwise a 100% discount would still mint points.
  Future<int> earnFor(String customerId, String orderId, int paidMinor) async {
    final points = (paidMinor ~/ 100) * pointsPerPound;
    if (points <= 0) return 0;

    await _adjust(
      customerId: customerId,
      orderId: orderId,
      points: points,
      reason: 'Earned on sale',
    );
    return points;
  }

  /// Spend points. Returns the discount in pence.
  Future<int> redeem(String customerId, int points, {String? orderId}) async {
    if (points <= 0) throw ArgumentError('Nothing to redeem.');

    final customer =
        await (_db.select(_db.customers)..where((c) => c.id.equals(customerId)))
            .getSingle();

    // Refusing beats going negative: a balance that can go below zero is a
    // balance that can be spent twice.
    if (customer.pointsBalance < points) {
      throw StateError(
        'Only ${customer.pointsBalance} points available.',
      );
    }

    await _adjust(
      customerId: customerId,
      orderId: orderId,
      points: -points,
      reason: 'Redeemed against sale',
    );

    return points * pencePerPoint;
  }

  /// Write the ledger entry and the cached balance together, so the balance can
  /// never drift from the entries that explain it.
  Future<void> _adjust({
    required String customerId,
    required int points,
    required String reason,
    String? orderId,
  }) async {
    await _db.transaction(() async {
      await _db.into(_db.loyaltyEntries).insert(
            LoyaltyEntriesCompanion.insert(
              id: _uuid.v4(),
              customerId: customerId,
              orderId: Value(orderId),
              points: points,
              reason: reason,
            ),
          );

      final customer = await (_db.select(_db.customers)
            ..where((c) => c.id.equals(customerId)))
          .getSingle();

      await (_db.update(_db.customers)..where((c) => c.id.equals(customerId)))
          .write(
        CustomersCompanion(
          pointsBalance: Value(customer.pointsBalance + points),
        ),
      );
    });
  }

  Future<List<LoyaltyEntry>> history(String customerId) =>
      (_db.select(_db.loyaltyEntries)
            ..where((e) => e.customerId.equals(customerId))
            ..orderBy([(e) => OrderingTerm.desc(e.createdAt)]))
          .get();
}

/// Date-only helper: memberships expire on a day, not at an instant.
abstract class DateUtils {
  static DateTime dateOnly(DateTime d) => DateTime(d.year, d.month, d.day);
}
