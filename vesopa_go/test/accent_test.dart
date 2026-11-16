import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/data/models.dart';
import 'package:vesopa_go/ui/accent.dart';
import 'package:vesopa_go/ui/theme.dart';

double _contrast(Color a, Color b) {
  final la = a.computeLuminance(), lb = b.computeLuminance();
  final hi = la > lb ? la : lb, lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

/// Reads Tp.lime directly, not through the theme, as most of Go's screens do.
class _Swatch extends StatelessWidget {
  const _Swatch();
  @override
  Widget build(BuildContext context) => ColoredBox(key: const Key('swatch'), color: Tp.lime, child: const SizedBox(width: 10, height: 10));
}

void main() {
  tearDown(() => Tp.palette = GoPalette.lime);

  test('an unknown or missing accent falls back to Vesopa lime', () {
    expect(GoPalette.byId(null), GoPalette.lime);
    expect(GoPalette.byId('tartan'), GoPalette.lime);
    expect(GoPalette.byId('sky').name, 'Sky');
  });

  test('every accent reads: deep ink on Day, and the key\'s own ink on the key', () {
    for (final p in GoPalette.all) {
      // Lime's deep ink is the till's own (#6E8A0E, 3.96:1 on white) and is
      // left to match the till; every added accent meets 4.5:1.
      if (p != GoPalette.lime) {
        expect(_contrast(p.deep, Colors.white), greaterThanOrEqualTo(4.5), reason: '${p.name} deep on white');
      }
      expect(_contrast(p.on, p.colour), greaterThanOrEqualTo(4.5), reason: '${p.name} ink on its key');
    }
  });

  test('table states keep the brand colours whatever the accent', () {
    Tp.palette = GoPalette.byId('violet');
    expect(Tp.stateColour(TableState.mains), Tp.brandLime);
  });

  testWidgets('choosing an accent repaints screens that read it directly, and is kept', (tester) async {
    SharedPreferences.setMockInitialValues({});
    late WidgetRef captured;
    await tester.pumpWidget(ProviderScope(
      child: Consumer(builder: (context, ref, _) {
        captured = ref;
        Tp.palette = ref.watch(accentProvider);
        return const Directionality(textDirection: TextDirection.ltr, child: Center(child: _Swatch()));
      }),
    ));
    await tester.pumpAndSettle();
    ColoredBox box() => tester.widget<ColoredBox>(find.byKey(const Key('swatch')));
    expect(box().color, GoPalette.lime.colour);

    final sky = GoPalette.byId('sky');
    await captured.read(accentProvider.notifier).set(sky);
    await tester.pumpAndSettle();
    expect(Tp.palette, sky);
    expect(box().color, sky.colour);
    expect((await SharedPreferences.getInstance()).getString('go_accent'), 'sky');
  });
}
