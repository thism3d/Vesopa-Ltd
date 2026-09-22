@Tags(['live'])
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/payments/dojo_config.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';

/// The accreditation checklist, run through the till's own payment code.
///
/// Every other test in this repository stubs the network. This one does not,
/// and that is the point: Dojo accredit the *integration*, so the evidence has
/// to come from the code the till actually ships with — `DojoProvider`,
/// `take()`, `awaitTerminal()`, the real polling loop and the real error
/// mapping — rather than from a script written alongside it that happens to
/// send similar requests.
///
/// Tagged `live` and excluded from CI (see dart_test.yaml). Run it deliberately
/// against Vesopa's own sandbox account:
///
///     flutter test --tags live --dart-define=DOJO_API_KEY=sk_sandbox_…
///
/// The account carries one virtual terminal per outcome, chosen by the last
/// four characters of its TID, so each scenario below is produced by the
/// acquirer rather than simulated here:
///
///     SIP0  a successful chip-and-PIN sale
///     DIP0  a decline
///     CIP0  cancelled at the card machine
///     TIP0  the result never arrives — expired
///     SIS0  signature verification required
void main() {
  const key = String.fromEnvironment('DOJO_API_KEY');

  setUpAll(() {
    if (key.isEmpty) {
      fail(
        'These tests need the sandbox key: '
        'flutter test --tags live --dart-define=DOJO_API_KEY=sk_sandbox_…',
      );
    }
  });

  DojoProvider provider({String? terminalId}) => DojoProvider(
    apiKey: key,
    softwareHouseId: DojoConfig.defaultSoftwareHouseId,
    resellerId: DojoConfig.defaultResellerId,
    terminalId: terminalId,
    pollTimeout: const Duration(seconds: 150),
  );

  /// The reader that simulates [outcome], by TID suffix.
  Future<DojoTerminal> readerFor(String suffix) async {
    final terminals = await provider().listTerminals();
    return terminals.firstWhere(
      (t) => t.tid.toUpperCase().endsWith(suffix),
      orElse: () => throw StateError(
        'No terminal ending $suffix on this account. '
        'Found: ${terminals.map((t) => t.tid).join(', ')}',
      ),
    );
  }

  /// Runs a sale on [suffix]'s reader and reports what the till concluded.
  Future<PaymentResult> saleOn(
    String suffix, {
    int amount = 500,
    bool manual = false,
    Future<bool> Function()? onSignature,
    List<String>? prompts,
  }) async {
    final reader = await readerFor(suffix);
    final dojo = provider(terminalId: reader.id);
    if (onSignature != null) dojo.onSignatureRequested = onSignature;
    if (prompts != null) {
      dojo.onTerminalUpdate = (s) {
        if (s.lastNotification != null) prompts.add(s.lastNotification!);
      };
    }
    return dojo.take(amount, orderId: 'acc-$suffix', manual: manual);
  }

  // ---- Configuration ------------------------------------------------------

  group('configuration', () {
    test('CFG-03 the till lists the account\'s card machines', () async {
      final terminals = await provider().listTerminals();

      expect(terminals, isNotEmpty);
      expect(terminals.every((t) => t.available), isTrue);
      expect(terminals.every((t) => t.id.startsWith('tm_sandbox_')), isTrue);
      // The operator picks from this list; no TID is compiled in.
      expect(terminals.map((t) => t.tid).where((t) => t.isNotEmpty), isNotEmpty);
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('CFG-02 a wrong API key says so, and does not read as a card fault',
        () async {
      final wrong = DojoProvider(
        apiKey: '${key.substring(0, key.length - 2)}XX',
        softwareHouseId: DojoConfig.defaultSoftwareHouseId,
        resellerId: DojoConfig.defaultResellerId,
      );

      try {
        await wrong.listTerminals();
        fail('a bad key should not list terminals');
      } on DojoException catch (e) {
        expect(e.statusCode, 401);
        // The whole point of the mapping: this must not say "payment failed".
        expect(e.clerkMessage, contains('API key'));
      }
    }, timeout: const Timeout(Duration(seconds: 60)));
  });

  // ---- Sales --------------------------------------------------------------

  group('sales', () {
    test('TS-01 a card sale captures and reports the reader\'s prompts',
        () async {
      final prompts = <String>[];
      final result = await saleOn('SIP0', amount: 560, prompts: prompts);

      expect(result.approved, isTrue, reason: result.message);
      expect(result.reference, startsWith('pi_sandbox_'));
      // These are what the till shows the operator while the customer pays.
      expect(prompts, contains('PresentCard'));
    }, timeout: const Timeout(Duration(seconds: 180)));

    test('PI-07 a manual card is flagged card-holder-not-present', () async {
      // The keyed route. Recorded separately from a dipped card because it
      // carries different interchange and different liability.
      final intent = await provider()
          .createIntent(910, orderId: 'acc-moto', cardHolderNotPresent: true);
      final read = await provider().fetchIntent(intent.id);

      expect(read['cardHolderNotPresent'], isTrue);
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('TS-07 a decline is never reported as money taken', () async {
      final result = await saleOn('DIP0', amount: 730);

      expect(result.approved, isFalse);
      expect(result.reference, startsWith('pi_sandbox_'));
    }, timeout: const Timeout(Duration(seconds: 180)));

    test('TS-07b the same intent is re-used after a decline', () async {
      // The checklist's actual requirement: a retry must not orphan the first
      // intent and charge against a second one.
      final declined = await readerFor('DIP0');
      final good = await readerFor('SIP0');

      final rest = provider();
      final intent = await rest.createIntent(640, orderId: 'acc-retry');

      final first = provider(terminalId: declined.id);
      final firstSession = await first.startTerminalSession(intent.id);
      await first.awaitTerminal(firstSession, intent.id, 640);

      final second = provider(terminalId: good.id);
      final retrySession = await second.startTerminalSession(intent.id);
      final result = await second.awaitTerminal(retrySession, intent.id, 640);

      expect(result.approved, isTrue, reason: result.message);
      expect(result.reference, intent.id, reason: 'must re-use the same intent');
    }, timeout: const Timeout(Duration(seconds: 240)));

    test('TS-11 cancelled at the card machine is not a sale', () async {
      final result = await saleOn('CIP0', amount: 670);

      expect(result.approved, isFalse);
    }, timeout: const Timeout(Duration(seconds: 180)));

    test('TS-14 an expired session is reported as unconfirmed, not as failed',
        () async {
      // The one outcome that must never be guessed at: the money may or may
      // not have moved, so the till has to say so and let the operator check
      // the card machine.
      final result = await saleOn('TIP0', amount: 505);

      expect(result.approved, isFalse);
      expect(
        result.uncertainty,
        isNot(PaymentUncertainty.none),
        reason: 'an expired sale must be flagged uncertain, not declined',
      );
    }, timeout: const Timeout(Duration(seconds: 240)));
  });

  // ---- Signature ----------------------------------------------------------

  group('signature verification', () {
    test('TS-05 accepting the signature completes the sale', () async {
      var asked = false;
      final result = await saleOn(
        'SIS0',
        amount: 640,
        onSignature: () async {
          asked = true;
          return true;
        },
      );

      expect(asked, isTrue, reason: 'the SIS0 reader should ask');
      expect(result.approved, isTrue, reason: result.message);
    }, timeout: const Timeout(Duration(seconds: 240)));

    test('TS-08 rejecting the signature is never reported as money taken',
        () async {
      var asked = false;
      final result = await saleOn(
        'SIS0',
        amount: 655,
        onSignature: () async {
          asked = true;
          return false;
        },
      );

      expect(asked, isTrue);
      expect(result.approved, isFalse);
    }, timeout: const Timeout(Duration(seconds: 240)));
  });

  // ---- Refunds ------------------------------------------------------------

  group('refunds', () {
    test('RF-03 an unlinked refund completes at the reader', () async {
      final reader = await readerFor('SIP0');
      final dojo = provider(terminalId: reader.id);

      final sessionId = await dojo.startRefundSession(amountMinor: 300);
      var session = await dojo.fetchSession(sessionId);
      final deadline = DateTime.now().add(const Duration(seconds: 120));
      while (!session.captured && !session.failed &&
          DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(seconds: 1));
        session = await dojo.fetchSession(sessionId);
      }

      expect(session.captured, isTrue, reason: 'refund status ${session.status}');
    }, timeout: const Timeout(Duration(seconds: 180)));

    test('RF-04 a matched refund references the original sale', () async {
      final reader = await readerFor('SIP0');
      final dojo = provider(terminalId: reader.id);

      // Take a payment first, so there is something to refund.
      final sale = await dojo.take(450, orderId: 'acc-matched');
      expect(sale.approved, isTrue, reason: sale.message);

      final sessionId =
          await dojo.startRefundSession(amountMinor: 450, intentId: sale.reference);
      var session = await dojo.fetchSession(sessionId);
      final deadline = DateTime.now().add(const Duration(seconds: 120));
      while (!session.captured && !session.failed &&
          DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(seconds: 1));
        session = await dojo.fetchSession(sessionId);
      }

      expect(session.captured, isTrue, reason: 'refund status ${session.status}');
    }, timeout: const Timeout(Duration(seconds: 240)));

    test('RF-06a a declined refund is reported as declined', () async {
      final reader = await readerFor('DIP0');
      final dojo = provider(terminalId: reader.id);

      final sessionId = await dojo.startRefundSession(amountMinor: 240);
      var session = await dojo.fetchSession(sessionId);
      final deadline = DateTime.now().add(const Duration(seconds: 120));
      while (!session.captured && !session.failed &&
          DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(seconds: 1));
        session = await dojo.fetchSession(sessionId);
      }

      expect(session.captured, isFalse);
      expect(session.failed, isTrue, reason: 'status ${session.status}');
    }, timeout: const Timeout(Duration(seconds: 180)));
  });

  // ---- Pre-authorisation --------------------------------------------------

  group('pre-authorisation', () {
    test('PA-01/05/06 authorise, increase, then capture', () async {
      final reader = await readerFor('SIP0');
      final dojo = provider(terminalId: reader.id);

      final intent = await dojo.createIntent(1800, orderId: 'acc-preauth',
          preAuth: true);
      final sessionId = await dojo.startTerminalSession(intent.id);
      await dojo.awaitTerminal(sessionId, intent.id, 1800);

      // Increase the authorised amount, then take it.
      await dojo.setAmount(intent.id, 2400);
      await dojo.capture(intent.id, 2400);

      final read = await dojo.fetchIntent(intent.id);
      expect('${read['status']}'.toLowerCase(), 'captured');
    }, timeout: const Timeout(Duration(seconds: 240)));

    test('PA-06b changing the amount after capture is refused, in words',
        () async {
      final reader = await readerFor('SIP0');
      final dojo = provider(terminalId: reader.id);

      final sale = await dojo.take(520, orderId: 'acc-after-capture');
      expect(sale.approved, isTrue, reason: sale.message);

      try {
        await dojo.setAmount(sale.reference!, 900);
        fail('a captured payment should not accept an amount change');
      } on DojoException catch (e) {
        expect(e.statusCode, greaterThanOrEqualTo(400));
        // Dojo explain this one better than we could, so it is passed through.
        expect(e.clerkMessage, isNotEmpty);
      }
    }, timeout: const Timeout(Duration(seconds: 240)));
  });

  // ---- Errors -------------------------------------------------------------

  group('errors the operator has to act on', () {
    test('ERR-404 an unknown card machine is reported as such', () async {
      final dojo = provider(terminalId: 'tm_sandbox_000000000000000000000000');
      final intent = await dojo.createIntent(400, orderId: 'acc-404');

      try {
        await dojo.startTerminalSession(intent.id);
        fail('an unknown terminal should not accept a session');
      } on DojoException catch (e) {
        expect(e.statusCode, greaterThanOrEqualTo(400));
        expect(e.clerkMessage, isNotEmpty);
      }
    }, timeout: const Timeout(Duration(seconds: 60)));

    test('ERR-422 cancelling after payment leaves the sale alone', () async {
      final reader = await readerFor('SIP0');
      final dojo = provider(terminalId: reader.id);

      final intent = await dojo.createIntent(480, orderId: 'acc-422');
      final sessionId = await dojo.startTerminalSession(intent.id);
      final result = await dojo.awaitTerminal(sessionId, intent.id, 480);
      expect(result.approved, isTrue, reason: result.message);

      // Too late to cancel. This returns false rather than throwing, and the
      // captured sale must be untouched.
      final cancelled = await dojo.cancelSession(sessionId);
      expect(cancelled, isFalse);

      final read = await dojo.fetchIntent(intent.id);
      expect('${read['status']}'.toLowerCase(), 'captured');
    }, timeout: const Timeout(Duration(seconds: 240)));
  });
}
