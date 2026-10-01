import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/page_highlight.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/data/till_settings.dart';
import 'package:vesopa_epos/ui/theme.dart';
import 'package:vesopa_epos/ui/widgets/here_bar.dart';
import 'package:vesopa_epos/ui/widgets/programmed_grid.dart';

/// The page highlight (2026-10-01): the key for the page a till is on lights
/// up by itself. Nicki: "If I'm on the DRAUGHT page the DRAUGHT navigation
/// highlights a different colour to show the user where they are".
void main() {
  const purple = Color(0xFF5B2A86);

  ScreenButton page(int target, {String? hereFill, String? hereBar, Color? fill = purple}) =>
      ScreenButton(
        row: target - 1,
        col: 0,
        kind: ScreenButtonKind.page,
        targetScreenId: target,
        label: 'PAGE $target',
        fill: fill,
        hereFill: hereFill,
        hereBar: hereBar,
      );

  group('the look', () {
    test('the default is a white key with a lime underbar', () {
      final look = PageHighlight.vesopa.lookFor(page(1), purple)!;
      expect(look.fill, PageHighlight.white);
      expect(look.bar, Pos.brand);
      expect(look.ink, Pos.inkOn(PageHighlight.white));
      expect(look.outline, isNull);
    });

    test('a server without the migration reads as the default', () {
      expect(PageHighlight.fromSettings(const {}), PageHighlight.vesopa);
      expect(TillSettings.fromJson(const {}).pageHighlight, PageHighlight.vesopa);
    });

    test('the venue’s choice is read off the till-settings row', () {
      final h = PageHighlight.fromSettings(const {
        'nav_here_style': 'bar',
        'nav_here_fill': '#FFEEDD',
        'nav_here_bar': '#d03227',
      });
      expect(h.style, PageHighlightStyle.bar);
      expect(h.fill, const Color(0xFFFFEEDD));
      expect(h.bar, '#d03227');
      final look = h.lookFor(page(1), purple)!;
      expect(look.fill, isNull, reason: 'underbar only keeps the key’s colour');
      expect(look.bar, const Color(0xFFD03227));
    });

    test('match each key gives each page its own colour of underbar', () {
      const h = PageHighlight(bar: PageHighlight.keyBar);
      expect(h.lookFor(page(1), purple)!.bar, purple);
      const green = Color(0xFF21A73E);
      expect(h.lookFor(page(2, fill: green), green)!.bar, green);
    });

    test('an underbar that would vanish into its key falls back to the lime', () {
      // Underbar only, matching the key: a purple bar on a purple key.
      const h = PageHighlight(style: PageHighlightStyle.bar, bar: PageHighlight.keyBar);
      expect(h.lookFor(page(1), purple)!.bar, Pos.brand);
      // A white bar on a white key.
      const w = PageHighlight(bar: '#ffffff');
      expect(w.lookFor(page(1), purple)!.bar, Pos.brand);
    });

    test('outline draws a ring and nothing else', () {
      const h = PageHighlight(style: PageHighlightStyle.outline);
      final look = h.lookFor(page(1), purple)!;
      expect(look.outline, Pos.brand);
      expect(look.fill, isNull);
      expect(look.bar, isNull);
    });

    test('off draws nothing', () {
      const h = PageHighlight(style: PageHighlightStyle.off);
      expect(h.lookFor(page(1), purple), isNull);
    });

    test('a key’s own colours win over the venue’s', () {
      final look = PageHighlight.vesopa.lookFor(
        page(1, hereFill: '#111111', hereBar: '#d03227'),
        purple,
      )!;
      expect(look.fill, const Color(0xFF111111));
      expect(look.ink, Colors.white);
      expect(look.bar, const Color(0xFFD03227));
    });

    test('a key’s own colours survive the till’s cache', () {
      final b = page(1, hereFill: '#ffffff', hereBar: 'key');
      final back = ScreenButton.fromJson(b.toJson());
      expect(back.hereFill, '#ffffff');
      expect(back.hereBar, 'key');
    });
  });

  group('on the grid', () {
    Widget host(PageHighlight highlight) {
      final screen = TillScreen(
        id: 2,
        name: 'Bottles',
        rows: 3,
        cols: 1,
        buttons: [page(1), page(2), page(3)],
      );
      final others = [
        const TillScreen(id: 1, name: 'Draughts', rows: 1, cols: 1, buttons: []),
        const TillScreen(id: 3, name: 'Spirits', rows: 1, cols: 1, buttons: []),
      ];
      return MaterialApp(
        theme: buildPosTheme(Brightness.light),
        home: Scaffold(
          body: SizedBox(
            width: 300,
            height: 400,
            child: ProgrammedGrid(
              screen: screen,
              screens: ScreenSet([screen, ...others]),
              products: const {},
              pageHighlight: highlight,
              onProduct: (_) {},
              onPage: (_) {},
              onFunction: (_) {},
              onModifier: (_) {},
            ),
          ),
        ),
      );
    }

    Color keyColour(WidgetTester tester, String label) {
      final material = tester.widget<Material>(
        find
            .ancestor(of: find.text(label), matching: find.byType(Material))
            .first,
      );
      return material.color!;
    }

    testWidgets('the open page’s key lights up, and only that one', (tester) async {
      await tester.pumpWidget(host(PageHighlight.vesopa));
      await tester.pumpAndSettle();
      expect(keyColour(tester, 'PAGE 2'), PageHighlight.white);
      expect(keyColour(tester, 'PAGE 1'), purple);
      expect(keyColour(tester, 'PAGE 3'), purple);
      expect(find.byType(HereBar), findsOneWidget);
      final bar = tester.widget<HereBar>(find.byType(HereBar));
      expect(bar.colour, Pos.brand);
    });

    testWidgets('off leaves every key as it is', (tester) async {
      await tester.pumpWidget(
        host(const PageHighlight(style: PageHighlightStyle.off)),
      );
      await tester.pumpAndSettle();
      expect(keyColour(tester, 'PAGE 2'), purple);
      expect(find.byType(HereBar), findsNothing);
    });
  });
}
