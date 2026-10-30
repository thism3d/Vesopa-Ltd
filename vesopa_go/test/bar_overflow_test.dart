import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/data/screen_set.dart';
import 'package:vesopa_go/ui/programmed_grid.dart';

/// The owner's bottom bar (2026-10-30): keys share the width when they fit;
/// when they do not, the rest go behind an arrow, Pay stays at the right,
/// and a tap elsewhere puts the rest away.
void main() {
  const fns = ['void', 'cancel', 'save_table', 'customer', 'note', 'open_drawer', 'last_bill', 'table_plan', 'pay'];
  final bar = TillScreen(id: 90, name: 'Bottom', surface: ScreenSurface.bottomBar, rows: 1, cols: fns.length, buttons: [
    for (var i = 0; i < fns.length; i++) ScreenButton(row: 0, col: i, kind: ScreenButtonKind.function, functionKey: fns[i]),
  ]);
  final set = ScreenSet([bar]);
  KeyActions actions(List<String> pressed) =>
      KeyActions(screens: set, productsByPlu: const {}, onProduct: (_) {}, onPage: (_) {}, onFunction: pressed.add, payLabel: '£11.00');

  Future<void> pump(WidgetTester tester, double width, List<String> pressed) => tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: SizedBox(width: width, height: 64, child: ProgrammedStrip(bar: bar, actions: actions(pressed))),
          ),
        ),
      ));

  testWidgets('wide enough: every key, no arrow', (tester) async {
    tester.view.physicalSize = const Size(2400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await pump(tester, 2000, []);
    expect(find.byIcon(Icons.keyboard_arrow_up_rounded), findsNothing);
    expect(find.text('Table Plan'), findsOneWidget);
  });

  testWidgets('too narrow: the rest behind the arrow, Pay still at the right', (tester) async {
    tester.view.physicalSize = const Size(600, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final pressed = <String>[];
    await pump(tester, 560, pressed);
    expect(find.byIcon(Icons.keyboard_arrow_up_rounded), findsOneWidget);
    expect(find.text('Pay £11.00'), findsOneWidget);
    expect(find.text('Table Plan'), findsNothing);

    await tester.tap(find.byIcon(Icons.keyboard_arrow_up_rounded));
    await tester.pumpAndSettle();
    expect(find.text('Table Plan'), findsOneWidget);
    await tester.tap(find.text('Table Plan'));
    await tester.pumpAndSettle();
    expect(pressed, ['table_plan']);
    expect(find.text('Table Plan'), findsNothing, reason: 'the row closes once a key is used');
  });
}
