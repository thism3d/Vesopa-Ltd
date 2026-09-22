import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/main.dart';
import 'package:vesopa_epos/ui/sign_on_pad.dart';
import 'package:vesopa_epos/ui/theme.dart';

/// "Sign on button needs to just pop up with a pin pad, no names, just quick
/// for the next member of staff to use the till as soon as possible."
///
/// So the two things worth guarding are that **no staff name is on screen** —
/// the list is the whole thing that made the key slow — and that a mistyped
/// PIN does not throw the clerk out of the dialog.
void main() {
  late AppDatabase db;

  /// Put somebody in the terminal's cache, and hand back the row so the same
  /// person can be listed in the roster the pad's guard reads.
  Future<StaffData> addStaff(String name, String pin, int pluId) async {
    await db.into(db.staff).insert(
      StaffCompanion.insert(pluid: Value(pluId), name: name, pin: pin),
    );
    return (db.select(db.staff)..where((s) => s.pin.equals(pin)))
        .getSingle();
  }

  /// Open the pad.
  ///
  /// `staffListProvider` is overridden with a plain stream rather than left to
  /// read drift. It only feeds `canSignOnProvider` — "can this terminal check a
  /// PIN at all" — and holding a live drift subscription for that costs the
  /// test a subscription it then has to unwind in the right order, which is a
  /// whole class of teardown flake for no coverage. The PIN check itself is
  /// **not** stubbed: `byPin` reads the real database below, and that is the
  /// thing under test.
  Future<void> open(WidgetTester tester, List<StaffData> roster) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          databaseProvider.overrideWithValue(db),
          staffListProvider.overrideWith((ref) => Stream.value(roster)),
        ],
        child: MaterialApp(
          theme: buildPosTheme(Brightness.light),
          home: Scaffold(
            body: Consumer(
              builder: (context, ref, _) {
                // Watched so the roster has actually emitted before the key is
                // pressed. `showSignOnPad` guards on `canSignOnProvider`, which
                // is false while that provider is still loading — and a
                // provider nothing is listening to only starts loading on the
                // first read. On a real till the shell has been watching it
                // since boot.
                ref.watch(staffListProvider);
                return TextButton(
                  onPressed: () => showSignOnPad(context, ref),
                  child: const Text('Sign on'),
                );
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign on'));
    await tester.pumpAndSettle();
  }

  /// Deliberately never `pumpAndSettle`. The fourth digit starts the PIN
  /// lookup, and while that runs the pad shows a spinner — an animation that
  /// by definition never settles, so `pumpAndSettle` waits out its full
  /// timeout and the whole suite hangs. Bounded pumps instead.
  Future<void> type(WidgetTester tester, String digits) async {
    for (final d in digits.split('')) {
      await tester.tap(find.widgetWithText(OutlinedButton, d));
      await tester.pump();
    }
    // Enough frames for the database lookup and the sign-on that follows it to
    // resolve. A fixed count rather than `pumpAndSettle`, which would wait out
    // its whole timeout on the spinner.
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }

  setUp(() {
    db = AppDatabase.forTesting(NativeDatabase.memory());
    addTearDown(() => db.close());
  });

  testWidgets('it opens straight onto the pad, naming nobody', (tester) async {
    final roster = [
      await addStaff('Aisha Khan', '1234', 1),
      await addStaff('Tom Reilly', '5678', 2),
    ];
    await open(tester, roster);

    // The pad is there...
    expect(find.widgetWithText(OutlinedButton, '7'), findsOneWidget);
    expect(find.text('Type your PIN to take the till.'), findsOneWidget);

    // ...and not one member of staff is named on it. This is the requirement.
    expect(find.text('Aisha Khan'), findsNothing);
    expect(find.text('Tom Reilly'), findsNothing);
  });

  testWidgets('a wrong PIN keeps the pad up', (tester) async {
    final roster = [await addStaff('Aisha Khan', '1234', 1)];
    await open(tester, roster);
    await type(tester, '9999');

    // Still open, and it says why. Dismissing on a miss is how four digits
    // becomes a re-press and four more.
    expect(find.widgetWithText(OutlinedButton, '7'), findsOneWidget);
    expect(
      find.text('That PIN was not recognised. Type it again, or correct it.'),
      findsOneWidget,
    );

    // The next digit starts a fresh attempt rather than being ignored.
    await type(tester, '1234');
    expect(find.widgetWithText(OutlinedButton, '7'), findsNothing);
  });

  testWidgets('the right PIN signs that person on and closes', (tester) async {
    final roster = [
      await addStaff('Aisha Khan', '1234', 1),
      await addStaff('Tom Reilly', '5678', 2),
    ];
    await open(tester, roster);
    await type(tester, '5678');

    expect(find.widgetWithText(OutlinedButton, '7'), findsNothing);
  });

  testWidgets('backspace corrects rather than restarting', (tester) async {
    final roster = [await addStaff('Aisha Khan', '1234', 1)];
    await open(tester, roster);
    // Three digits, one of them wrong, then correct the last one.
    await type(tester, '129');
    await tester.tap(find.byIcon(Icons.backspace_outlined));
    await tester.pump();
    await type(tester, '34');

    expect(find.widgetWithText(OutlinedButton, '7'), findsNothing);
  });
}
