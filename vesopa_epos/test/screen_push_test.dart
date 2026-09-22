import 'dart:async';
import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/sync_service.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Does a screen programmed in the back office actually reach the counter?
///
/// It did not, and this is the test that would have said so. Two halves had to
/// both be missing for the failure, and each looked innocent on its own:
///
///   * the server sends `screens` **scoped to the venue**, and deliberately
///     sends nothing office-scoped to a socket that has never said which office
///     it is — the default is silence, because the other default puts one
///     venue's orders on another's screen;
///   * the till never sent that `subscribe` frame.
///
/// So every till in every venue was skipped. A manager laid out a page, the
/// back office confirmed the save, and the counter carried on showing the old
/// one until somebody restarted the app — which reads as "screen programming
/// does not work" rather than as a missing line in a socket handshake.
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
  late AppDatabase db;
  late _FakeChannel channel;

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    channel = _FakeChannel();
  });

  tearDown(() => db.close());

  SyncService service({String office = 'manager@vesopa.co.uk'}) => SyncService(
    db,
    apiBase: 'https://backoffice.example',
    wsUrl: 'wss://backoffice.example/ws',
    office: office,
    connector: (_) => channel,
  );

  test('the terminal says which venue it belongs to as soon as it connects', () async {
    final sync = service();
    await sync.connectForTest();

    expect(channel.sent, isNotEmpty, reason: 'nothing was sent on the socket');
    final frame = jsonDecode(channel.sent.first) as Map<String, dynamic>;
    expect(frame['type'], 'subscribe');
    expect(
      frame['office'],
      'manager@vesopa.co.uk',
      reason: 'the server keys office-scoped pushes on exactly this string',
    );

    sync.dispose();
  });

  // Every reconnection, not just the first: the server holds the subscription
  // per socket, so a dropped connection forgets which venue the till is. A
  // terminal that reconnects overnight would otherwise stop hearing about its
  // own screens until it was restarted, which is the same bug with a longer
  // fuse.
  test('it says so again after the socket has been rebuilt', () async {
    final sync = service();
    await sync.connectForTest();
    expect(channel.sent.length, 1);

    sync.dispose();

    final second = _FakeChannel();
    channel = second;
    final again = SyncService(
      db,
      apiBase: 'https://backoffice.example',
      wsUrl: 'wss://backoffice.example/ws',
      office: 'manager@vesopa.co.uk',
      connector: (_) => second,
    );
    await again.connectForTest();

    expect(second.sent.length, 1, reason: 'the new socket was never subscribed');
    again.dispose();
  });

  // A terminal that has not been commissioned yet has no venue. Sending
  // `subscribe` with an empty office would put it in the same bucket as every
  // other uncommissioned till.
  test('a terminal with no venue subscribes to nothing', () async {
    final sync = service(office: '');
    await sync.connectForTest();

    expect(channel.sent, isEmpty);
    sync.dispose();
  });
}
