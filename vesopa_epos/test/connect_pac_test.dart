import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/connect_pac.dart';
import 'package:vesopa_epos/payments/payment_provider.dart';

/// Every request the provider made, so the headers and payload shape can be
/// asserted — those are what the live host actually rejects on.
final _sent = <http.Request>[];

http.Client _client(Future<http.Response> Function(http.Request) handler) =>
    MockClient((request) async {
      _sent.add(request);
      return handler(request);
    });

ConnectPacProvider _provider(
  http.Client client, {
  String? terminalId = '12345678',
}) =>
    ConnectPacProvider(
      baseUrl: 'https://acct.connect.paymentsense.cloud',
      apiKey: 'test-key',
      terminalId: terminalId,
      softwareHouseId: 'vesopa',
      installerId: 'installer',
      client: client,
      // Keep the tests instant; the real cadence is Connect's 1s guidance.
      pollInterval: Duration.zero,
      pollTimeout: const Duration(seconds: 2),
    );

/// A transaction that answers with the given sequence of poll bodies.
http.Client _sequence(List<Map<String, dynamic>> polls) {
  var index = 0;
  return _client((request) async {
    if (request.method == 'POST') {
      return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
    }
    if (request.method == 'GET') {
      final body = polls[index < polls.length ? index : polls.length - 1];
      index++;
      return http.Response(jsonEncode(body), 200);
    }
    return http.Response('{}', 200);
  });
}

