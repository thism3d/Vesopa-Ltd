/// Being set up from the till.
///
/// The till owns this screen's settings, and this is the reading end. The
/// guarantees worth holding are the same ones the basket feed holds, for the
/// same reason — the writer is a different process on a different release
/// cadence:
///
///   * a settings file with one bad field in it still applies the rest;
///   * a settings file from a newer till is ignored rather than half-applied;
///   * nothing here throws, ever, because a control channel that fell over
///     would take a working customer display down with it.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_display/data/control.dart';

void main() {
  late Directory dir;

  setUp(() => dir = Directory.systemTemp.createTempSync('vesopa-ctl'));
  tearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });

  /// The basket path whose *folder* is the shared one.
  String basketIn(Directory where) => '${where.path}/basket.json';

  void writeControl(Directory where, Map<String, Object?> json) =>
      File('${where.path}/$displayControlFile')
          .writeAsStringSync(jsonEncode(json));

  test('what the till set is what this screen reads', () {
    final control = TillControl.fromJson({
      'format': 1,
      'advert_folder': r'D:\Ads',
      'idle_seconds': 0,
      'dwell_seconds': 20,
      'show_prices': false,
      'thank_you': 'Diolch',
      'screen_key': r'\\?\DISPLAY#DELA0C1',
      'full_screen': false,
      'advert_volume': 40,
      'bill_on_right': true,
      'bill_share': 35,
      'fill_screen': true,
      'standing_message': 'Ask about our loyalty card',
    })!;

    expect(control.advertFolder, r'D:\Ads');
    // Zero is a real answer — "keep the bill up" — not a missing one.
    expect(control.idleSeconds, 0);
    expect(control.dwellSeconds, 20);
    expect(control.showPrices, isFalse);
    expect(control.thankYou, 'Diolch');
    expect(control.screenKey, r'\\?\DISPLAY#DELA0C1');
    expect(control.fullScreen, isFalse);
    expect(control.advertVolume, 40);
    expect(control.billOnRight, isTrue);
    expect(control.billShare, 35);
    expect(control.fillScreen, isTrue);
    expect(control.standingMessage, 'Ask about our loyalty card');
  });

  test('sound is off unless the till turned it up', () {
    // The default that matters most. A screen on a counter that starts playing
    // a soundtrack at the person waiting to be served is a complaint, so sound
    // is opted into rather than discovered and switched off.
    expect(TillControl.fromJson({'format': 1})!.advertVolume, 0);
  });

  test('one bad field does not throw the other six away', () {
    final control = TillControl.fromJson({
      'format': 1,
      'advert_folder': r'D:\Ads',
      'idle_seconds': 'not a number',
      'thank_you': 'Diolch',
    })!;

    expect(control.advertFolder, r'D:\Ads');
    expect(control.thankYou, 'Diolch');
    expect(control.idleSeconds, 45, reason: 'falls back on its own');
  });

  test('settings from a newer till are ignored, not half-applied', () {
    // A display running three of seven settings from a shape it does not
    // understand is worse than one carrying on with what it had.
    expect(TillControl.fromJson({'format': 99, 'idle_seconds': 5}), isNull);
  });

  test('anything that is not a settings file is ignored', () {
    expect(TillControl.fromJson(null), isNull);
    expect(TillControl.fromJson('a string'), isNull);
    expect(TillControl.fromJson(<Object?>[]), isNull);
  });

  // ---------------------------------------------------------------------------
  // Which end is in charge
  // ---------------------------------------------------------------------------

  test('no settings file means this screen sets itself up', () {
    // The display's own settings page shows its controls in this case. It is
    // how a display is configured before the till has ever been started.
    expect(isControlledByTill(basketIn(dir)), isFalse);
  });

  test('a settings file means the till is in charge', () {
    writeControl(dir, {'format': 1});
    expect(isControlledByTill(basketIn(dir)), isTrue);
  });

  test('no basket path means nothing is in charge', () {
    expect(isControlledByTill(''), isFalse);
    expect(isControlledByTill('   '), isFalse);
  });

  // ---------------------------------------------------------------------------
  // Reporting back
  // ---------------------------------------------------------------------------

  test('the channel writes a status the till can read', () async {
    final channel = TillControlChannel(
      basketPath: basketIn(dir),
      pollEvery: const Duration(milliseconds: 50),
    )..report = const DisplayStatusReport(
      appVersion: '1.6.1',
      following: r'C:\till\basket.json',
      screens: [(key: 'a', label: 'Screen 1'), (key: 'b', label: 'Screen 2')],
      screenKey: 'b',
      fullScreen: true,
      advertCount: 3,
    );

    channel.start();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    await channel.dispose();

    final json =
        jsonDecode(
              File('${dir.path}/$displayStatusFile').readAsStringSync(),
            )
            as Map<String, Object?>;

    expect(json['app_version'], '1.6.1');
    expect(json['screen_key'], 'b');
    expect(json['full_screen'], isTrue);
    expect(json['advert_count'], 3);
    expect((json['screens']! as List).length, 2);
    expect(DateTime.tryParse(json['updated_at']! as String), isNotNull);
  });

  test('no half-written status file is ever left behind', () async {
    final channel = TillControlChannel(
      basketPath: basketIn(dir),
      pollEvery: const Duration(milliseconds: 50),
    )..start();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    await channel.dispose();

    expect(
      dir.listSync().map((e) => e.path.split(RegExp(r'[\\/]')).last),
      isNot(contains('$displayStatusFile.tmp')),
    );
  });

  test('a folder that is not there is not a crash', () async {
    // The till has not been installed, or its data folder has gone. The screen
    // carries on showing whatever it last had.
    final channel = TillControlChannel(
      basketPath: '${dir.path}/nowhere/basket.json',
      pollEvery: const Duration(milliseconds: 50),
    )..start();
    await Future<void>.delayed(const Duration(milliseconds: 150));
    await channel.dispose();
  });

  test('a change from the till arrives once, not on every poll', () async {
    // Re-applying settings the display is already running would restart a
    // playing advert every two seconds.
    writeControl(dir, {'format': 1, 'thank_you': 'Diolch'});

    final channel = TillControlChannel(
      basketPath: basketIn(dir),
      pollEvery: const Duration(milliseconds: 40),
    );
    final seen = <TillControl>[];
    final sub = channel.controls.listen(seen.add);
    channel.start();

    await Future<void>.delayed(const Duration(milliseconds: 250));
    await sub.cancel();
    await channel.dispose();

    expect(seen, hasLength(1));
    expect(seen.single.thankYou, 'Diolch');
  });
}
