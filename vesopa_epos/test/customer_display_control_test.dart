/// The channel the till sets the customer display up over.
///
/// What matters here is the same thing that matters everywhere the two
/// applications meet: they are separate processes on separate release
/// cadences, so every read is defensive and no failure reaches a sale.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/customer_display.dart';
import 'package:vesopa_epos/data/customer_display_control.dart';

void main() {
  late Directory dir;

  setUp(() => dir = Directory.systemTemp.createTempSync('vesopa-control'));
  tearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });

  File controlFile() =>
      File('${dir.path}/$customerDisplayFolder/$displayControlFile');
  File statusFile() =>
      File('${dir.path}/$customerDisplayFolder/$displayStatusFile');

  test('a till that has never set anything reads back the defaults', () async {
    final control = await readDisplayControl(override: dir);
    expect(control.idleSeconds, 45);
    expect(control.showPrices, isTrue);
    expect(control.fullScreen, isTrue);
    expect(control.advertFolder, isEmpty);
  });

  test('what the till writes is what it reads back', () async {
    const set = DisplayControl(
      advertFolder: r'D:\Ads',
      idleSeconds: 0,
      dwellSeconds: 20,
      showPrices: false,
      thankYou: 'Diolch',
      screenKey: r'\?\DISPLAY#DELA0C1',
      fullScreen: false,
      advertVolume: 40,
      billOnRight: true,
      billShare: 35,
      fillScreen: true,
      standingMessage: 'Ask about our loyalty card',
    );
    expect(await writeDisplayControl(set, override: dir), isTrue);

    final back = await readDisplayControl(override: dir);
    expect(back.advertFolder, r'D:\Ads');
    // Zero is a real answer — "keep the bill up" — and must survive the round
    // trip rather than falling back to the default.
    expect(back.idleSeconds, 0);
    expect(back.dwellSeconds, 20);
    expect(back.showPrices, isFalse);
    expect(back.thankYou, 'Diolch');
    expect(back.screenKey, r'\?\DISPLAY#DELA0C1');
    expect(back.fullScreen, isFalse);
    expect(back.advertVolume, 40);
    expect(back.billOnRight, isTrue);
    expect(back.billShare, 35);
    expect(back.fillScreen, isTrue);
    expect(back.standingMessage, 'Ask about our loyalty card');
  });

  test('sound is off unless somebody turned it up', () async {
    // The default that matters most here. A screen on a counter that starts
    // playing a soundtrack at the person waiting to be served is a complaint,
    // so sound is opted into rather than discovered and switched off.
    expect(const DisplayControl().advertVolume, 0);
    expect((await readDisplayControl(override: dir)).advertVolume, 0);
  });

  test('no half-written settings file is ever left behind', () async {
    // The reader is a different process. A half-written file is a display that
    // has applied three of its seven settings.
    await writeDisplayControl(const DisplayControl(), override: dir);
    final folder = Directory('${dir.path}/$customerDisplayFolder');
    expect(
      folder.listSync().map((e) => e.path.split(RegExp(r'[\/]')).last),
      isNot(contains('$displayControlFile.tmp')),
    );
  });

  test('one bad field does not throw the other six away', () async {
    controlFile().parent.createSync(recursive: true);
    controlFile().writeAsStringSync(
      jsonEncode({
        'format': 1,
        'advert_folder': r'D:\Ads',
        'idle_seconds': 'not a number',
        'thank_you': 'Diolch',
      }),
    );

    final back = await readDisplayControl(override: dir);
    expect(back.advertFolder, r'D:\Ads');
    expect(back.thankYou, 'Diolch');
    expect(back.idleSeconds, 45, reason: 'falls back, rather than rejecting');
  });

  test('settings from a newer till are left alone, not half-applied', () async {
    controlFile().parent.createSync(recursive: true);
    controlFile().writeAsStringSync(
      jsonEncode({'format': 99, 'idle_seconds': 5, 'thank_you': 'Whatever'}),
    );

    final back = await readDisplayControl(override: dir);
    expect(back.thankYou, 'Thank you');
    expect(back.idleSeconds, 45);
  });

  test('rubbish in the settings file is not a crash', () async {
    controlFile().parent.createSync(recursive: true);
    controlFile().writeAsStringSync('{not json at all');
    expect((await readDisplayControl(override: dir)).idleSeconds, 45);
  });

  // ---------------------------------------------------------------------------
  // What the display says back
  // ---------------------------------------------------------------------------

  test('no status file means no display, not a broken one', () async {
    expect(await readDisplayStatus(override: dir), isNull);
  });

  test('a status the display wrote is read back whole', () async {
    statusFile().parent.createSync(recursive: true);
    statusFile().writeAsStringSync(
      jsonEncode(
        DisplayStatus(
          updatedAt: DateTime.now(),
          appVersion: '1.6.1',
          following: r'C:\till\basket.json',
          screens: const [
            DisplayScreenOption(key: 'a', label: 'Screen 1  ·  1920 x 1080'),
            DisplayScreenOption(key: 'b', label: 'Screen 2  ·  1280 x 1024'),
          ],
          screenKey: 'b',
          fullScreen: true,
          advertCount: 4,
        ).toJson(),
      ),
    );

    final status = (await readDisplayStatus(override: dir))!;
    expect(status.isLive, isTrue);
    expect(status.appVersion, '1.6.1');
    expect(status.screens.length, 2);
    expect(status.screens[1].label, contains('1280 x 1024'));
    expect(status.screenKey, 'b');
    expect(status.advertCount, 4);
  });

  test('a display that stopped reporting is not live', () async {
    statusFile().parent.createSync(recursive: true);
    statusFile().writeAsStringSync(
      jsonEncode(
        DisplayStatus(
          updatedAt: DateTime.now().subtract(const Duration(minutes: 5)),
        ).toJson(),
      ),
    );
    expect((await readDisplayStatus(override: dir))!.isLive, isFalse);
  });

  test('a status with no timestamp is old, not new', () async {
    // The dangerous direction. A till that reported a display as connected
    // because one field was missing would send a manager looking for a fault
    // on the display instead of at the plug.
    statusFile().parent.createSync(recursive: true);
    statusFile().writeAsStringSync(jsonEncode({'format': 1}));
    expect((await readDisplayStatus(override: dir))!.isLive, isFalse);
  });

  group('a code left on the screen', () {
    test('is taken down when the till starts', () async {
      // The hole the sheet's own tidy-up cannot cover: a till that is killed,
      // crashes, or loses power while a customer's code is up leaves it on a
      // screen facing the room, and nobody watches a customer display.
      await writeDisplayControl(
        const DisplayControl(
          customerQr: 'https://example.test/c/abc',
          customerQrCaption: 'Scan to add your loyalty card',
          advertFolder: r'C:dverts',
          thankYou: 'Diolch',
        ),
        override: dir,
      );

      expect(await clearCustomerCode(override: dir), isTrue);

      final after = await readDisplayControl(override: dir);
      expect(after.customerQr, isEmpty);
      // Everything that is the venue's own is left exactly as it was. Clearing
      // the code must not be a reset.
      expect(after.advertFolder, r'C:dverts');
      expect(after.thankYou, 'Diolch');
    });

    test('costs nothing when there is no code up', () async {
      await writeDisplayControl(
        const DisplayControl(thankYou: 'Diolch'),
        override: dir,
      );
      expect(await clearCustomerCode(override: dir), isTrue);
      expect((await readDisplayControl(override: dir)).thankYou, 'Diolch');
    });

    test('a machine with no display attached is not an error', () async {
      final gone = Directory('${dir.path}/not-there');
      expect(await clearCustomerCode(override: gone), isTrue);
    });
  });
}
