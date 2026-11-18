import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_go/display/data/control.dart';
import 'package:vesopa_go/display/data/display_options.dart';
import 'package:vesopa_go/data/terminal_sync.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a display nobody has set up does everything', () async {
    SharedPreferences.setMockInitialValues({});
    final o = await DisplayOptions.load();
    expect(o.touch, isTrue);
    expect(o.sound, isTrue);
    expect(o.showQr, isTrue);
    expect(o.thanksSeconds, 0);
  });

  test('what a manager chose comes back', () async {
    SharedPreferences.setMockInitialValues({});
    await const DisplayOptions().copyWith(touch: false, sound: false, showQr: false, thanksSeconds: 5, textScale: 1.3).save();
    final o = await DisplayOptions.load();
    expect(o.touch, isFalse);
    expect(o.sound, isFalse);
    expect(o.showQr, isFalse);
    expect(o.showAmount, isTrue);
    expect(o.thanksSeconds, 5);
    expect(o.textScale, 1.3);
  });

  test('a silly text size from the back office is brought back in range', () async {
    SharedPreferences.setMockInitialValues({'go_display_text_scale': 9.0});
    expect((await DisplayOptions.load()).textScale, 1.6);
  });

  const till = TillControl(
    advertFolder: '',
    idleSeconds: 45,
    dwellSeconds: 12,
    showPrices: true,
    thankYou: 'Cheers',
    thankYouSeconds: 20,
    screenKey: '',
    fullScreen: true,
    advertVolume: 30,
    billOnRight: true,
    billShare: 60,
    fillScreen: true,
    standingMessage: 'Quiz on Thursday',
    customerQr: 'https://club.example',
    customerQrCaption: 'Join',
    childLock: false,
    tiles: ['clock', 'qr'],
    tilePlace: 'side',
  );

  test('a screen nobody has set follows the till', () {
    final c = const DisplayOptions().applyTo(till);
    expect(c.idleSeconds, 45);
    expect(c.thankYou, 'Cheers');
    expect(c.advertVolume, 30);
    expect(c.billOnRight, isTrue);
    expect(c.billShare, 60);
    expect(c.tiles, ['clock', 'qr']);
    expect(c.tilePlace, 'side');
    expect(c.standingMessage, 'Quiz on Thursday');
  });

  test("what is set on the screen wins over the till's", () {
    final c = const DisplayOptions(
      idleSeconds: 0,
      thankYou: 'Diolch',
      advertVolume: 0,
      billSide: 'left',
      billShare: 40,
      tiles: 'date,total',
      tilePlace: 'bottom',
      showPrices: false,
      standingMessage: 'Open late',
      customerQr: 'https://mine.example',
      customerQrCaption: 'Scan me',
    ).applyTo(till);
    expect(c.idleSeconds, 0);
    expect(c.thankYou, 'Diolch');
    expect(c.advertVolume, 0);
    expect(c.billOnRight, isFalse);
    expect(c.billShare, 40);
    expect(c.tiles, ['date', 'total']);
    expect(c.tilePlace, 'bottom');
    expect(c.showPrices, isFalse);
    expect(c.standingMessage, 'Open late');
    expect(c.customerQr, 'https://mine.example');
    expect(c.customerQrCaption, 'Scan me');
  });

  test('no till yet: the Windows display defaults', () {
    final c = const DisplayOptions().applyTo(null);
    expect(c.idleSeconds, 45);
    expect(c.thankYouSeconds, 20);
    expect(c.tiles, isEmpty);
  });

  test('every option is kept in the back office', () {
    for (final k in DisplayOptions.keys) {
      expect(terminalSettings.containsKey('go_display_$k'), isTrue, reason: k);
    }
  });

  test('the new options come back after a save', () async {
    SharedPreferences.setMockInitialValues({});
    await const DisplayOptions().copyWith(idleSeconds: 90, dwellSeconds: 8, fillVideos: false, billSide: 'right', tiles: 'clock', orientation: 'landscape').save();
    final o = await DisplayOptions.load();
    expect(o.idleSeconds, 90);
    expect(o.dwellSeconds, 8);
    expect(o.fillVideos, isFalse);
    expect(o.billSide, 'right');
    expect(o.tileList, ['clock']);
    expect(o.orientation, 'landscape');
  });
}
