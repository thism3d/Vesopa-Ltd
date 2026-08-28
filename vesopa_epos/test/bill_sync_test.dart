/// One venue, one set of open bills, however many terminals.
///
/// The design is a *mirror*: every other terminal's open bills are written into
/// this one's own `orders` table, marked with `heldBy`. Nothing downstream had
/// to be taught about a second source of bills — the table plan, the picker and
/// the open-bills strip all read the stream they always read, and the room they
/// draw is now the whole room.
///
/// `heldBy` is what keeps that honest, and every check here is about one of the
/// two things it prevents: a bill bouncing between two tills for ever, and two
/// clerks taking payment for one table.
library;

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/bill_sync.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';
import 'package:vesopa_epos/data/table_repository.dart';
import 'package:vesopa_epos/data/terminal_service.dart';

/// A TerminalService that never reaches a network.
///
/// Subclassed rather than mocked with a package: what these tests need to see
/// is exactly what went out and exactly what came back, and a two-field record
/// of each is clearer than a matcher DSL.
class _FakeTerminals extends TerminalService {
  _FakeTerminals({super.terminalName = 'Bar'})
    : super(apiBase: 'http://example.invalid', terminalToken: 'tok');

  final pushed = <Map<String, dynamic>>[];
  final retired = <String>[];
  BillFeed feed = const BillFeed(rev: 0);
  RemoteBill? claimAnswer;
  bool reachable = true;

  @override
  Future<BillFeed?> pullBills({int since = 0}) async =>
      reachable ? feed : null;

  @override
  Future<bool> pushBill({
    required String id,
    required Map<String, dynamic> payload,
    required int totalMinor,
    required int lineCount,
    String status = 'open',
    int? tableNumber,
    int? roomId,
    int? covers,
    int? staffId,
    String? clerkName,
  }) async {
    if (!reachable) return false;
    pushed.add({
      'id': id,
      'status': status,
      'total_minor': totalMinor,
      'line_count': lineCount,
      'table_number': tableNumber,
      'payload': payload,
    });
    return true;
  }

  @override
  Future<bool> retireBill(String id, {String reason = 'settled'}) async {
    if (!reachable) return false;
    retired.add(id);
    return true;
  }

  @override
  Future<RemoteBill> claimBill(String id) async {
    final answer = claimAnswer;
    if (answer == null) throw TerminalUnavailable('gone');
    return answer;
  }
}

RemoteBill _remote({
  String id = 'other-1',
  String terminal = 'Door',
  int table = 6,
  int total = 1250,
  List<Map<String, dynamic>>? lines,
}) => RemoteBill(
  id: id,
  status: 'parked',
  rev: 1,
  terminal: terminal,
  tableNumber: table,
  totalMinor: total,
  lineCount: (lines ?? const []).length,
  clerkName: 'Sam',
  payload: {
    'id': id,
    'table_number': table,
    'total_minor': total,
    'lines': lines ??
        [
          {
            'id': '$id-l1',
            'plu_id': 1,
            'name': 'IPA',
            'quantity': 2,
            'unit_price_minor': 500,
          },
        ],
  },
);

