import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/payments/connect_pac.dart';
import 'package:vesopa_epos/payments/connect_ws.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Cancel from the till on a Connect card machine (Pontardawe RFC,
/// 2026-10-13): "Cancel card payment from the till doesn't work". A sale over
/// the socket never looked at the till's Cancel, so neither the till nor the
/// machine stopped.

class _FakeChannel implements WebSocketChannel {
  final _incoming = StreamController<dynamic>.broadcast();
  final sent = <Map<String, dynamic>>[];
  late final _FakeSink _sink = _FakeSink((s) {
    final m = jsonDecode(s) as Map<String, dynamic>;
    sent.add(m);
    onSent?.call(m);
  });
  void Function(Map<String, dynamic>)? onSent;

  @override
  Stream<dynamic> get stream => _incoming.stream;
  @override
  WebSocketSink get sink => _sink;
  @override
  Future<void> get ready async {}

  void reply(Map<String, dynamic> m) => _incoming.add(jsonEncode(m));

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this._onData);
  final void Function(String) _onData;
  @override
  void add(dynamic data) => _onData(data as String);
  @override
  Future<void> close([int? closeCode, String? closeReason]) async {}
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

ConnectPacProvider _rest(Future<http.Response> Function(http.Request) handler) =>
    ConnectPacProvider(
      baseUrl: 'https://acct.connect.paymentsense.cloud',
      apiKey: 'test-key',
      terminalId: '12345678',
      client: MockClient(handler),
      pollInterval: Duration.zero,
      pollTimeout: const Duration(seconds: 2),
      cancelGrace: const Duration(milliseconds: 300),
    );

void main() {
  group('over REST', () {
    test('the machine cancels: reported as cancelled from the till', () async {
      var deleted = false;
      final provider = _rest((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
        }
        if (request.method == 'DELETE') {
          deleted = true;
          return http.Response('{}', 202);
        }
        return http.Response(
          jsonEncode(deleted
              ? {'transactionResult': 'CANCELLED'}
              : {'notifications': ['PRESENT_CARD']}),
          200,
        );
      });
      final notes = <String>[];
      provider.onProgress = (_) => provider.abandon();
      provider.onCancelAnswered = (_, m) => notes.add(m);

      final result = await provider.take(500);
      expect(deleted, isTrue);
      expect(result.approved, isFalse);
      expect(result.message, contains('Cancelled from the till'));
      expect(notes.single, contains('Cancelling'));
    });

    test('a card already in when Cancel was pressed still records as paid',
        () async {
      var deleted = false;
      final provider = _rest((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
        }
        if (request.method == 'DELETE') {
          deleted = true;
          return http.Response('{}', 202);
        }
        return http.Response(
          jsonEncode(deleted
              ? {'transactionResult': 'SUCCESSFUL', 'amountBase': 500, 'authCode': 'A1'}
              : {'notifications': ['PIN_ENTRY']}),
          200,
        );
      });
      provider.onProgress = (_) => provider.abandon();

      final result = await provider.take(500);
      expect(result.approved, isTrue);
      expect(result.reference, 'A1');
    });

    test('no verdict after the cancel: check the machine, never declined',
        () async {
      final provider = _rest((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode({'requestId': 'req-1'}), 202);
        }
        if (request.method == 'DELETE') return http.Response('{}', 202);
        return http.Response(jsonEncode({'notifications': ['PRESENT_CARD']}), 200);
      });
      provider.onProgress = (_) => provider.abandon();

      final result = await provider.take(500);
      expect(result.approved, isFalse);
      expect(result.kind.uncertain, isTrue);
    });
  });

  group('over the socket', () {
    late _FakeChannel channel;
    late ConnectPacProvider provider;

    setUp(() {
      channel = _FakeChannel();
      provider = ConnectPacProvider(
        baseUrl: 'https://acct.connect.paymentsense.cloud',
        apiKey: 'test-key',
        terminalId: '12345678',
        client: MockClient((_) async => http.Response('', 500)),
      )..socket = ConnectSocket(
          baseUrl: 'https://acct.connect.paymentsense.cloud',
          apiKey: 'test-key',
          connector: (_) => channel,
        );
    });

    test('Cancel sends cancelTransaction and the sale ends cancelled', () async {
      int? saleId;
      channel.onSent = (m) {
        if (m['method'] == 'sale') {
          saleId = m['id'] as int;
          // The machine shows "present card"; the clerk presses Cancel.
          scheduleMicrotask(provider.abandon);
        }
        if (m['method'] == 'cancelTransaction') {
          expect(m['params'], {'tid': '12345678'});
          scheduleMicrotask(() {
            channel.reply({'jsonrpc': '2.0', 'id': m['id'], 'result': {}});
            channel.reply({
              'jsonrpc': '2.0',
              'id': saleId,
              'result': {'transactionResult': 'CANCELLED'},
            });
          });
        }
      };
      final notes = <String>[];
      provider.onCancelAnswered = (_, m) => notes.add(m);

      final result = await provider.take(500);
      expect(channel.sent.map((m) => m['method']), contains('cancelTransaction'));
      expect(result.approved, isFalse);
      expect(result.kind.uncertain, isFalse);
      expect(result.message, contains('Cancelled from the till'));
      expect(notes.single, contains('Cancelling'));
    });

    test('Stop waiting ends a sale the machine never answers', () async {
      channel.onSent = (m) {
        if (m['method'] == 'sale') scheduleMicrotask(provider.abandon);
        if (m['method'] == 'cancelTransaction') {
          scheduleMicrotask(() {
            channel.reply({'jsonrpc': '2.0', 'id': m['id'], 'result': {}});
            provider.stopWaiting();
          });
        }
      };

      final result = await provider.take(500);
      expect(result.approved, isFalse);
      expect(result.kind.uncertain, isTrue);
    });
  });
}
