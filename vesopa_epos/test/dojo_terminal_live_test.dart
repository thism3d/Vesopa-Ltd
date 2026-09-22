@Tags(['live'])
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/payments/dojo_config.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';

/// Exercises the pay-at-counter flow against Dojo's real sandbox.
///
/// Tagged `live` and excluded from the default run (see dart_test.yaml) because
/// it needs the network and a sandbox terminal. Run it deliberately with:
///
///     flutter test --tags live
///
/// It is here because the terminal flow is the one part that cannot be proved
/// with mocks alone: the endpoint shape, the mandatory `reseller-id` header and
/// the signature step were all discovered by calling the real thing.
void main() {
  // The key is never committed (this repo is public). Supply it when running:
  //   flutter test --tags live --dart-define=DOJO_API_KEY=sk_sandbox_…
  const key = String.fromEnvironment('DOJO_API_KEY');

  setUpAll(() {
    if (key.isEmpty) {
      fail(
        'These tests need a sandbox key: '
        'flutter test --tags live --dart-define=DOJO_API_KEY=sk_sandbox_…',
      );
    }
  });

  DojoProvider provider({String? terminalId}) => DojoProvider(
    apiKey: key,
    softwareHouseId: DojoConfig.defaultSoftwareHouseId,
    resellerId: DojoConfig.defaultResellerId,
    terminalId: terminalId,
    pollTimeout: const Duration(seconds: 90),
  );

  test('lists available sandbox card machines', () async {
    final terminals = await provider().listTerminals();

    expect(terminals, isNotEmpty, reason: 'sandbox should expose test readers');
    expect(terminals.every((t) => t.available), isTrue);
    expect(terminals.first.id, startsWith('tm_sandbox_'));
  }, timeout: const Timeout(Duration(seconds: 60)));

  test('takes a payment on a card machine, end to end', () async {
    final terminals = await provider().listTerminals();
    final reader = terminals.first;

    final dojo = provider(terminalId: reader.id);

    // The sandbox reader always asks for a signature; accepting it is what lets
    // the session reach Captured.
    final prompts = <String>[];
    dojo.onTerminalUpdate = (s) {
      if (s.lastNotification != null) prompts.add(s.lastNotification!);
    };

    final result = await dojo.take(560, orderId: 'live-test');

    expect(
      result.approved,
      isTrue,
      reason: 'sandbox sale should capture: ${result.message}',
    );
    expect(result.reference, startsWith('pi_sandbox_'));
    // The reader tells the customer what to do; the till surfaces these.
    expect(prompts, contains('PresentCard'));
  }, timeout: const Timeout(Duration(seconds: 120)));

  // NOTE: the sandbox reader picks the cardholder verification method itself —
  // some sales run chip-and-PIN (Initiated → PresentCard → EnterPin →
  // RemoveCard → Captured) and never ask for a signature at all. So this only
  // asserts the rejection path *when* a signature is actually requested; it
  // cannot force one.
  test('a rejected signature is never reported as money taken', () async {
    final terminals = await provider().listTerminals();
    final dojo = provider(terminalId: terminals.first.id);

    var wasAsked = false;
    dojo.onSignatureRequested = () async {
      wasAsked = true;
      return false;
    };

    final result = await dojo.take(320, orderId: 'live-reject');

    if (wasAsked) {
      expect(result.approved, isFalse);
      expect(result.message, contains('Signature rejected'));
    } else {
      // A PIN sale: it should have captured cleanly instead.
      expect(result.approved, isTrue, reason: result.message);
    }
  }, timeout: const Timeout(Duration(seconds: 120)));
}
