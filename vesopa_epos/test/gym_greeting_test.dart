/// The greeting at the gym door, and the promise it has to keep.
///
/// "They use this as a self service where no one mans the till... can't have
/// pop ups."
///
/// That sentence is a set of testable claims, and this file is those claims.
/// Every one of them is invisible in a screenshot -- a greeting that blocks the
/// screen and a greeting that does not look identical -- which is precisely why
/// they are asserted rather than looked at:
///
///   * it takes no route, so nothing has to be dismissed before the till works;
///   * it swallows no touch, so a sale can be rung up underneath it;
///   * it clears itself, so the next member is not looking at the last one's
///     name;
///   * and a second swipe replaces the first outright rather than queueing
///     behind it, because two people arriving together is the ordinary case at
///     half past six in the morning.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:vesopa_epos/data/gym.dart';
import 'package:vesopa_epos/ui/gym_greeting.dart';

/// The greeting layer over a till, and a handle on the notifier that drives it.
///
/// The layer is mounted the way main.dart mounts it -- last in a Stack, over
/// everything -- because "does it cover the till" and "does it let a touch
/// through" are the two questions here and neither can be asked of it alone.
late WidgetRef _ref;

Future<void> pumpDoor(WidgetTester tester, {VoidCallback? onTap}) async {
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        home: Consumer(
          builder: (context, ref, _) {
            _ref = ref;
            return Scaffold(
              body: Stack(
                children: [
                  Positioned.fill(
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: onTap,
                      child: const Center(child: Text('the sale screen')),
                    ),
                  ),
                  const GymGreetingLayer(apiBase: 'https://example.test'),
                ],
              ),
            );
          },
        ),
      ),
    ),
  );
}

GymAnswer entered({String name = 'Sarah Hughes'}) =>
    GymAnswer(outcome: GymOutcome.entered, memberName: name, memberNo: 42);

