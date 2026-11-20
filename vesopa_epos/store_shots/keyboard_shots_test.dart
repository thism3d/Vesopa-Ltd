// The till's iPad-style keyboard, pictured on The Vesopa Kitchen's till
// (owner, 2026-11-20: "provide me screenshots of the venue The Vesopa Kitchen
// of this new keyboard layout"). Writes store_shots/keyboard/*.png:
//
//     flutter test --update-goldens store_shots/keyboard_shots_test.dart
//
// Not in test/: these are pictures to look at, not checks.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/on_screen_keyboard.dart';
import 'package:vesopa_epos/ui/widgets/programmed_grid.dart';

void main() {
  setUpAll(() async {
    final open = FontLoader('OpenSans')
      ..addFont(rootBundle.load('assets/fonts/OpenSans-Regular.ttf'))
      ..addFont(rootBundle.load('assets/fonts/OpenSans-Bold.ttf'));
    await open.load();
    // The icons, which the test harness otherwise draws as boxes.
    final root = Platform.environment['FLUTTER_ROOT'] ?? '/opt/fl/flutter';
    final icons = File('$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
    if (icons.existsSync()) {
      final bytes = icons.readAsBytesSync();
      await (FontLoader('MaterialIcons')..addFont(Future.value(ByteData.view(bytes.buffer)))).load();
    }
  });

  // The till is a Windows PC: no phone-style selection handles.
  void shotTest(String name, Future<void> Function(WidgetTester) body) =>
      testWidgets(name, body, variant: TargetPlatformVariant.only(TargetPlatform.windows));

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    KeyboardDock.instance.reset();
  });

  Product product(int plu, String name, int price) => Product(
        pluId: plu,
        name: name,
        priceMinor: price,
        taxPercentage: 20,
        stockQuantity: 0,
        printToReceipt: true,
        renewsMembership: false,
        isModifier: false,
      );

  // The Vesopa Kitchen's food.
  final menu = [
    product(1, 'Margherita Pizza', 1150),
    product(2, 'Pepperoni Pizza', 1295),
    product(3, 'Smash Burger', 1395),
    product(4, 'Fish & Chips', 1450),
    product(5, 'Chicken Wings', 895),
    product(6, 'Loaded Fries', 650),
    product(7, 'Caesar Salad', 950),
    product(8, 'Sticky Toffee Pudding', 695),
    product(9, 'Open Food', 0),
    product(10, 'Coca-Cola Can', 150),
  ];
  const fills = [
    Color(0xFFD03227), Color(0xFFB7410E), Color(0xFF8A5A2B), Color(0xFF1F6FB2), Color(0xFFE07B00),
    Color(0xFFC9A227), Color(0xFF2E8B57), Color(0xFF6B3E26), Color(0xFF4A4F57), Color(0xFFB00020),
  ];
  final screen = TillScreen(
    id: 1,
    name: 'Food',
    rows: 3,
    cols: 5,
    buttons: [
      for (var i = 0; i < menu.length; i++)
        ScreenButton(row: i ~/ 5, col: i % 5, kind: ScreenButtonKind.product, pluId: menu[i].pluId, fill: fills[i]),
      const ScreenButton(row: 2, col: 0, kind: ScreenButtonKind.function, functionKey: 'note', fill: Color(0xFF1E2430)),
      const ScreenButton(row: 2, col: 1, kind: ScreenButtonKind.function, functionKey: 'print_bill', fill: Color(0xFF1E2430)),
      const ScreenButton(row: 2, col: 2, kind: ScreenButtonKind.function, functionKey: 'covers', fill: Color(0xFF1E2430)),
      const ScreenButton(row: 2, col: 3, colSpan: 2, kind: ScreenButtonKind.page, targetScreenId: 2, label: 'DRINKS', fill: Color(0xFFA5C715)),
    ],
  );

  final shotKey = GlobalKey();
  final navigator = GlobalKey<NavigatorState>();

  Future<void> till(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1366, 768);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final theme = buildPosTheme(Brightness.dark);
    await tester.pumpWidget(RepaintBoundary(
      key: shotKey,
      child: MaterialApp(
        navigatorKey: navigator,
        debugShowCheckedModeBanner: false,
        theme: theme.copyWith(textTheme: theme.textTheme.apply(fontFamily: 'OpenSans')),
        builder: (context, child) => KeyboardInsets(child: child!),
        home: Scaffold(
          backgroundColor: PayPalette.dark.canvas,
          body: Row(children: [
            // The bill.
            Container(
              width: 340,
              color: PayPalette.dark.panel,
              padding: const EdgeInsets.all(16),
              child: const Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Table 12 · 2 covers', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                SizedBox(height: 12),
                Text('1 x Smash Burger            £13.95'),
                Text('1 x Margherita Pizza        £11.50'),
                Text('1 x Open Food                £0.00'),
                Spacer(),
                Text('Total £25.45', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
              ]),
            ),
            Expanded(
              child: ProgrammedGrid(
                screen: screen,
                screens: ScreenSet([screen, const TillScreen(id: 2, name: 'Drinks')]),
                products: {for (final p in menu) p.pluId: p},
                onProduct: (_) {},
                onPage: (_) {},
                onFunction: (_) {},
                onModifier: (_) {},
              ),
            ),
          ]),
        ),
      ),
    ));
    await tester.pumpAndSettle();
  }

  /// The till's note box, as sale_page.dart draws it.
  Future<TextEditingController> note(WidgetTester tester, {String text = '', PosKeyboardMode mode = PosKeyboardMode.text, String title = 'Note on Open Food'}) async {
    final c = TextEditingController(text: text);
    unawaited(showDialog<void>(
      context: navigator.currentContext!,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: KeyboardSize.dialogWidth(context, mode == PosKeyboardMode.text ? 540 : 380),
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextField(
                controller: c,
                autofocus: true,
                keyboardType: TextInputType.none,
                textAlign: mode == PosKeyboardMode.text ? TextAlign.start : TextAlign.center,
                style: mode == PosKeyboardMode.text ? null : const TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
                decoration: const InputDecoration(border: OutlineInputBorder()),
              ),
              OnScreenKeyboard(controller: c, mode: mode, submitLabel: 'Save', onSubmit: () {}, autoCapitalise: true),
            ]),
          ),
        ),
        actions: [
          TextButton(onPressed: () {}, child: const Text('Cancel')),
          FilledButton(onPressed: () {}, child: const Text('OK')),
        ],
      ),
    ));
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> shot(WidgetTester tester, String name) async {
    await tester.pumpAndSettle();
    await expectLater(find.byKey(shotKey), matchesGoldenFile('keyboard/$name.png'));
  }

  shotTest('1 letters, docked', (tester) async {
    await till(tester);
    final c = await note(tester);
    c.text = 'Extra cheese, no onions';
    await shot(tester, '1-letters-docked');
  });

  shotTest('2 .?123', (tester) async {
    await till(tester);
    final c = await note(tester);
    c.text = 'Table 12 @ 7:30';
    await tester.tap(find.text('.?123').first);
    await shot(tester, '2-numbers-and-symbols');
  });

  shotTest('3 #+=', (tester) async {
    await till(tester);
    await note(tester, text: 'Allergy: nuts');
    await tester.tap(find.text('.?123').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('#+=').first);
    await shot(tester, '3-more-symbols');
  });

  shotTest('4 split', (tester) async {
    await till(tester);
    await note(tester, text: 'Gluten free bun');
    unawaited(KeyboardDock.instance.setLayout(KeyboardLayout.split));
    await shot(tester, '4-split');
  });

  shotTest('5 undocked', (tester) async {
    await till(tester);
    await note(tester, text: 'Well done');
    unawaited(KeyboardDock.instance.setLayout(KeyboardLayout.undocked));
    await shot(tester, '5-undocked');
  });

  shotTest('6 floating', (tester) async {
    await till(tester);
    await note(tester, text: 'No sauce');
    unawaited(KeyboardDock.instance.setLayout(KeyboardLayout.floating));
    KeyboardDock.instance.floatAt.value = const Offset(900, 330);
    await shot(tester, '6-floating');
  });

  shotTest('7 price pad', (tester) async {
    await till(tester);
    await note(tester, text: '12.5', mode: PosKeyboardMode.decimal, title: 'Price of Open Food');
    await shot(tester, '7-price-pad');
  });

  shotTest('9 covers pad, floating', (tester) async {
    await till(tester);
    await note(tester, text: '4', mode: PosKeyboardMode.number, title: 'Covers');
    unawaited(KeyboardDock.instance.setLayout(KeyboardLayout.floating));
    KeyboardDock.instance.floatAt.value = const Offset(880, 300);
    await shot(tester, '9-covers-pad-floating');
  });

  shotTest('8 put away by a real keyboard', (tester) async {
    await till(tester);
    await note(tester, text: 'Extra gravy');
    await tester.sendKeyEvent(LogicalKeyboardKey.keyS);
    await shot(tester, '8-put-away-keyboard-button');
  });
}
