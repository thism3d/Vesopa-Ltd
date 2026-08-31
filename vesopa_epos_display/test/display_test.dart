/// The customer display, end to end where it can be.
///
/// What is actually worth guarding here is not the layout. It is the two rules
/// the venue asked for and the one property that makes the whole thing safe:
///
///   * a bill with nothing on it shows adverts, immediately;
///   * a bill nobody has touched for the set time shows adverts, and comes
///     straight back the moment anything is rung up;
///   * a basket file that is missing, truncated, half-written or produced by a
///     newer till never takes the screen down — the last good bill stays up.
///
/// The third one is the reason this application exists as a separate process,
/// so it is the one with the most checks against it.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_display/data/adverts.dart';
import 'package:vesopa_epos_display/data/basket_feed.dart';
import 'package:vesopa_epos_display/data/settings.dart';
import 'package:vesopa_epos_display/ui/theme.dart';

void main() {
  late Directory dir;

  setUp(() => dir = Directory.systemTemp.createTempSync('vesopa-display'));
  tearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });

  // -------------------------------------------------------------------------
  // Reading the till's file
  // -------------------------------------------------------------------------

  Map<String, Object?> sale({
    String state = 'sale',
    List<Object?>? lines,
    int total = 920,
  }) => {
    'format': 1,
    'updated_at': DateTime.now().toIso8601String(),
    'state': state,
    'lines':
        lines ??
        [
          {'name': 'Lager Pint', 'quantity': 2, 'total_minor': 920},
        ],
    'total_minor': total,
  };

  test('a basket the till wrote is read back whole', () {
    final basket = Basket.fromJson(sale())!;
    expect(basket.state, 'sale');
    expect(basket.totalMinor, 920);
    expect(basket.lines.single.name, 'Lager Pint');
    expect(basket.lines.single.quantity, 2);
    expect(basket.hasSale, isTrue);
  });

  test('a modifier line is marked as one', () {
    final basket = Basket.fromJson(
      sale(
        lines: [
          {'name': 'Gin', 'quantity': 1, 'total_minor': 450},
          {'name': 'Dash Lime', 'quantity': 1, 'total_minor': 0, 'modifier': true},
        ],
      ),
    )!;
    expect(basket.lines[0].isModifier, isFalse);
    expect(basket.lines[1].isModifier, isTrue);
  });

  test('an empty basket is not a sale', () {
    // A customer walking up to a till with nothing rung up should be looking at
    // the venue's advert, not a bill for nothing.
    final basket = Basket.fromJson(sale(state: 'idle', lines: [], total: 0))!;
    expect(basket.hasSale, isFalse);
  });

  test('a file from a newer till is ignored rather than half-understood', () {
    // A display showing a bill it has guessed at is worse than one showing
    // adverts, because the customer cannot tell which it is doing.
    final future = {...sale(), 'format': supportedFormat + 1};
    expect(Basket.fromJson(future), isNull);
  });

  test('a line that is not a line is dropped, and the rest survive', () {
    final basket = Basket.fromJson(
      sale(
        lines: [
          {'name': 'Lager Pint', 'quantity': 2, 'total_minor': 920},
          'this is not a line',
          {'quantity': 1},
          {'name': 'Crisps', 'quantity': 1, 'total_minor': 120},
        ],
      ),
    )!;
    expect(basket.lines.map((l) => l.name), ['Lager Pint', 'Crisps']);
  });

  test('missing figures read as zero rather than throwing', () {
    final basket = Basket.fromJson({'format': 1, 'state': 'sale'})!;
    expect(basket.totalMinor, 0);
    expect(basket.lines, isEmpty);
  });

  test('a file with no usable timestamp is treated as fresh, not ancient', () {
    // The alternative is a display that declares the till dead because one
    // field was missing from an otherwise perfectly good basket.
    final basket = Basket.fromJson({'format': 1, 'state': 'sale', 'updated_at': 'x'})!;
    expect(DateTime.now().difference(basket.updatedAt).inSeconds, lessThan(5));
  });

  test('the feed picks up a file that appears after it started', () async {
    final path = '${dir.path}/basket.json';
    final feed = BasketFeed(path: path, pollEvery: const Duration(milliseconds: 40));
    addTearDown(feed.dispose);

    final seen = <Basket>[];
    feed.baskets.listen(seen.add);
    feed.start();

    // Nothing there yet — a display switched on before the till.
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(seen, isEmpty);

    File(path).writeAsStringSync(jsonEncode(sale()));
    await Future<void>.delayed(const Duration(milliseconds: 200));

    expect(seen, isNotEmpty);
    expect(seen.last.totalMinor, 920);
  });

  test('and a truncated one leaves the last good bill on screen', () async {
    final path = '${dir.path}/basket.json';
    File(path).writeAsStringSync(jsonEncode(sale()));

    final feed = BasketFeed(path: path, pollEvery: const Duration(milliseconds: 40));
    addTearDown(feed.dispose);
    feed.start();
    await Future<void>.delayed(const Duration(milliseconds: 150));
    expect(feed.current.totalMinor, 920);

    // Caught mid-write. The reader must hold what it had rather than clearing
    // the customer's bill off the screen.
    File(path).writeAsStringSync('{"format":1,"lines":[{"na');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(feed.current.totalMinor, 920);
  });

  test('a till that has stopped writing eventually reads as stale', () async {
    final path = '${dir.path}/basket.json';
    File(path).writeAsStringSync(
      jsonEncode({...sale(), 'updated_at': DateTime(2020).toIso8601String()}),
    );

    final feed = BasketFeed(
      path: path,
      pollEvery: const Duration(milliseconds: 40),
      staleAfter: const Duration(minutes: 10),
    );
    addTearDown(feed.dispose);
    feed.start();
    await Future<void>.delayed(const Duration(milliseconds: 150));

    expect(feed.isStale, isTrue);
  });

  // -------------------------------------------------------------------------
  // Adverts
  // -------------------------------------------------------------------------

  void put(String name) => File('${dir.path}/$name').writeAsStringSync('x');

  test('only files it can actually draw are picked up', () {
    put('01-poster.png');
    put('02-clip.mp4');
    put('notes.txt');
    put('artwork.psd');
    put('Thumbs.db');

    final found = advertsIn(dir);
    expect(found.map((a) => a.file.uri.pathSegments.last), [
      '01-poster.png',
      '02-clip.mp4',
    ]);
    expect(found[0].kind, AdvertKind.image);
    expect(found[1].kind, AdvertKind.video);
  });

  test('they play in file-name order, so a venue can set the order', () {
    put('03-c.png');
    put('01-a.png');
    put('02-b.png');
    expect(
      advertsIn(dir).map((a) => a.file.uri.pathSegments.last),
      ['01-a.png', '02-b.png', '03-c.png'],
    );
  });

  test('a folder that is not there is empty, not an exception', () {
    expect(advertsIn(Directory('${dir.path}/nope')), isEmpty);
  });

  test('the rotation wraps, and survives the folder shrinking', () {
    put('a.png');
    put('b.png');
    put('c.png');
    final adverts = advertsIn(dir);

    final rotation = AdvertRotation();
    expect(rotation.current(adverts)!.path, adverts[0].path);
    rotation.advance(adverts);
    rotation.advance(adverts);
    expect(rotation.current(adverts)!.path, adverts[2].path);
    rotation.advance(adverts);
    expect(rotation.current(adverts)!.path, adverts[0].path);

    // Somebody deleted a poster while the loop was past it. Clamping rather
    // than resetting keeps the screen on the last advert instead of jumping
    // back to the first.
    rotation.advance(adverts);
    rotation.advance(adverts);
    final fewer = adverts.take(2).toList();
    expect(rotation.current(fewer)!.path, fewer[1].path);
  });

  test('an empty folder has nothing current, and does not divide by zero', () {
    final rotation = AdvertRotation();
    expect(rotation.current(const []), isNull);
    rotation.advance(const []);
    expect(rotation.current(const []), isNull);
  });

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  test('a screen with no till file is not set up', () {
    expect(const DisplaySettings().isConfigured, isFalse);
    expect(
      const DisplaySettings(basketPath: r'C:\x\basket.json').isConfigured,
      isTrue,
    );
  });

  test('an empty advert folder is null, not the working directory', () {
    // An empty path resolves to wherever the process happens to be running,
    // and a display that decided to play every image next to its own
    // executable would be a memorable bug.
    expect(const DisplaySettings().advertDirectory, isNull);
    expect(
      const DisplaySettings(advertFolder: '   ').advertDirectory,
      isNull,
    );
    expect(
      const DisplaySettings(advertFolder: r'D:\Ads').advertDirectory?.path,
      r'D:\Ads',
    );
  });

  test('zero seconds means never go full screen', () {
    // A screen beside a busy bar may want the bill up permanently. That is an
    // answer, not a mistake, so it is representable.
    expect(const DisplaySettings(idleSeconds: 0).idleAfter, Duration.zero);
    expect(
      const DisplaySettings(idleSeconds: 45).idleAfter,
      const Duration(seconds: 45),
    );
  });

  // -------------------------------------------------------------------------
  // Money
  // -------------------------------------------------------------------------

  test('money reads as money', () {
    expect(money(920), '£9.20');
    expect(money(0), '£0.00');
    expect(money(5), '£0.05');
    expect(money(-250), '-£2.50');
  });
}
