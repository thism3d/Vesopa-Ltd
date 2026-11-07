import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/data/kitchen_print_queue.dart';

void main() {
  const ticketId = '11111111-1111-4111-8111-111111111111';
  final claimJson = {
    'claim_id': '22222222-2222-4222-8222-222222222222',
    'stations': ['kp1'],
    'ticket': {
      'id': ticketId,
      'kind': 'table',
      'table_number': 12,
      'room_name': 'Lounge',
      'staff_name': 'Sam',
      'placed_at': '2026-11-07T18:30:00Z',
      'lines': [
        {'quantity': 2, 'name': 'Burger', 'note': 'No salt', 'is_modifier': false, 'stations': ['kp1']},
        {'quantity': 2, 'name': 'Chips', 'is_modifier': true, 'stations': ['kp1']},
        {'quantity': 1, 'name': 'Soup', 'is_modifier': false, 'stations': ['kp2']},
      ],
    },
  };

  group('a Go ticket on paper', () {
    test('carries only its station, with the table and a choice under its dish', () {
      final claim = GoTicketClaim.fromJson(claimJson)!;
      final t = claim.ticketFor('kp1');
      expect(t.order.tableNumber, 12);
      expect(t.lines.map((l) => l.name), ['Burger', 'Chips']);
      expect(t.lines[0].quantity, 2);
      expect(t.lines[0].notes, 'No salt');
      expect(t.lines[1].parentLineId, t.lines[0].id);
    });

    test('says it is a saved table or a sale, and that it came from Go', () {
      expect(GoTicketClaim.fromJson(claimJson)!.headline, 'Table saved - Vesopa Go');
      final sale = jsonDecode(jsonEncode(claimJson)) as Map<String, dynamic>;
      (sale['ticket'] as Map)['kind'] = 'sale';
      expect(GoTicketClaim.fromJson(sale)!.headline, 'Sale - Vesopa Go');
    });

    test('another till won: nothing to print', () {
      expect(GoTicketClaim.fromJson({'claim_id': null, 'stations': []}), isNull);
    });
  });

  group('the queue', () {
    test('reads the jobs, and asks with the till\'s token', () async {
      late http.Request seen;
      final s = KitchenPrintService(
        apiBase: 'https://x',
        terminalToken: 't',
        client: MockClient((r) async {
          seen = r;
          return http.Response(jsonEncode({'jobs': [{'ticket_id': ticketId, 'stations': ['kp1', 'kp2']}]}), 200);
        }),
      );
      final jobs = await s.queue();
      expect(seen.url.path, '/till/kitchen/print-queue');
      expect(seen.headers['Authorization'], 'Bearer t');
      expect(jobs.single.ticketId, ticketId);
      expect(jobs.single.stations, ['kp1', 'kp2']);
    });

    test('a server that is down is an empty queue, not a crash', () async {
      final s = KitchenPrintService(apiBase: 'https://x', terminalToken: 't', client: MockClient((_) async => throw Exception('down')));
      expect(await s.queue(), isEmpty);
      expect(await s.claim(ticketId, ['kp1'], terminal: 'Bar'), isNull);
    });

    test('a till with no token asks nothing', () async {
      var asked = false;
      final s = KitchenPrintService(apiBase: 'https://x', terminalToken: null, client: MockClient((_) async {
        asked = true;
        return http.Response('{}', 200);
      }));
      expect(await s.queue(), isEmpty);
      expect(asked, isFalse);
    });

    test('says how each station went', () async {
      late Map<String, dynamic> body;
      final s = KitchenPrintService(apiBase: 'https://x', terminalToken: 't', client: MockClient((r) async {
        body = jsonDecode(r.body) as Map<String, dynamic>;
        return http.Response('{"ok":true}', 200);
      }));
      await s.report(GoTicketClaim.fromJson(claimJson)!, {'kp1': null, 'kp2': 'Out of paper'});
      expect(body['claim_id'], claimJson['claim_id']);
      expect(body['results'], [
        {'station': 'kp1', 'ok': true},
        {'station': 'kp2', 'ok': false, 'error': 'Out of paper'},
      ]);
    });
  });
}
