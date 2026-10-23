// Activity showed nothing for Pontardawe RFC (owner, 2026-10-23): points are
// DECIMAL on the server since fractional points, MySQL hands them over as
// strings, and every row failed to draw.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_loyalty/data/api.dart';
import 'package:vesopa_loyalty/ui/history_page.dart';

const _slug = 'test-club';

void main() {
  test('points read as numbers whether they come as numbers or strings', () {
    expect(asNumber('120.00000'), 120);
    expect(asNumber(1.5), 1.5);
    expect(asNumber(null), 0);
    expect(pointsText(120.0), '120');
    expect(pointsText(1.5), '1.5');
    expect(pointsText(0.07), '0.07');
  });

  testWidgets('Activity lists rows whose points are DECIMAL strings', (tester) async {
    SharedPreferences.setMockInitialValues({
      'loyalty_venue_slug': _slug,
      'loyalty_token_$_slug': 'a-token',
    });
    final body = jsonEncode({
      'items': [
        {'id': 1, 'kind': 'earn', 'points': '120.00000', 'balance_after': '120.00000', 'spend_minor': 12000, 'value_minor': null, 'note': 'Bar', 'created_at': '2026-10-20T19:00:00Z'},
        {'id': 2, 'kind': 'redeem', 'points': '-1.50000', 'balance_after': '118.50000', 'spend_minor': null, 'value_minor': '10', 'note': null, 'created_at': '2026-10-21T19:00:00Z'},
      ],
      'more': false,
    });
    await http.runWithClient(() async {
      await tester.pumpWidget(ProviderScope(
        retry: (_, _) => null,
        child: const MaterialApp(home: Scaffold(body: HistoryPage())),
      ));
      for (var i = 0; i < 10; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump(const Duration(milliseconds: 50));
      }
    }, () => MockClient((req) async => http.Response(body, 200, headers: {'content-type': 'application/json'})));
    expect(tester.takeException(), isNull);
    expect(find.text('Points earned'), findsOneWidget);
    expect(find.text('+120'), findsOneWidget);
    expect(find.text('-1.5'), findsOneWidget);
  });
}
