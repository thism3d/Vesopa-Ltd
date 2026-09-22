import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/ui/sign_in_page.dart';
import 'package:vesopa_epos_kitchen/ui/theme.dart';
import 'package:vesopa_epos_kitchen/ui/widgets/on_screen_keyboard.dart';

/// The on-screen keyboard has to fit whatever panel the venue bought.
///
/// It did not. The keys were fixed pixel widths adding up to 816, and the
/// sign-in card is 804 wide on a 1024-pixel screen — so the bottom row painted
/// a yellow-and-black overflow hatch across the one screen a chef has to use
/// before they can see any orders at all.
///
/// These pump it at a spread of real widths and assert nothing overflows.
/// Flutter reports an overflow as an exception during paint, which
/// `takeException` surfaces — so an assertion of `isNull` is the whole test.
void main() {
  Widget host(double width, {String submitLabel = 'Next'}) {
    final controller = TextEditingController();
    return MaterialApp(
      theme: Kds.theme(),
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: width,
            child: OnScreenKeyboard(
              controller: controller,
              onSubmit: () {},
              submitLabel: submitLabel,
            ),
          ),
        ),
      ),
    );
  }

  // 804 is the width from the crash report. The rest bracket it: a small
  // wall-mounted panel, a 1080p one, and a 4K.
  for (final width in <double>[420, 640, 804, 900, 1200, 1600, 2400]) {
    testWidgets('nothing overflows at ${width.toInt()}px', (tester) async {
      tester.view.physicalSize = Size(width, 1400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(host(width));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('the symbol layer fits too', (tester) async {
    tester.view.physicalSize = const Size(804, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(host(804));
    // The layer switch drops the shift key and the three punctuation keys, so
    // the row is re-laid-out — a fit on one layer is not a fit on the other.
    await tester.tap(find.text('123'));
    await tester.pumpAndSettle();

    expect(find.text('abc'), findsOneWidget, reason: 'we are on the symbols');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a long submit label does not push the row out', (tester) async {
    // "Sign in" is the widest label the keyboard carries, and it lands on the
    // narrowest screen at exactly the moment somebody is trying to sign in.
    tester.view.physicalSize = const Size(420, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(host(420, submitLabel: 'Sign in'));
    expect(tester.takeException(), isNull);
  });

  testWidgets('shift latches, then locks, then releases', (tester) async {
    final controller = TextEditingController();
    await tester.pumpWidget(
      MaterialApp(
        theme: Kds.theme(),
        home: Scaffold(
          body: SizedBox(
            width: 900,
            child: OnScreenKeyboard(controller: controller, onSubmit: () {}),
          ),
        ),
      ),
    );

    // Lower case by default.
    await tester.tap(find.text('a'));
    await tester.pump();
    expect(controller.text, 'a');

    // One tap of shift applies to the next character only — which is what
    // somebody typing an email address means by it.
    await tester.tap(find.byIcon(Icons.arrow_upward));
    await tester.pump();
    await tester.tap(find.text('B'));
    await tester.pump();
    expect(controller.text, 'aB');

    await tester.tap(find.text('c'));
    await tester.pump();
    expect(controller.text, 'aBc', reason: 'shift released after one letter');
  });

  testWidgets('typing, backspace and the punctuation keys', (tester) async {
    final controller = TextEditingController();
    await tester.pumpWidget(
      MaterialApp(
        theme: Kds.theme(),
        home: Scaffold(
          body: SizedBox(
            width: 900,
            child: OnScreenKeyboard(controller: controller, onSubmit: () {}),
          ),
        ),
      ),
    );

    // The field this keyboard exists for most is an email address, so the
    // three punctuation keys are on the letter layer rather than behind a
    // layer switch.
    for (final key in ['g', 'r', 'i', 'l', 'l', '@', 'v', '.', 'c']) {
      await tester.tap(find.text(key).first);
      await tester.pump();
    }
    expect(controller.text, 'grill@v.c');

    await tester.tap(find.byIcon(Icons.backspace_outlined));
    await tester.pump();
    expect(controller.text, 'grill@v.');
  });

  testWidgets('a controller that was never focused still types', (tester) async {
    // A fresh controller has an invalid selection (offset -1). Appending is the
    // right reading of a tap in that state, and the naive substring throws.
    final controller = TextEditingController(text: 'abc');
    await tester.pumpWidget(
      MaterialApp(
        theme: Kds.theme(),
        home: Scaffold(
          body: SizedBox(
            width: 900,
            child: OnScreenKeyboard(controller: controller, onSubmit: () {}),
          ),
        ),
      ),
    );

    await tester.tap(find.text('d'));
    await tester.pump();
    expect(controller.text, 'abcd');
    expect(tester.takeException(), isNull);
  });

  // The page the keyboard lives on, at the resolutions a kitchen panel actually
  // runs. The crash came from here, not from the keyboard in isolation: the
  // sign-in card constrains its width, and that constraint is what the bottom
  // row failed to fit inside.
  for (final size in const <Size>[
    Size(1024, 768),  // the panel in the reference recording
    Size(1280, 800),
    Size(1920, 1080),
    Size(800, 1280),  // portrait, which some wall mounts are
  ]) {
    testWidgets(
      'the sign-in page lays out at ${size.width.toInt()}x${size.height.toInt()}',
      (tester) async {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(
          const ProviderScope(
            child: MaterialApp(home: SignInPage()),
          ),
        );
        await tester.pump();

        expect(tester.takeException(), isNull);
        expect(find.text('Sign in'), findsWidgets);
      },
    );
  }
}
