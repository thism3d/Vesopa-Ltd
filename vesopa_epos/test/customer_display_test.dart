import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/customer_display.dart';

/// The feed the customer display application reads.
///
/// The till's whole involvement in the second screen is this file, and the two
/// things that matter about it are both about the reader being a *different
/// process*:
///
///   * a half-written file is a bill with three of its five lines on it, so the
///     write has to be atomic;
///   * nothing here may throw into a sale, so every failure is swallowed and
///     the display simply stops updating.
void main() {
  late Directory dir;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('vesopa-display-test');
  });

  tearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });

  CustomerDisplayFeed feedInto(Directory where) =>
      CustomerDisplayFeed(directoryOverride: where);

  File writtenIn(Directory where) => File(
    '${where.path}/$customerDisplayFolder/$customerDisplayFile',
  );

  Map<String, Object?> readBack(Directory where) =>
      jsonDecode(writtenIn(where).readAsStringSync()) as Map<String, Object?>;

  const sale = DisplaySnapshot(
    state: 'sale',
    lines: [
      DisplayLine(name: 'Lager Pint', quantity: 2, totalMinor: 920),
      DisplayLine(name: 'Dash Lime', quantity: 1, totalMinor: 0, isModifier: true),
    ],
    subtotalMinor: 920,
    taxMinor: 153,
    totalMinor: 920,
  );

  test('it writes the basket where the display can find it', () async {
    final feed = feedInto(dir);
    await feed.publish(sale);

    final json = readBack(dir);
    expect(json['format'], customerDisplayFormat);
    expect(json['state'], 'sale');
    expect(json['total_minor'], 920);
    expect((json['lines']! as List).length, 2);
    expect((json['lines']! as List)[1], containsPair('modifier', true));
  });

  test('and stamps when it was written, so a stale display can say so', () async {
    final feed = feedInto(dir);
    await feed.publish(sale);
    final stamp = DateTime.parse(readBack(dir)['updated_at']! as String);
    expect(DateTime.now().difference(stamp).inSeconds, lessThan(5));
  });

  test('an unchanged basket is not rewritten', () async {
    // The basket stream fires for things the customer cannot see — a note
    // edited, a kitchen route set. Rewriting for each of them would keep
    // resetting the display's own "nothing has happened lately" timer, and the
    // full-screen adverts would never come up.
    final feed = feedInto(dir);
    await feed.publish(sale);
    final first = writtenIn(dir).lastModifiedSync();

    await Future<void>.delayed(const Duration(milliseconds: 30));
    await feed.publish(sale);

    expect(writtenIn(dir).lastModifiedSync(), first);
  });

  test('but a changed one is', () async {
    final feed = feedInto(dir);
    await feed.publish(sale);
    await feed.publish(
      const DisplaySnapshot(
        state: 'sale',
        lines: [DisplayLine(name: 'Lager Pint', quantity: 3, totalMinor: 1380)],
        totalMinor: 1380,
      ),
    );
    expect(readBack(dir)['total_minor'], 1380);
  });

  test('clearing puts the screen back to adverts', () async {
    final feed = feedInto(dir);
    await feed.publish(sale);
    await feed.clear();

    final json = readBack(dir);
    expect(json['state'], 'idle');
    expect((json['lines']! as List), isEmpty);
    expect(json['total_minor'], 0);
  });

  test('no half-written file is ever left behind', () async {
    // The reader is another process, so the file it opens must be either the
    // old basket or the new one and never part of both. That is what the
    // temp-then-rename is for; this checks the temp file does not survive as a
    // second thing for somebody to find.
    final feed = feedInto(dir);
    await feed.publish(sale);

    final folder = Directory('${dir.path}/$customerDisplayFolder');
    final names = folder
        .listSync()
        .map((e) => e.uri.pathSegments.last)
        .toList();
    expect(names, [customerDisplayFile]);
  });

  test('a folder it cannot write to does not throw into the sale', () async {
    // A till with a broken data folder must keep selling. The display goes
    // stale, which is a fault the customer can see; a thrown exception here
    // would be one the queue can.
    final missing = Directory('${dir.path}/nope');
    dir.deleteSync(recursive: true);

    final feed = CustomerDisplayFeed(directoryOverride: missing);
    await expectLater(feed.publish(sale), completes);
  });

  test('an empty basket is idle, not an empty sale', () {
    // A customer standing at a till with nothing rung up should be looking at
    // the venue's adverts, not at a bill for £0.00.
    final snapshot = snapshotFor(lines: const [], totalMinor: 0);
    expect(snapshot.state, 'idle');
  });

  test('two snapshots that draw the same screen compare equal', () {
    const other = DisplaySnapshot(
      state: 'sale',
      lines: [
        DisplayLine(name: 'Lager Pint', quantity: 2, totalMinor: 920),
        DisplayLine(name: 'Dash Lime', quantity: 1, totalMinor: 0, isModifier: true),
      ],
      subtotalMinor: 920,
      taxMinor: 153,
      totalMinor: 920,
    );
    expect(sale.sameAs(other), isTrue);

    const priced = DisplaySnapshot(
      state: 'sale',
      lines: [DisplayLine(name: 'Lager Pint', quantity: 2, totalMinor: 940)],
      totalMinor: 940,
    );
    expect(sale.sameAs(priced), isFalse);
  });
}
