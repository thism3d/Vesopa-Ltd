import 'dart:async';
import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/bill_sync.dart';
import 'package:vesopa_epos/data/lan/lan_link.dart';
import 'package:vesopa_epos/data/lan/lan_service.dart';
import 'package:vesopa_epos/data/lan/offline_ledger.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/order_repository.dart';
import 'package:vesopa_epos/data/terminal_service.dart';

/// The venue's local link at the till (2026-10-27): the offline ledger's
/// rules, and tables shared between two tills with the internet down.
class _Offline extends TerminalService {
  _Offline() : super(apiBase: 'http://example.invalid', terminalToken: 'tok', terminalName: 'Bar');

  @override
  Future<BillFeed?> pullBills({int since = 0}) async => null;

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
    int? changedAt,
  }) async {
    // The internet is down: each push takes the timeout to fail. The local
    // link must not wait for it.
    await Future<void>.delayed(const Duration(seconds: 3));
    return false;
  }

  @override
  Future<bool> retireBill(String id, {String reason = 'settled'}) async => false;

  @override
  Future<RemoteBill> claimBill(String id) async => throw TerminalUnavailable('offline');
}

Future<void> until(bool Function() ok, {Duration within = const Duration(seconds: 10)}) async {
  final end = DateTime.now().add(within);
  while (!ok()) {
    if (DateTime.now().isAfter(end)) throw TimeoutException('condition not met');
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

Future<bool> untilAsync(Future<bool> Function() ok, {Duration within = const Duration(seconds: 10)}) async {
  final end = DateTime.now().add(within);
  while (!await ok()) {
    if (DateTime.now().isAfter(end)) return false;
    await Future<void>.delayed(const Duration(milliseconds: 60));
  }
  return true;
}

void main() {
  group('the offline ledger', () {
    OfflineLedger withSnapshot() => OfflineLedger()
      ..setSnapshot({
        'customers': [
          {'id': 'c1', 'name': 'Rhys Jones', 'phone': '07700 900123', 'card_number': '999800001', 'points_balance': 40, 'scheme_id': null},
        ],
        'settings_by_scheme': {
          'none': {'point_value_minor': 5, 'min_redeem_points': 10},
        },
        'gift_cards': [
          {'id': 'g1', 'code': '9878-0001', 'balance_minor': 1000, 'kind': 'swipe', 'status': 'active', 'redeemable': true},
        ],
        'vouchers': [
          {'code': 'XMAS10', 'active': 1, 'reusable': 0, 'times_used': 0, 'max_uses': 0, 'min_spend_minor': 0, 'discount_type': 'amount', 'value': 500},
        ],
      }, at: 1000);

    LedgerEntry move(String id, String kind, Map<String, dynamic> body) =>
        LedgerEntry(id: id, kind: kind, body: body, at: 2000);

    test('a gift card cannot be spent twice across tills', () {
      final l = withSnapshot();
      l.accept(move('a:1', 'gift_redeem', {'code': '98780001', 'amount_minor': 600}));
      expect(l.giftCard('9878 0001')!['balance_minor'], 400);
      expect(
        () => l.accept(move('b:1', 'gift_redeem', {'code': '9878-0001', 'amount_minor': 600})),
        throwsA(isA<LedgerRefused>()),
      );
      l.accept(move('b:2', 'gift_load', {'code': '9878-0001', 'amount_minor': 200}));
      expect(l.giftCard('9878-0001')!['balance_minor'], 600);
      // The same move sent twice is taken once.
      l.accept(move('a:1', 'gift_redeem', {'code': '98780001', 'amount_minor': 600}));
      expect(l.giftCard('9878-0001')!['balance_minor'], 600);
      expect([for (final e in l.entries) e.seq], [1, 2]);
    });

    test('a card sold while offline exists from its first load', () {
      final l = withSnapshot();
      expect(l.giftCard('123456789'), isNull);
      l.accept(move('a:1', 'gift_load', {'code': '123456789', 'amount_minor': 2500}));
      expect(l.giftCard('123456789')!['balance_minor'], 2500);
    });

    test('points, a single-use voucher and a member found by card', () {
      final l = withSnapshot();
      expect(l.memberByCard(';999800001?')!['name'], 'Rhys Jones');
      l.accept(move('a:1', 'points', {'customer_id': 'c1', 'kind': 'redeem', 'points': 30}));
      expect(l.memberById('c1')!['points_balance'], 10);
      expect(l.memberById('c1')!['points_value_minor'], 50);
      expect(
        () => l.accept(move('a:2', 'points', {'customer_id': 'c1', 'kind': 'redeem', 'points': 11})),
        throwsA(isA<LedgerRefused>()),
      );
      expect(l.voucher('xmas10', 2000)!['discount_minor'], 500);
      l.accept(move('a:3', 'voucher', {'code': 'XMAS10'}));
      expect(l.voucher('XMAS10', 2000)!['valid'], isFalse);
      expect(() => l.accept(move('b:1', 'voucher', {'code': 'XMAS10'})), throwsA(isA<LedgerRefused>()));
    });

    test('a fresh snapshot never counts a replayed move twice', () {
      final l = withSnapshot();
      l.accept(move('a:1', 'gift_redeem', {'code': '9878-0001', 'amount_minor': 300}));
      l.accept(move('a:2', 'gift_redeem', {'code': '9878-0001', 'amount_minor': 100}));
      expect(l.giftCard('9878-0001')!['balance_minor'], 600);
      // The cloud took a:1; its new copy says so and shows 700.
      l.setSnapshot({
        'applied': ['a:1'],
        'gift_cards': [
          {'id': 'g1', 'code': '9878-0001', 'balance_minor': 700, 'kind': 'swipe', 'status': 'active', 'redeemable': true},
        ],
      }, at: 3000);
      expect(l.giftCard('9878-0001')!['balance_minor'], 600, reason: '700 less a:2, which is still to send');
      expect(l.entries.map((e) => e.id), ['a:2']);
      expect(replayPath('gift_redeem'), '/api/gift-cards/redeem');
    });
  });

  test('tables move between tills over the local link with the internet down', () async {
    SharedPreferences.setMockInitialValues({});
    final key = List<int>.generate(32, (i) => 200 - i);
    final hex = key.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

    // This till ("Bar"): the real service, its key from a back office stand-in.
    final api = MockClient((req) async {
      if (req.url.path == '/api/lan/key') {
        return http.Response(jsonEncode({'key': hex, 'targets': ['127.0.0.1']}), 200);
      }
      return http.Response('{}', 200);
    });
    await LanService.instance.configure(
      apiBase: 'http://backoffice.test',
      token: 'tok',
      deviceId: 'till-bar',
      name: 'Bar',
      version: 'test',
      role: 'till',
      client: api,
    );

    final db = AppDatabase.forTesting(NativeDatabase.memory());
    final orders = OrderRepository(db);
    final sync = BillSync(db, _Offline())..start();
    Future<Order?> find(String id) => (db.select(db.orders)..where((o) => o.id.equals(id))).getSingleOrNull();
    addTearDown(() async {
      await sync.dispose();
      await db.close();
      await LanService.instance.node?.dispose();
    });

    // The other till ("Door"), a plain node on the same venue key.
    final door = LanNode(
      LanIdentity(venueKey: key, id: 'till-door', name: 'Door', role: 'till'),
      discoveryPort: 47961,
      linkPort: 0,
      broadcast: false,
      claimAfter: const Duration(seconds: 30),
      targets: [(host: '127.0.0.1', port: LanNode.defaultDiscoveryPort)],
    );
    final doorHeard = <LanMessage>[];
    door.subscribe(BillSync.lanChannel, doorHeard.add);
    // Door hands a bill over when asked.
    door.subscribe('bills-claim', (m) {
      final d = m.data as Map;
      door.publish(BillSync.lanChannel, {
        'id': d['id'],
        'terminal': d['by'],
        'status': 'parked',
        'table_number': 6,
        'total_minor': 900,
        'payload': {
          'id': d['id'],
          'total_minor': 900,
          'lines': [
            {'id': 'l-1', 'plu_id': 1, 'name': 'Carling', 'quantity': 2, 'unit_price_minor': 450},
          ],
        },
      }, key: '${d['id']}');
    });
    await door.start();
    addTearDown(door.dispose);

    await until(() => LanService.instance.isHub && door.linked);

    // Door parks table 6: it is on Bar's plan, held by Door.
    door.publish(BillSync.lanChannel, {
      'id': 'bill-door-6',
      'terminal': 'Door',
      'status': 'parked',
      'table_number': 6,
      'total_minor': 900,
      'line_count': 1,
      'payload': {
        'id': 'bill-door-6',
        'total_minor': 900,
        'lines': [
          {'id': 'l-1', 'plu_id': 1, 'name': 'Carling', 'quantity': 2, 'unit_price_minor': 450},
        ],
      },
    }, key: 'bill-door-6');
    expect(await untilAsync(() async {
      final o = await find('bill-door-6');
      return o != null && o.heldBy == 'Door' && o.tableNumber == 6;
    }), isTrue);

    // Bar opens a bill of its own: Door hears it.
    final mine = await orders.openOrder();
    await db.into(db.orderLines).insert(OrderLinesCompanion.insert(
          id: 'line-bar-1',
          orderId: mine,
          pluId: 2,
          name: 'Coors',
          unitPriceMinor: 480,
        ));
    final added = DateTime.now();
    await until(() => doorHeard.any((m) => m.key == mine && m.data != null));
    final took = DateTime.now().difference(added);
    // ignore: avoid_print
    print('a new bill reached the other till in ${took.inMilliseconds} ms, with the cloud timing out');
    expect(took, lessThan(const Duration(milliseconds: 500)));

    // A second change lands at once too, while the first cloud push is still waiting.
    final second = DateTime.now();
    await db.into(db.orderLines).insert(OrderLinesCompanion.insert(
          id: 'line-bar-2',
          orderId: mine,
          pluId: 3,
          name: 'Madri',
          unitPriceMinor: 520,
        ));
    await until(() => doorHeard.any((m) =>
        m.key == mine && ((m.data as Map?)?['payload']?['lines'] as List?)?.length == 2));
    expect(DateTime.now().difference(second), lessThan(const Duration(milliseconds: 500)));

    // Bar takes table 6 with the internet down: Door hands it over.
    await sync.claim('bill-door-6');
    final taken = await find('bill-door-6');
    expect(taken!.heldBy, isNull, reason: 'Bar holds it now');
    expect(taken.totalMinor, 900);

    // Door retracts something it no longer holds: gone from Bar's plan.
    door.publish(BillSync.lanChannel, {
      'id': 'bill-door-7',
      'terminal': 'Door',
      'status': 'open',
      'total_minor': 100,
      'payload': {'id': 'bill-door-7', 'lines': const []},
    }, key: 'bill-door-7');
    expect(await untilAsync(() async => (await find('bill-door-7')) != null), isTrue);
    door.publish(BillSync.lanChannel, null, key: 'bill-door-7');
    expect(await untilAsync(() async => (await find('bill-door-7')) == null), isTrue);
  }, timeout: const Timeout(Duration(seconds: 60)));
}
