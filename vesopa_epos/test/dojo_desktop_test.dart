import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/dojo_desktop.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';

/// The desktop card flow is the one path that cannot be exercised on this
/// machine (it only runs on the Windows till), so it is pinned down here
/// instead: the routing decision, the settle/decline outcomes, and above all
/// that an abandoned or unfinished payment is never reported as money taken.
void main() {
  DojoProvider restWith(http.Client client) =>
      DojoProvider(apiKey: 'sk_sandbox_test', client: client);

  /// A stub Dojo: creates an intent, then returns [statuses] in turn as the
  /// intent is polled.
  MockClient dojo({
    required List<String> statuses,
    String? paymentLink = 'https://pay.dojo.tech/checkout/pi_test',
    void Function(http.Request req)? onRequest,
  }) {
    var polls = 0;
    return MockClient((req) async {
      onRequest?.call(req);
      if (req.method == 'POST' && req.url.path.endsWith('/payment-intents')) {
        return http.Response(
          jsonEncode({
            'id': 'pi_test',
            'clientSessionSecret': 'secret',
            if (paymentLink != null) 'paymentLink': paymentLink,
          }),
          201,
        );
      }
      if (req.method == 'POST' && req.url.path.endsWith('/terminal-sessions')) {
        return http.Response(
          jsonEncode({'id': 'ts_test', 'status': 'InitiateRequested'}),
          200,
        );
      }
      // GET the intent or the session: walk through the scripted statuses.
      final status = statuses[polls.clamp(0, statuses.length - 1)];
      polls++;
      if (req.url.path.contains('/terminal-sessions/')) {
        return http.Response(
          jsonEncode({
            'id': 'ts_test',
            'status': status,
            'notificationEvents': [
              {'notificationType': 'PresentCard'},
            ],
          }),
          200,
        );
      }
      return http.Response(jsonEncode({'id': 'pi_test', 'status': status}), 200);
    });
  }

  test('with no reader, opens the hosted checkout and settles when paid', () async {
    String? opened;
    final provider = DesktopDojoProvider(
      intents: restWith(dojo(statuses: ['created', 'succeeded'])),
      openCheckout: (url) async {
        opened = url;
        return true;
      },
    );

    expect(provider.mode, DesktopCardMode.hostedCheckout);

    final result = await provider.take(560, orderId: 'order-1');

    expect(opened, 'https://pay.dojo.tech/checkout/pi_test');
    expect(result.approved, isTrue);
    expect(result.amountMinor, 560);
    expect(result.reference, 'pi_test');
  });

  test('with a reader configured, runs a terminal session instead', () async {
    final sentTo = <String>[];
    final provider = DesktopDojoProvider(
      intents: DojoProvider(
        apiKey: 'sk_sandbox_test',
        terminalId: 'tm_test',
        softwareHouseId: 'SH-1',
        resellerId: 'RS-1',
        client: dojo(
          // A terminal session reports `Captured`, not `succeeded`.
          statuses: ['Captured'],
          onRequest: (r) {
            if (r.method == 'POST' &&
                r.url.path.endsWith('/terminal-sessions')) {
              sentTo.add(r.url.path);
            }
          },
        ),
      ),
      openCheckout: (_) async => fail('must not open a window with a reader'),
    );

    expect(provider.mode, DesktopCardMode.terminal);
    final result = await provider.take(1000);

    expect(sentTo, isNotEmpty, reason: 'should push the sale to the reader');
    expect(result.approved, isTrue);
  });

  test('a reader without both partner ids falls back to on-screen', () async {
    // Dojo refuses the terminal endpoints without reseller-id, so a half
    // configured till must not try to use the machine.
    final provider = DesktopDojoProvider(
      intents: DojoProvider(
        apiKey: 'sk_sandbox_test',
        terminalId: 'tm_test',
        softwareHouseId: 'SH-1',
        // resellerId missing
        client: dojo(statuses: ['succeeded']),
      ),
      openCheckout: (_) async => true,
    );

    expect(provider.mode, DesktopCardMode.hostedCheckout);
  });

  test('an Authorized session is not yet money in the till', () async {
    // Authorized comes before signature verification; treating it as paid would
    // book a sale that a rejected signature then declines.
    final provider = DesktopDojoProvider(
      intents: DojoProvider(
        apiKey: 'sk_sandbox_test',
        terminalId: 'tm_test',
        softwareHouseId: 'SH-1',
        resellerId: 'RS-1',
        client: dojo(statuses: ['Authorized', 'Declined']),
      ),
      openCheckout: (_) async => fail('reader configured'),
    );

    final result = await provider.take(1000);
    expect(result.approved, isFalse);
    expect(result.message, contains('declined'));
  });

  test('a declined intent is not approved', () async {
    final provider = DesktopDojoProvider(
      intents: restWith(dojo(statuses: ['failed'])),
      openCheckout: (_) async => true,
    );

    final result = await provider.take(250);
    expect(result.approved, isFalse);
    expect(result.message, contains('failed'));
  });

  test('cancelling stops the wait and never reports the money as taken', () async {
    // An intent that never leaves "created" — the customer walked away.
    final provider = DesktopDojoProvider(
      intents: restWith(dojo(statuses: ['created'])),
      openCheckout: (_) async => true,
      pollTimeout: const Duration(seconds: 30),
    );

    provider.onStageChanged = (stage) {
      // Abandon as soon as we are waiting on the customer.
      if (stage == DojoStage.awaitingCard) provider.cancel();
    };

    final result = await provider.take(700);

    expect(result.approved, isFalse);
    expect(result.message, contains('abandoned'));
  });

  test('timing out is reported as unknown, not as a decline', () async {
    final provider = DesktopDojoProvider(
      intents: restWith(dojo(statuses: ['created'])),
      openCheckout: (_) async => true,
      // Already expired, so the loop exits without a verdict.
      pollTimeout: Duration.zero,
    );

    final result = await provider.take(700);
    expect(result.approved, isFalse);
    expect(result.message, contains('may still have gone through'));
  });

  test('a failure to open the checkout window is not a payment', () async {
    final provider = DesktopDojoProvider(
      intents: restWith(dojo(statuses: ['succeeded'])),
      openCheckout: (_) async => false,
    );

    final result = await provider.take(300);
    expect(result.approved, isFalse);
    expect(result.message, contains('Could not open'));
  });
}
