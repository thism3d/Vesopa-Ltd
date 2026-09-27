// A screen change scheduled in the back office (2026-09-27) reaches the till.
//
// The server applies a due change and sends 'screens' to the venue, exactly as
// a Save in the screen editor does. The till must fetch its screens again on
// that message -- and it is the only thing that makes a scheduled change show
// up on a till that is already running.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/data/sync_service.dart';
import 'package:vesopa_epos/main.dart';

void main() {
  test('a scheduled change going live reloads the till’s screens', () async {
    SharedPreferences.setMockInitialValues({});
    var name = 'Drinks';
    var fetches = 0;
    final client = MockClient((req) async {
      fetches++;
      expect(req.url.path, '/api/till/screens');
      return http.Response(
        jsonEncode({
          'screens': [
            {'id': 1, 'name': name, 'surface': 'sale', 'rows': 4, 'cols': 5, 'sortOrder': 0, 'buttons': []},
          ],
        }),
        200,
      );
    });
    final events = StreamController<SyncEvent>();
    final container = ProviderContainer(overrides: [
      officeProvider.overrideWithValue('venue@example.com'),
      screensRepositoryProvider.overrideWithValue(ScreensRepository(apiBase: 'http://bo.test', client: client)),
      syncEventsProvider.overrideWith((ref) => events.stream),
    ]);
    addTearDown(container.dispose);
    addTearDown(events.close);

    container.listen(screensProvider, (_, _) {});
    final first = await container.read(screensProvider.future);
    expect(first.screens.single.name, 'Drinks');

    // The server applies the change at six and tells the venue's tills.
    name = 'Autumn Drinks';
    events.add(const SyncEvent('screens', 1));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final second = await container.read(screensProvider.future);
    expect(second.screens.single.name, 'Autumn Drinks');
    expect(fetches, 2);

    // Something unrelated does not refetch.
    events.add(const SyncEvent('staff.updated', 2));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await container.read(screensProvider.future);
    expect(fetches, 2);
  });
}
