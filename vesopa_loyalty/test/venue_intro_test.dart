import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_loyalty/ui/venue_intro.dart';

Widget _app(bool ready) => VenueIntro(
  ready: ready,
  child: const MaterialApp(home: Scaffold(body: Text('the app'))),
);

/// Time passing frame by frame, as it does on a phone.
Future<void> _wait(WidgetTester tester, Duration d) async {
  for (var t = Duration.zero; t < d; t += const Duration(milliseconds: 50)) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  testWidgets('the crest waits for the branding, then lifts away', (tester) async {
    await tester.pumpWidget(_app(false));
    await _wait(tester, const Duration(seconds: 5));
    // Played through, but the app has nothing to show yet: still the crest.
    expect(find.byType(Image), findsOneWidget);

    await tester.pumpWidget(_app(true));
    await _wait(tester, const Duration(seconds: 1));
    expect(find.byType(Image), findsNothing);
    expect(find.text('the app'), findsOneWidget);
  });

  testWidgets('ready from the start: the opening still plays, then goes', (tester) async {
    await tester.pumpWidget(_app(true));
    await _wait(tester, const Duration(milliseconds: 900));
    expect(find.byType(Image), findsOneWidget);
    await _wait(tester, const Duration(seconds: 3));
    expect(find.byType(Image), findsNothing);
    expect(find.text('the app'), findsOneWidget);
  });
}
