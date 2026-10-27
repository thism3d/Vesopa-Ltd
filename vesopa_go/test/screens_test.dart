import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/data/session.dart';
import 'package:vesopa_go/ui/programmed_grid.dart';

/// One home screen as /api/till/screens sends it: a product key two cells
/// wide, a page key, and a function key Go cannot do.
const _screens = [
  {
    'id': 7,
    'name': 'Bar',
    'surface': 'sale',
    'rows': 2,
    'cols': 3,
    'buttons': [
      {'row': 0, 'col': 0, 'colSpan': 2, 'kind': 'product', 'pluId': 101, 'label': 'Pint'},
      {'row': 0, 'col': 2, 'kind': 'page', 'targetScreenId': 8, 'label': 'Food'},
      {'row': 1, 'col': 0, 'kind': 'function', 'functionKey': 'open_drawer', 'label': 'No sale'},
    ],
  },
  {'id': 8, 'name': 'Food', 'surface': 'sale', 'rows': 1, 'cols': 1, 'buttons': []},
];

void main() {
  test('the till’s home screen is drawn only when the venue set one', () {
    expect(TapConfig.fromJson(const {'screens': _screens}).home, isNull);
    final c = TapConfig.fromJson(const {'screens': _screens, 'till': {'home_screen_id': 7}});
    expect(c.home?.name, 'Bar');
    expect(c.home?.buttons.first.colSpan, 2);
  });

  testWidgets('product keys ring up, page keys open their screen, the till’s own functions do nothing', (tester) async {
    final c = TapConfig.fromJson(const {'screens': _screens, 'till': {'home_screen_id': 7}});
    Product? rung;
    TillScreen? opened;
    const pint = Product(id: 'plu101', plu: 101, name: 'Pint', priceMinor: 580, category: 'beer');
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 600,
          height: 300,
          child: ProgrammedGrid(
            screen: c.home!,
            screens: c.screens,
            productsByPlu: const {101: pint},
            onProduct: (p) => rung = p,
            onPage: (s) => opened = s,
            onFunction: (_) => fail('No sale is the till’s'),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('Pint'));
    expect(rung, pint);
    await tester.tap(find.text('Food'));
    expect(opened?.id, 8);
    await tester.tap(find.text('No sale'));
    expect(find.text('On the till'), findsOneWidget);
  });
}
