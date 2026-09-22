import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';

/// The shape the live API actually returns when an intent is created.
///
/// Note what is NOT here: `clientSessionSecret`. Creating an intent yields only
/// a zeroed expiry date, and the secret has to be asked for separately. Getting
/// this wrong is what made Manual card fail with "Dojo did not return a client
/// secret for this payment".
const _createResponse = '''
{
  "id": "pi_sandbox_TEST",
  "captureMode": "Auto",
  "cardHolderNotPresent": false,
  "clientSessionSecretExpirationDate": "0001-01-01T00:00:00Z",
  "status": "Created",
  "paymentLink": "https://pay.dojo.tech:443/checkout/pi_sandbox_TEST"
}
''';

const _refreshResponse = '''
{
  "id": "pi_sandbox_TEST",
  "clientSessionSecret": "SECRET-123",
  "clientSessionSecretExpirationDate": "2026-07-24T04:45:42Z",
  "status": "Created"
}
''';

void main() {
  late List<http.Request> sent;

  DojoProvider provider({int refreshStatus = 200}) {
    sent = [];
    return DojoProvider(
      apiKey: 'sk_sandbox_test',
      client: MockClient((request) async {
        sent.add(request);
        if (request.url.path.endsWith('/refresh-client-session-secret')) {
          return http.Response(_refreshResponse, refreshStatus);
        }
        return http.Response(_createResponse, 200);
      }),
    );
  }

  group('creating an intent', () {
    test('does not fetch a secret unless one is asked for', () async {
      final intent = await provider().createIntent(560, orderId: 'order-1');

      // One call only: the terminal route has no use for a client secret and
      // should not pay for the extra round trip.
      expect(sent, hasLength(1));
      expect(intent.id, 'pi_sandbox_TEST');
      expect(intent.clientSecret, isNull);
      expect(intent.paymentLink, contains('/checkout/pi_sandbox_TEST'));
    });

    test('sends the amount in pence, PascalCase', () async {
      await provider().createIntent(560, orderId: 'order-1');

      final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
      // Lowercase `amount` is rejected with "The Amount field is required".
      expect(body['Amount'], {'Value': 560, 'CurrencyCode': 'GBP'});
      expect(body['Reference'], 'order-1');
      // A presented card must not be flagged keyed.
      expect(body.containsKey('CardHolderNotPresent'), isFalse);
    });

    test('flags a keyed card as card-not-present', () async {
      await provider().createIntent(560, cardHolderNotPresent: true);

      final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
      // Different interchange, different liability — it must not be passed off
      // as a dipped card.
      expect(body['CardHolderNotPresent'], isTrue);
    });
  });

  group('client session secret', () {
    test('is fetched with a second call when requested', () async {
      final dojo = provider();
      final intent = await dojo.createIntent(560, withClientSecret: true);

      expect(sent, hasLength(2));
      expect(
        sent.last.url.path,
        '/payment-intents/pi_sandbox_TEST/refresh-client-session-secret',
      );
      expect(sent.last.method, 'POST');
      expect(intent.clientSecret, 'SECRET-123');
      // The id and checkout link survive the second call.
      expect(intent.id, 'pi_sandbox_TEST');
      expect(intent.paymentLink, contains('pi_sandbox_TEST'));
    });

    test('can be minted for an intent that already exists', () async {
      final secret = await provider().refreshClientSecret('pi_sandbox_TEST');
      expect(secret, 'SECRET-123');
    });

    test('a refusal is an error, not a silent null', () async {
      // A missing secret means the drop-in cannot open at all, so it must fail
      // loudly rather than hand the SDK a null and let it fail on the customer's
      // screen.
      expect(
        () => provider(refreshStatus: 401).createIntent(
          560,
          withClientSecret: true,
        ),
        throwsA(isA<DojoException>()),
      );
    });
  });
}
