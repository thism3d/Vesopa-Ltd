// Vesopa AI on Go, against answers the real server gave for the in-memory
// test venue (test/fixtures/vesopa_ai.json, from vesopa_server's
// test/lib/ai_fake_venue.js). Phone and tablet, Day and Night: every tab
// draws, nothing overflows, a question gets its answer with the period, the
// site and the records behind it.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:vesopa_go/advisor/advisor_api.dart';
import 'package:vesopa_go/advisor/advisor_page.dart';
import 'package:vesopa_go/data/api.dart';
import 'package:vesopa_go/ui/theme.dart';

void main() {
  final fx = jsonDecode(File('test/fixtures/vesopa_ai.json').readAsStringSync()) as Map<String, dynamic>;
  final answers = (fx['answers'] as Map).cast<String, dynamic>();
  final asked = <String>[];

  http.Client client() => MockClient((req) async {
        final path = req.url.path;
        Object body;
        if (path == '/api/ai/me') {
          body = fx['me'];
        } else if (path == '/api/ai/briefing') {
          body = fx['briefing'];
        } else if (path == '/api/ai/ask') {
          final q = (jsonDecode(req.body) as Map)['question'] as String;
          asked.add(q);
          body = {...(answers[q] ?? answers['Why did sales drop today?']) as Map, 'question': q, 'conversation_id': 1};
        } else if (path == '/api/ai/conversations') {
          body = [];
        } else if (path == '/api/ai/records') {
          body = fx['records'];
        } else {
          return http.Response('{"error":"no"}', 404);
        }
        return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
      });

  Future<void> pump(WidgetTester tester, Size size, Brightness b) async {
    tester.view.physicalSize = size * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(ProviderScope(
      overrides: [advisorApiProvider.overrideWithValue(AdvisorApi(TapApi(base: 'https://test.invalid'), client: client()))],
      child: MaterialApp(theme: Tp.theme(b), home: const AdvisorPage()),
    ));
    await tester.pumpAndSettle();
  }

  for (final (name, size) in [('phone', const Size(390, 844)), ('tablet', const Size(1180, 820))]) {
    for (final b in Brightness.values) {
      testWidgets('Vesopa AI: $name, ${b.name}', (tester) async {
        await pump(tester, size, b);
        // Briefing: the server's own headline, tiles and alerts.
        expect(find.text('${fx['briefing']['headline']}'), findsOneWidget);
        await tester.scrollUntilVisible(find.text('Needs your attention'), 300, scrollable: find.byType(Scrollable).at(1));
        expect(find.text('Needs your attention'), findsOneWidget);
        expect(find.textContaining('out of stock'), findsWidgets);

        // Ask: a question, and its answer with period, site and records.
        await tester.tap(find.text('Ask').first);
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField).last, 'Why did sales drop today?');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();
        expect(asked.last, 'Why did sales drop today?');
        expect(find.text('${answers['Why did sales drop today?']['headline']}'), findsOneWidget);
        expect(find.textContaining('Today (Mon 16 Nov'), findsWidgets);
        await tester.ensureVisible(find.text('How this was worked out').last);
        await tester.pumpAndSettle();
        await tester.tap(find.text('How this was worked out').last);
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.textContaining('See the records').last);
        await tester.pumpAndSettle();
        await tester.tap(find.textContaining('See the records').last);
        await tester.pumpAndSettle();
        expect(find.textContaining('straight from your sales'), findsOneWidget);
        await tester.tapAt(const Offset(10, 10));
        await tester.pumpAndSettle();

        // The intelligence tabs.
        for (final tab in ['Sales', 'Stock', 'Profit', 'Team']) {
          await tester.tap(find.text(tab).first);
          await tester.pumpAndSettle();
          expect(find.byType(Card), findsWidgets, reason: tab);
        }
        expect(find.textContaining('Suggested reorders'), findsNothing); // Team tab now showing
      });
    }
  }
}
