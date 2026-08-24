import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';

/// The Dojo calls added for accreditation: refunds, capture, and the request
/// shapes Dojo are fussy about.
///
/// These are pinned down here rather than left to the sandbox because each one
/// has a shape that is *not* guessable from the rest of the API, and each was a
/// 400 before it was right:
///
///   * `captures` and `refunds` take `amount` as a bare integer, while every
///     other endpoint takes `{value, currencyCode}`.
///   * `refunds` needs an `idempotencyKey` *header*, which nothing else does.
///   * `autoExpireIn` is a .NET TimeSpan (`d.hh:mm:ss`), not an ISO duration,
///     and is rejected outside 30 seconds to 7 days.
///   * item-line modifiers need all four of id/name/quantity/amountPerModifier.
///
/// A regression in any of those is a payment that fails at the counter, and the
/// error Dojo return for it is not one a clerk can act on.
void main() {
  /// Captures the last request so its body can be asserted on.
  ({DojoProvider provider, List<http.Request> sent}) providerRecording({
    int status = 200,
    Map<String, dynamic> body = const {'id': 'pi_test'},
  }) {
    final sent = <http.Request>[];
    final client = MockClient((req) async {
      sent.add(req);
      return http.Response(jsonEncode(body), status);
    });
    return (
      provider: DojoProvider(
        apiKey: 'sk_sandbox_test',
        softwareHouseId: 'softwareHouse1',
        resellerId: 'reseller1',
        terminalId: 'tm_test',
        client: client,
      ),
      sent: sent,
    );
  }

  group('refunds', () {
    test('sends a bare integer amount and an idempotencyKey header', () async {
      final r = providerRecording(body: {'refundId': 'rf_test'});
      final id = await r.provider.refundToCard(
        'pi_test',
        amountMinor: 250,
        idempotencyKey: 'vesopa-abc',
        reason: 'Customer returned it',
      );

      expect(id, 'rf_test');
      final req = r.sent.single;
      expect(req.url.path, '/payment-intents/pi_test/refunds');
      expect(req.headers['idempotencyKey'], 'vesopa-abc');

      final json = jsonDecode(req.body) as Map<String, dynamic>;
      // A bare integer. `{value, currencyCode}` here is a 400.
      expect(json['amount'], 250);
      expect(json['refundReason'], 'Customer returned it');
    });

    test('a matched refund references the intent and sends no amount', () async {
      final r = providerRecording(body: {'id': 'ts_test'});
      await r.provider.startRefundSession(amountMinor: 500, intentId: 'pi_test');

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      final details = json['details'] as Map<String, dynamic>;
      expect(details['sessionType'], 'MatchedRefund');
      expect(details['matchedRefund'], {'paymentIntentId': 'pi_test'});
      // The amount comes from the original sale, not from us — sending one
      // would be a way to refund more than was taken.
      expect(details.containsKey('unlinkedRefund'), isFalse);
    });

    test('an unlinked refund carries the amount and no intent', () async {
      final r = providerRecording(body: {'id': 'ts_test'});
      await r.provider.startRefundSession(amountMinor: 500);

      final details =
          (jsonDecode(r.sent.single.body) as Map<String, dynamic>)['details']
              as Map<String, dynamic>;
      expect(details['sessionType'], 'UnlinkedRefund');
      expect(details['unlinkedRefund'], {
        'amount': {'value': 500, 'currencyCode': 'GBP'},
      });
    });

    test('refusing to refund without a reader is not a network call', () async {
      final client = MockClient((_) async => fail('should not have called out'));
      final provider = DojoProvider(apiKey: 'sk_sandbox_test', client: client);

      await expectLater(
        provider.startRefundSession(amountMinor: 100),
        throwsA(isA<DojoException>()),
      );
    });
  });

  group('capture', () {
    test('sends a bare integer amount', () async {
      final r = providerRecording();
      await r.provider.capture('pi_test', 2400, tipsMinor: 100);

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      expect(json['amount'], 2400);
      expect(json['tipsAmount'], 100);
    });

    test('omits the tip when there is not one', () async {
      final r = providerRecording();
      await r.provider.capture('pi_test', 2400);

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      expect(json.containsKey('tipsAmount'), isFalse);
    });
  });

  group('intent creation', () {
    test('a pre-auth carries a .NET TimeSpan expiry and Release', () async {
      final r = providerRecording();
      await r.provider.createIntent(1800, preAuth: true);

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      expect(json['CaptureMode'], 'Manual');
      expect(json['autoExpireIn'], '6.00:00:00');
      // Release, not Capture: an authorisation nobody came back for should let
      // the customer's money go, not help itself to it.
      expect(json['autoExpireAction'], 'Release');
    });

    test('an over-long expiry is clamped under Dojo\'s 7-day limit', () async {
      final r = providerRecording();
      await r.provider.createIntent(
        1800,
        preAuth: true,
        preAuthExpiry: const Duration(days: 30),
      );

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      expect(json['autoExpireIn'], '6.23:00:00');
    });

    test('a too-short expiry is clamped above the 30-second floor', () async {
      final r = providerRecording();
      await r.provider.createIntent(
        1800,
        preAuth: true,
        preAuthExpiry: const Duration(seconds: 5),
      );

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      expect(json['autoExpireIn'], '0.00:00:31');
    });

    test('an ordinary sale sends no expiry fields at all', () async {
      final r = providerRecording();
      await r.provider.createIntent(500);

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      expect(json['CaptureMode'], 'Auto');
      expect(json.containsKey('autoExpireIn'), isFalse);
    });

    test('tips and cashback go on the intent, not a later call', () async {
      final r = providerRecording();
      await r.provider.createIntent(1000, tipsMinor: 150, cashbackMinor: 500);

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      // POST /tips-amount answers 405 on this account, so creation time is the
      // only route that works.
      expect(json['tipsAmount'], {'value': 150, 'currencyCode': 'GBP'});
      expect(json['cashbackAmount'], {'value': 500, 'currencyCode': 'GBP'});
    });

    test('item lines carry every field a modifier requires', () async {
      final r = providerRecording();
      await r.provider.createIntent(
        925,
        itemLines: const [
          DojoItemLine(
            name: 'Flat white',
            quantity: 2,
            totalMinor: 640,
            plu: 'COF-FW',
            modifiers: [
              DojoModifier(id: 'MOD-OAT', name: 'Oat milk', amountMinor: 40),
              // Negative: a promotion has to show as its own line rather than
              // silently shrinking the price.
              DojoModifier(
                id: 'PROMO-STAFF',
                name: 'Staff discount',
                amountMinor: -100,
              ),
            ],
          ),
        ],
      );

      final lines = (jsonDecode(r.sent.single.body)
          as Map<String, dynamic>)['itemLines'] as List;
      final line = lines.single as Map<String, dynamic>;
      expect(line['name'], 'Flat white');
      expect(line['amountTotal'], {'value': 640, 'currencyCode': 'GBP'});
      expect(line['plu'], 'COF-FW');

      final mods = line['modifiers'] as List;
      // All four fields, or Dojo reject the whole intent with a 400.
      for (final m in mods.cast<Map<String, dynamic>>()) {
        expect(m.keys.toSet(), {'id', 'name', 'quantity', 'amountPerModifier'});
      }
      expect(
        (mods.last as Map<String, dynamic>)['amountPerModifier'],
        {'value': -100, 'currencyCode': 'GBP'},
      );
    });

    test('a keyed card is flagged card-holder-not-present', () async {
      final r = providerRecording();
      await r.provider.createIntent(999, cardHolderNotPresent: true);

      final json = jsonDecode(r.sent.single.body) as Map<String, dynamic>;
      expect(json['CardHolderNotPresent'], true);
    });
  });

  group('errors the clerk has to act on', () {
    Future<DojoException> failing(int status, String body) async {
      final client = MockClient((_) async => http.Response(body, status));
      final provider = DojoProvider(
        apiKey: 'sk_sandbox_test',
        softwareHouseId: 'softwareHouse1',
        resellerId: 'reseller1',
        terminalId: 'tm_test',
        client: client,
      );
      try {
        await provider.setAmount('pi_test', 100);
        fail('expected a DojoException');
      } on DojoException catch (e) {
        return e;
      }
    }

    test('401 asks for the API key to be checked, not "payment failed"',
        () async {
      final e = await failing(401, '');
      expect(e.statusCode, 401);
      expect(e.clerkMessage, contains('API key'));
      expect(e.retryable, isFalse);
    });

    test('404 points the clerk at the card machine', () async {
      final e = await failing(404, '{"Detail":"not found"}');
      expect(e.clerkMessage, contains('card machine'));
    });

    test('409 is retryable and says the machine is busy', () async {
      final e = await failing(
        409,
        '{"detail":"the terminal is either offline or currently in use"}',
      );
      expect(e.retryable, isTrue);
      expect(e.clerkMessage, contains('busy'));
    });

    test('422 is passed through verbatim — Dojo explain it best', () async {
      final e = await failing(
        422,
        '{"detail":"the status of the terminal session doesn\'t allow it to be '
        'canceled"}',
      );
      expect(e.clerkMessage, contains("doesn't allow it to be canceled"));
    });

    test('a validation error surfaces the field message, not the raw body',
        () async {
      final e = await failing(
        400,
        '{"errors":{"Amount.Value":["is too small"]},"traceId":"trace-123"}',
      );
      expect(e.message, 'is too small');
      // Dojo support ask for this first.
      expect(e.traceId, 'trace-123');
    });

    test('an amount of zero never reaches the network', () async {
      final client = MockClient((_) async => fail('should not have called out'));
      final provider = DojoProvider(apiKey: 'sk_sandbox_test', client: client);

      await expectLater(
        provider.setAmount('pi_test', 0),
        throwsA(isA<DojoException>()),
      );
    });

    test('a non-JSON body falls back to a sentence, not raw HTML', () async {
      final e = await failing(502, '<html><body>Bad Gateway</body></html>');
      expect(e.message, 'Could not change the amount');
      expect(e.clerkMessage, isNot(contains('<html>')));
    });
  });
}
