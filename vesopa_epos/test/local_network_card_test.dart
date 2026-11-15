import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/lan/lan_link.dart';
import 'package:vesopa_epos/data/lan/lan_service.dart';
import 'package:vesopa_epos/ui/settings_page.dart';

/// The Local network panel (2026-11-15): Master / Slave / Automatic chosen on
/// the till, the devices with their badges, at a phone's width and a till's.
void main() {
  Future<void> fonts() async {
    Future<void> load(String family, String path) async {
      final f = File(path);
      if (!f.existsSync()) return;
      final loader = FontLoader(family)..addFont(Future.value(ByteData.view(f.readAsBytesSync().buffer)));
      await loader.load();
    }

    await load('Roboto', r'C:\Windows\Fonts\segoeui.ttf');
    final flutter = Platform.environment['FLUTTER_ROOT'];
    if (flutter != null) {
      await load('MaterialIcons', '$flutter/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
    }
  }

  for (final (name, size) in [('phone', const Size(400, 900)), ('till', const Size(1100, 900))]) {
    testWidgets('the panel lays out on a $name, and choosing Master is kept', (tester) async {
      await tester.binding.setSurfaceSize(size);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      SharedPreferences.setMockInitialValues({});
      final key = List<int>.generate(32, (i) => 99 - i).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      final posted = <String>[];
      await tester.runAsync(() async {
        await fonts();
        await LanService.instance.configure(
          apiBase: 'http://backoffice.test',
          token: 'tok',
          deviceId: 'till-bar-$name',
          name: 'Bar',
          version: 'test',
          role: 'till',
          client: MockClient((req) async {
            if (req.url.path == '/api/lan/key') return http.Response(jsonEncode({'key': key, 'targets': <String>[]}), 200);
            if (req.url.path == '/api/lan/main-till') posted.add(req.body);
            return http.Response('{}', 200);
          }),
        );
        // Another till and a kitchen screen, as the link would have heard them.
        final node = LanService.instance.node!;
        node.peers['till-lounge'] = LanPeer(
          id: 'till-lounge',
          name: 'Lounge',
          role: 'till',
          address: InternetAddress('192.168.1.190'),
          port: 47821,
          upMs: 5000,
          claimsHub: true,
          preferred: false,
          version: '1.16.53',
          seen: DateTime.now(),
          mode: 'slave',
        );
        node.peers['kitchen-1'] = LanPeer(
          id: 'kitchen-1',
          name: 'Kitchen screen',
          role: 'kitchen',
          address: InternetAddress('192.168.1.60'),
          port: 0,
          upMs: 0,
          claimsHub: false,
          preferred: false,
          version: '1.7.24',
          seen: DateTime.now(),
        );
      });

      await tester.pumpWidget(MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFFA5C715), brightness: Brightness.light),
        home: Scaffold(
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: RepaintBoundary(key: const Key('shot'), child: Card(margin: EdgeInsets.zero, child: localNetworkCardForTest())),
          ),
        ),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.text('Master'), findsOneWidget);
      expect(find.text('Lounge'), findsOneWidget);
      expect(find.text('AUTO'), findsOneWidget);

      await tester.runAsync(() async {
        await LanService.instance.setMode('master');
      });
      await tester.pump();
      expect(LanService.instance.mode, 'master');
      expect(LanService.instance.node!.identity.mode, 'master');
      expect(posted.single, contains('till-bar-$name'), reason: 'a master is pinned in the back office too');
      expect(find.text('MASTER'), findsWidgets);
      expect(tester.takeException(), isNull);

      await tester.runAsync(() async {
        await LanService.instance.setMode('auto');
        await LanService.instance.node?.dispose();
      });
    });
  }
}
