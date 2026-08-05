import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/payments/connect_pac.dart'
    show ConnectReport, ConnectException;
import 'package:vesopa_epos/payments/connect_ws.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// A WebSocketChannel a test drives by hand: it records what the client sends
/// and lets the test push replies back, exercising the JSON-RPC round trip
/// without a real socket.
class _FakeChannel implements WebSocketChannel {
  final _incoming = StreamController<dynamic>.broadcast();
  final sent = <String>[];
  late final _FakeSink _sink = _FakeSink(sent.add);

  @override
  Stream<dynamic> get stream => _incoming.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  Future<void> get ready async {}

  void serverSend(Map<String, dynamic> message) =>
      _incoming.add(jsonEncode(message));

  Future<void> serverClose() => _incoming.close();

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

void main() {
  late _FakeChannel channel;

  ConnectSocket socket() => ConnectSocket(
        baseUrl: 'https://acct.connect.paymentsense.cloud',
        apiKey: 'live-key',
        softwareHouseId: 'vesopa',
        installerId: 'installer',
        connector: (_) => channel,
      );

  setUp(() => channel = _FakeChannel());

  group('handshake', () {
    test('puts credentials in the query string, not headers, and asks for v1',
        () {
      final uri = socket().uri;
      // The trap: the REST interface uses headers and v2. The WebSocket uses
      // query params and v1, and getting it wrong opens a socket that then
      // answers nothing.
      expect(uri.scheme, 'wss');
      expect(uri.host, 'acct.connect.paymentsense.cloud');
      expect(uri.path, '/pac');
      expect(uri.queryParameters['token'], 'live-key');
      expect(uri.queryParameters['api-version'], 'v1');
      expect(uri.queryParameters['software-house-id'], 'vesopa');
      expect(uri.queryParameters['installer-id'], 'installer');
    });
  });

  group('connectedTerminals', () {
    test('sends a JSON-RPC request and reads the result', () async {
      final s = socket();
      final future = s.connectedTerminals();

      await Future<void>.delayed(Duration.zero);
      final req = jsonDecode(channel.sent.single) as Map<String, dynamic>;
      expect(req['jsonrpc'], '2.0');
      expect(req['method'], 'connectedTerminals');

      channel.serverSend({
        'jsonrpc': '2.0',
        'id': req['id'],
        'result': [
          {'tid': '111', 'currency': 'GBP', 'status': 'AVAILABLE'},
        ],
      });

      final terminals = await future;
      expect(terminals.single.tid, '111');
      await s.dispose();
    });

    test('an empty result is an answer, not an error', () async {
      final s = socket();
      final future = s.connectedTerminals();
      await Future<void>.delayed(Duration.zero);
      final id = jsonDecode(channel.sent.single)['id'] as int;
      channel.serverSend({'jsonrpc': '2.0', 'id': id, 'result': []});
      expect(await future, isEmpty);
      await s.dispose();
    });
  });

  group('transactions', () {
    test('sends amount in pence and flags a keyed sale', () async {
      final s = socket();
      final future = s.performTransaction(
        tid: '111',
        amountMinor: 1250,
        method: 'sale',
        cardholderNotPresent: true,
      );
      await Future<void>.delayed(Duration.zero);
      final req = jsonDecode(channel.sent.single) as Map<String, dynamic>;
      expect(req['method'], 'sale');
      expect(req['params']['tid'], '111');
      expect(req['params']['amount'], 1250);
      expect(req['params']['cardholderNotPresent'], isTrue);

      channel.serverSend({
        'jsonrpc': '2.0',
        'id': req['id'],
        'result': {'transactionResult': 'SUCCESSFUL', 'authCode': 'A1'},
      });
      final result = await future;
      expect(result['transactionResult'], 'SUCCESSFUL');
      await s.dispose();
    });

    test('relays terminal notifications as progress', () async {
      final s = socket();
      final prompts = <String>[];
      s.onProgress = (p) => prompts.add(p.prompt);
      await s.connect();

      channel.serverSend({
        'jsonrpc': '2.0',
        'method': 'terminalNotification',
        'params': {'notificationValue': 'PRESENT_CARD', 'tid': '111'},
      });
      await Future<void>.delayed(Duration.zero);
      expect(prompts.single, contains('present their card'));
      await s.dispose();
    });

    test('answers a signature request with the same id', () async {
      final s = socket();
      s.onSignatureRequested = () async => true;
      await s.connect();

      channel.serverSend({
        'jsonrpc': '2.0',
        'id': 42,
        'method': 'signatureVerificationRequest',
        'params': {'tid': '111', 'receiptLines': <String, dynamic>{}},
      });
      await Future<void>.delayed(Duration.zero);

      final reply = jsonDecode(channel.sent.last) as Map<String, dynamic>;
      // The reply must carry the request's id, or Connect cannot match it and
      // the transaction stalls.
      expect(reply['id'], 42);
      expect(reply['result'], {'accepted': true});
      await s.dispose();
    });
  });

  group('resilience', () {
    test('a dropped socket fails the in-flight call rather than hanging',
        () async {
      final s = socket();
      final future = s.connectedTerminals();
      await Future<void>.delayed(Duration.zero);

      // The far end vanishes mid-request. The caller must not wait forever.
      await channel.serverClose();

      await expectLater(future, throwsA(isA<ConnectException>()));
    });

    test('surfaces a JSON-RPC error as a readable message', () async {
      final s = socket();
      final future = s.report(ConnectReport.endOfDay, '111');
      await Future<void>.delayed(Duration.zero);
      final id = jsonDecode(channel.sent.single)['id'] as int;

      channel.serverSend({
        'jsonrpc': '2.0',
        'id': id,
        'error': {'userMessage': 'Terminal is busy'},
      });

      await expectLater(
        future,
        throwsA(predicate((e) => '$e'.contains('Terminal is busy'))),
      );
      await s.dispose();
    });
  });
}
