import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
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

  // Text: the iPad-style keyboard docked along the bottom (keyboard_dock.dart).
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    KeyboardDock.instance.reset();
  });

  Finder key(String label) => find.descendant(of: find.byType(Overlay), matching: find.text(label)).last;

  group('it fits', () {
    // 520 is a small panel; 1920 the common one. Nothing may overflow.
    for (final width in const [520.0, 640.0, 800.0, 1024.0, 1280.0, 1920.0]) {
      testWidgets('nothing overflows at ${width.toInt()}px', (tester) async {
        tester.view.physicalSize = Size(width, 900);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(host(TextEditingController(), width: width));
        await tester.pumpAndSettle();

        expect(find.text('q'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    for (final layout in KeyboardLayout.values) {
      testWidgets('the ${layout.name} keyboard fits, on every page', (tester) async {
        tester.view.physicalSize = const Size(1366, 768);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(host(TextEditingController()));
        await tester.pumpAndSettle();
        unawaited(KeyboardDock.instance.setLayout(layout));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await tester.tap(key('.?123'));
        await tester.pumpAndSettle();
        expect(find.text('ABC'), findsWidgets);
        await tester.tap(key('#+='));
        await tester.pumpAndSettle();
        expect(find.text('€'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a long return label does not push the row out', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildPosTheme(Brightness.light),
          home: Scaffold(
            body: OnScreenKeyboard(
              controller: TextEditingController(),
              submitLabel: 'Cancel check',
              onSubmit: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Cancel check'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('typing', () {
    testWidgets('a controller that was never focused still types', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));
      await tester.pumpAndSettle();

      await tester.tap(key('h'));
      await tester.tap(key('i'));
      await tester.pump();

      expect(controller.text, 'hi');
      expect(tester.takeException(), isNull);
    });

    testWidgets('shift latches for one letter, then releases', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));
      await tester.pumpAndSettle();

      await tester.tap(find.bySemanticsLabel('Shift').first);
      await tester.pump();
      await tester.tap(key('A'));
      await tester.pump();
      await tester.tap(key('b'));
      await tester.pump();

      expect(controller.text, 'Ab');
    });

    testWidgets('a second tap locks caps until it is turned off', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));
      await tester.pumpAndSettle();

      await tester.tap(find.bySemanticsLabel('Shift').first);
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('Shift').first);
      await tester.pump();
      await tester.tap(key('A'));
      await tester.tap(key('B'));
      await tester.pump();
      expect(controller.text, 'AB');

      await tester.tap(find.bySemanticsLabel('Shift').first);
      await tester.pump();
      await tester.tap(key('c'));
      await tester.pump();
      expect(controller.text, 'ABc');
    });

    testWidgets('a capital starts each sentence where the field wants one, and two spaces type a full stop', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(MaterialApp(
        theme: buildPosTheme(Brightness.light),
        home: Scaffold(body: OnScreenKeyboard(controller: controller, autoCapitalise: true)),
      ));
      await tester.pumpAndSettle();
      await tester.tap(key('H'));
      await tester.pump();
      await tester.tap(key('i'));
      await tester.tap(find.bySemanticsLabel('space'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('space'));
      await tester.pump();
      await tester.tap(key('O'));
      await tester.pump();
      await tester.tap(key('k'));
      await tester.pump();
      expect(controller.text, 'Hi. Ok');
    });

    testWidgets('backspace removes the last character, and stops at empty', (tester) async {
      final controller = TextEditingController(text: 'ab');
      await tester.pumpWidget(host(controller));
      await tester.pumpAndSettle();

      final back = find.bySemanticsLabel('Delete').first;
      await tester.tap(back);
      await tester.pump();
      expect(controller.text, 'a');
      await tester.tap(back);
      await tester.pump();
      expect(controller.text, '');
      await tester.tap(back);
      await tester.pump();
      expect(controller.text, '');
      expect(tester.takeException(), isNull);
    });

    testWidgets('the comma and full stop are on the letters; pull down for ! and ?', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));
      await tester.pumpAndSettle();

      await tester.tap(key(','));
      await tester.tap(key('.'));
      await tester.pump();
      expect(controller.text, ',.');
      await tester.drag(key('.'), const Offset(0, 40));
      await tester.pump();
      expect(controller.text, ',.?');
      await tester.drag(key('q'), const Offset(0, 40));
      await tester.pump();
      expect(controller.text, ',.?1', reason: 'the top row types its number pulled down');
    });

    testWidgets('.?123 has the UK iPad symbols, and @ and £ are there', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));
      await tester.pumpAndSettle();
      await tester.tap(key('.?123'));
      await tester.pumpAndSettle();
      await tester.tap(key('@'));
      await tester.tap(key('5'));
      await tester.pump();
      await tester.drag(key('#'), const Offset(0, 40));
      await tester.pump();
      expect(controller.text, '@5£');
    });
  });

  group('editing', () {
    testWidgets('undo and redo', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(host(controller));
      await tester.pumpAndSettle();
      await tester.tap(key('a'));
      await tester.pump();
      await tester.tap(find.byTooltip('Undo'));
      await tester.pump();
      expect(controller.text, '');
      await tester.tap(find.byTooltip('Redo'));
      await tester.pump();
      expect(controller.text, 'a');
    });

    testWidgets('select all, cut and paste', (tester) async {
      final clip = <String, dynamic>{};
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') clip['text'] = (call.arguments as Map)['text'];
        if (call.method == 'Clipboard.getData') return {'text': clip['text']};
        return null;
      });
      final controller = TextEditingController(text: 'pie');
      await tester.pumpWidget(host(controller));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Select all'));
      await tester.pump();
      await tester.tap(find.byTooltip('Cut'));
      await tester.pumpAndSettle();
      expect(controller.text, '');
      await tester.tap(find.byTooltip('Paste'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Paste'));
      await tester.pumpAndSettle();
      expect(controller.text, 'piepie');
    });

    testWidgets('typing on a real keyboard puts it away; the keyboard button brings it back', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(MaterialApp(
        theme: buildPosTheme(Brightness.light),
        home: Scaffold(
          body: Column(children: [
            TextField(controller: controller, autofocus: true, keyboardType: TextInputType.none),
            OnScreenKeyboard(controller: controller),
          ]),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.text('q'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyX);
      await tester.pumpAndSettle();
      expect(find.text('q'), findsNothing);
      expect(find.byTooltip('Keyboard'), findsOneWidget, reason: 'the keyboard button in the corner');
      await tester.tap(find.byTooltip('Keyboard'));
      await tester.pumpAndSettle();
      expect(find.text('q'), findsOneWidget);
    });

    testWidgets('the page makes room for it while it is docked', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(MaterialApp(
        theme: buildPosTheme(Brightness.light),
        builder: (context, child) => KeyboardInsets(child: child!),
        home: Builder(builder: (context) {
          return Scaffold(body: Column(children: [
            Text('inset ${MediaQuery.viewInsetsOf(context).bottom.round()}'),
            OnScreenKeyboard(controller: controller),
          ]));
        }),
      ));
      await tester.pumpAndSettle();
      expect(KeyboardDock.instance.inset.value, greaterThan(150));
      expect(find.text('inset ${KeyboardDock.instance.inset.value.round()}'), findsOneWidget);
      unawaited(KeyboardDock.instance.setLayout(KeyboardLayout.floating));
      await tester.pumpAndSettle();
      expect(KeyboardDock.instance.inset.value, 0);
    });
  });

  group('the numeric pad', () {
    testWidgets('types digits and nothing else', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(
        host(controller, width: 380, mode: PosKeyboardMode.number),
      );
      await tester.pumpAndSettle();

      await tester.tap(key('4'));
      await tester.tap(key('0'));
      await tester.pump();

      expect(controller.text, '40');
      // No letters to reach for on a Covers field.
      expect(find.text('q'), findsNothing);
      expect(find.bySemanticsLabel('space'), findsNothing);
    });

    // Guarded on the key rather than in the parser: "12.3.7" typed into a price
    // is a clerk who then has to work out which tap went wrong.
    testWidgets('a decimal pad allows exactly one point', (tester) async {
      final controller = TextEditingController();
      await tester.pumpWidget(
        host(controller, width: 380, mode: PosKeyboardMode.decimal),
      );
      await tester.pumpAndSettle();

      await tester.tap(key('1'));
      await tester.pump();
      await tester.tap(key('.'));
      await tester.pump();
      await tester.tap(key('5'));
      await tester.pump();
      expect(controller.text, '1.5');

      // The second point does nothing at all.
      await tester.tap(key('.'));
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
      await tester.pumpAndSettle();
      expect(find.text('.'), findsNothing);
    });
  });

  group('the submit key', () {
    testWidgets('is dead when there is nothing to submit to', (tester) async {
      await tester.pumpWidget(host(TextEditingController()));
      // Present, but not wired — a disabled key that is still visible tells the
      // clerk the way out exists and is not available yet.
      await tester.pumpAndSettle();
      expect(key('Done'), findsOneWidget);
    });

    testWidgets('fires once when it is', (tester) async {
      var fired = 0;
      await tester.pumpWidget(
        host(TextEditingController(), onSubmit: () => fired++),
      );

      await tester.pumpAndSettle();
      await tester.tap(key('Done'));
      await tester.pump();
      expect(fired, 1);
    });
  });
}
