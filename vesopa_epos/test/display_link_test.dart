import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/display_link.dart';

/// The live link on this PC (2026-10-17): a display dials the till's loopback
/// WebSocket from `link.json`, gets the basket the moment it is published, and
/// its status comes back to the till.
void main() {
  test('a display on this PC gets the basket over the link and reports back', () async {
    final folder = await Directory.systemTemp.createTemp('display_link_');
    final hub = DisplayLinkHub.instance;
    await hub.startLocal(folder);

    final note = jsonDecode(await File('${folder.path}/$displayLinkFile').readAsString()) as Map;
    expect(note['port'], isA<int>());

    // A wrong key is turned away.
    await expectLater(
      WebSocket.connect('ws://127.0.0.1:${note['port']}/display?token=nope'),
      throwsA(anything),
    );

    final ws = await WebSocket.connect(
      'ws://127.0.0.1:${note['port']}/display?token=${note['token']}',
    );
    final received = <Map>[];
    final gotBasket = Completer<void>();
    ws.listen((data) {
      final msg = jsonDecode(data as String) as Map;
      received.add(msg);
      if (msg['type'] == 'display.basket' && !gotBasket.isCompleted) gotBasket.complete();
    });
    ws.add(jsonEncode({'type': 'display.hello', 'role': 'display', 'device': 'd1', 'name': 'Bar TV'}));

    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(hub.localConnected, isTrue);

    hub.sendBasket({'format': 1, 'state': 'sale', 'total_minor': 450});
    await gotBasket.future.timeout(const Duration(seconds: 3));
    expect(received.last['data']['total_minor'], 450);

    final status = Completer<void>();
    final sub = hub.changes.listen((_) {
      if (hub.statuses['local'] != null && !status.isCompleted) status.complete();
    });
    ws.add(jsonEncode({
      'type': 'display.status',
      'data': {
        'format': 1,
        'updated_at': DateTime.now().toIso8601String(),
        'width': 1920,
        'height': 1080,
        'screen_size': 'tv55',
        'link': 'local',
        'tiles_supported': ['clock', 'total'],
      },
    }));
    await status.future.timeout(const Duration(seconds: 3));
    final s = hub.statuses['local']!;
    expect(s.runningAt, '1920 x 1080');
    expect(s.screenSize, 'tv55');
    expect(s.tilesSupported, ['clock', 'total']);

    await sub.cancel();
    await ws.close();
    await folder.delete(recursive: true);
  });
}
