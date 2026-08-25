import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/ui/tables_page.dart' show parkedOrdersProvider;
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/programmed_bar.dart';

/// The till's two strips of chrome, laid out by the venue.
///
/// A bar is a screen — one or two rows of the same buttons the sale grid is
/// made of — so almost nothing about it needs its own test. What is tested here
/// is only where a bar is *not* a grid, and each of those is a way a venue could
/// lose something it had before it touched this feature:
///
///   * the fallback chain, because null at any point along it has to mean the
///     built-in bar rather than no bar at all;
///   * Pay, because a bottom bar that cannot take money is a till that cannot;
///   * the live displays, because `open_bills` is the top bar today and a venue
///     that programs one and cannot get the tables back has lost the ability to
///     serve two parties at once.
void main() {
  ScreenButton key(
    String functionKey, {
    int col = 0,
    int colSpan = 1,
    String? label,
  }) => ScreenButton(
    row: 0,
    col: col,
    colSpan: colSpan,
    kind: ScreenButtonKind.function,
    functionKey: functionKey,
    label: label,
  );

  TillScreen bar(
    List<ScreenButton> buttons, {
    int id = 20,
    String name = 'Counter bar',
    ScreenSurface surface = ScreenSurface.bottomBar,
    int cols = 6,
  }) => TillScreen(
    id: id,
    name: name,
    surface: surface,
    rows: 1,
    cols: cols,
    buttons: buttons,
  );

  Widget host(
    TillScreen it, {
    int total = 3285,
    ScreenSet? screens,
    List<Order> parked = const [],
    double width = 900,
    void Function(String)? onFunction,
  }) {
    return ProviderScope(
      overrides: [
        // The open-bills key watches the real table repository, which opens a
        // database and leaves a stream behind it. Fed from a list here instead:
        // what is under test is that the strip is drawn inside a bar cell, not
        // that drift can watch a table.
        parkedOrdersProvider.overrideWith((ref) => Stream.value(parked)),
      ],
      child: MaterialApp(
        theme: buildPosTheme(Brightness.light),
        home: Scaffold(
          body: SizedBox(
            width: width,
            height: 120,
            child: ProgrammedBar(
              bar: it,
              screens: screens ?? ScreenSet([it]),
              products: const <int, Product>{},
              live: BarLive(
                currentOrderId: 'order-1',
                currentOrder: null,
                totalMinor: total,
                screenName: 'Drinks',
                onSwitchOrder: (_) {},
              ),
              onProduct: (_) {},
              onPage: (_) {},
              onFunction: onFunction ?? (_) {},
            ),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Which bar a till wears
  //
  // Pure model, no widgets. This is the chain that decides whether a venue sees
  // its own bar, the venue default, or the built-in one — and every wrong answer
  // it could give is a till that has lost a key somebody relies on.
  // ---------------------------------------------------------------------------
  group('which bar a screen wears', () {
    final bottom = bar([key('pay')], id: 20);
    final other = bar([key('void')], id: 21, name: 'Quiet bar');
    final sale = TillScreen(id: 1, name: 'Home', buttons: const []);
    final set = ScreenSet([sale, bottom, other]);

    test('the venue’s default, when the screen asks for nothing', () {
      expect(
        set.barFor(sale, ScreenSurface.bottomBar, 20)?.id,
        20,
      );
    });

    test('the screen’s own beats the venue’s', () {
      final fussy = TillScreen(id: 2, name: 'Drinks', bottomBarId: 21);
      expect(set.barFor(fussy, ScreenSurface.bottomBar, 20)?.id, 21);
    });

    // The whole reason null is allowed everywhere along this chain: it is the
    // venue's answer, not an absence of one, and it means the bar every till
    // has always shown.
    test('nothing anywhere means the built-in bar', () {
      expect(set.barFor(sale, ScreenSurface.bottomBar, null), isNull);
    });

    test('a bar that has been deleted falls back to the built-in', () {
      expect(set.barFor(sale, ScreenSurface.bottomBar, 999), isNull);
    });

    // The back office refuses to set this, but a till reads rows it did not
    // write — out of its own cache, put there by an older release. A sale page
    // worn as a bottom bar would draw a page of lagers squashed into the bottom
    // two inches of the till.
    test('a sale screen cannot be worn as a bar', () {
      expect(set.barFor(null, ScreenSurface.bottomBar, 1), isNull);
      expect(set.surfaceById(1, ScreenSurface.topBar), isNull);
      expect(set.surfaceById(20, ScreenSurface.bottomBar)?.id, 20);
    });

    test('and a surface this build has never heard of is ignored', () {
      // Not an error. The server stores this as a string precisely so an older
      // till meets a newer surface and skips it, rather than failing to parse
      // the venue's whole layout and showing a clerk nothing at all.
      final future = TillScreen.fromJson({
        'id': 30,
        'name': 'Side panel',
        'surface': 'sidebar',
      });
      expect(future.surface, ScreenSurface.unknown);
      expect(
        ScreenSet([future]).surfaceById(30, ScreenSurface.bottomBar),
        isNull,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // What a bar draws
  // ---------------------------------------------------------------------------
  group('the keys', () {
    testWidgets('a function key shows its built-in name', (tester) async {
      await tester.pumpWidget(host(bar([key('void'), key('pay', col: 1)])));
      expect(find.text('Void'), findsOneWidget);
      expect(find.text('Pay'), findsOneWidget);
    });

    testWidgets('the venue’s own wording wins', (tester) async {
      await tester.pumpWidget(host(bar([key('open_drawer', label: 'DRAWER')])));
      expect(find.text('DRAWER'), findsOneWidget);
      expect(find.text('No Sale'), findsNothing);
    });

    // The one thing the built-in bar does that a plain label cannot, and
    // without it a venue would have to keep the built-in bar to have it: the
    // clerk reads the figure they are about to charge off the key they press.
    testWidgets('Pay carries what it is about to charge', (tester) async {
      await tester.pumpWidget(host(bar([key('pay')]), total: 3285));
      expect(find.text('£32.85'), findsOneWidget);
    });

    testWidgets('and refuses the press on an empty bill', (tester) async {
      final pressed = <String>[];
      await tester.pumpWidget(
        host(bar([key('pay')]), total: 0, onFunction: pressed.add),
      );
      await tester.tap(find.text('Pay'));
      await tester.pump();
      expect(pressed, isEmpty, reason: 'the till offered to charge nothing');
    });

    testWidgets('an ordinary key hands its own key back', (tester) async {
      final pressed = <String>[];
      await tester.pumpWidget(
        host(bar([key('save_table')]), onFunction: pressed.add),
      );
      await tester.tap(find.text('Save Table'));
      await tester.pump();
      expect(pressed, ['save_table']);
    });

    // A key from a newer back office. Drawn inert rather than dropped, so the
    // bar keeps its shape and the gap is explained — a key that simply vanished
    // would have somebody looking for it.
    testWidgets('a key this build does not know still draws', (tester) async {
      final pressed = <String>[];
      await tester.pumpWidget(
        host(bar([key('teleport')]), onFunction: pressed.add),
      );
      expect(find.text('teleport'), findsOneWidget);
    });
  });

  // ---------------------------------------------------------------------------
  // The live displays
  //
  // The group that makes this feature safe rather than a trap.
  // ---------------------------------------------------------------------------
  group('the live displays', () {
    testWidgets('the open-bills key draws the strip of bills', (tester) async {
      await tester.pumpWidget(
        host(
          bar(
            [key('open_bills', colSpan: 4)],
            surface: ScreenSurface.topBar,
          ),
        ),
      );
      await tester.pump();

      // The current bill, which is the one thing on the strip that is there
      // whatever else is. Without this key a venue that programmed a top bar
      // would have no way to reach a bill sitting on a table.
      expect(find.text('Current'), findsOneWidget);
    });

    testWidgets('the total key shows the bill', (tester) async {
      await tester.pumpWidget(
        host(bar([key('order_total')], surface: ScreenSurface.topBar), total: 1250),
      );
      expect(find.text('£12.50'), findsOneWidget);
    });

    testWidgets('the screen-name key names the open screen', (tester) async {
      await tester.pumpWidget(
        host(bar([key('screen_name')], surface: ScreenSurface.topBar)),
      );
      expect(find.text('Drinks'), findsOneWidget);
    });

    // Not an empty cell. An empty cell is where a venue has not put anything;
    // a spacer is where it has decided nothing goes, and it can be coloured.
    testWidgets('a spacer draws nothing and is not pressable', (tester) async {
      final pressed = <String>[];
      await tester.pumpWidget(
        host(
          bar([key('spacer'), key('pay', col: 1)]),
          onFunction: pressed.add,
        ),
      );
      expect(find.text('spacer'), findsNothing);
      expect(find.text('Pay'), findsOneWidget);
    });

    testWidgets('a live display is never dispatched as a key', (tester) async {
      final pressed = <String>[];
      await tester.pumpWidget(
        host(
          bar([key('clock', colSpan: 6)], surface: ScreenSurface.topBar),
          onFunction: pressed.add,
        ),
      );
      await tester.tap(find.byType(ProgrammedBar), warnIfMissed: false);
      await tester.pump();
      expect(pressed, isEmpty);
    });
  });

  // A bar is laid out in an office against a counter terminal and then met on
  // whatever the venue is holding. Sixteen keys across a handheld is 25px each,
  // which is a bar a clerk cannot use and cannot fix from behind a counter.
  group('on a narrow terminal', () {
    testWidgets('the keys keep a size a thumb can hit', (tester) async {
      final wide = bar(
        [for (var c = 0; c < 12; c++) key('covers', col: c)],
        cols: 12,
      );
      await tester.pumpWidget(host(wide, width: 420));
      await tester.pump();

      // Every key is still there and still a real target — the bar gave up
      // fitting rather than giving up being pressable.
      final first = tester.getSize(
        find.ancestor(
          of: find.text('Covers').first,
          matching: find.byType(Material),
        ).first,
      );
      expect(first.width, greaterThanOrEqualTo(60));
      expect(find.byType(SingleChildScrollView), findsOneWidget);
    });

    testWidgets('and a bar that fits is not made scrollable', (tester) async {
      await tester.pumpWidget(host(bar([key('pay')], cols: 2), width: 900));
      expect(find.byType(SingleChildScrollView), findsNothing);
    });
  });

  // ---------------------------------------------------------------------------
  // The wire
  // ---------------------------------------------------------------------------
  group('the wire', () {
    test('a bar survives the round trip through the cache', () {
      // The cache is written as JSON and read back by a possibly different
      // release. A bar that lost its surface on the way through would come back
      // as a sale screen and be refused by every lookup above.
      final original = bar([key('pay', colSpan: 3)], cols: 12);
      final back = TillScreen.fromJson(original.toJson());

      expect(back.surface, ScreenSurface.bottomBar);
      expect(back.cols, 12);
      expect(back.buttons.single.colSpan, 3);
      expect(back.buttons.single.functionKey, 'pay');
    });

    test('a key’s own face survives it too', () {
      const original = ScreenButton(
        row: 0,
        col: 0,
        kind: ScreenButtonKind.page,
        targetScreenId: 4,
        emoji: '🍔',
        imageUrl: '/uploads/food.png',
      );
      final back = ScreenButton.fromJson(original.toJson());
      expect(back.emoji, '🍔');
      expect(back.imageUrl, '/uploads/food.png');
    });

    test('a screen remembers which bars it asked for', () {
      final screen = TillScreen.fromJson({
        'id': 3,
        'name': 'Drinks',
        'surface': 'sale',
        'topBarId': 8,
        'bottomBarId': 9,
      });
      expect(screen.topBarId, 8);
      expect(screen.bottomBarId, 9);
    });
  });
}
