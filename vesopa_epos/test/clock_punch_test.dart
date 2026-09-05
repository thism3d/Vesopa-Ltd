/// The Clock key reports the shift of whoever is standing at the till.
///
/// The venue asked for three things: that the key clocks in "the person that is
/// signed into the till" rather than opening a list to pick from, that it turns
/// green when they are on and shows the time they started, and that it turns
/// red when they have finished and shows the time they went.
///
/// The colours are the part worth guarding. A key labelled "Clock in / out"
/// answers neither of the questions somebody presses it with — am I on, and
/// since when — and the two states it can be in are opposite answers to the
/// same question. Getting them the wrong way round would be worse than having
/// no colour at all.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/local/database.dart';
import 'package:vesopa_epos/data/terminal_service.dart';
import 'package:vesopa_epos/ui/widgets/clock_punch_button.dart';

void main() {
  const alex = StaffData(
    id: 7,
    pluid: 1,
    name: 'Alex Morgan',
    pin: '4321',
    swipeCard: '',
    // No group: every key, which is what the clock has nothing to say about
    // either way. See data/till_permissions.dart.
    permissions: '',
  );
  const sam = StaffData(
    id: 8,
    pluid: 2,
    name: 'Sam Reilly',
    pin: '1122',
    swipeCard: '',
    permissions: '',
  );

  DateTime at(int hour, int minute) => DateTime(2026, 9, 5, hour, minute);

  ClockEntry shift(
    StaffData who, {
    required DateTime from,
    DateTime? to,
    int id = 1,
  }) => ClockEntry(
    id: id,
    staffId: who.id,
    staffName: who.name,
    clockedInAt: from,
    clockedOutAt: to,
  );

  /// `label()` formats through `TimeOfDay`, which needs a `MaterialLocalizations`
  /// — so it is read from inside a real tree rather than being called bare.
  Future<String> labelOf(WidgetTester tester, ClockPunch punch) async {
    late String label;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) {
            label = punch.label(context);
            return const SizedBox.shrink();
          },
        ),
      ),
    );
    return label;
  }

  group('what the key reports', () {
    test('nobody signed on is not a shift to punch', () {
      const punch = ClockPunch();
      expect(punch.signedOn, isFalse);
      expect(punch.isOn, isFalse);
      // And it says what to do about it rather than sitting there inert.
      expect(punch.action, 'Sign on first');
    });

    test('on shift reads from the open entry', () {
      final punch = ClockPunch.from(
        alex,
        ClockState(open: [shift(alex, from: at(9, 14))]),
      );
      expect(punch.isOn, isTrue);
      expect(punch.openedAt, at(9, 14));
      expect(punch.action, 'Tap to clock out');
    });

    test('off shift reads from the closed one', () {
      final punch = ClockPunch.from(
        alex,
        ClockState(today: [shift(alex, from: at(9, 14), to: at(17, 32))]),
      );
      expect(punch.isOn, isFalse);
      expect(punch.closedAt, at(17, 32));
      expect(punch.action, 'Tap to clock in');
    });

    test('somebody else on shift is not this person on shift', () {
      // The list this replaced was a list precisely because a till has many
      // staff. Reading the wrong row would put a colleague's hours on the key.
      final punch = ClockPunch.from(
        alex,
        ClockState(
          open: [shift(sam, from: at(9, 0))],
          today: [shift(sam, from: at(7, 0), to: at(9, 0), id: 2)],
        ),
      );
      expect(punch.isOn, isFalse);
      expect(punch.closedAt, isNull);
    });

    test('two shifts in a day report the later finish', () {
      final punch = ClockPunch.from(
        alex,
        ClockState(
          today: [
            shift(alex, from: at(9, 0), to: at(12, 30), id: 1),
            shift(alex, from: at(17, 0), to: at(23, 15), id: 2),
          ],
        ),
      );
      expect(punch.closedAt, at(23, 15));
    });

    test('back on after lunch is on, not off', () {
      // The morning's clock-out is still in `today`. Reporting it while a shift
      // is open would tell somebody standing at the till that they had gone
      // home.
      final punch = ClockPunch.from(
        alex,
        ClockState(
          open: [shift(alex, from: at(14, 0), id: 2)],
          today: [shift(alex, from: at(9, 0), to: at(12, 30), id: 1)],
        ),
      );
      expect(punch.isOn, isTrue);
      expect(punch.openedAt, at(14, 0));
    });
  });

  group('what the key says', () {
    testWidgets('green side: In, and the time it started', (tester) async {
      final punch = ClockPunch.from(
        alex,
        ClockState(open: [shift(alex, from: at(9, 14))]),
      );
      expect(await labelOf(tester, punch), contains('In'));
      expect(await labelOf(tester, punch), contains('9:14'));
    });

    testWidgets('red side: Out, and the time it finished', (tester) async {
      final punch = ClockPunch.from(
        alex,
        ClockState(today: [shift(alex, from: at(9, 14), to: at(17, 32))]),
      );
      expect(await labelOf(tester, punch), contains('Out'));
      expect(await labelOf(tester, punch), contains('5:32'));
    });

    testWidgets('and a shift that has not started says so plainly', (
      tester,
    ) async {
      final punch = ClockPunch.from(alex, ClockState.empty);
      expect(await labelOf(tester, punch), 'Clock in');
    });
  });
}
