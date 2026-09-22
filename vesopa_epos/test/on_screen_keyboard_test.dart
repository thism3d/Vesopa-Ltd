import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/on_screen_keyboard.dart';

/// The till's on-screen keyboard.
///
/// Two things are being guarded, and only one of them is typing.
///
/// The first is **fit**. The keys are a multiple of a unit divided out of the
/// width actually available, rather than fixed pixel sizes — because fixed
/// sizes overflow the moment the keyboard is narrower than they happen to add
/// up to, and a till is whatever panel the venue had on the shelf. A hatched
/// keyboard is unusable, and this is the thing standing between a clerk and a
/// void reason.
///
/// The second is **the caret**. A controller that has never been focused has an
/// invalid selection, and the obvious range-replacement throws on it. That is
/// the state every one of these dialogs opens in.
void main() {
  Widget host(
    TextEditingController controller, {
    double width = 660,
    PosKeyboardMode mode = PosKeyboardMode.text,
    VoidCallback? onSubmit,
  }) => MaterialApp(
    theme: buildPosTheme(Brightness.light),
    home: Scaffold(
      body: Center(
        child: SizedBox(
          width: width,
          child: OnScreenKeyboard(
            controller: controller,
            mode: mode,
            onSubmit: onSubmit,
          ),
        ),
      ),
    ),
  );

  group('it fits', () {
    // 640 is a narrow dialog on a small till; 1920 is the common panel. Nothing
    // in between may overflow, and neither may either end.
    for (final width in const [520.0, 640.0, 800.0, 1024.0, 1280.0, 1920.0]) {
      testWidgets('nothing overflows at ${width.toInt()}px', (tester) async {
        tester.view.physicalSize = Size(width + 40, 900);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(host(TextEditingController(), width: width));
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('the symbol layer fits too', (tester) async {
      await tester.pumpWidget(host(TextEditingController(), width: 640));
      await tester.tap(find.text('123'));
      await tester.pumpAndSettle();

      expect(find.text('abc'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a long submit label does not push the row out', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildPosTheme(Brightness.light),
          home: Scaffold(
            body: SizedBox(
              width: 560,
              child: OnScreenKeyboard(
                controller: TextEditingController(),
                submitLabel: 'Cancel check',
                onSubmit: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  });

  group('typing', () {
    testWidgets('a controller that was never focused still types', (
      tester,
    ) async {
      // The state every one of these dialogs opens in. The naive
      // `replaceRange(selection.start, ...)` throws here, because start is -1.
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));

      await tester.tap(find.widgetWithText(InkWell, 'h'));
      await tester.tap(find.widgetWithText(InkWell, 'i'));
      await tester.pump();

      expect(controller.text, 'hi');
      expect(tester.takeException(), isNull);
    });

    testWidgets('shift latches for one letter, then releases', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));

      await tester.tap(find.byIcon(Icons.arrow_upward));
      await tester.pump();
      await tester.tap(find.widgetWithText(InkWell, 'A'));
      await tester.pump();
      await tester.tap(find.widgetWithText(InkWell, 'b'));
      await tester.pump();

      expect(controller.text, 'Ab');
    });

    testWidgets('a second tap locks caps until it is turned off', (
      tester,
    ) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));

      await tester.tap(find.byIcon(Icons.arrow_upward));
      await tester.pump();
      await tester.tap(find.byIcon(Icons.arrow_upward));
      await tester.pump();

      await tester.tap(find.widgetWithText(InkWell, 'A'));
      await tester.pump();
      await tester.tap(find.widgetWithText(InkWell, 'B'));
      await tester.pump();
      expect(controller.text, 'AB');

      await tester.tap(find.byIcon(Icons.keyboard_capslock));
      await tester.pump();
      await tester.tap(find.widgetWithText(InkWell, 'c'));
      await tester.pump();
      expect(controller.text, 'ABc');
    });

    testWidgets('backspace removes the last character, and stops at empty', (
      tester,
    ) async {
      final controller = TextEditingController(text: 'ab');
      await tester.pumpWidget(host(controller));

      await tester.tap(find.byIcon(Icons.backspace_outlined));
      await tester.pump();
      expect(controller.text, 'a');

      await tester.tap(find.byIcon(Icons.backspace_outlined));
      await tester.pump();
      expect(controller.text, '');

      // The one that used to throw rather than do nothing.
      await tester.tap(find.byIcon(Icons.backspace_outlined));
      await tester.pump();
      expect(controller.text, '');
      expect(tester.takeException(), isNull);
    });

    // On the letter layer, not behind a layer switch. These are what the fields
    // this exists for are full of, and hiding a full stop behind `123` is how a
    // note ends up unwritten.
    testWidgets('at, dot and dash are on the letter layer', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));

      await tester.tap(find.widgetWithText(InkWell, '@'));
      await tester.tap(find.widgetWithText(InkWell, '.'));
      await tester.tap(find.widgetWithText(InkWell, '-'));
      await tester.pump();

      expect(controller.text, '@.-');
    });
  });

  group('the numeric pad', () {
    testWidgets('types digits and nothing else', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(
        host(controller, width: 380, mode: PosKeyboardMode.number),
      );

      await tester.tap(find.widgetWithText(InkWell, '4'));
      await tester.tap(find.widgetWithText(InkWell, '0'));
      await tester.pump();

      expect(controller.text, '40');
      // No letters to reach for on a Covers field.
      expect(find.widgetWithText(InkWell, 'q'), findsNothing);
      expect(find.widgetWithText(InkWell, 'space'), findsNothing);
    });

    // Guarded on the key rather than in the parser: "12.3.7" typed into a price
    // is a clerk who then has to work out which tap went wrong.
    testWidgets('a decimal pad allows exactly one point', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(
        host(controller, width: 380, mode: PosKeyboardMode.decimal),
      );

      await tester.tap(find.widgetWithText(InkWell, '1'));
      await tester.pump();
      await tester.tap(find.widgetWithText(InkWell, '.'));
      await tester.pump();
      await tester.tap(find.widgetWithText(InkWell, '5'));
      await tester.pump();
      expect(controller.text, '1.5');

      // The second point does nothing at all.
      await tester.tap(find.widgetWithText(InkWell, '.'));
      await tester.pump();
      expect(controller.text, '1.5');
    });

    testWidgets('the number pad has no decimal point', (tester) async {
      await tester.pumpWidget(
        host(
          TextEditingController(),
          width: 380,
          mode: PosKeyboardMode.number,
        ),
      );
      expect(find.widgetWithText(InkWell, '.'), findsNothing);
    });
  });

  group('the submit key', () {
    testWidgets('is dead when there is nothing to submit to', (tester) async {
      await tester.pumpWidget(host(TextEditingController()));
      // Present, but not wired — a disabled key that is still visible tells the
      // clerk the way out exists and is not available yet.
      expect(find.widgetWithText(InkWell, 'Done'), findsOneWidget);
    });

    testWidgets('fires once when it is', (tester) async {
      var fired = 0;
      await tester.pumpWidget(
        host(TextEditingController(), onSubmit: () => fired++),
      );

      await tester.tap(find.widgetWithText(InkWell, 'Done'));
      await tester.pump();
      expect(fired, 1);
    });
  });
}