void main() {
  setUp(_sent.clear);

  group('authentication and headers', () {
    test('sends Basic auth with the key as the password, and v2', () async {
      final provider = _provider(
        _client((_) async => http.Response('{"terminals":[]}', 200)),
      );
      await provider.listTerminals();

      final headers = _sent.single.headers;
      // The key is the *password*, with any username — a bearer token is
      // rejected, and so is an unversioned Accept (v0 does not understand the
      // partner headers and answers 415).
      expect(
        headers['authorization'],
        'Basic ${base64Encode(utf8.encode('epos:test-key'))}',
      );
      expect(headers['accept'], 'application/connect.v2+json');
      expect(headers['software-house-id'], 'vesopa');
      expect(headers['installer-id'], 'installer');
    });

    test('omits partner headers entirely when unset', () async {
      final provider = ConnectPacProvider(
        baseUrl: 'https://acct.connect.paymentsense.cloud',
        apiKey: 'k',
        client: _client((_) async => http.Response('{"terminals":[]}', 200)),
      );
      await provider.listTerminals();
      expect(_sent.single.headers.containsKey('software-house-id'), isFalse);
    });
  });

  group('terminals', () {
    test('reads the terminals array', () async {
      final provider = _provider(_client((_) async => http.Response(
            '{"terminals":[{"tid":"111","currency":"GBP","status":"AVAILABLE"},'
            '{"tid":"222","currency":"GBP","status":"BUSY"}]}',
            200,
          )));
      final found = await provider.listTerminals();
      expect(found.map((t) => t.tid), ['111', '222']);
      expect(found.first.available, isTrue);
      expect(found.last.available, isFalse);
    });

    test('an empty list is an answer, not an error', () async {
      final provider = _provider(
        _client((_) async => http.Response('{"terminals":[]}', 200)),
      );
      expect(await provider.listTerminals(), isEmpty);
    });
  });

  group('taking a payment', () {
    test('posts the amount in pence and polls to approval', () async {
      final provider = _provider(_sequence([
        {'notifications': ['PRESENT_CARD']},
        {'notifications': ['PIN_ENTRY']},
        {
          'transactionResult': 'SUCCESSFUL',
          'amountTotal': 1250,
          'authCode': 'AUTH99',
        },
      ]));

      final result = await provider.take(1250, orderId: 'order-1');

      final body = jsonDecode(_sent.first.body) as Map<String, dynamic>;
      expect(body['transactionType'], 'SALE');
      expect(body['amount'], 1250);
      expect(body['currency'], 'GBP');
      // A presented card must NOT be flagged card-not-present, or the reader
      // opens its keypad instead of waiting for the chip.
      expect(body.containsKey('cardholderNotPresent'), isFalse);

      expect(result.approved, isTrue);
      // The auth code is what a chargeback is argued with, so it beats the
      // request id as the reference kept against the sale.
      expect(result.reference, 'AUTH99');
      expect(result.amountMinor, 1250);
    });

    test('a keyed card sets cardholderNotPresent', () async {
      final provider = _provider(_sequence([
        {'transactionResult': 'SUCCESSFUL', 'authCode': 'A1'},
      ]));
      await provider.take(500, manual: true);

      final body = jsonDecode(_sent.first.body) as Map<String, dynamic>;
      expect(body['cardholderNotPresent'], isTrue);
    });

    test('a decline is not a payment', () async {
      final provider = _provider(_sequence([
        {'transactionResult': 'DECLINED', 'userMessage': 'Card declined'},
      ]));
      final result = await provider.take(500);
      expect(result.approved, isFalse);
      expect(result.message, 'Card declined');
    });

    test('VOID and CANCELLED are failures, not approvals', () async {
      for (final outcome in ['VOID', 'CANCELLED', 'UNSUCCESSFUL', 'TIMED_OUT']) {
        final provider = _provider(_sequence([
          {'transactionResult': outcome},
        ]));
        expect((await provider.take(500)).approved, isFalse,
            reason: '$outcome must never book money');
      }
    });

    test('records cashback and gratuity added at the reader', () async {
      final provider = _provider(_sequence([
        {
          'transactionResult': 'SUCCESSFUL',
          'amountBase': 1000,
          'amountCashback': 2000,
          'amountGratuity': 150,
          'amountTotal': 3150,
          'authCode': 'A1',
        },
      ]));
      final result = await provider.take(1000);

      // The sale is what comes off the bill; the rest is money the customer
      // added at the machine and the till must account for separately — the
      // drawer is £20 down and someone is owed a £1.50 tip.
      expect(result.amountMinor, 1000);
      expect(result.cashbackMinor, 2000);
      expect(result.gratuityMinor, 150);
      expect(result.chargedMinor, 3150);
    });

    test('keeps the acquirer\'s own receipt text', () async {
      final provider = _provider(_sequence([
        {
          'transactionResult': 'SUCCESSFUL',
          'receiptLines': {
            'CUSTOMER': [
              {'text': 'VISA DEBIT'},
              'AUTH CODE A1',
            ],
          },
        },
      ]));
      final result = await provider.take(500);
      expect(result.receiptLines, ['VISA DEBIT', 'AUTH CODE A1']);
    });
  });

  group('refunds', () {
    test('runs as a REFUND transaction', () async {
      final provider = _provider(_sequence([
        {'transactionResult': 'SUCCESSFUL', 'amountBase': 750, 'authCode': 'R1'},
      ]));
      final result = await provider.refund(750);

      final body = jsonDecode(_sent.first.body) as Map<String, dynamic>;
      expect(body['transactionType'], 'REFUND');
      expect(body['amount'], 750);
      expect(result.approved, isTrue);
    });

    test('a refused refund gives no money back', () async {
      final provider = _provider(_sequence([
        {'transactionResult': 'DECLINED'},
      ]));
      expect((await provider.refund(750)).approved, isFalse);
    });
  });

  group('a timed-out transaction', () {
    test('is never a decline, and asks about the reader', () async {
      // Never resolves: the card is still on the reader when time runs out.
      var checkedTerminals = false;
      final provider = _provider(_client((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
        }
        if (request.url.path.endsWith('/pac/terminals')) {
          checkedTerminals = true;
          return http.Response('{"terminals":[]}', 200);
        }
        return http.Response(
          jsonEncode({'notifications': ['PLEASE_WAIT']}),
          200,
        );
      }));

      final result = await provider.take(500);
      expect(result.approved, isFalse);
      // The checklist asks the till to work out whether the *device* is the
      // problem before telling the clerk anything.
      expect(checkedTerminals, isTrue);
      expect(result.uncertainty, PaymentUncertainty.terminalUnreachable);
      expect(result.message, contains('Standalone Mode'));
    });

    test('with the reader still available, points at the last transaction',
        () async {
      final provider = _provider(_client((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
        }
        final path = request.url.path;
        if (path.endsWith('/pac/terminals')) {
          return http.Response(
            '{"terminals":[{"tid":"12345678","currency":"GBP",'
            '"status":"AVAILABLE"}]}',
            200,
          );
        }
        if (path.endsWith('/transactions/last')) {
          return http.Response(
            '{"transactionResult":"SUCCESSFUL","amountTotal":500}',
            200,
          );
        }
        return http.Response(
          jsonEncode({'transactionResult': 'TIMED_OUT'}),
          200,
        );
      }));

      final result = await provider.take(500);
      expect(result.approved, isFalse);
      expect(result.uncertainty, PaymentUncertainty.checkTerminal);
      // Saves the clerk walking over to the machine to read it themselves.
      expect(result.message, contains('SUCCESSFUL'));
    });
  });

  group('PDQ reports', () {
    test('starts the report and polls it to REPORT_FINISHED', () async {
      var index = 0;
      final provider = _provider(_client((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'rep-1'}), 202);
        }
        final polls = [
          {'notifications': <String>[]},
          {
            'notifications': ['REPORT_FINISHED'],
            'receiptLines': {
              'MERCHANT': ['END OF DAY', 'TOTAL 123.45'],
            },
          },
        ];
        final body = polls[index < polls.length ? index : polls.length - 1];
        index++;
        return http.Response(jsonEncode(body), 200);
      }));

      final report = await provider.runReport(ConnectReport.endOfDay);

      expect(jsonDecode(_sent.first.body), {'reportType': 'END_OF_DAY'});
      expect(_sent.first.url.path, endsWith('/pac/terminals/12345678/reports'));
      expect(report.finished, isTrue);
      expect(report.lines, ['END OF DAY', 'TOTAL 123.45']);
    });

    test('refuses cleanly with no card machine set', () async {
      final provider = _provider(
        _client((_) async => http.Response('{}', 200)),
        terminalId: null,
      );
      final report = await provider.runReport(ConnectReport.endOfDay);
      expect(report.finished, isFalse);
      expect(_sent, isEmpty);
    });

    test('refuses cleanly when no card machine is set', () async {
      final provider = _provider(
        _client((_) async => http.Response('{}', 200)),
        terminalId: null,
      );
      final result = await provider.take(500);
      expect(result.approved, isFalse);
      expect(result.message, contains('No card machine'));
      expect(_sent, isEmpty);
    });

    test('surfaces the acquirer\'s own wording on a refusal', () async {
      final provider = _provider(_client((_) async => http.Response(
            '{"userMessage":"\'999\' is unavailable. Check the PDQ."}',
            404,
          )));
      final result = await provider.take(500);
      expect(result.approved, isFalse);
      expect(result.message, contains('is unavailable'));
    });
  });

  group('signature verification', () {
    test('answers the reader and completes when accepted', () async {
      var answered = false;
      var index = 0;
      final client = _client((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
        }
        if (request.method == 'PUT') {
          answered = true;
          expect(request.url.path, endsWith('/transactions/req-1/signature'));
          expect(jsonDecode(request.body), {'accepted': true});
          return http.Response('{}', 202);
        }
        final polls = [
          {'notifications': ['SIGNATURE_VERIFICATION']},
          {'transactionResult': 'SUCCESSFUL', 'authCode': 'A1'},
        ];
        final body = polls[index < polls.length ? index : polls.length - 1];
        index++;
        return http.Response(jsonEncode(body), 200);
      });

      final provider = _provider(client)
        ..onSignatureRequested = () async => true;
      final result = await provider.take(500);

      expect(answered, isTrue);
      expect(result.approved, isTrue);
    });

    test('a rejected signature is not a payment', () async {
      final provider = _provider(_client((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
        }
        if (request.method == 'PUT') {
          expect(jsonDecode(request.body), {'accepted': false});
          return http.Response('{}', 202);
        }
        return http.Response(
          jsonEncode({'notifications': ['SIGNATURE_VERIFICATION']}),
          200,
        );
      }))
        ..onSignatureRequested = () async => false;

      final result = await provider.take(500);
      expect(result.approved, isFalse);
      expect(result.message, 'Signature rejected');
    });
  });

  group('progress', () {
    test('relays the reader prompts to the clerk', () async {
      final prompts = <String>[];
      final provider = _provider(_sequence([
        {'notifications': ['PRESENT_CARD']},
        {'notifications': ['PIN_ENTRY']},
        {'notifications': ['REMOVE_CARD']},
        {'transactionResult': 'SUCCESSFUL'},
      ]))
        ..onProgress = (p) => prompts.add(p.prompt);

      await provider.take(500);
      expect(prompts, [
        'Ask the customer to present their card',
        'Customer is entering their PIN',
        'Ask the customer to remove their card',
      ]);
    });

    test('reads a notification object as well as a bare string', () async {
      final prompts = <String>[];
      final provider = _provider(_sequence([
        {
          'notifications': [
            {'notificationValue': 'INSERT_CARD'},
          ],
        },
        {'transactionResult': 'SUCCESSFUL'},
      ]))
        ..onProgress = (p) => prompts.add(p.prompt);

      await provider.take(500);
      expect(prompts.first, 'Ask the customer to insert their card');
    });

    test('abandoning cancels and reports unknown, never declined', () async {
      var cancelled = false;
      final provider = _provider(_client((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
        }
        if (request.method == 'DELETE') {
          cancelled = true;
          return http.Response('{}', 202);
        }
        return http.Response(
          jsonEncode({'notifications': ['PRESENT_CARD']}),
          200,
        );
      }));
      provider.onProgress = (_) => provider.abandon();

      final result = await provider.take(500);
      expect(cancelled, isTrue);
      expect(result.approved, isFalse);
      expect(result.message, contains('abandoned'));
    });
  });
}
