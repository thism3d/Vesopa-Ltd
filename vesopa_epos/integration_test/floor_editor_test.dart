// The floor editor, driven on a real machine against the real back office.
//
// WHY THIS IS AN INTEGRATION TEST AND NOT A WIDGET TEST
//
// flutter_test runs a widget test inside a fake-async zone with dart:io stubbed
// to answer 400 without opening a socket. That is right for a unit test, and it
// makes it impossible to prove the one thing that has actually gone wrong on
// this feature twice: whether the screen, the repository and the server agree.
//
// Both previous bugs were of exactly that kind. The till was taught to draw
// walls the server had never been asked to send — every unit test passed. The
// lasso computed corners from a box it had not scrolled — every unit test
// passed. Neither could have been caught without running the real thing.
//
// So this runs the real widgets on a real Windows machine, taps them, and then
// asks the live server what it stored.
//
//     flutter test integration_test/floor_editor_test.dart -d windows \
//       --dart-define=VESOPA_EMAIL=… --dart-define=VESOPA_PASSWORD=…
//
// It works only on a room it creates and deletes again, in a tearDown that runs
// even when an expectation fails partway through, so a venue's real plan is
// never touched.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:vesopa_epos/data/floor_repository.dart';
import 'package:vesopa_epos/main.dart';
import 'package:vesopa_epos/ui/floor_editor_page.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  const base = 'https://backoffice.vesopaepos.com';
  const email = String.fromEnvironment('VESOPA_EMAIL');
  const password = String.fromEnvironment('VESOPA_PASSWORD');

  final net = http.Client();
  late String terminalToken;
  late String sessionToken;
  int? roomId;

  Map<String, String> manager() => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $sessionToken',
      };

  setUpAll(() async {
    if (email.isEmpty || password.isEmpty) {
      fail(
        'This test signs in for real. Supply an account:\n'
        '  flutter test integration_test/floor_editor_test.dart -d windows '
        '--dart-define=VESOPA_EMAIL=… --dart-define=VESOPA_PASSWORD=…',
      );
    }

    // Commissioned the way the app commissions rather than with a token made by
    // hand: if the commissioning flow is broken, this fails, which is right.
    final res = await net.post(
      Uri.parse('$base/api/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'email': email,
        'password': password,
        'terminal': true,
      }),
    );
    expect(res.statusCode, 200, reason: 'could not sign in: ${res.body}');
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    terminalToken = body['terminalToken'] as String;
    sessionToken = body['token'] as String;
  });

  setUp(() async {
    final res = await net.post(
      Uri.parse('$base/api/floor/rooms'),
      headers: manager(),
      body: jsonEncode({'name': 'Editor live test', 'cols': 20, 'rows': 14}),
    );
    expect(res.statusCode, anyOf(200, 201), reason: res.body);
    roomId = (jsonDecode(res.body) as Map<String, dynamic>)['id'] as int;
  });

  tearDown(() async {
    // Runs even when an expectation above failed. A scratch room left behind is
    // a room a real venue then sees on its tills.
    if (roomId == null) return;
    await net.delete(
      Uri.parse('$base/api/floor/rooms/$roomId'),
      headers: manager(),
    );
    roomId = null;
  });

  /// The room as the server currently has it — read through the same endpoint
  /// a till reads, so this proves the round trip and not just the write.
  Future<Map<String, dynamic>?> fromServer() async {
    final res = await net.get(
      Uri.parse('$base/till/floor?office=${Uri.encodeComponent(email)}'),
    );
    for (final r in (jsonDecode(res.body) as List).cast<Map<String, dynamic>>()) {
      if (r['id'] == roomId) return r;
    }
    return null;
  }

  FloorRepository repo() => FloorRepository(
        apiBase: base,
        cache: _NoCache(),
        office: email,
        terminalToken: terminalToken,
        client: net,
      );

  /// The editor, on the scratch room only, so a tap cannot land on a real one.
  Widget editor(FloorRepository r) => ProviderScope(
        overrides: [
          floorRepositoryProvider.overrideWith((ref) async => r),
          floorPlanProvider.overrideWith((ref) async {
            final rooms = await r.load();
            return [for (final room in rooms) if (room.id == roomId) room];
          }),
        ],
        child: const MaterialApp(home: FloorEditorPage()),
      );

  /// Pump until the editor has finished loading its plan.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(milliseconds: 200));
      if (find.text('Draw the room').evaluate().isNotEmpty) return;
    }
    fail('the editor never finished loading');
  }

  testWidgets('the furniture strip puts a real table on the floor',
      (tester) async {
    await tester.pumpWidget(editor(repo()));
    await settle(tester);

    // It reads as furniture rather than as "add table", which is the whole
    // point of the strip.
    expect(find.text('Four'), findsOneWidget);
    expect(find.text('Round 6'), findsOneWidget);
    expect(find.text('Booth'), findsOneWidget);

    await tester.tap(find.text('Four'));
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    final room = await fromServer();
    final tables = (room!['tables'] as List).cast<Map<String, dynamic>>();
    expect(tables, hasLength(1), reason: 'the tap never reached the server');
    // The preset's own proportions, not a default square.
    expect(tables.single['seats'], 4);
    expect(tables.single['width'], 3);
    expect(tables.single['height'], 2);
    expect(tables.single['shape'], 'rect');
    // And a code, or the card that sits on it could never be scanned.
    expect(tables.single['id'], isNotNull);
  });

  testWidgets('a table dragged across the plan is saved where it was put',
      (tester) async {
    // Put one down first, through the same path a person would.
    await tester.pumpWidget(editor(repo()));
    await settle(tester);
    await tester.tap(find.text('Two'));
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    final before = (await fromServer())!['tables'] as List;
    final was = before.single as Map<String, dynamic>;

    // Rebuilt, so the editor is holding the table the server now knows about.
    await tester.pumpWidget(editor(repo()));
    await settle(tester);

    // By key, not by "the last Material in the tree" — the scaffold, the app
    // bar and every chip are Materials too.
    final table = find.byKey(ValueKey('floor-table-${was['id']}'));
    expect(table, findsOneWidget, reason: 'the table is not on the plan');
    await tester.drag(table, const Offset(150, 100));
    await tester.pump(const Duration(milliseconds: 300));

    // Save appears only once something has moved, which is itself the proof
    // that the drag was noticed.
    expect(find.text('Save layout'), findsOneWidget,
        reason: 'the drag did not mark the layout as changed');
    await tester.tap(find.text('Save layout'));
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    final now = ((await fromServer())!['tables'] as List).single
        as Map<String, dynamic>;
    expect(
      now['pos_x'] != was['pos_x'] || now['pos_y'] != was['pos_y'],
      isTrue,
      reason: 'the table came back where it started: $was -> $now',
    );
  });

  testWidgets('a room drawn corner by corner is stored as those corners',
      (tester) async {
    await tester.pumpWidget(editor(repo()));
    await settle(tester);

    await tester.tap(find.text('Draw the room'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('Tap the first corner'), findsOneWidget);

    // Taps land on the plan itself, which is what a finger does — not on a
    // handle and not through the model.
    final plan = find.byType(GestureDetector).last;
    final box = tester.getRect(plan);
    Future<void> tapAt(double dx, double dy) async {
      await tester.tapAt(Offset(box.left + dx, box.top + dy));
      await tester.pump(const Duration(milliseconds: 250));
    }

    await tapAt(40, 40);
    await tapAt(360, 40);
    await tapAt(360, 240);
    await tapAt(40, 240);
    expect(find.textContaining('4 corners'), findsOneWidget,
        reason: 'the corner taps did not land where they were aimed');

    // Back on the first corner closes the room and saves it.
    await tapAt(40, 40);
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    final room = await fromServer();
    expect(room!['outline'], isNotNull,
        reason: 'closing the shape did not save it');
    final outline = jsonDecode(room['outline'] as String) as List;
    expect(outline, hasLength(4));
    expect(outline.first, isNot(outline.last),
        reason: 'the shape closed onto itself twice');
  });

  testWidgets('Done with nothing drawn clears the shape', (tester) async {
    // The only way back from a room somebody drew wrongly, so "no shape" has to
    // be a real answer rather than a missing one.
    await net.put(
      Uri.parse('$base/till/floor/rooms/$roomId'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $terminalToken',
      },
      body: jsonEncode({
        'outline': [
          [0, 0],
          [8, 0],
          [8, 8],
        ],
      }),
    );
    expect((await fromServer())!['outline'], isNotNull);

    await tester.pumpWidget(editor(repo()));
    await settle(tester);
    await tester.tap(find.text('Draw the room'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Cancel'));
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.text('Draw the room'));
    await tester.pump(const Duration(milliseconds: 300));
    // Undo every corner it opened with, then Done.
    for (var i = 0; i < 4; i++) {
      final undo = find.text('Undo corner');
      if (undo.evaluate().isEmpty) break;
      await tester.tap(undo);
      await tester.pump(const Duration(milliseconds: 200));
    }
    await tester.tap(find.text('Done'));
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }

    expect((await fromServer())!['outline'], isNull,
        reason: 'the shape could not be cleared');
  });
}

/// A cache that keeps nothing.
///
/// The editor must not leave a test layout in the real till's offline store —
/// that store is what a till falls back on when the network drops, and a room
/// that no longer exists would sit in it until the next successful fetch.
class _NoCache implements FloorCache {
  @override
  Future<List<FloorRoom>> load() async => const [];

  @override
  Future<void> save(List<FloorRoom> rooms) async {}
}
