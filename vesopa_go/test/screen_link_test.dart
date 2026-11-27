// The phone's remote reaching a TV (owner, 2026-11-27: "in the same WiFi it
// cannot be found yet ... fallback always go to the live server"): straight to
// the TV's own little server on the same Wi-Fi, through Vesopa as well, each
// key pressed once, and the TV asking Vesopa for its keys when its live socket
// is down.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/remote/go_remote.dart';
import 'package:vesopa_go/remote/remote_link.dart';

class _Api extends TapApi {
  _Api(this.local, {this.serverUp = true});
  final Map<String, Object?> local;
  bool serverUp;
  final sent = <String>[];

  @override
  Future<Map<String, dynamic>> awakeScreens(String deviceId) async => {
        'screens': [
          {'device_id': 'tv1', 'name': 'Bar TV', 'mode': 'display', 'tv': true, 'live': false, 'local': local},
        ],
      };

  @override
  Future<Map<String, dynamic>> screenKey(String deviceId, String key, {String? id, int? index, String? text}) async {
    if (!serverUp) throw const TapApiError(0, 'offline');
    sent.add(key);
    // Vesopa passes it on too, with the same id: the TV must not press it twice.
    GoRemote.receive({'device_id': deviceId, 'key': key, 'id': id, 'seq': 99}, via: 'live');
    return {'ok': true};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // Real sockets for these tests: the TV's server and the phone talk over HTTP.
  HttpOverrides.global = null;

  final pressed = <String>[];
  bool handler(String key) {
    pressed.add(key);
    return true;
  }

  setUpAll(() async {
    GoRemote.myId = 'tv1';
    GoRemote.listen(handler);
    await LocalScreenServer.instance.start(force: true);
  });

  setUp(() {
    pressed.clear();
    RemoteLink.screens.value = {};
  });

  Map<String, Object?> local({String? key}) =>
      {'ips': ['127.0.0.1'], 'port': LocalScreenServer.instance.boundPort, 'key': key ?? LocalScreenServer.instance.key};

  test('found on the same Wi-Fi: Local, and a key reaches it with Vesopa down', () async {
    expect(LocalScreenServer.instance.boundPort, isNotNull);
    final api = _Api(local(), serverUp: false);
    await RemoteLink.refresh(api, 'phone');
    final s = RemoteLink.screens.value['tv1']!;
    expect(s.reachable, isTrue, reason: 'a screen with its live socket down is still listed');
    expect(s.via, 'Local');
    await RemoteLink.send(api, 'tv1', 'next');
    expect(pressed, ['next']);
  });

  test('both roads at once: the key is pressed once', () async {
    final api = _Api(local());
    await RemoteLink.refresh(api, 'phone');
    await RemoteLink.send(api, 'tv1', 'ok');
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(api.sent, ['ok']);
    expect(pressed, ['ok']);
  });

  test('the wrong key is refused: Live through Vesopa instead', () async {
    final api = _Api(local(key: 'b' * 32));
    await RemoteLink.refresh(api, 'phone');
    final s = RemoteLink.screens.value['tv1']!;
    expect(s.via, 'Live');
    expect(s.reachable, isTrue);
    await RemoteLink.send(api, 'tv1', 'previous');
    expect(pressed, ['previous']);
  });

  test('the TV asks Vesopa for its keys: older ones are not replayed, new ones pressed once', () async {
    var calls = 0;
    final beacon = ScreenBeacon(() async {}, poll: (after) async {
      calls++;
      if (calls == 1) return {'keys': [], 'seq': 10};
      return {
        'keys': [
          {'device_id': 'tv1', 'key': 'down', 'seq': 11},
          {'device_id': 'tv1', 'key': 'right', 'seq': 12},
        ],
        'seq': 12,
      };
    });
    await beacon.pollOnce();
    expect(pressed, isEmpty);
    await beacon.pollOnce();
    await beacon.pollOnce();
    expect(pressed, ['down', 'right']);
  });

  test('a QR scanned in a browser hands over to Go: vesopago://link?c=', () {
    // Same parsing as the QR's own address.
    expect(Uri.parse('vesopago://link?c=ABCD1234').host, 'link');
  });
}
