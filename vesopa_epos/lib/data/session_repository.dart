import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import 'local/database.dart';

/// A count and an amount, which is how every line of a Z report is read.
///
/// "Drink 204.40" says the bar took two hundred pounds. "Drink [55] 204.40"
/// says it did so across fifty-five items, and the two numbers together are
/// what a manager actually checks — an average that has moved is the thing
/// worth asking about, and it cannot be seen without both.
class ReportTally {
  const ReportTally({this.count = 0, this.amountMinor = 0});

  final int count;
  final int amountMinor;

  ReportTally plus(int amountMinor, {int count = 1}) => ReportTally(
        count: this.count + count,
        amountMinor: this.amountMinor + amountMinor,
      );

  bool get isEmpty => count == 0 && amountMinor == 0;
}

/// Sum a set of tallies into the TOTAL line that closes each section.
ReportTally totalOf(Iterable<ReportTally> tallies) {
  var count = 0;
  var amount = 0;
  for (final t in tallies) {
    count += t.count;
    amount += t.amountMinor;
  }
  return ReportTally(count: count, amountMinor: amount);
}

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
    this.covers = 0,
    this.voids = const ReportTally(),
    this.noSales = const ReportTally(),
    this.refunds = const ReportTally(),
    this.discounts = const ReportTally(),
    this.gratuityMinor = 0,
    this.terminalName,
    this.staffName,
  });

  final bool isZ;
  final int? zNumber;
  final DateTime openedAt;
  final DateTime? closedAt;
  final int orderCount;
  final int grossMinor;
  final int discountMinor;
  final int taxMinor;

  /// Tender and department, each with the count beside the money.
  final Map<String, ReportTally> byMethod;
  final Map<String, ReportTally> byDepartment;

  final int openingFloatMinor;

  /// How many people were served, where the venue counts covers. Zero is a
  /// counter till, and a zero average spend follows from it rather than being
  /// a division nobody can do.
  final int covers;

  /// The lines a manager reads looking for something. See TillEvents.
  final ReportTally voids;
  final ReportTally noSales;
  final ReportTally refunds;

  /// Bills that carried a reduction, and what it came to.
  final ReportTally discounts;

  /// Tips taken on the card machine. Not takings — it belongs to whoever earned
  /// it — but it is in the drawer's card total and has to be accounted for.
  final int gratuityMinor;

  final String? terminalName;

  /// Who was signed on when the report was taken.
  final String? staffName;

  /// What should physically be in the drawer: the float plus everything taken
  /// in cash.
  int get expectedCashMinor =>
      openingFloatMinor + (byMethod['cash']?.amountMinor ?? 0);

  /// Takings divided by bills. Zero rather than a division by zero on a till
  /// that has not traded.
  int get averageSpendMinor =>
      orderCount == 0 ? 0 : (grossMinor / orderCount).round();

  /// Takings divided by people, where covers are counted.
  int get averageCoverMinor =>
      covers == 0 ? 0 : (grossMinor / covers).round();
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
  Future<TillReport> xReport({String? terminalName, String? staffName}) async {
    final session = await current();
    return _report(
      session,
      isZ: false,
      terminalName: terminalName,
      staffName: staffName,
    );
  }

  /// Z report: close the trading period and start a new one.
  ///
  /// The read and the close happen in one transaction, so a sale rung up while
  /// the report is generating cannot land in the closed session after it has
  /// been totalled — it falls into the new one instead. Without that, the
  /// printed Z and the stored Z would disagree.
  Future<TillReport> zReport({String? terminalName, String? staffName}) async {
    return _db.transaction(() async {
      final session = await current();
      final report = await _report(
        session,
        isZ: true,
        terminalName: terminalName,
        staffName: staffName,
      );

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
        covers: report.covers,
        voids: report.voids,
        noSales: report.noSales,
        refunds: report.refunds,
        discounts: report.discounts,
        gratuityMinor: report.gratuityMinor,
        terminalName: report.terminalName,
        staffName: report.staffName,
      );
    });
  }

  Future<TillReport> _report(
    TillSession session, {
    required bool isZ,
    String? terminalName,
    String? staffName,
  }) async {
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
    var covers = 0;
    var discountedBills = 0;
    for (final o in orders) {
      gross += o.totalMinor;
      discount += o.discountMinor;
      tax += o.taxMinor;
      covers += o.covers ?? 0;
      if (o.discountMinor > 0) discountedBills++;
    }

    final byMethod = <String, ReportTally>{};
    var gratuity = 0;
    if (ids.isNotEmpty) {
      final payments = await (_db.select(_db.payments)
            ..where((p) => p.orderId.isIn(ids)))
          .get();
      for (final p in payments) {
        // One tender taken is one count, whatever it settled — a bill split
        // across two cards is two card payments, and that is what the drawer
        // reconciliation is counting against.
        byMethod[p.method] =
            (byMethod[p.method] ?? const ReportTally()).plus(p.amountMinor);
        gratuity += p.gratuityMinor;
      }
    }

    final byDepartment = <String, ReportTally>{};
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
        // Counted by items sold rather than by lines: three of something on one
        // line is three sales of it, and a department count that said "1" for a
        // round of three would not reconcile against stock.
        byDepartment[dept] = (byDepartment[dept] ?? const ReportTally()).plus(
          (l.unitPriceMinor * l.quantity).round(),
          count: l.quantity.round(),
        );
      }
    }

    // Voids, no-sales and refunds. Read from the till's own log rather than
    // from the outbox, which is emptied as it is delivered — see TillEvents.
    final events = await (_db.select(_db.tillEvents)
          ..where((e) => e.sessionId.equals(session.id)))
        .get();
    var voids = const ReportTally();
    var noSales = const ReportTally();
    var refunds = const ReportTally();
    for (final e in events) {
      switch (e.kind) {
        case 'void':
          voids = voids.plus(e.amountMinor);
        case 'no_sale':
          noSales = noSales.plus(e.amountMinor);
        case 'refund':
          refunds = refunds.plus(e.amountMinor);
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
      covers: covers,
      voids: voids,
      noSales: noSales,
      refunds: refunds,
      discounts: ReportTally(count: discountedBills, amountMinor: discount),
      gratuityMinor: gratuity,
      terminalName: terminalName,
      staffName: staffName,
    );
  }
}
