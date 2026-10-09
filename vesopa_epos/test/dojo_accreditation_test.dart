import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/dojo_config.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';
import 'package:vesopa_epos/ui/card_payment_dialog.dart';

/// The fixes from Dojo's accreditation sheet (Alex Radzio, 9 Oct 2026).
void main() {
  group('Identifying Headers', () {
    test('the software house id is locked to SL942X04 on Dojo', () {
      const config = DojoConfig(softwareHouseId: 'softwareHouse1');
      expect(config.effectiveSoftwareHouseId, 'SL942X04');
    });

    test('a blank reseller id is sent as the software house id', () {
      const config = DojoConfig(resellerId: '');
      expect(config.effectiveResellerId, 'SL942X04');
    });

    test('the old reseller1 placeholder reads as blank', () {
      final config = DojoConfig.fromJson({
        'apiKey': 'sk_sandbox_x',
        'platform': 'dojo',
        'softwareHouseId': 'softwareHouse1',
        'resellerId': 'reseller1',
      });
      expect(config.effectiveSoftwareHouseId, 'SL942X04');
      expect(config.effectiveResellerId, 'SL942X04');
    });

    test('a typed reseller id is kept', () {
      const config = DojoConfig(resellerId: 'RES123');
      expect(config.effectiveResellerId, 'RES123');
    });

    test('a fresh till starts on the public sandbox key', () {
      expect(const DojoConfig().apiKey, startsWith('sk_sandbox_'));
      expect(const DojoConfig().configured, isTrue);
    });

    test(
      'payment intent AND terminal session requests carry both ids',
      () async {
        final sent = <http.Request>[];
        final client = MockClient((req) async {
          sent.add(req);
          if (req.url.path == '/payment-intents') {
            return http.Response(jsonEncode({'id': 'pi_1'}), 200);
          }
          if (req.url.path == '/terminal-sessions') {
            return http.Response(jsonEncode({'id': 'ts_1'}), 200);
          }
          return http.Response(
            jsonEncode({'id': 'ts_1', 'status': 'Captured'}),
            200,
          );
        });
        final dojo = DojoProvider(
          apiKey: 'sk_sandbox_x',
          softwareHouseId: 'SL942X04',
          resellerId: 'SL942X04',
          terminalId: 'tm_1',
          pollInterval: Duration.zero,
          client: client,
        );
        final r = await dojo.take(500);
        expect(r.approved, isTrue);
        expect(sent, isNotEmpty);
        for (final req in sent) {
          expect(
            req.headers['software-house-id'],
            'SL942X04',
            reason: req.url.path,
          );
          expect(req.headers['reseller-id'], 'SL942X04', reason: req.url.path);
        }
      },
    );
  });

  group('Incorrect authorization credentials', () {
    test('Save with a wrong key says the API key is incorrect', () async {
      final dojo = DojoProvider(
        apiKey: 'sk_sandbox_wrong',
        softwareHouseId: 'SL942X04',
        resellerId: 'SL942X04',
        client: MockClient((_) async => http.Response('', 401)),
      );
      final check = await dojo.verifySettings();
      expect(check.ok, isFalse);
      expect(check.message, contains('API key is incorrect'));
    });

    test('a machine that is offline cannot be saved', () async {
      final dojo = DojoProvider(
        apiKey: 'sk_sandbox_x',
        softwareHouseId: 'SL942X04',
        resellerId: 'SL942X04',
        terminalId: 'tm_1',
        client: MockClient(
          (_) async => http.Response(
            jsonEncode([
              {
                'id': 'tm_1',
                'properties': {'tid': 'T1'},
                'status': 'Offline',
              },
            ]),
            200,
          ),
        ),
      );
      final check = await dojo.verifySettings();
      expect(check.ok, isFalse);
      expect(check.message, contains('Offline'));
    });

    test('a connected machine can be saved', () async {
      final dojo = DojoProvider(
        apiKey: 'sk_sandbox_x',
        softwareHouseId: 'SL942X04',
        resellerId: 'SL942X04',
        terminalId: 'T1',
        client: MockClient(
          (_) async => http.Response(
            jsonEncode([
              {
                'id': 'tm_1',
                'properties': {'tid': 'T1'},
                'status': 'Available',
              },
            ]),
            200,
          ),
        ),
      );
      final check = await dojo.verifySettings();
      expect(check.ok, isTrue);
      expect(check.terminal?.id, 'tm_1');
    });
  });

  group('terminal session results', () {
    DojoProvider withSessions(
      List<Map<String, dynamic>> sessions, {
      int startStatus = 200,
      List<http.Request>? sent,
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
            return http.Response(
              jsonEncode({'id': 'ts_1', 'detail': 'busy'}),
              startStatus,
            );
          }
          if (req.url.path.endsWith('/cancel')) {
            return http.Response('{}', 200);
          }
          if (req.url.path.startsWith('/payment-intents/')) {
            return http.Response('{}', 200);
          }
          final s = sessions[i < sessions.length ? i++ : sessions.length - 1];
          return http.Response(jsonEncode({'id': 'ts_1', ...s}), 200);
        }),
      );
    }

    test('approved carries the auth code and the card slip', () async {
      final r = await withSessions([
        {
          'status': 'Captured',
          'paymentDetails': {
            'authCode': '441367',
            'card': {'cardNumber': '************3924', 'cardType': 'VISA'},
          },
          'receipt': {
            'lines': [
              {
                'lineType': 'Text',
                'text': {'value': 'APPROVED'},
              },
            ],
          },
        },
      ]).take(1234);
      expect(r.kind, CardOutcome.approved);
      expect(r.authCode, '441367');
      expect(r.cardLast4, '3924');
      expect(r.receiptLines, ['APPROVED']);
      expect(r.sessionId, 'ts_1');
    });

    test('declined is a decline', () async {
      final r = await withSessions([
        {'status': 'Declined'},
      ]).take(100);
      expect(r.kind, CardOutcome.declined);
      expect(r.approved, isFalse);
    });

    test('a busy machine (409) is reported as busy', () async {
      final r = await withSessions(const [], startStatus: 409).take(100);
      expect(r.kind, CardOutcome.busy);
    });

    test('expired is not a decline: the till offers to check it', () async {
      final r = await withSessions([
        {'status': 'Expired'},
      ]).take(100);
      expect(r.kind, CardOutcome.expired);
      expect(r.kind.uncertain, isTrue);
      expect(r.reference, 'pi_1');
    });

    test('cancel from the till sends a cancel and reports cancelled', () async {
      final sent = <http.Request>[];
      final dojo = withSessions([
        {'status': 'Initiated'},
        {'status': 'Initiated'},
        {'status': 'Canceled'},
      ], sent: sent);
      dojo.onTerminalUpdate = (_) => dojo.requestCancel();
      final r = await dojo.take(100);
      expect(sent.where((r) => r.url.path.endsWith('/cancel')), hasLength(1));
      expect(r.kind, CardOutcome.cancelled);
      expect(r.message, contains('from the till'));
    });

    test(
      'a lost connection mid-sale is not confirmed, never declined',
      () async {
        var reads = 0;
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
            if (req.url.path == '/terminal-sessions') {
              return http.Response(jsonEncode({'id': 'ts_1'}), 200);
            }
            reads++;
            if (reads == 1) {
              return http.Response(
                jsonEncode({'id': 'ts_1', 'status': 'Initiated'}),
                200,
              );
            }
            throw http.ClientException('offline');
          }),
        );
        dojo.onTerminalUpdate = (_) {};
        // Stop as soon as the reads start failing, rather than sit out the
        // 45-second silence in a test.
        Future<void>.delayed(const Duration(milliseconds: 50), dojo.abandon);
        final r = await dojo.take(100);
        expect(r.approved, isFalse);
        expect(r.kind.uncertain, isTrue);
      },
    );
  });

  group('steps never go backwards', () {
    test('present card cannot return after processing', () {
      expect(
        forwardStep(CardStep.processing, CardStep.present),
        CardStep.processing,
      );
    });
    test('signature always shows', () {
      expect(
        forwardStep(CardStep.processing, CardStep.signature),
        CardStep.signature,
      );
    });
    test('after the signature only processing or done', () {
      expect(
        forwardStep(CardStep.signature, CardStep.present),
        CardStep.processing,
      );
      expect(forwardStep(CardStep.signature, CardStep.done), CardStep.done);
    });
    test('notifications are ordered by time, not list position', () {
      final s = DojoSession.fromJson({
        'id': 'ts',
        'status': 'Initiated',
        'notificationEvents': [
          {
            'createdAt': '2026-10-09T18:49:18.97Z',
            'notificationType': 'PleaseWait',
          },
          {
            'createdAt': '2026-10-09T18:49:14.841Z',
            'notificationType': 'PresentCard',
          },
        ],
      });
      expect(s.lastNotification, 'PleaseWait');
    });
  });

  test('payment status reads amounts and refunds', () {
    final st = DojoPaymentStatus.fromJson({
      'id': 'pi_1',
      'status': 'Captured',
      'totalAmount': {'value': 1234, 'currencyCode': 'GBP'},
      'refundedAmount': 234,
      'paymentDetails': {
        'authCode': 'A1',
        'card': {'cardNumber': '************3924', 'cardType': 'VISA'},
      },
    });
    expect(st.paid, isTrue);
    expect(st.refundableMinor, 1000);
    expect(st.summary, contains('VISA ••3924'));
  });
}
