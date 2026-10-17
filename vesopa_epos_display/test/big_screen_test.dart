import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_display/data/basket_feed.dart';
import 'package:vesopa_epos_display/data/control.dart';
import 'package:vesopa_epos_display/data/settings.dart';
import 'package:vesopa_epos_display/ui/board_scale.dart';
import 'package:vesopa_epos_display/ui/tiles.dart';

/// Big screens (2026-10-17): sizes, touch and tiles, off by default.
void main() {
  test('a settings file from an older till leaves the screen as it was', () {
    final c = TillControl.fromJson({'format': 1})!;
    expect(c.screenSize, 'auto');
    expect(c.zoom, 100);
    expect(c.touch, isTrue);
    expect(c.tiles, isEmpty);
  });

  test('the till can set the TV size, touch and tiles', () {
    final c = TillControl.fromJson({
      'format': 1,
      'screen_size': 'tv65',
      'zoom': 900,
      'touch': false,
      'tiles': ['clock', 7, 'total'],
      'tile_place': 'side',
      'special_title': 'Sunday roast',
    })!;
    expect(c.screenSize, 'tv65');
    expect(c.zoom, 300, reason: 'clamped');
    expect(c.touch, isFalse);
    expect(c.tiles, ['clock', 'total'], reason: 'junk dropped');
    expect(c.tilePlace, 'side');
    expect(c.specialTitle, 'Sunday roast');
  });

  test('a TV size looks the same on HD and 4K', () {
    final hd = BoardScale.of(preset: 'tv55', width: 1920);
    expect(BoardScale.of(preset: 'tv55', width: 3840), hd * 2);
    expect(BoardScale.of(preset: 'auto', width: 1920), 1);
  });

  test('no tiles by default, and an empty tile takes no room', () {
    final idle = Basket.unknown;
    expect(TileStrip.anyVisible(const DisplaySettings(), idle), isFalse);
    // The total only has something to say during a sale.
    expect(TileStrip.anyVisible(const DisplaySettings(tiles: ['total']), idle), isFalse);
    expect(TileStrip.anyVisible(const DisplaySettings(tiles: ['clock']), idle), isTrue);
    // The welcome tile needs words.
    expect(TileStrip.anyVisible(const DisplaySettings(tiles: ['welcome']), idle), isFalse);
    expect(
      TileStrip.anyVisible(const DisplaySettings(tiles: ['welcome'], welcomeText: 'Hello'), idle),
      isTrue,
    );
  });
}
