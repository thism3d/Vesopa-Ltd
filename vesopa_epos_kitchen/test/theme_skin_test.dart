/// Day and Night.
///
/// The board reads colour as meaning — fresh, warn, late, done, rush, and the
/// red on a modifier — and a second theme is only safe if that vocabulary
/// survives it intact. These checks are that promise written down: the grounds
/// move, the meanings do not, and the ink stays readable on whichever ground it
/// lands on.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/ui/theme.dart';

/// WCAG contrast between two opaque colours.
double _contrast(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  group('the two skins', () {
    test('Night is genuinely dark and Day is genuinely light', () {
      expect(KdsSkin.day.canvas.computeLuminance(), greaterThan(0.7));
      expect(KdsSkin.night.canvas.computeLuminance(), lessThan(0.05));
    });

    // The rule that keeps a ticket findable at two metres. On Day a card is
    // lighter than the board it sits on; on Night it has to be lighter too. A
    // card darker than its ground reads as a hole, not as a card.
    test('a card is lighter than the board it sits on, in both', () {
      for (final skin in [KdsSkin.day, KdsSkin.night]) {
        expect(
          skin.card.computeLuminance(),
          greaterThan(skin.canvas.computeLuminance()),
          reason: 'a card must sit on the board, not in it',
        );
      }
    });

    test('body text clears 7:1 on a card in both, and muted text clears 4.5', () {
      for (final skin in [KdsSkin.day, KdsSkin.night]) {
        expect(_contrast(skin.ink, skin.card), greaterThan(7));
        expect(_contrast(skin.inkMuted, skin.card), greaterThan(4.5));
      }
    });

    // Every status colour is a header fill with Kds.inkOn() over it, so what
    // has to hold is that the *fill* still separates from both grounds.
    test('every status colour still reads against either board', () {
      const statuses = {
        'fresh': Kds.fresh,
        'warn': Kds.warn,
        'late': Kds.late,
        'done': Kds.done,
        'rush': Kds.rush,
      };
      for (final entry in statuses.entries) {
        for (final skin in [KdsSkin.day, KdsSkin.night]) {
          expect(
            _contrast(entry.value, skin.canvas),
            greaterThan(1.4),
            reason: '${entry.key} disappears into the board',
          );
        }
        // And the ink the header picks for itself is readable on it, which is
        // the part that is the same in both themes and must stay that way.
        expect(_contrast(Kds.inkOn(entry.value), entry.value), greaterThan(4.5));
      }
    });
  });

  group('the theme carries its skin', () {
    test('light gets Day, dark gets Night', () {
      final day = Kds.theme();
      final night = Kds.theme(brightness: Brightness.dark);

      expect(day.extension<KdsSkin>(), KdsSkin.day);
      expect(night.extension<KdsSkin>(), KdsSkin.night);
      expect(day.scaffoldBackgroundColor, KdsSkin.day.canvas);
      expect(night.scaffoldBackgroundColor, KdsSkin.night.canvas);
    });

    testWidgets('Kds.of reads it back off the context', (tester) async {
      late KdsSkin seen;
      await tester.pumpWidget(
        MaterialApp(
          theme: Kds.theme(brightness: Brightness.dark),
          home: Builder(
            builder: (context) {
              seen = Kds.of(context);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      expect(seen, KdsSkin.night);
    });

    // A widget built outside a MaterialApp -- which is what a bare widget test
    // does -- must still draw. Day is the fallback because Day is the default.
    testWidgets('and falls back to Day with no theme at all', (tester) async {
      late KdsSkin seen;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) {
              seen = Kds.of(context);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      expect(seen, KdsSkin.day);
    });
  });
}
