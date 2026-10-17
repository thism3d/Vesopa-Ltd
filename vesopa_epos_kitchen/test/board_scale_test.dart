import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_kitchen/ui/board_scale.dart';

void main() {
  group('BoardScale', () {
    test('auto leaves an ordinary screen alone', () {
      expect(BoardScale.of(preset: 'auto', width: 1920), 1);
      expect(BoardScale.of(preset: 'auto', width: 1366), 1);
    });

    test('auto enlarges a 4K TV left at 100% scaling', () {
      expect(BoardScale.of(preset: 'auto', width: 3840), 2);
    });

    test('a TV preset looks the same on HD and 4K', () {
      final hd = BoardScale.of(preset: 'tv55', width: 1920);
      final uhd = BoardScale.of(preset: 'tv55', width: 3840);
      expect(hd, 1.5);
      // Twice the pixels, twice the scale: the same physical size on the wall.
      expect(uhd, hd * 2);
    });

    test('bigger TVs draw bigger', () {
      final sizes = ['tv32', 'tv43', 'tv55', 'tv65', 'tv75', 'tv100'];
      final scales = [for (final s in sizes) BoardScale.of(preset: s, width: 1920)];
      for (var i = 1; i < scales.length; i++) {
        expect(scales[i], greaterThan(scales[i - 1]));
      }
    });

    test('zoom and the keyboard nudge multiply, within bounds', () {
      expect(BoardScale.of(preset: 'monitor', width: 1920, zoomPercent: 150), 1.5);
      expect(
        BoardScale.of(preset: 'monitor', width: 1920, zoomPercent: 200, nudgePercent: 110),
        closeTo(2.2, 1e-9),
      );
      expect(BoardScale.of(preset: 'tv100', width: 3840, zoomPercent: 300), 5);
      expect(BoardScale.of(preset: 'monitor', width: 1920, zoomPercent: 10), 0.5);
    });
  });
}
