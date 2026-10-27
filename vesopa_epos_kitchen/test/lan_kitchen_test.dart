import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos_kitchen/data/lan/lan_link.dart';
import 'package:vesopa_epos_kitchen/data/lan/lan_service.dart';
import 'package:vesopa_epos_kitchen/data/ticket.dart';

/// A kitchen screen on the venue's local link (2026-10-27): a ticket fired on
/// a till arrives over the venue's own network, with the internet down, and
/// reads as the same card the back office would have drawn.
void main() {
  test('a ticket fired on a till reaches the kitchen screen over the local link', () async {
    SharedPreferences.setMockInitialValues({});
    final key = List<int>.generate(32, (i) => (i * 13 + 5) % 256);
    final hex = key.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

    final till = LanNode(
      LanIdentity(venueKey: key, id: 'till-bar', name: 'Bar', role: 'till'),
      discoveryPort: 47971,
      linkPort: 0,
      broadcast: false,
      claimAfter: const Duration(milliseconds: 300),
      announceEvery: const Duration(milliseconds: 200),
    );
    await till.start();
    addTearDown(till.dispose);

    final api = MockClient((req) async => req.url.path == '/api/lan/key'
        ? http.Response(jsonEncode({'key': hex, 'targets': []}), 200)
        : http.Response('{}', 200));
    // The kitchen asks the till directly: no broadcast in a test.
    await LanService.instance.configure(
      apiBase: 'http://backoffice.test',
      token: 'kitchen-token',
      deviceId: 'kitchen-1',
      name: 'Grill',
      version: 'test',
      role: 'kitchen',
      client: api,
    );
    LanService.instance.node!.targets = [(host: '127.0.0.1', port: 47971)];
    addTearDown(() async => LanService.instance.node?.dispose());

    final heard = <LanMessage>[];
    LanService.instance.subscribe('kitchen', heard.add);

    final end = DateTime.now().add(const Duration(seconds: 10));
    while (!LanService.instance.linked) {
      if (DateTime.now().isAfter(end)) fail('the kitchen screen never linked to the till');
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }

    till.publish('kitchen', {
      'op': 'ticket',
      'ticket': {
        'id': 'tk-1',
        'office': 'club@venue.test',
        'order_id': 'order-6',
        'kind': 'sale',
        'placed_at': DateTime.now().toUtc().toIso8601String(),
        'table_number': 6,
        'staff_name': 'Nicki',
        'lines': [
          {'id': 'l1', 'quantity': 2, 'name': 'Burger', 'stations': 'grill'},
          {'id': 'l2', 'quantity': 1, 'name': 'Chips', 'stations': 'fryer', 'note': 'no salt'},
        ],
      },
    }, log: true);

    while (heard.isEmpty) {
      if (DateTime.now().isAfter(end)) fail('the ticket never arrived');
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    final ticket = Ticket.fromTill(((heard.single.data as Map)['ticket'] as Map).cast<String, dynamic>());
    expect(ticket.id, 'tk-1');
    expect(ticket.tableNumber, 6);
    expect(ticket.lines.map((l) => l.name), ['Burger', 'Chips']);
    expect(ticket.lines.last.note, 'no salt');
    expect(ticket.linesFor({'grill'}).single.name, 'Burger');
    expect(ticket.isComplete, isFalse);
  }, timeout: const Timeout(Duration(seconds: 40)));
}
