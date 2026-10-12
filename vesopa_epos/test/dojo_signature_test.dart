import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';

/// Dojo's second UAT round (Alex Radzio, 12 Oct 2026): the signature flow,
/// and expired results on matched and unlinked refunds.
void main() {
  /// A provider whose terminal session reads walk through [sessions], with
  /// the last one repeated.
  DojoProvider dojoWith(
    List<Map<String, dynamic>> sessions, {
    List<http.Request>? sent,
    Map<String, dynamic>? intent,
    int signatureStatus = 200,
  }) {
    var i = 0;
    return DojoProvider(
      apiKey: 'sk_sandbox_x',
      softwareHouseId: 'SL942X04',
      resellerId: 'SL942X04',
      terminalId: 'tm_1',
      pollInterval: Duration.zero,
      client: MockClient((req) async {
        sent?.add(req);
        if (req.url.path == '/payment-intents') {
          return http.Response(jsonEncode({'id': 'pi_1'}), 200);
        }
        if (req.url.path == '/terminal-sessions') {
          return http.Response(jsonEncode({'id': 'ts_1'}), 200);
        }
        if (req.url.path.endsWith('/signature')) {
          return http.Response('{}', signatureStatus);
        }
        if (req.url.path.endsWith('/cancel')) {
          return http.Response('{}', 200);
        }
        if (req.url.path.startsWith('/payment-intents/')) {
          return http.Response(jsonEncode({'id': 'pi_1', ...?intent}), 200);
        }
        final s = sessions[i < sessions.length ? i++ : sessions.length - 1];
        return http.Response(jsonEncode({'id': 'ts_1', ...s}), 200);
      }),
    )..acceptedGrace = Duration.zero;
  }

  const sig = {'status': 'SignatureVerificationRequired'};

  group('sale with a signature', () {
    test('accepted: the answer is sent and the sale is approved', () async {
      final sent = <http.Request>[];
      final dojo = dojoWith([sig, sig, sig, {'status': 'Captured'}], sent: sent);
      dojo.onSignatureRequested = () async => true;
      final r = await dojo.take(500);
      expect(r.kind, CardOutcome.approved);
      final answers = sent.where((r) => r.url.path.endsWith('/signature'));
      expect(answers, hasLength(1));
      expect(jsonDecode(answers.single.body), {'accepted': true});
    });

    test('rejected: declined by Dojo reads as signature rejected', () async {
      final sent = <http.Request>[];
      final dojo = dojoWith([sig, sig, {'status': 'Declined'}], sent: sent);
      dojo.onSignatureRequested = () async => false;
      final r = await dojo.take(500);
      expect(r.kind, CardOutcome.signatureRejected);
      expect(r.approved, isFalse);
      final answers = sent.where((r) => r.url.path.endsWith('/signature'));
      expect(jsonDecode(answers.single.body), {'accepted': false});
    });

    test('SignatureVerificationRejected ends the sale as rejected', () async {
      final dojo = dojoWith([sig, {'status': 'SignatureVerificationRejected'}]);
      dojo.onSignatureRequested = () async => false;
      final r = await dojo.take(500);
      expect(r.kind, CardOutcome.signatureRejected);
    });

    test(
      'no answer for 80 seconds: Dojo accept it, the prompt comes down and '
      'the sale is approved',
      () async {
        final sent = <http.Request>[];
        final dojo = dojoWith(
          [sig, sig, sig, {'status': 'Captured'}],
          sent: sent,
        );
        final never = Completer<bool>();
        String? settled;
        dojo.onSignatureRequested = () => never.future;
        dojo.onSignatureSettled = (note) => settled = note;
        final r = await dojo.take(500);
        expect(r.kind, CardOutcome.approved);
        expect(settled, contains('by itself'));
        expect(sent.where((r) => r.url.path.endsWith('/signature')), isEmpty);
      },
    );

    test(
      'late rejection after 80 seconds still shows the captured sale',
      () async {
        final dojo = dojoWith(
          [sig, {'status': 'SignatureVerificationAccepted'}, {'status': 'Captured'}],
          signatureStatus: 422,
        );
        final late = Completer<bool>();
        dojo.onSignatureRequested = () => late.future;
        dojo.onTerminalUpdate = (s) {
          if (s.signatureAccepted && !late.isCompleted) late.complete(false);
        };
        final r = await dojo.take(500);
        expect(r.kind, CardOutcome.approved);
        expect(r.approved, isTrue);
      },
    );

    test('a reject the machine refuses (already accepted) is still paid', () async {
      final dojo = dojoWith(
        [sig, sig, {'status': 'Captured'}],
        signatureStatus: 422,
      );
      dojo.onSignatureRequested = () async => false;
      final r = await dojo.take(500);
      expect(r.kind, CardOutcome.approved);
      expect(r.message, contains('already accepted'));
    });

    test(
      'signature accepted and stuck there: settled from the intent',
      () async {
        final dojo = dojoWith(
          [sig, {'status': 'SignatureVerificationAccepted'}],
          intent: {'status': 'Captured', 'amount': {'value': 500}},
        );
        dojo.onSignatureRequested = () async => true;
        final r = await dojo.take(500);
        expect(r.kind, CardOutcome.approved);
        expect(r.acquirerStatus, 'Captured');
      },
    );
  });

  group('refunds on the machine', () {
    test('unlinked: signature accepted is a refund', () async {
      final dojo = dojoWith([sig, {'status': 'Captured'}]);
      dojo.onSignatureRequested = () async => true;
      final id = await dojo.startRefundSession(amountMinor: 300);
      final r = await dojo.followSession(
        id,
        amountMinor: 300,
        kind: TerminalSessionKind.unlinkedRefund,
      );
      expect(r.kind, CardOutcome.approved);
      expect(r.message, contains('Refunded'));
    });

    test('matched: signature rejected is declined, nothing went back', () async {
      final dojo = dojoWith([sig, {'status': 'Declined'}]);
      dojo.onSignatureRequested = () async => false;
      final id = await dojo.startRefundSession(amountMinor: 300, intentId: 'pi_1');
      final r = await dojo.followSession(
        id,
        intentId: 'pi_1',
        amountMinor: 300,
        kind: TerminalSessionKind.matchedRefund,
      );
      expect(r.kind, CardOutcome.signatureRejected);
      expect(r.message, contains('Nothing went back'));
    });

    test('expired is not confirmed and says to check the machine', () async {
      for (final kind in [
        TerminalSessionKind.matchedRefund,
        TerminalSessionKind.unlinkedRefund,
      ]) {
        final dojo = dojoWith([{'status': 'Initiated'}, {'status': 'Expired'}]);
        final r = await dojo.followSession(
          'ts_1',
          intentId: kind == TerminalSessionKind.matchedRefund ? 'pi_1' : null,
          amountMinor: 300,
          kind: kind,
        );
        expect(r.kind, CardOutcome.expired, reason: kind.name);
        expect(r.kind.uncertain, isTrue);
        expect(r.message, contains('cannot be confirmed'));
        expect(r.message, contains('card machine screen'));
      }
    });

    test('cancel from the till cancels the refund session', () async {
      final sent = <http.Request>[];
      final dojo = dojoWith(
        [{'status': 'Initiated'}, {'status': 'Initiated'}, {'status': 'Canceled'}],
        sent: sent,
      );
      dojo.requestCancel();
      final r = await dojo.followSession(
        'ts_1',
        amountMinor: 300,
        kind: TerminalSessionKind.unlinkedRefund,
      );
      expect(sent.where((r) => r.url.path.endsWith('/cancel')), hasLength(1));
      expect(r.kind, CardOutcome.cancelled);
      expect(r.message, contains('Nothing went back'));
    });
  });

  test('a connection lost while starting the sale is not confirmed', () async {
    final dojo = DojoProvider(
      apiKey: 'sk_sandbox_x',
      softwareHouseId: 'SL942X04',
      resellerId: 'SL942X04',
      terminalId: 'tm_1',
      pollInterval: Duration.zero,
      client: MockClient((req) async {
        if (req.url.path == '/payment-intents') {
          return http.Response(jsonEncode({'id': 'pi_1'}), 200);
        }
        throw http.ClientException('connection reset');
      }),
    );
    final r = await dojo.take(500);
    expect(r.kind, CardOutcome.unknown);
    expect(r.kind.uncertain, isTrue);
    expect(r.reference, 'pi_1');
  });
}
