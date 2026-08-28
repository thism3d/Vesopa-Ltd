/// A key that asks a question.
///
/// Until now a modifier could only be reached by ringing up a product that
/// carried one. That covers "which mixer with that gin?" and misses what a bar
/// actually wants: a MIXERS key on the screen, pressed against whatever is
/// already on the bill.
///
/// The key is a new `kind`, not a new function key, and these checks are why
/// that distinction has to hold: a `kind` this build has never heard of draws
/// as inert, and a modifier key whose group has been deleted has to draw as
/// unavailable rather than as a blank a clerk presses twice.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/modifiers.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/ui/widgets/programmed_grid.dart';

const _group = ModifierGroup(
  id: 7,
  name: 'Mixers',
  minSelect: 0,
  maxSelect: 1,
  screenId: 42,
);

TillScreen _screen(List<ScreenButton> buttons) => TillScreen(
  id: 1,
  name: 'Drinks',
  surface: ScreenSurface.sale,
  rows: 2,
  cols: 2,
  buttons: buttons,
);

Widget _host(
  TillScreen screen, {
  void Function(ModifierGroup)? onModifier,
  Map<int, ModifierGroup> groups = const {7: _group},
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 800,
      height: 480,
      child: ProgrammedGrid(
        screen: screen,
        screens: ScreenSet([screen]),
        products: const {},
        modifiers: groups,
        onProduct: (_) {},
        onPage: (_) {},
        onFunction: (_) {},
        onModifier: onModifier ?? (_) {},
      ),
    ),
  ),
);

void main() {
  group('the wire', () {
    test('a modifier key survives the round trip through the cache', () {
      const button = ScreenButton(
        row: 1,
        col: 2,
        kind: ScreenButtonKind.modifier,
        modifierGroupId: 7,
      );
      final back = ScreenButton.fromJson(button.toJson());
      expect(back.kind, ScreenButtonKind.modifier);
      expect(back.modifierGroupId, 7);
    });

    // The reason `kind` is a string on the wire. A till one release behind its
    // back office has to ignore a key it has never heard of, not fail to parse
    // the screen and show a clerk nothing at all.
    test('and a kind from a newer back office reads as unknown', () {
      final back = ScreenButton.fromJson(const {
        'row': 0,
        'col': 0,
        'kind': 'teleport',
      });
      expect(back.kind, ScreenButtonKind.unknown);
    });
  });

  group('the key', () {
    testWidgets('names the question it asks', (tester) async {
      await tester.pumpWidget(
        _host(
          _screen(const [
            ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.modifier,
              modifierGroupId: 7,
            ),
          ]),
        ),
      );
      expect(find.text('Mixers'), findsOneWidget);
    });

    testWidgets('unless the venue has given it a name of its own', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          _screen(const [
            ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.modifier,
              modifierGroupId: 7,
              label: 'WITH?',
            ),
          ]),
        ),
      );
      expect(find.text('WITH?'), findsOneWidget);
      expect(find.text('Mixers'), findsNothing);
    });

    testWidgets('hands the group back when it is pressed', (tester) async {
      final asked = <ModifierGroup>[];
      await tester.pumpWidget(
        _host(
          _screen(const [
            ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.modifier,
              modifierGroupId: 7,
            ),
          ]),
          onModifier: asked.add,
        ),
      );
      await tester.tap(find.text('Mixers'));
      await tester.pump();
      expect(asked.single.id, 7);
    });

    // A group deleted in the back office after the layout was saved. The key
    // has to say so and refuse the press: a blank key is one a clerk presses
    // twice before asking anybody about it.
    testWidgets('says so when the question has been deleted', (tester) async {
      final asked = <ModifierGroup>[];
      await tester.pumpWidget(
        _host(
          _screen(const [
            ScreenButton(
              row: 0,
              col: 0,
              kind: ScreenButtonKind.modifier,
              modifierGroupId: 7,
            ),
          ]),
          groups: const {},
          onModifier: asked.add,
        ),
      );
      expect(find.text('Unavailable'), findsOneWidget);
      expect(find.text('Question removed'), findsOneWidget);

      await tester.tap(find.text('Unavailable'));
      await tester.pump();
      expect(asked, isEmpty, reason: 'a broken key must refuse the press');
    });
  });

  group('the two new function keys', () {
    // Both are on the bar's "anywhere" list, because neither touches the bill
    // and both are things somebody arriving mid-service needs from whichever
    // screen the till happens to be showing.
    test('are named rather than drawn as their raw key', () {
      for (final key in ['sign_on', 'clock_in_out']) {
        final button = ScreenButton.fromJson({
          'row': 0,
          'col': 0,
          'kind': 'function',
          'functionKey': key,
        });
        expect(button.kind, ScreenButtonKind.function);
        expect(button.functionKey, key);
      }
    });
  });
}
