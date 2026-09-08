// Drives the till's REAL customer-display publisher, at the REAL path the
// display application reads, through the exact sequence the venue reported as
// broken.
//
// Not a unit test with a temp folder. The bug was never in the rule — the
// display's own tests all passed while the screen went to adverts the instant a
// sale finished — it was in what the till published and when. So this runs the
// shipped code against the shipped location, and the display application can be
// pointed at it and looked at.
//
//     flutter test integration_test/customer_display_hold_test.dart -d windows

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:vesopa_epos/data/customer_display.dart';
import 'package:vesopa_epos/data/local/database.dart';

OrderLine orderLine(String name, double qty, int unitPriceMinor) => OrderLine(
      id: name,
      orderId: 'integration',
      pluId: 1,
      name: name,
      quantity: qty,
      unitPriceMinor: unitPriceMinor,
      taxPercentage: 20,
      lineDiscountMinor: 0,
    );

Map<String, Object?> readBasket(File file) =>
    jsonDecode(file.readAsStringSync()) as Map<String, Object?>;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  test('a finished sale survives the bill that starts behind it', () async {
    // The real feed, the real folder, the real announcement file — everything
    // the display application looks for.
    final feed = CustomerDisplayFeed();

    // What the till does when a sale settles, in order.
    feed.thankYouHold = const Duration(seconds: 20);
    await feed.publish(
      snapshotFor(
        lines: [orderLine('Lager Pint', 2, 460), orderLine('Chips', 1, 250)],
        paid: true,
        subtotalMinor: 1170,
        totalMinor: 1170,
        paidMinor: 1500,
        changeMinor: 330,
        message: 'Thank you',
      ),
    );

    final file = feed.file;
    expect(file, isNotNull, reason: 'the till could not resolve its own file');
    print('publishing to: ${file!.path}');

    var basket = readBasket(file);
    expect(basket['state'], 'paid');
    expect((basket['lines'] as List), hasLength(2));
    expect(basket['change_minor'], 330);
    print('after settle:            ${basket['state']}  '
        '${(basket['lines'] as List).length} lines  '
        'change ${basket['change_minor']}');

    // The change window closes, and the till starts a new empty bill. THIS is
    // what wiped the screen: two idles arriving within a second of the sale.
    await feed.clear();
    await feed.publish(snapshotFor(lines: const []));

    basket = readBasket(file);
    expect(basket['state'], 'paid',
        reason: 'the new empty bill wiped the thank-you');
    print('after clear + new bill:  ${basket['state']}  '
        '(held — this is the fix)');

    // Ringing something up replaces it at once, which is what was asked for.
    await feed.publish(
      snapshotFor(lines: [orderLine('Coffee', 1, 300)], totalMinor: 300),
    );
    basket = readBasket(file);
    expect(basket['state'], 'sale');
    expect((basket['lines'] as List).single['name'], 'Coffee');
    print('after ringing up:        ${basket['state']}  '
        '${(basket['lines'] as List).single['name']}');

    // Leave the screen as a till at rest would.
    await feed.clear(force: true);
    expect(readBasket(file)['state'], 'idle');
    print('after shutdown:          ${readBasket(file)['state']}');
  });

  test('the hold actually expires rather than sticking for ever', () async {
    final feed = CustomerDisplayFeed();
    feed.thankYouHold = const Duration(seconds: 2);

    await feed.publish(
      snapshotFor(lines: [orderLine('Lager Pint', 1, 460)], paid: true),
    );
    final file = feed.file!;

    await feed.clear();
    expect(readBasket(file)['state'], 'paid', reason: 'cleared too early');
    print('at 0s:  ${readBasket(file)['state']}');

    await Future<void>.delayed(const Duration(seconds: 3));
    await feed.clear();
    expect(readBasket(file)['state'], 'idle', reason: 'never let go');
    print('at 3s:  ${readBasket(file)['state']}');

    await feed.clear(force: true);
  });
}
