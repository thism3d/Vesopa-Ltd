// Every text box opens the till's keyboard (Nicky, Pontardawe RFC,
// 2026-11-24: "This have now broken keyboards on setting and custom text").
// 1.16.56 gave the keyboard only to boxes built for it; a plain TextField, as
// most of Settings has, got none.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/ui/widgets/keyboard_dock.dart';
import 'package:vesopa_epos/ui/widgets/pos_text_field.dart';

Widget _page(List<Widget> children) => MaterialApp(
      home: Scaffold(body: Column(children: children)),
    );

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    KeyboardAutoAsk.install();
  });
  tearDown(() {
    KeyboardAutoAsk.uninstall();
    KeyboardDock.instance.reset();
  });

  testWidgets('a plain text box on Settings gets the keyboard and types', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    final venue = TextEditingController();
    await tester.pumpWidget(_page([TextField(controller: venue)]));
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();

    expect(KeyboardDock.instance.active.value?.controller, same(venue));
    for (final key in ['b', 'a', 'r']) {
      await tester.tap(find.byWidgetPredicate((w) => w is Text && w.data?.toLowerCase() == key).last);
      await tester.pumpAndSettle();
    }
    expect(venue.text.toLowerCase(), 'bar');
    debugDefaultTargetPlatformOverride = null;
  }, variant: TargetPlatformVariant.only(TargetPlatform.windows));

  testWidgets('a number box gets the number pad', (tester) async {
    final qty = TextEditingController();
    await tester.pumpWidget(_page([TextField(controller: qty, keyboardType: TextInputType.number)]));
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();
    expect(KeyboardDock.instance.active.value?.mode, PosKeyboardMode.number);
  });

  testWidgets('leaving the box puts the keyboard away', (tester) async {
    final a = TextEditingController();
    await tester.pumpWidget(_page([TextField(controller: a), const Text('elsewhere')]));
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();
    expect(KeyboardDock.instance.active.value, isNotNull);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    expect(KeyboardDock.instance.active.value, isNull);
    expect(KeyboardAutoAsk.current, isNull);
  });

  testWidgets('moving to another box types into that one', (tester) async {
    final a = TextEditingController(), b = TextEditingController();
    await tester.pumpWidget(_page([TextField(controller: a), TextField(controller: b)]));
    await tester.tap(find.byType(TextField).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(TextField).last);
    await tester.pumpAndSettle();
    expect(KeyboardDock.instance.active.value?.controller, same(b));
  });

  testWidgets('a box that brings its own keyboard is left to it', (tester) async {
    final name = TextEditingController();
    await tester.pumpWidget(_page([PosTextField(controller: name)]));
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();
    expect(KeyboardDock.instance.active.value?.controller, same(name));
    expect(KeyboardAutoAsk.current, isNull, reason: 'one request, the field\'s own');
  });

  testWidgets('a read-only box gets none', (tester) async {
    final shown = TextEditingController(text: 'x');
    await tester.pumpWidget(_page([TextField(controller: shown, readOnly: true)]));
    await tester.tap(find.byType(TextField));
    await tester.pumpAndSettle();
    expect(KeyboardDock.instance.active.value, isNull);
  });
}
