import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/customer_display.dart';
import 'package:vesopa_epos/data/local/database.dart';

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

  /// One line on a bill, with only the columns the display reads.
  OrderLine orderLine(String name, double quantity, int unitPriceMinor) =>
      OrderLine(
        id: name,
        orderId: 'o1',
        pluId: 1,
        name: name,
        quantity: quantity,
        unitPriceMinor: unitPriceMinor,
        taxPercentage: 20,
        lineDiscountMinor: 0,
      );

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

  // ---------------------------------------------------------------------------
  // Telling the display where to look
  // ---------------------------------------------------------------------------

  test('the till leaves a note saying where it writes', () async {
    // The display used to work this path out from the till's version resources
    // and its Store package name. Saying it outright is what stops a change to
    // either of those going out as a blank customer screen.
    final note = File('${dir.path}/customer-display.json');
    final basket = File(r'C:\somewhere\displayasket.json');

    await announceDisplayFile(
      basket,
      terminalName: 'Bar 1',
      pathOverride: note.path,
    );

    final json = jsonDecode(note.readAsStringSync()) as Map<String, Object?>;
    expect(json['format'], displayAnnouncementFormat);
    expect(json['basket'], basket.path);
    expect(json['terminal'], 'Bar 1');
    expect(DateTime.tryParse(json['updated_at']! as String), isNotNull);
  });

  test('a note that cannot be written does not throw into a sale', () async {
    // Same rule as everything else in this file. A machine whose ProgramData is
    // locked down loses the note and nothing else: the display falls back to
    // working the path out, which is what it did before the note existed.
    await announceDisplayFile(
      File('irrelevant'),
      pathOverride: '${dir.path}/${'x' * 300}/note.json',
    );
  });

  test('publishing into a test folder announces nothing', () async {
    // The announcement is at one fixed machine-wide path. A test run that
    // repointed a real customer display at a temp folder about to be deleted
    // would be a memorable way to discover this was not guarded.
    final real = displayAnnouncementPath();
    final before = real == null || !File(real).existsSync()
        ? null
        : File(real).lastModifiedSync();

    await feedInto(dir).publish(sale);

    final after = real == null || !File(real).existsSync()
        ? null
        : File(real).lastModifiedSync();
    expect(after, before);
  });

  test('an empty basket is idle, not an empty sale', () {
    // A customer standing at a till with nothing rung up should be looking at
    // the venue's adverts, not at a bill for £0.00.
    final snapshot = snapshotFor(lines: const [], totalMinor: 0);
    expect(snapshot.state, 'idle');
  });

  // ---------------------------------------------------------------------
  // Holding a finished sale on screen
  // ---------------------------------------------------------------------
  //
  // The venue reported the thank-you setting doing nothing: the screen went to
  // full-screen adverts the instant a sale finished. Three things caused it,
  // and every one of them was on this side of the file rather than in the
  // display's own rule, which is why the display's unit tests all passed while
  // the feature did not work at all.

  test('a finished sale is published with its items on it', () async {
    // A `paid` snapshot with no lines is not a sale as far as the display is
    // concerned — Basket.hasSale wants a state AND items — so one sent without
    // them is discarded by the very rule meant to hold it up. That is what the
    // till used to send.
    final snapshot = snapshotFor(
      lines: [orderLine('Lager Pint', 2, 460)],
      paid: true,
      totalMinor: 920,
      paidMinor: 1000,
      changeMinor: 80,
    );

    expect(snapshot.state, 'paid');
    expect(snapshot.lines, isNotEmpty, reason: 'a paid sale with no items');
    expect(snapshot.paidMinor, 1000);
    expect(snapshot.changeMinor, 80);
  });

  test('a new empty bill does not wipe the finished sale', () async {
    // The exact sequence that broke it: the sale settles, the change window
    // closes, and the till starts a new bill which publishes idle on top of the
    // thank-you a fraction of a second later.
    final feed = feedInto(dir);
    feed.thankYouHold = const Duration(seconds: 20);

    await feed.publish(
      snapshotFor(
        lines: [orderLine('Lager Pint', 1, 460)],
        paid: true,
        totalMinor: 460,
      ),
    );
    await feed.clear();

    final written = jsonDecode(feed.file!.readAsStringSync()) as Map;
    expect(written['state'], 'paid', reason: 'the thank-you was wiped');
  });

  test('but a real sale replaces it at once', () async {
    // "If the till is used before 20 seconds it will show the new transaction."
    final feed = feedInto(dir);
    feed.thankYouHold = const Duration(seconds: 20);

    await feed.publish(
      snapshotFor(lines: [orderLine('Lager Pint', 1, 460)], paid: true),
    );
    await feed.publish(
      snapshotFor(lines: [orderLine('Chips', 1, 250)], totalMinor: 250),
    );

    final written = jsonDecode(feed.file!.readAsStringSync()) as Map;
    expect(written['state'], 'sale');
    expect((written['lines'] as List).single['name'], 'Chips');
  });

  test('the hold expires and the screen can be cleared again', () async {
    final feed = feedInto(dir);
    // A hold that has already passed, rather than a test that waits.
    feed.thankYouHold = Duration.zero;
    await feed.publish(
      snapshotFor(lines: [orderLine('Lager Pint', 1, 460)], paid: true),
    );

    // Zero means hold until something replaces it, so this one does not clear.
    await feed.clear();
    expect(
      (jsonDecode(feed.file!.readAsStringSync()) as Map)['state'],
      'paid',
    );

    // A real hold that has elapsed does clear.
    feed.thankYouHold = const Duration(milliseconds: 1);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await feed.clear();
    expect(
      (jsonDecode(feed.file!.readAsStringSync()) as Map)['state'],
      'idle',
    );
  });

  test('the till shutting down clears it whatever the hold says', () async {
    // There is no next sale to replace it and nothing left running to take it
    // down, so the last bill of the night would stay on a screen facing the
    // street.
    final feed = feedInto(dir);
    feed.thankYouHold = const Duration(minutes: 5);
    await feed.publish(
      snapshotFor(lines: [orderLine('Lager Pint', 1, 460)], paid: true),
    );

    await feed.clear(force: true);
    expect(
      (jsonDecode(feed.file!.readAsStringSync()) as Map)['state'],
      'idle',
    );
  });

  test('two sales running together each hold from their own moment', () async {
    // A second sale settling inside the first one's hold must restart it, not
    // inherit what is left of it.
    final feed = feedInto(dir);
    feed.thankYouHold = const Duration(milliseconds: 60);

    await feed.publish(
      snapshotFor(lines: [orderLine('First', 1, 100)], paid: true),
    );
    await Future<void>.delayed(const Duration(milliseconds: 45));
    await feed.publish(
      snapshotFor(lines: [orderLine('Second', 1, 200)], paid: true),
    );

    // 45ms into the first hold, but only just into the second.
    await feed.clear();
    expect(
      (jsonDecode(feed.file!.readAsStringSync()) as Map)['state'],
      'paid',
      reason: "the second sale inherited what was left of the first hold",
    );
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
