import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/barclaycard_provider.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';

/// The till's Barclaycard route (pay on the customer's phone) against a
/// stubbed Vesopa server.
void main() {
  BarclaycardProvider provider(List<Map<String, dynamic>> states, {List<String>? calls}) {
    var i = 0;
    return BarclaycardProvider(
      apiBase: 'https://bo.example',
      token: 't',
      client: MockClient((req) async {
        calls?.add('${req.method} ${req.url.path}');
        if (req.method == 'POST' && req.url.path == '/api/till/barclaycard/payments') {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          expect(body['amount_minor'], 1280);
          return http.Response(jsonEncode({'id': 'p1', 'url': 'https://bo.example/api/public/barclaycard/pay/p1', 'status': 'NEW'}), 201);
        }
        if (req.url.path.endsWith('/cancel')) {
          return http.Response(jsonEncode({'ok': true, 'message': 'Cancelled.'}), 200);
        }
        if (req.url.path == '/api/till/barclaycard/refunds') {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          expect(body['gateway_payment_id'], '7925');
          return http.Response(jsonEncode({'ok': true, 'message': 'Refunded to the card.', 'refund_id': 'r1'}), 200);
        }
        final s = states[i < states.length ? i : states.length - 1];
        i += 1;
        return http.Response(jsonEncode(s), 200);
      }),
    );
  }

  test('shows the QR code, then books the Barclaycard payment id when paid', () async {
    String? link;
    final p = provider([
      {'id': 'p1', 'status': 'NEW', 'progress': 'WAITING_FOR_CARD_ENTRY', 'final': false, 'message': 'The customer has the payment page open.'},
      {'id': 'p1', 'status': 'SUCCESSFUL', 'final': true, 'outcome': 'approved', 'message': 'Paid', 'gateway_payment_id': '7925', 'card_last4': '1111', 'auth_code': '831000'},
    ]);
    p.onPayLink = (url) => link = url;
    final r = await p.take(1280, orderId: 'o1');
    expect(link, 'https://bo.example/api/public/barclaycard/pay/p1');
    expect(r.approved, isTrue);
    expect(r.kind, CardOutcome.approved);
    expect(r.reference, 'barclays:7925');
    expect(r.cardLast4, '1111');
  });

  test('cancel from the till closes the page and takes nothing', () async {
    final calls = <String>[];
    final p = provider([
      {'id': 'p1', 'status': 'NEW', 'final': false, 'message': 'Waiting for the customer to scan the code.'},
    ], calls: calls);
    p.onProgress = (_, _) => p.requestCancel();
    final r = await p.take(1280);
    expect(r.approved, isFalse);
    expect(r.kind, CardOutcome.cancelled);
    expect(calls, contains('POST /api/till/barclaycard/payments/p1/cancel'));
  });

  test('a timed-out page is not a payment', () async {
    final r = await provider([
      {'id': 'p1', 'status': 'CANCELLED', 'reason': 'EXPIRED', 'final': true, 'outcome': 'cancelled', 'message': 'The payment page timed out. No money was taken.'},
    ]).take(1280);
    expect(r.approved, isFalse);
    expect(r.kind, CardOutcome.expired);
  });

  test('refunds go back through Barclaycard by the payment id', () async {
    final r = await provider(const []).refund('barclays:7925', 500);
    expect(r.ok, isTrue);
    expect(r.refundId, 'r1');
    expect(isBarclaycardReference('barclays:7925'), isTrue);
  });
}
