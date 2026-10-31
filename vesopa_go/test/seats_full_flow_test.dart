import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/pages/sign_in_flow.dart';

/// The server's real answer when every Go licence is taken (terminal_vesopa.js).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  testWidgets('all licences in use: the list opens, and signing one out signs this device in', (tester) async {
    final calls = <String>[];
    final client = MockClient((req) async {
      calls.add(req.url.path);
      if (req.url.path.endsWith('/commission')) {
        return http.Response(
          jsonEncode({
            'error': 'All 10 Vesopa Go licences are in use: Android (Vesopa Go) E448, ...',
            'licences': 10,
            'kind': 'go',
            'seats': [
              {'id': 's1', 'name': 'Android (Vesopa Go) E448', 'last_seen_at': '2026-10-31T09:00:00Z'},
              {'id': 's2', 'name': 'Android (Vesopa Go) 1395', 'last_seen_at': '2026-10-20T09:00:00Z'},
            ],
            'release_token': 'pass',
          }),
          409,
        );
      }
      if (req.url.path.endsWith('/release-seat')) {
        final b = jsonDecode(req.body) as Map;
        expect(b['seat_id'], 's2');
        expect(b['release_token'], 'pass');
        return http.Response(
          jsonEncode({
            'terminalToken': 't',
            'user': {'officeEmail': 'kitchen@example.com', 'officeName': 'The Vesopa Kitchen'},
          }),
          200,
        );
      }
      return http.Response('{}', 200);
    });

    late WidgetRef captured;
    await tester.pumpWidget(ProviderScope(
      overrides: [apiProvider.overrideWithValue(TapApi(base: 'https://x', client: client))],
      child: MaterialApp(
        home: Consumer(builder: (context, ref, _) {
          captured = ref;
          return Scaffold(
            body: Center(
              child: FilledButton(
                onPressed: () => commissionDevice(context, ref, 'id-token'),
                child: const Text('sign in'),
              ),
            ),
          );
        }),
      ),
    ));
    Future<void> settle() async {
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pumpAndSettle();
      }
    }

    await tester.tap(find.text('sign in'));
    await settle();
    expect(find.text('All 10 Vesopa Go licences are in use'), findsOneWidget);

    // The one unused longest is first: sign it out.
    await tester.tap(find.text('Sign out').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign it out'));
    await settle();
    expect(calls.last, endsWith('/release-seat'));
    expect(captured.read(tapProvider).venue?.name, 'The Vesopa Kitchen');
  });
}
