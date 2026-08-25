import 'package:flutter/material.dart' show Color;
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/screens.dart';
import 'package:vesopa_epos/data/till_settings.dart';

/// A venue's programmed sale screen, as the till reads it.
///
/// The promise being guarded is the same one the kitchen's branding model
/// makes: **nothing a manager can do in an office may stop a till drawing.** A
/// layout is arranged weeks before a clerk stands in front of it, over a
/// catalogue that keeps changing, by somebody who can type a colour wrong. Each
/// of those has to come out as a key on a screen rather than as a red error at
/// a counter.
void main() {
  Map<String, dynamic> button(Map<String, dynamic> over) => {
    'row': 0,
    'col': 0,
    'kind': 'product',
    'pluId': 1,
    ...over,
  };

  group('a screen parses, whatever is in it', () {
    test('an empty payload is an empty set, not a crash', () {
      expect(ScreenSet.fromJson(const {}).isEmpty, isTrue);
      expect(ScreenSet.fromJson(const {'screens': []}).isEmpty, isTrue);
    });

    test('a screen carries its grid and its buttons', () {
      final set = ScreenSet.fromJson({
        'screens': [
          {
            'id': 3,
            'name': 'Draughts',
            'rows': 4,
            'cols': 5,
            'buttons': [button({'pluId': 7})],
          },
        ],
      });

      final screen = set.byId(3)!;
      expect(screen.name, 'Draughts');
      expect(screen.rows, 4);
      expect(screen.cols, 5);
      expect(screen.buttons.single.pluId, 7);
      expect(screen.at(0, 0), isNotNull);
      expect(screen.at(1, 1), isNull);
    });

    test('a screen that is not there is null, not an exception', () {
      final set = ScreenSet.fromJson(const {'screens': []});
      expect(set.byId(9), isNull);
      expect(set.byId(null), isNull);
    });

    // The reason `kind` is a string on the wire rather than an enum. A till
    // running an older release than the back office has to meet a button it has
    // never heard of and carry on drawing the rest of the screen.
    test('a button kind from a newer release parses as unknown', () {
      final screen = TillScreen.fromJson({
        'id': 1,
        'name': 'x',
        'buttons': [button({'kind': 'hologram'})],
      });
      expect(screen.buttons.single.kind, ScreenButtonKind.unknown);
    });

    test('a grid outside its bounds is clamped rather than trusted', () {
      final screen = TillScreen.fromJson({
        'id': 1,
        'name': 'x',
        'rows': 900,
        'cols': 900,
        'buttons': [button({'rowSpan': 900, 'colSpan': 900})],
      });
      expect(screen.rows, 10);
      // Sixteen, not twelve, since the bars arrived: a bar's cells are narrow
      // by nature and the built-in bottom bar is already ten keys plus a wide
      // Pay. The ceiling is shared rather than split by surface — a sale key
      // cannot be wider than the screen it is positioned inside anyway.
      expect(screen.cols, 16);
      expect(screen.buttons.single.rowSpan, 10);
      expect(screen.buttons.single.colSpan, 16);
    });
  });

  group('colours fall back rather than failing', () {
    for (final bad in ['', '  ', 'red', '#12345', 'nonsense']) {
      test('a fill of "$bad" is null, so the till picks', () {
        final b = ScreenButton.fromJson(button({'fill': bad, 'ink': bad}));
        expect(b.fill, isNull);
        expect(b.ink, isNull);
      });
    }

    test('a good colour parses, with or without its hash', () {
      expect(
        ScreenButton.fromJson(button({'fill': '#a5c715'})).fill,
        const Color(0xFFA5C715),
      );
      expect(
        ScreenButton.fromJson(button({'ink': 'A5C715'})).ink,
        const Color(0xFFA5C715),
      );
    });

    test('a colour survives the cache round trip', () {
      final original = ScreenButton.fromJson(
        button({'fill': '#1e2430', 'ink': '#ffffff'}),
      );
      final cached = ScreenButton.fromJson(original.toJson());
      expect(cached.fill, original.fill);
      expect(cached.ink, original.ink);
    });
  });

  group('spans', () {
    test('a spanning button swallows the cells under it', () {
      final screen = TillScreen.fromJson({
        'id': 1,
        'name': 'x',
        'rows': 3,
        'cols': 3,
        'buttons': [button({'rowSpan': 2, 'colSpan': 2})],
      });

      // Its own cell is where it draws, so it is not covered.
      expect(screen.covered, isNot(contains('0:0')));
      expect(screen.covered, containsAll(<String>['0:1', '1:0', '1:1']));
      expect(screen.covered, isNot(contains('2:2')));
    });

    test('a plain button covers nothing', () {
      final screen = TillScreen.fromJson({
        'id': 1,
        'name': 'x',
        'buttons': [button({})],
      });
      expect(screen.covered, isEmpty);
    });
  });

  group('the whole layout survives the cache', () {
    // Cached for the same reason the catalogue is: a till switched on before
    // the venue's wifi has settled must still be able to ring up a sale.
    test('a set round-trips through its own JSON', () {
      final original = ScreenSet.fromJson({
        'screens': [
          {
            'id': 3,
            'name': 'Draughts',
            'rows': 4,
            'cols': 5,
            'buttons': [
              button({'pluId': 7, 'label': '1/2 Carling', 'fill': '#a5c715'}),
              button({
                'row': 1,
                'kind': 'page',
                'pluId': null,
                'targetScreenId': 9,
              }),
              button({
                'row': 2,
                'kind': 'function',
                'pluId': null,
                'functionKey': 'covers',
              }),
            ],
          },
        ],
      });

      final cached = ScreenSet.fromJson(original.toJson());
      final screen = cached.byId(3)!;

      expect(screen.name, 'Draughts');
      expect(screen.buttons, hasLength(3));
      expect(screen.at(0, 0)!.label, '1/2 Carling');
      expect(screen.at(0, 0)!.fill, const Color(0xFFA5C715));
      expect(screen.at(1, 0)!.kind, ScreenButtonKind.page);
      expect(screen.at(1, 0)!.targetScreenId, 9);
      expect(screen.at(2, 0)!.kind, ScreenButtonKind.function);
      expect(screen.at(2, 0)!.functionKey, 'covers');
    });
  });

  group('which screen a till opens on', () {
    // Null is the venue's answer, not an absence of one: it means the built-in
    // Default, which is the catalogue-driven grid the till has always drawn.
    // This is what stops a venue with no programmed screens having no till.
    test('no home screen means the built-in Default', () {
      final settings = TillSettings.fromJson(const {});
      expect(settings.homeScreenId, isNull);
    });

    test('a home screen is read off the till-settings row', () {
      final settings = TillSettings.fromJson(const {'home_screen_id': 4});
      expect(settings.homeScreenId, 4);
    });

    // It is part of equality, so a venue switching its home screen actually
    // rebuilds the sale page rather than the change landing at the next
    // restart.
    test('changing the home screen is a change', () {
      final a = TillSettings.fromJson(const {'home_screen_id': 4});
      final b = TillSettings.fromJson(const {'home_screen_id': 5});
      final c = TillSettings.fromJson(const {'home_screen_id': 4});

      expect(a, isNot(equals(b)));
      expect(a, equals(c));
      expect(a.hashCode, equals(c.hashCode));
    });
  });
}
