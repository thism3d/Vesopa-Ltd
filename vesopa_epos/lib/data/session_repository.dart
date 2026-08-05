import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import 'local/database.dart';

/// A point-in-time reading of the trading period.
class TillReport {
  const TillReport({
    required this.isZ,
    required this.zNumber,
    required this.openedAt,
    required this.closedAt,
    required this.orderCount,
    required this.grossMinor,
    required this.discountMinor,
    required this.taxMinor,
    required this.byMethod,
    required this.byDepartment,
    required this.openingFloatMinor,
  });

  final bool isZ;
  final int? zNumber;
  final DateTime openedAt;
  final DateTime? closedAt;
  final int orderCount;
  final int grossMinor;
  final int discountMinor;
  final int taxMinor;
  final Map<String, int> byMethod;
  final Map<String, int> byDepartment;
  final int openingFloatMinor;

  /// What should physically be in the drawer: the float plus everything taken
  /// in cash.
  int get expectedCashMinor => openingFloatMinor + (byMethod['cash'] ?? 0);
}

/// Owns the trading period. X reads it; Z reads it, closes it, and opens the
/// next one.
class SessionRepository {
  SessionRepository(this._db);

  final AppDatabase _db;
  static const _uuid = Uuid();

  /// The session sales are currently booked against, opening one if the till
  /// has never traded.
  Future<TillSession> current() async {
    final open = await (_db.select(_db.tillSessions)
          ..where((s) => s.closedAt.isNull())
          ..orderBy([(s) => OrderingTerm.desc(s.openedAt)])
          ..limit(1))
        .get();

    if (open.isNotEmpty) return open.first;
    return _open(0);
  }

  Future<TillSession> _open(int floatMinor) async {
    final id = _uuid.v4();
    await _db.into(_db.tillSessions).insert(
          TillSessionsCompanion.insert(
            id: id,
            openingFloatMinor: Value(floatMinor),
          ),
        );
    return (_db.select(_db.tillSessions)..where((s) => s.id.equals(id)))
        .getSingle();
  }

  /// X report: read the open session without changing anything. Safe to run as
  /// often as the manager likes, mid-service included.
  Future<TillReport> xReport() async {
    final session = await current();
    return _report(session, isZ: false);
  }

  /// Z report: close the trading period and start a new one.
  ///
  /// The read and the close happen in one transaction, so a sale rung up while
  /// the report is generating cannot land in the closed session after it has
  /// been totalled — it falls into the new one instead. Without that, the
  /// printed Z and the stored Z would disagree.
  Future<TillReport> zReport() async {
    return _db.transaction(() async {
      final session = await current();
      final report = await _report(session, isZ: true);

      final lastZ = await (_db.selectOnly(_db.tillSessions)
            ..addColumns([_db.tillSessions.zNumber.max()]))
          .getSingle();
      final nextZ = (lastZ.read(_db.tillSessions.zNumber.max()) ?? 0) + 1;

      await (_db.update(_db.tillSessions)..where((s) => s.id.equals(session.id)))
          .write(
        TillSessionsCompanion(
          closedAt: Value(DateTime.now()),
          zNumber: Value(nextZ),
        ),
      );

      // The next period starts with the cash that stays in the drawer.
      await _open(session.openingFloatMinor);

      return TillReport(
        isZ: true,
        zNumber: nextZ,
        openedAt: report.openedAt,
        closedAt: DateTime.now(),
        orderCount: report.orderCount,
        grossMinor: report.grossMinor,
        discountMinor: report.discountMinor,
        taxMinor: report.taxMinor,
        byMethod: report.byMethod,
        byDepartment: report.byDepartment,
        openingFloatMinor: report.openingFloatMinor,
      );
    });
  }

  Future<TillReport> _report(TillSession session, {required bool isZ}) async {
    // Only settled sales count. Parked and voided orders are deliberately
    // excluded — a bill still sitting on a table is not takings.
    final orders = await (_db.select(_db.orders)
          ..where((o) =>
              o.sessionId.equals(session.id) & o.status.equals('closed')))
        .get();

    final ids = orders.map((o) => o.id).toList();

    var gross = 0;
    var discount = 0;
    var tax = 0;
    for (final o in orders) {
      gross += o.totalMinor;
      discount += o.discountMinor;
      tax += o.taxMinor;
    }

    final byMethod = <String, int>{};
    if (ids.isNotEmpty) {
      final payments = await (_db.select(_db.payments)
            ..where((p) => p.orderId.isIn(ids)))
          .get();
      for (final p in payments) {
        byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amountMinor;
      }
    }

    final byDepartment = <String, int>{};
    if (ids.isNotEmpty) {
      final lines = await (_db.select(_db.orderLines)
            ..where((l) => l.orderId.isIn(ids)))
          .get();
      final products = await _db.select(_db.products).get();
      final deptOf = {
        for (final p in products) p.pluId: p.departmentName ?? 'Other',
      };
      for (final l in lines) {
        final dept = deptOf[l.pluId] ?? 'Other';
        byDepartment[dept] = (byDepartment[dept] ?? 0) +
            (l.unitPriceMinor * l.quantity).round();
      }
    }

    return TillReport(
      isZ: isZ,
      zNumber: session.zNumber,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      orderCount: orders.length,
      grossMinor: gross,
      discountMinor: discount,
      taxMinor: tax,
      byMethod: byMethod,
      byDepartment: byDepartment,
      openingFloatMinor: session.openingFloatMinor,
    );
  }
}