void main() {
  testWidgets('draws nothing at all when the door has nothing to say',
      (tester) async {
    await pumpDoor(tester);
    expect(find.byType(Material), findsWidgets);
    expect(find.textContaining('Welcome'), findsNothing);
    // No dialog route was ever pushed, which is the claim.
    expect(find.byType(Dialog), findsNothing);
  });

  testWidgets('greets by name without opening a dialog', (tester) async {
    await pumpDoor(tester);
    _ref.read(gymGreetingProvider.notifier).show(entered(), seconds: 6);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('Sarah'), findsOneWidget);
    // A dialog is a route. This must never be one: a route has to be popped,
    // and there is nobody at this till to pop it.
    //
    // Not asserted through ModalBarrier, which the Navigator puts in the tree
    // for the ordinary page route as well and which therefore proves nothing.
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(BottomSheet), findsNothing);
    // And the till is still the thing underneath it.
    expect(find.text('the sale screen'), findsOneWidget);
  });

  testWidgets('lets a touch through to the till underneath', (tester) async {
    var taps = 0;
    await pumpDoor(tester, onTap: () => taps++);

    _ref.read(gymGreetingProvider.notifier).show(entered(), seconds: 6);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // Straight at the panel, which sits at the top of the screen.
    await tester.tapAt(const Offset(400, 80));
    await tester.pump();

    expect(taps, 1,
        reason: 'the greeting swallowed a tap, which makes it a dialog by '
            'another name — a clerk ringing a sale up at this counter would '
            'find the screen dead every time somebody came through the door');
  });

  testWidgets('clears itself after the venue seconds', (tester) async {
    await pumpDoor(tester);
    _ref.read(gymGreetingProvider.notifier).show(entered(), seconds: 3);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('Sarah'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 400));

    // It has to go on its own. A panel carrying somebody's name and photograph
    // waiting for a tap nobody is there to give is the next member's greeting
    // hidden behind the last member's, and a stranger's face left facing the
    // room.
    expect(find.textContaining('Sarah'), findsNothing);
  });

  testWidgets('a second swipe replaces the first rather than queueing',
      (tester) async {
    await pumpDoor(tester);
    final notifier = _ref.read(gymGreetingProvider.notifier);

    notifier.show(entered(name: 'Sarah Hughes'), seconds: 6);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    notifier.show(entered(name: 'Dafydd Morgan'), seconds: 6);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.textContaining('Dafydd'), findsOneWidget);
    expect(find.textContaining('Sarah'), findsNothing,
        reason: 'two members arriving together is the ordinary case, and the '
            'second must not be shown the first one\'s name');
  });

  testWidgets('and gets its own full few seconds, not the tail of the first',
      (tester) async {
    await pumpDoor(tester);
    final notifier = _ref.read(gymGreetingProvider.notifier);

    notifier.show(entered(name: 'Sarah Hughes'), seconds: 4);
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));

    notifier.show(entered(name: 'Dafydd Morgan'), seconds: 4);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    // One second after the FIRST timer would have fired.
    await tester.pump(const Duration(seconds: 2));
    expect(find.textContaining('Dafydd'), findsOneWidget,
        reason: 'the replaced greeting took its timer with it');

    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.textContaining('Dafydd'), findsNothing);
  });

  testWidgets('says what happened on the way out, and how long they were in',
      (tester) async {
    await pumpDoor(tester);
    _ref.read(gymGreetingProvider.notifier).show(
          const GymAnswer(
            outcome: GymOutcome.left,
            memberName: 'Sarah Hughes',
            minutes: 74,
          ),
          seconds: 6,
        );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('Sarah'), findsOneWidget);
    expect(find.textContaining('1 hour 14 min'), findsOneWidget);
  });

  testWidgets('an expired membership says when, in words a member can read',
      (tester) async {
    await pumpDoor(tester);
    _ref.read(gymGreetingProvider.notifier).show(
          const GymAnswer(
            outcome: GymOutcome.expired,
            memberName: 'Ieuan Rees',
            membershipExpiry: '2026-03-04',
            expiredDays: 12,
          ),
          seconds: 6,
        );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // "4 March 2026", not "2026-03-04". A date on a screen somebody is reading
    // is a date, not a database column.
    expect(find.textContaining('4 March 2026'), findsOneWidget);
    expect(find.textContaining('12 days ago'), findsOneWidget);
  });

  testWidgets('a double read says so rather than saying nothing',
      (tester) async {
    // Silence at a door is what makes somebody swipe again, and again, and then
    // go looking for a member of staff who is not there.
    await pumpDoor(tester);
    _ref.read(gymGreetingProvider.notifier).show(
          const GymAnswer(
            outcome: GymOutcome.ignored,
            memberName: 'Sarah Hughes',
          ),
          seconds: 6,
        );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('already in'), findsOneWidget);
  });

  testWidgets('an offline swipe promises the visit is saved, not that it failed',
      (tester) async {
    await pumpDoor(tester);
    _ref.read(gymGreetingProvider.notifier).show(
          const GymAnswer(outcome: GymOutcome.queued),
          seconds: 6,
        );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('Recorded'), findsOneWidget);
    expect(find.textContaining('saved'), findsOneWidget);
  });

  testWidgets('a card that is not a gym card draws nothing', (tester) async {
    await pumpDoor(tester);
    _ref.read(gymGreetingProvider.notifier).show(
          const GymAnswer.notGym(),
          seconds: 6,
        );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // Asserted on what is drawn rather than on IgnorePointer, which Flutter
    // itself puts in the tree three times over for its own reasons.
    expect(find.textContaining('Welcome'), findsNothing,
        reason: 'notGym has nothing to say and must not paint a panel');
    expect(find.textContaining('Recorded'), findsNothing);
    expect(find.text('the sale screen'), findsOneWidget);
  });

  testWidgets('a touch on the Gym page takes the greeting away early',
      (tester) async {
    // The one moment there demonstrably IS a person at the till.
    await pumpDoor(tester);
    final notifier = _ref.read(gymGreetingProvider.notifier);
    notifier.show(entered(), seconds: 30);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.textContaining('Sarah'), findsOneWidget);

    notifier.dismiss();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.textContaining('Sarah'), findsNothing);
  });
}
