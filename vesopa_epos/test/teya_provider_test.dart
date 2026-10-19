import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';
import 'package:vesopa_epos/payments/teya_provider.dart';

/// The till's Teya provider against a stubbed Vesopa server.
void main() {
  TeyaProvider provider(List<Map<String, dynamic>> states, {List<String>? calls, int createStatus = 201}) {
    var i = 0;
    return TeyaProvider(
      apiBase: 'https://bo.example',
      token: 't',
      terminalId: 'term-1',
      client: MockClient((req) async {
        calls?.add('${req.method} ${req.url.path}');
        if (req.method == 'POST' && req.url.path == '/api/till/teya/payments') {
          if (createStatus != 201) {
            return http.Response(jsonEncode({'error': 'The card machine is already taking another payment.', 'code': 'TRANSACTION_ALREADY_IN_PROGRESS'}), createStatus);
          }
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          expect(body['terminal_id'], 'term-1');
          return http.Response(jsonEncode({'id': 'pr1', 'status': 'NEW'}), 201);
        }
        if (req.url.path.endsWith('/cancel')) {
          return http.Response(jsonEncode({'ok': true, 'message': 'Cancelling'}), 200);
        }
        final s = states[i < states.length ? i : states.length - 1];
        i += 1;
        return http.Response(jsonEncode(s), 200);
      }),
    );
  }

  test('an approved payment books the gateway id for refunds', () async {
    final progress = <String?>[];
    final p = provider([
      {'id': 'pr1', 'status': 'IN_PROGRESS', 'progress': 'WAITING_FOR_CARD_ENTRY', 'final': false, 'message': 'Present card'},
      {'id': 'pr1', 'status': 'SUCCESSFUL', 'final': true, 'outcome': 'approved', 'message': 'Approved', 'gateway_payment_id': 'gw9', 'card_last4': '4673', 'card_brand': 'MASTERCARD', 'auth_code': '537001'},
    ]);
    p.onProgress = (step, _) => progress.add(step);
    final r = await p.take(1250, orderId: 'o1');
    expect(r.approved, isTrue);
    expect(r.kind, CardOutcome.approved);
    expect(r.reference, 'teya:gw9');
    expect(r.sessionId, 'pr1');
    expect(r.cardLast4, '4673');
    expect(progress, contains('WAITING_FOR_CARD_ENTRY'));
  });

  test('a decline is a decline, never paid', () async {
    final r = await provider([
      {'id': 'pr1', 'status': 'FAILED', 'reason': 'DECLINED_ONLINE', 'final': true, 'outcome': 'declined', 'message': 'Card declined.'},
    ]).take(500);
    expect(r.approved, isFalse);
    expect(r.kind, CardOutcome.declined);
    expect(r.message, 'Card declined.');
  });

  test('cancel from the till asks the server and follows to the result', () async {
    final calls = <String>[];
    final p = provider([
      {'id': 'pr1', 'status': 'IN_PROGRESS', 'final': false},
      {'id': 'pr1', 'status': 'CANCELLED', 'reason': 'CANCELLED_BY_EPOS', 'final': true, 'outcome': 'cancelled', 'message': 'Cancelled from the till.'},
    ], calls: calls);
    p.onProgress = (_, _) => p.requestCancel();
    final r = await p.take(500);
    expect(r.kind, CardOutcome.cancelled);
    expect(calls, contains('POST /api/till/teya/payments/pr1/cancel'));
  });

  test('nothing sent to the machine is a clean failure', () async {
    final r = await provider(const [], createStatus: 409).take(500);
    expect(r.approved, isFalse);
    expect(r.kind, CardOutcome.busy);
    expect(r.reference, isNull);
  });

  test('stop waiting is "not confirmed", never declined', () async {
    final p = provider([
      {'id': 'pr1', 'status': 'IN_PROGRESS', 'final': false},
    ]);
    p.onProgress = (_, _) => p.stopWaiting();
    final r = await p.take(500);
    expect(r.kind.uncertain, isTrue);
    expect(r.reference, 'teya:pr1');
  });

  test('a Teya reference is recognised', () {
    expect(isTeyaReference('teya:gw1'), isTrue);
    expect(isTeyaReference('pi_123'), isFalse);
    expect(isTeyaReference(null), isFalse);
  });
}
