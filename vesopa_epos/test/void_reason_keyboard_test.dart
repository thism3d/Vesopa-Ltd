import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/void_dialog.dart';

/// "Void and Cancel 'other reason' still doesn't allow you to click void after
/// typing a reason."
///
/// The reason it survived one fix is that it is invisible to a developer with a
/// keyboard. `TextField.onChanged` reports characters that arrive through the
/// input connection, and the till's on-screen keyboard does not use one — it
/// writes to the [TextEditingController] directly. So typing with a real
/// keyboard enabled the button and typing on the till did not.
///
/// These tests therefore type the way a clerk does: by pressing the drawn keys.
void main() {
  Future<void> openDialog(WidgetTester tester, {bool wholeCheck = false}) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          // The till fetches its reason list from the back office. A test has
          // no back office, and the empty list this pins is also the worst
          // case: "Other reason…" is then the only way to answer at all.
          voidReasonsProvider.overrideWith((_) async => const <String>[]),
        ],
        child: MaterialApp(
          theme: buildPosTheme(Brightness.light),
          home: Scaffold(
            body: Builder(
              builder: (context) => Consumer(
                builder: (context, ref, _) => TextButton(
                  onPressed: () =>
                      showVoidDialog(context, ref, wholeCheck: wholeCheck),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  /// The confirm button, which is the thing under test.
  FilledButton confirmButton(WidgetTester tester, String label) =>
      tester.widget<FilledButton>(
        find.ancestor(
          of: find.text(label),
          matching: find.byType(FilledButton),
        ),
      );

  /// Press a drawn key, the way a clerk on a touch screen does.
  Future<void> pressKey(WidgetTester tester, String key) async {
    await tester.tap(find.widgetWithText(InkWell, key).last);
    await tester.pump();
  }

  testWidgets('the on-screen keyboard arms the Void button', (tester) async {
    tester.view.physicalSize = const Size(1280, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await openDialog(tester);

    await tester.tap(find.text('Other reason…'));
    await tester.pumpAndSettle();

    // Nothing typed yet: the button is correctly dead.
    expect(confirmButton(tester, 'Void').onPressed, isNull);

    await pressKey(tester, 's');
    await pressKey(tester, 'p');
    await pressKey(tester, 'i');
    await pressKey(tester, 'l');
    await pressKey(tester, 't');

    // The reason reached the field...
    expect(find.text('spilt'), findsOneWidget);
    // ...and, the bug, the button that accepts it came back to life.
    expect(confirmButton(tester, 'Void').onPressed, isNotNull);
  });

  testWidgets('backspacing to empty disarms it again', (tester) async {
    tester.view.physicalSize = const Size(1280, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await openDialog(tester);
    await tester.tap(find.text('Other reason…'));
    await tester.pumpAndSettle();

    await pressKey(tester, 'x');
    expect(confirmButton(tester, 'Void').onPressed, isNotNull);

    await tester.tap(find.byIcon(Icons.backspace_outlined).last);
    await tester.pump();

    // A reason of "" is not a reason, and the audit trail is the point.
    expect(confirmButton(tester, 'Void').onPressed, isNull);
  });

  testWidgets('cancelling the whole check works the same way', (tester) async {
    tester.view.physicalSize = const Size(1280, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await openDialog(tester, wholeCheck: true);
    await tester.tap(find.text('Other reason…'));
    await tester.pumpAndSettle();

    expect(confirmButton(tester, 'Cancel check').onPressed, isNull);
    await pressKey(tester, 'a');
    expect(confirmButton(tester, 'Cancel check').onPressed, isNotNull);
  });

  testWidgets('a listed reason still arms it without typing', (tester) async {
    tester.view.physicalSize = const Size(1280, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          voidReasonsProvider.overrideWith(
            (_) async => const <String>['Wrong item rung up'],
          ),
        ],
        child: MaterialApp(
          theme: buildPosTheme(Brightness.light),
          home: Scaffold(
            body: Consumer(
              builder: (context, ref, _) => TextButton(
                onPressed: () => showVoidDialog(context, ref),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(confirmButton(tester, 'Void').onPressed, isNull);
    await tester.tap(find.text('Wrong item rung up'));
    await tester.pumpAndSettle();
    expect(confirmButton(tester, 'Void').onPressed, isNotNull);
  });
}
