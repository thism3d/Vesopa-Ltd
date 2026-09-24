/// Laying out a room from the till.
///
/// The editor itself is a screen, and most of what it does is only meaningful
/// with a finger on it. What is worth testing without one is the part that
/// talks to the back office: which request each edit becomes, and — the half
/// that goes wrong silently — what happens when the back office says no.
///
/// A refusal is the interesting case because it has a *reason*: "there is
/// already a table called Window", "that room is not yours". A repository that
/// throws away the reason leaves a screen saying "could not save", which is a
/// screen somebody presses again.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_epos/data/floor_repository.dart';
import 'package:vesopa_epos/ui/floor_editor_page.dart';

/// A cache that remembers what it was given, so a write that wrongly touched
/// it would be visible.
class _Cache implements FloorCache {
  List<FloorRoom> saved = const [];

  @override
  Future<List<FloorRoom>> load() async => saved;

  @override
  Future<void> save(List<FloorRoom> rooms) async => saved = rooms;
}

void main() {
  late List<http.Request> sent;
  late _Cache cache;

  setUp(() {
    sent = [];
    cache = _Cache();
  });

  FloorRepository repoThat(
    Future<http.Response> Function(http.Request) answer, {
    String? token = 'a-terminal-token',
  }) {
    // The repository builds its own client through the http package's top
    // level functions, so the request is captured by swapping that client out
    // for the duration of the test.
    return FloorRepository(
      apiBase: 'https://example.test',
      cache: cache,
      office: 'venue@example.test',
      terminalToken: token,
    );
  }

  group('whether the editor is offered at all', () {
    test('a commissioned till can edit', () {
      expect(repoThat((_) async => http.Response('', 200)).canEdit, isTrue);
    });

    test('a till with no terminal token cannot', () {
      // Offered and then failing is worse than not offered: a manager would
      // rearrange a room and lose the work at the moment they pressed Save.
      expect(repoThat((_) async => http.Response('', 200), token: null).canEdit,
          isFalse);
      expect(repoThat((_) async => http.Response('', 200), token: '').canEdit,
          isFalse);
    });
  });

  group('the furniture', () {
    test('every preset is a shape the server will accept', () {
      // shape is written straight into a column the server narrows to exactly
      // these two, so a third value here would be silently stored as 'rect'.
      for (final p in TablePreset.all) {
        expect(['rect', 'circle'], contains(p.shape), reason: p.label);
      }
    });

    test('every preset has a size the server will not clamp', () {
      // The server clamps width and height to 1..20. A preset outside that
      // would be saved as something other than what was drawn on the button.
      for (final p in TablePreset.all) {
        expect(p.w, inInclusiveRange(1, 20), reason: p.label);
        expect(p.h, inInclusiveRange(1, 20), reason: p.label);
        expect(p.seats, inInclusiveRange(0, 99), reason: p.label);
      }
    });

    test('the round ones are round and the long ones are long', () {
      // The button is a drawing of the table, and the drawing is the label:
      // somebody reaches for the long one without reading the word under it.
      final six = TablePreset.all.firstWhere((p) => p.label == 'Six');
      expect(six.w, greaterThan(six.h), reason: 'a six should read as long');
      final round = TablePreset.all.firstWhere((p) => p.label == 'Round 4');
      expect(round.isCircle, isTrue);
      expect(round.w, round.h, reason: 'a round table should be square in the box');
    });
  });

  group('what an edit sends', () {
    test('a rearrangement is one request, naming each table by id', () async {
      // One request and not one per table: a manager moving a dozen tables
      // would otherwise fire a dozen writes, and half of them landing is a
      // plan that matches neither the screen nor what was there before.
      final client = MockClient((req) async {
        sent.add(req);
        return http.Response(jsonEncode({'ok': true, 'saved': 2}), 200);
      });
      await _withClient(client, () async {
        await repoThat((_) async => http.Response('', 200)).saveTables(const [
          FloorTable(
            id: 11, number: 1, label: null, x: 2, y: 3,
            width: 3, height: 2, shape: 'rect', seats: 4,
          ),
          FloorTable(
            id: 12, number: 2, label: null, x: 8, y: 3,
            width: 2, height: 2, shape: 'circle', seats: 2,
          ),
        ]);
      });

      expect(sent, hasLength(1));
      expect(sent.single.method, 'PUT');
      expect(sent.single.url.path, '/till/floor/tables');
      expect(sent.single.headers['Authorization'], 'Bearer a-terminal-token');

      final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
      final tables = (body['tables'] as List).cast<Map<String, dynamic>>();
      expect(tables.map((t) => t['id']), [11, 12]);
      expect(tables.first['pos_x'], 2);
      expect(tables.first['pos_y'], 3);
      expect(tables.last['shape'], 'circle');
    });

    test('a table from an older cache, with no id, is not sent', () async {
      // It cannot be addressed. Sent with a null id the server would read it
      // as table 0 and update nothing, or worse, something.
      final client = MockClient((req) async {
        sent.add(req);
        return http.Response(jsonEncode({'ok': true}), 200);
      });
      await _withClient(client, () async {
        await repoThat((_) async => http.Response('', 200)).saveTables(const [
          FloorTable(
            id: null, number: 1, label: null, x: 0, y: 0,
            width: 2, height: 2, shape: 'rect', seats: 4,
          ),
          FloorTable(
            id: 9, number: 2, label: null, x: 1, y: 1,
            width: 2, height: 2, shape: 'rect', seats: 4,
          ),
        ]);
      });
      final tables = ((jsonDecode(sent.single.body) as Map)['tables'] as List);
      expect(tables, hasLength(1));
      expect((tables.single as Map)['id'], 9);
    });

    test('nothing to save sends nothing at all', () async {
      final client = MockClient((req) async {
        sent.add(req);
        return http.Response('', 200);
      });
      await _withClient(client, () async {
        await repoThat((_) async => http.Response('', 200))
            .saveTables(const []);
      });
      expect(sent, isEmpty);
    });

    test('a new table is created and its id comes back', () async {
      final client = MockClient((req) async {
        sent.add(req);
        return http.Response(jsonEncode({'id': 77}), 201);
      });
      late int id;
      await _withClient(client, () async {
        id = await repoThat((_) async => http.Response('', 200)).addTable(
          roomId: 2,
          tableNumber: 14,
          x: 4, y: 5, width: 3, height: 2,
          shape: 'rect', seats: 4,
        );
      });
      expect(id, 77);
      expect(sent.single.method, 'POST');
      final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
      expect(body['room_id'], 2);
      expect(body['table_number'], 14);
      // No name was given, so none is sent — rather than an empty string, which
      // the server would have to decide the meaning of.
      expect(body.containsKey('name'), isFalse);
    });

    test('clearing a room shape sends null, not nothing', () async {
      // "No shape of its own" is a real answer — the plain rectangle every room
      // was before any of this existed. Omitting the field would leave the old
      // shape in place, so a manager could never undo a drawing.
      final client = MockClient((req) async {
        sent.add(req);
        return http.Response(jsonEncode({'ok': true}), 200);
      });
      await _withClient(client, () async {
        await repoThat((_) async => http.Response('', 200))
            .saveRoomShape(2, null);
      });
      final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
      expect(body.containsKey('outline'), isTrue);
      expect(body['outline'], isNull);
    });

    test('a drawn shape is sent as its corners', () async {
      final client = MockClient((req) async {
        sent.add(req);
        return http.Response(jsonEncode({'ok': true}), 200);
      });
      await _withClient(client, () async {
        await repoThat((_) async => http.Response('', 200)).saveRoomShape(
          2,
          const [
            [0, 0],
            [16, 0],
            [16, 5],
            [8, 5],
            [8, 10],
            [0, 10],
          ],
        );
      });
      final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
      expect((body['outline'] as List), hasLength(6));
      expect((body['outline'] as List).first, [0, 0]);
    });
  });

  group('when the back office says no', () {
    test('the reason it gave is what reaches the screen', () async {
      final client = MockClient(
        (_) async => http.Response(
          jsonEncode({'error': 'There is already a table called "Window".'}),
          409,
        ),
      );
      await _withClient(client, () async {
        await expectLater(
          repoThat((_) async => http.Response('', 200)).addTable(
            roomId: 2, tableNumber: 1, x: 0, y: 0,
            width: 2, height: 2, shape: 'rect', seats: 4,
            name: 'Window',
          ),
          throwsA(
            isA<FloorSaveFailed>().having(
              (e) => e.message,
              'message',
              contains('already a table called "Window"'),
            ),
          ),
        );
      });
    });

    test('an expired terminal is told to sign in again', () async {
      // 401 here means the terminal token has expired, and "could not save"
      // sends somebody looking for a network fault that is not there.
      final client = MockClient((_) async => http.Response('not json', 401));
      await _withClient(client, () async {
        await expectLater(
          repoThat((_) async => http.Response('', 200))
              .saveRoomShape(2, null),
          throwsA(
            isA<FloorSaveFailed>().having(
              (e) => e.message,
              'message',
              contains('signed in again'),
            ),
          ),
        );
      });
    });

    test('a refusal never writes the plan to the cache', () async {
      // The cache is what the till falls back on when the network drops. A
      // layout that was refused must not become the layout a till shows for
      // the rest of the evening.
      final client = MockClient(
        (_) async => http.Response(jsonEncode({'error': 'no'}), 400),
      );
      await _withClient(client, () async {
        await expectLater(
          repoThat((_) async => http.Response('', 200)).saveTables(const [
            FloorTable(
              id: 1, number: 1, label: null, x: 0, y: 0,
              width: 2, height: 2, shape: 'rect', seats: 4,
            ),
          ]),
          throwsA(isA<FloorSaveFailed>()),
        );
      });
      expect(cache.saved, isEmpty);
    });
  });
}

/// Run [body] with the http package pointed at [client].
///
/// The repository calls the package-level http functions, so this is where the
/// request is intercepted.
Future<void> _withClient(
  http.Client client,
  Future<void> Function() body,
) async {
  await http.runWithClient(body, () => client);
}
