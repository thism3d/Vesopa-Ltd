/// Pontardawe RFC, 2026-11-06: saving a table signs the clerk off, back to the
/// idle screen, and says which table was saved.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/staff_session.dart';
import 'package:vesopa_epos/data/till_settings.dart';
import 'package:vesopa_epos/main.dart';
import 'package:vesopa_epos/ui/idle_screen.dart';

void main() {
  const steffi = StaffData(
    id: 1,
    pluid: 1,
    name: 'Steffi',
    pin: '1234',
    swipeCard: '',
    permissions: '',
    training: false,
  );
  const venue = TillSettings();

  ProviderContainer start({bool canCheckPin = true, bool requirePin = true}) {
    final c = ProviderContainer(
      overrides: [canSignOnProvider.overrideWithValue(canCheckPin)],
    );
    addTearDown(c.dispose);
    c.read(staffSessionProvider.notifier)
      ..configure(signoffSeconds: 0, requirePin: requirePin)
      ..signOn(steffi);
    return c;
  }

  test('saving a table signs off and says which table', () {
    final c = start();
    expect(
      c.read(staffSessionProvider.notifier).signOffAfterTable(venue, 18),
      isTrue,
    );

    final s = c.read(staffSessionProvider);
    expect(s.signedOn, isFalse);
    expect(s.idle, isTrue);
    expect(s.notice, 'Table 18 saved');
  });

  test('the message goes when the next person signs on', () {
    final c = start();
    final staff = c.read(staffSessionProvider.notifier);
    staff.signOffAfterTable(venue, 18);
    staff.signOn(steffi);
    expect(c.read(staffSessionProvider).notice, isNull);
  });

  test('a venue without idle after a sale keeps its clerk on', () {
    final c = start();
    const off = TillSettings(idleAfterSale: false);
    expect(
      c.read(staffSessionProvider.notifier).signOffAfterTable(off, 18),
      isFalse,
    );
    expect(c.read(staffSessionProvider).signedOn, isTrue);
  });

  test('a till that cannot check a PIN keeps its clerk on', () {
    final c = start(canCheckPin: false);
    expect(
      c.read(staffSessionProvider.notifier).signOffAfterTable(venue, 18),
      isFalse,
    );
    expect(c.read(staffSessionProvider).signedOn, isTrue);
  });

  test('a venue with no PIN on the idle screen keeps its clerk on', () {
    final c = start(requirePin: false);
    expect(
      c.read(staffSessionProvider.notifier).signOffAfterTable(venue, 18),
      isFalse,
    );
    expect(c.read(staffSessionProvider).signedOn, isTrue);
  });

  testWidgets('the idle screen says it, then lets it go', (tester) async {
    final c = start();
    addTearDown(() => tester.pumpWidget(const SizedBox()));
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: c,
        child: const MaterialApp(home: IdleScreen(settings: venue)),
      ),
    );
    c.read(staffSessionProvider.notifier).signOffAfterTable(venue, 18);
    await tester.pump();
    expect(find.text('Table 18 saved'), findsOneWidget);
    double opacity() => tester
        .widget<AnimatedOpacity>(find.byType(AnimatedOpacity).last)
        .opacity;
    expect(opacity(), 1);

    await tester.pump(const Duration(seconds: 6));
    expect(opacity(), 0);
  });
}
