import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/kitchen_printing.dart';
import 'package:vesopa_epos/data/kitchen_screens.dart';
import 'package:vesopa_epos/printing/print_service.dart';

/// What the clerk is told after a bill is fired at the kitchen.
///
/// This is the contract the status chip reads, and it is the half of a real
/// failure that was missing. A venue had every product routed to DRINKS, DRINKS
/// still set to Printer, and no printer bound on the till — three settings that
/// are each individually reasonable — and saved table after table while the
/// kitchen got nothing and the till said nothing at all. `fireKitchen` returned
/// before working any of it out.
///
/// So the rule these pin down is: **silent only when nothing was routed
/// anywhere.** Anything that was routed and did not arrive has to produce a
/// sentence naming the station, because the clerk is the only person in the
/// building who can see both the bill and the kitchen.
void main() {
  const orderId = 'e7c1a0f2-0000-4000-8000-000000000001';

  group('nothing routed', () {
    // A counter till with no kitchen. This happens on every single sale, and a
    // chip here is a chip that gets ignored on the day it matters.
    const result = KitchenFireResult(orderId: orderId, lineIds: ['a', 'b']);

    test('is silent', () => expect(result.isSilent, isTrue));
    test('has no failures', () => expect(result.hasFailures, isFalse));
    test('offers nothing to retry', () {
      expect(result.failedStations, isEmpty);
    });
  });

  group('routed to a printer that is not there', () {
    // The reported case, once the till stopped returning early: DRINKS is on
    // the bill, DRINKS goes to paper, and there is no paper.
    const result = KitchenFireResult(
      orderId: orderId,
      stations: [
        StationPrintResult(
          station: 'kp2',
          label: 'DRINKS',
          error: 'no printer set up',
        ),
      ],
      lineIds: ['a'],
    );

    test('is not silent', () {
      expect(
        result.isSilent,
        isFalse,
        reason: 'this is the failure that went unreported for a whole service',
      );
    });

    test('says which station, by the name the venue uses', () {
      // "kp2" is not a word anybody in the building says. The chip has to
      // carry the label the manager typed into the back office.
      expect(result.summary, contains('DRINKS'));
      expect(result.summary, contains('no printer set up'));
      expect(result.summary, isNot(contains('kp2')));
    });

    test('offers that station for retry', () {
      expect(result.failedStations, {'kp2'});
    });
  });

  group('one station worked and one did not', () {
    const result = KitchenFireResult(
      orderId: orderId,
      stations: [
        StationPrintResult(station: 'kp1', label: 'FOOD'),
        StationPrintResult(
          station: 'kp2',
          label: 'DRINKS',
          error: 'no printer set up',
        ),
      ],
    );

    test('reports both halves, not just the bad one', () {
      // A clerk who is told only about the failure does not know whether to
      // walk the food order over as well.
      expect(result.summary, contains('Sent to FOOD'));
      expect(result.summary, contains('DRINKS'));
    });

    test('retries only the one that failed', () {
      expect(result.failedStations, {'kp2'});
    });
  });

  group('delivered to a screen', () {
    const result = KitchenFireResult(
      orderId: orderId,
      screens: KitchenScreenResult(stations: {'kp2'}, delivered: true),
    );

    test('is not silent, because something did happen', () {
      expect(result.isSilent, isFalse);
    });

    test('does not narrate a success', () {
      // On a venue running screens this is every fire, several hundred times a
      // day. A chip that says "sent to the kitchen screens" that often is a
      // chip the clerk stops reading.
      expect(result.summary, 'Sent to the kitchen.');
      expect(result.hasFailures, isFalse);
    });
  });

  group('the screen could not be reached', () {
    const result = KitchenFireResult(
      orderId: orderId,
      screens: KitchenScreenResult(
        stations: {'kp2'},
        delivered: false,
        queued: true,
      ),
    );

    test('says so', () {
      expect(result.isSilent, isFalse);
      expect(result.summary, isNot('Sent to the kitchen.'));
      expect(result.summary, isNotEmpty);
    });

    test('is not offered as a printer retry', () {
      // A queued screen delivery is already being re-sent in the background.
      // Putting it on the retry button would tell the clerk they had fixed
      // something they had not.
      expect(result.failedStations, isEmpty);
      expect(result.hasFailures, isFalse);
    });
  });
}