void main() {
  late AppDatabase db;
  late OrderRepository orders;
  late TableRepository tables;
  late _FakeTerminals terminals;
  late BillSync sync;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    orders = OrderRepository(db);
    tables = TableRepository(db, orders);
    terminals = _FakeTerminals();
    sync = BillSync(db, terminals);
  });

  tearDown(() async {
    await sync.dispose();
    await db.close();
  });

  const beer = Product(
    pluId: 1,
    name: 'IPA',
    priceMinor: 500,
    taxPercentage: 20,
    stockQuantity: 0,
    printToReceipt: true,
    departmentName: 'Drink',
  );

  Future<String> billWithBeer() async {
    final id = await orders.openOrder();
    await orders.addLine(id, beer);
    return id;
  }

  group('what goes out', () {
    test('a bill with something on it is shared', () async {
      final id = await billWithBeer();
      await sync.pushAll();

      expect(terminals.pushed, hasLength(1));
      expect(terminals.pushed.single['id'], id);
      expect(terminals.pushed.single['line_count'], 1);
      expect(terminals.pushed.single['total_minor'], 500);
    });

    // A stream over a joined query fires on every line insert, and a busy
    // counter is a great many inserts. Without a signature the terminal would
    // post every open bill in the venue on every keystroke.
    test('and is not sent again until it changes', () async {
      final id = await billWithBeer();
      await sync.pushAll();
      await sync.pushAll();
      expect(terminals.pushed, hasLength(1));

      await orders.addLine(id, beer);
      await sync.pushAll();
      expect(terminals.pushed, hasLength(2));
      expect(terminals.pushed.last['line_count'], 1, reason: 'merged onto one');
      expect(terminals.pushed.last['total_minor'], 1000);
    });

    // The whole loop guard. A mirrored bill is somebody else's, and sending it
    // back as though this terminal had written it is how two tills bounce one
    // bill between them for ever.
    test('but a bill another terminal is holding is never sent back', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();
      await sync.pushAll();
      expect(terminals.pushed, isEmpty);
    });

    test('a bill that has gone is retired explicitly', () async {
      final id = await billWithBeer();
      await sync.pushAll();

      // Settled: the order leaves open/parked, so it leaves the venue's plan.
      await (db.update(db.orders)..where((o) => o.id.equals(id))).write(
        const OrdersCompanion(status: Value('closed')),
      );
      await sync.pushAll();
      expect(terminals.retired, [id]);
    });

    // A retire that failed must be retried, or a settled table sits on the
    // other terminal's plan for ever.
    test('and a retire that did not get through is tried again', () async {
      final id = await billWithBeer();
      await sync.pushAll();
      await (db.update(db.orders)..where((o) => o.id.equals(id))).write(
        const OrdersCompanion(status: Value('closed')),
      );

      terminals.reachable = false;
      await sync.pushAll();
      expect(terminals.retired, isEmpty);

      terminals.reachable = true;
      await sync.pushAll();
      expect(terminals.retired, [id]);
    });
  });

  group('what comes in', () {
    test('another terminal’s table lands on this one’s plan', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();

      final parked = await tables.watchParked().first;
      expect(parked, hasLength(1));
      expect(parked.single.tableNumber, 6);
      expect(parked.single.totalMinor, 1250);
      expect(
        parked.single.heldBy,
        'Door',
        reason: 'and it is visibly somebody else’s',
      );
    });

    test('with its items, so the check can be read here', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();

      final lines = await orders.linesOnce('other-1');
      expect(lines, hasLength(1));
      expect(lines.single.name, 'IPA');
      expect(lines.single.quantity, 2);
    });

    // Lines are replaced wholesale rather than merged: a merge would have to
    // work out what had been voided on the other terminal, and "the bill is
    // what the terminal holding it says it is" is both simpler and correct.
    test('and a round added there replaces what was here', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();

      terminals.feed = BillFeed(
        rev: 5,
        changed: [
          _remote(
            total: 1750,
            lines: [
              {
                'id': 'other-1-l1',
                'plu_id': 1,
                'name': 'IPA',
                'quantity': 2,
                'unit_price_minor': 500,
              },
              {
                'id': 'other-1-l2',
                'plu_id': 2,
                'name': 'Pie',
                'quantity': 1,
                'unit_price_minor': 750,
              },
            ],
          ),
        ],
      );
      await sync.pull();

      final lines = await orders.linesOnce('other-1');
      expect(lines.map((l) => l.name), containsAll(['IPA', 'Pie']));
      expect(lines, hasLength(2), reason: 'replaced, not appended');
    });

    test('a settled table is taken off the plan', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();
      expect(await tables.watchParked().first, hasLength(1));

      terminals.feed = const BillFeed(rev: 5, removed: ['other-1']);
      await sync.pull();
      expect(await tables.watchParked().first, isEmpty);
    });

    // The one deletion that must not happen. A bill this terminal is holding is
    // never removed by the feed: the race that could produce it is between our
    // own retire and our own push, and losing a live bill to it is
    // unrecoverable at a counter.
    test('but a bill this terminal is holding is never deleted by the feed',
        () async {
      final id = await billWithBeer();
      terminals.feed = BillFeed(rev: 5, removed: [id]);
      await sync.pull();

      final still = await orders.orderOnce(id);
      expect(still, isNotNull);
      expect(await orders.linesOnce(id), hasLength(1));
    });

    test('and the plan says so when it has stopped hearing', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();
      expect(sync.currentStatus.sharing, isTrue);
      expect(sync.currentStatus.stale, isFalse);

      terminals.reachable = false;
      await sync.pull();
      expect(sync.currentStatus.stale, isTrue);
      expect(
        sync.currentStatus.sharing,
        isTrue,
        reason: 'it is still a shared plan, it is just behind',
      );
    });
  });

  group('taking a table over', () {
    test('makes it this terminal’s to ring up and settle', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();
      expect((await orders.orderOnce('other-1'))!.heldBy, 'Door');

      terminals.claimAnswer = _remote(terminal: 'Bar');
      await sync.claim('other-1');

      expect(
        (await orders.orderOnce('other-1'))!.heldBy,
        isNull,
        reason: 'ours now',
      );
    });

    test('and it is then shared from here', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();
      terminals.claimAnswer = _remote(terminal: 'Bar');
      await sync.claim('other-1');

      await sync.pushAll();
      expect(terminals.pushed.map((p) => p['id']), contains('other-1'));
    });

    test('a bill settled while the clerk reached for it says so', () async {
      terminals.feed = BillFeed(rev: 4, changed: [_remote()]);
      await sync.pull();
      terminals.claimAnswer = null;

      expect(
        () => sync.claim('other-1'),
        throwsA(isA<TerminalUnavailable>()),
      );
    });
  });
}
