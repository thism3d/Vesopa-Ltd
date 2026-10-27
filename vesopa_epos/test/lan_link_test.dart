import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/lan/lan_link.dart';

/// The local link between a venue's devices (2026-10-27), on real sockets
/// over loopback: discovery, the main till, the encrypted link, channels,
/// requests, and another till taking over.
void main() {
  final key = List<int>.generate(32, (i) => i * 7 % 256);

  LanNode node(String id, String role, int port, List<int> others, {List<int>? withKey}) => LanNode(
        LanIdentity(venueKey: withKey ?? key, id: id, name: id.toUpperCase(), role: role, version: 't'),
        discoveryPort: port,
        linkPort: 0,
        broadcast: false,
        claimAfter: const Duration(milliseconds: 300),
        announceEvery: const Duration(milliseconds: 150),
        targets: [for (final p in others) (host: '127.0.0.1', port: p)],
      );

  Future<void> until(bool Function() ok, {Duration within = const Duration(seconds: 8)}) async {
    final end = DateTime.now().add(within);
    while (!ok()) {
      if (DateTime.now().isAfter(end)) throw TimeoutException('condition not met');
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
  }

  test('one main till; the others and a kitchen screen link to it and hear each other', () async {
    final a = node('till-a', 'till', 47910, [47911]);
    final b = node('till-b', 'till', 47911, [47910]);
    await a.start();
    await Future<void>.delayed(const Duration(milliseconds: 600));
    await b.start();
    final k = node('kitchen-1', 'kitchen', 0, [47910, 47911]);
    await k.start();
    addTearDown(() async {
      await a.dispose();
      await b.dispose();
      await k.dispose();
    });

    await until(() => a.isHub && !b.isHub && b.linked && k.linked && k.hubId == 'till-a');
    expect(b.isHub, isFalse, reason: 'the till running longest keeps the job');
    expect(b.hubId, 'till-a');
    expect(k.hubId, 'till-a');

    // A keyed message (a bill) and a log message (a kitchen ticket).
    final kitchenGot = <LanMessage>[];
    final aGot = <LanMessage>[];
    k.subscribe('kitchen', kitchenGot.add);
    a.subscribe('bills', aGot.add);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(b.publish('bills', {'id': 'bill-1', 'total': 450}, key: 'bill-1'), isTrue);
    expect(b.publish('kitchen', {'ticket': 't-1'}, log: true), isTrue);
    await until(() => aGot.isNotEmpty && kitchenGot.isNotEmpty);
    expect((aGot.single.data as Map)['total'], 450);
    expect(aGot.single.from, 'till-b');

    // A screen that joins late is handed what the main till kept.
    final late = <LanMessage>[];
    final k2 = node('kitchen-2', 'kitchen', 0, [47910]);
    await k2.start();
    addTearDown(k2.dispose);
    await until(() => k2.linked);
    k2.subscribe('kitchen', late.add);
    await until(() => late.isNotEmpty);
    expect((late.single.data as Map)['ticket'], 't-1');

    // A request is answered by the main till.
    a.handle('ledger', (data, from) => {'echo': data, 'from': from});
    final answer = await b.request('ledger', 'hello') as Map;
    expect(answer['echo'], 'hello');
    expect(answer['from'], 'till-b');

    // One clock: everybody within a few milliseconds of the main till.
    expect((b.now() - a.now()).abs(), lessThan(500));

    // The main till goes; the other till takes over and the kitchen follows.
    await a.stop();
    await until(() => b.isHub && k.linked && k.hubId == 'till-b', within: const Duration(seconds: 15));
  }, timeout: const Timeout(Duration(seconds: 40)));

  test('the main till coming back at a new address is followed (MAC randomisation, a new DHCP lease)', () async {
    final a = node('till-m', 'till', 47930, []);
    await a.start();
    final k = node('kitchen-m', 'kitchen', 0, [47930]);
    await k.start();
    addTearDown(() async {
      await a.dispose();
      await k.dispose();
    });
    await until(() => a.isHub && k.linked && k.hubId == 'till-m');

    // The same till, restarted, listening somewhere else.
    await a.stop();
    final again = node('till-m', 'till', 47930, []);
    await again.start();
    addTearDown(again.dispose);
    await until(() => again.isHub && k.linked && again.clientCount == 1, within: const Duration(seconds: 25));
    final got = <LanMessage>[];
    k.subscribe('kitchen', got.add);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    again.publish('kitchen', {'ticket': 'after-move'}, log: true);
    await until(() => got.isNotEmpty);
  }, timeout: const Timeout(Duration(seconds: 50)));

  test('a change reaches the other device in milliseconds, one at a time and in a burst', () async {
    final a = node('till-fast', 'till', 47940, []);
    await a.start();
    final b = node('till-fast-2', 'till', 47941, [47940]);
    await b.start();
    addTearDown(() async {
      await a.dispose();
      await b.dispose();
    });
    await until(() => a.isHub && b.linked);

    final sentAt = <int, int>{};
    final delays = <int>[];
    final clock = Stopwatch()..start();
    a.subscribe('speed', (m) {
      final n = (m.data as Map)['n'] as int;
      delays.add(clock.elapsedMicroseconds - sentAt[n]!);
    });
    await Future<void>.delayed(const Duration(milliseconds: 200));

    // One at a time, as a clerk rings up: the case Nagle's delay would hit.
    for (var n = 0; n < 40; n++) {
      sentAt[n] = clock.elapsedMicroseconds;
      b.publish('speed', {'n': n, 'pad': 'x' * 200}, key: 'k');
      await Future<void>.delayed(const Duration(milliseconds: 15));
    }
    // A burst: a full table plan republished at once.
    for (var n = 40; n < 240; n++) {
      sentAt[n] = clock.elapsedMicroseconds;
      b.publish('speed', {'n': n, 'pad': 'y' * 2000}, key: 'k$n');
    }
    await until(() => delays.length == 240);
    final singles = [...delays.take(40)]..sort();
    final all = [...delays]..sort();
    final p95single = singles[(singles.length * 0.95).floor() - 1] / 1000;
    final worst = all.last / 1000;
    // ignore: avoid_print
    print('local link: one-at-a-time p95 ${p95single.toStringAsFixed(2)} ms, '
        'median ${(singles[singles.length ~/ 2] / 1000).toStringAsFixed(2)} ms; '
        'burst of 200 all delivered, slowest ${worst.toStringAsFixed(1)} ms');
    expect(p95single, lessThan(20), reason: 'a single change must arrive within milliseconds');
    expect(worst, lessThan(500), reason: 'even a whole plan at once arrives in well under a second');
  }, timeout: const Timeout(Duration(seconds: 40)));

  test('a device holding another venue key is never let in', () async {
    final a = node('till-x', 'till', 47920, []);
    await a.start();
    final stranger = node('kitchen-x', 'kitchen', 0, [47920], withKey: List<int>.filled(32, 9));
    await stranger.start();
    addTearDown(() async {
      await a.dispose();
      await stranger.dispose();
    });
    await until(() => a.isHub);
    await Future<void>.delayed(const Duration(seconds: 1));
    expect(stranger.peers, isEmpty, reason: 'its packets do not verify, and ours do not to it');
    expect(stranger.linked, isFalse);
    expect(a.clientCount, 0);
  });
}
