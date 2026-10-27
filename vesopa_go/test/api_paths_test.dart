import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vesopa_go/data/api.dart';

/// The addresses the phone calls are the server's own, as the till calls them.
///
/// Tap once asked for /till/screens and /till/modifiers, which the server does
/// not have (it mounts them under /api: vesopa_server/src/server.js,
/// tillScreenRoutes and tillModifierRoutes; vesopa_epos lib/data/screens.dart
/// and modifiers.dart). The 404 was caught and the menu loaded with no choices
/// and no screens, so nothing looked wrong. This pins every path a menu
/// refresh reads.
void main() {
  test('a menu refresh reads the paths the server serves', () async {
    final seen = <String>[];
    final api = TapApi(
      base: 'https://office.test',
      client: MockClient((req) async {
        seen.add('${req.method} ${req.url.path}');
        final body = switch (req.url.path) {
          '/till/staff' => '{"items": []}',
          '/api/till/screens' => '{"screens": []}',
          _ => req.url.path.endsWith('products') || req.url.path.endsWith('floor') ? '[]' : '{}',
        };
        return http.Response(body, 200);
      }),
    )
      ..token = 't'
      ..office = 'venue@example.com';
    await api.staff();
    await api.products();
    await api.modifiers();
    await api.screens();
    await api.floor();
    await api.tapConfig();
    expect(seen, [
      'GET /till/staff',
      'GET /till/products',
      'GET /api/till/modifiers',
      'GET /api/till/screens',
      'GET /till/floor',
      'GET /api/tap/config',
    ]);
  });
}
