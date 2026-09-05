/// A swipe reaches the till without anybody touching the screen.
///
/// THE FAULT THIS IS HERE FOR
///
/// A venue reported that swiping a membership card did nothing, and that
/// touching the screen anywhere afterwards immediately produced the "New member
/// for this card?" prompt. Three terminals, same behaviour. It read as a broken
/// reader, and it was not: the card was decoded correctly every time.
///
/// [SwipeCardListener] deferred the work to `addPostFrameCallback`, which adds
/// to a queue and does *not* request a frame. A till showing a still sale screen
/// has no frame coming, so the callback waited — for a finger.
///
/// WHY THE ASSERTION IS ABOUT A FRAME AND NOT ABOUT A DIALOG
///
/// `testWidgets` pumps frames on its own, generously. A test that swiped a card
/// and then pumped would pass against the broken version, because the pump is
/// the tap. So the check below is that a completed swipe leaves a frame
/// *scheduled* — measured before anything pumps. That is the property the till
/// actually lacked, stated in the only terms that can tell the two versions
/// apart.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/mock_card_reader.dart';
import 'package:vesopa_epos/data/swipe_cards.dart';
import 'package:vesopa_epos/ui/swipe_listener.dart';

void main() {
  /// The logical key that carries [character], for the simulator.
  ///
  /// A reader types printable characters; what matters downstream is
  /// [KeyEvent.character], and the logical key only has to be a real one that
  /// is not Return. Digits and the two sentinels are all this needs.
  LogicalKeyboardKey keyFor(String character) => switch (character) {
    ';' => LogicalKeyboardKey.semicolon,
    '?' => LogicalKeyboardKey.slash,
    '%' => LogicalKeyboardKey.digit5,
    _ => LogicalKeyboardKey(
      LogicalKeyboardKey.digit0.keyId + int.parse(character),
    ),
  };

  /// Swipe a card the way the reader on the counter does: one key at a time,
  /// through the real [HardwareKeyboard], sentinels included.
  Future<void> swipe(WidgetTester tester, String number) async {
    for (final character in ';$number?'.split('')) {
      final key = keyFor(character);
      await simulateKeyDownEvent(key, character: character);
      await simulateKeyUpEvent(key);
    }
  }

  Widget harness({
    required Future<void> Function(SwipedCard) onCard,
    bool enabled = true,
    Widget? child,
  }) => MaterialApp(
    home: SwipeCardListener(
      onCard: onCard,
      enabled: enabled,
      child: child ?? const Scaffold(body: Text('Ring up an item to start')),
    ),
  );

  // ---------------------------------------------------------------------------
  // The fault
  // ---------------------------------------------------------------------------

  testWidgets('a completed swipe asks for a frame, so nobody has to tap', (
    tester,
  ) async {
    await tester.pumpWidget(harness(onCard: (_) async {}));
    await tester.pumpAndSettle();

    // The precondition the whole test rests on: the till is idle and nothing is
    // going to repaint of its own accord. If this ever stops holding, the check
    // below stops meaning anything, so it is asserted rather than assumed.
    expect(
      tester.binding.hasScheduledFrame,
      isFalse,
      reason: 'the till was not idle before the swipe',
    );

    await swipe(tester, '1000000000003');

    expect(
      tester.binding.hasScheduledFrame,
      isTrue,
      reason: 'the swipe was read but no frame was requested, so the callback '
          'that opens the member prompt would wait for somebody to touch the '
          'screen',
    );
  });

  testWidgets('and the card that arrives is the one on the stripe', (
    tester,
  ) async {
    final seen = <SwipedCard>[];
    await tester.pumpWidget(harness(onCard: (c) async => seen.add(c)));
    await tester.pumpAndSettle();

    await swipe(tester, '1000000000003');
    await tester.pumpAndSettle();

    expect(seen, hasLength(1));
    expect(seen.single.number, '1000000000003');
    expect(seen.single.raw, ';1000000000003?');
    expect(seen.single.via, ReadVia.swipe);
  });

  // ---------------------------------------------------------------------------
  // The rules the deferral must not have broken
  // ---------------------------------------------------------------------------

  testWidgets('the keystrokes never reach the box that has focus', (
    tester,
  ) async {
    // The reason the handler claims keys at all: a loyalty card swiped over an
    // open discount dialog would otherwise type its number into the amount.
    final controller = TextEditingController();
    await tester.pumpWidget(
      harness(
        onCard: (_) async {},
        child: Scaffold(body: TextField(controller: controller, autofocus: true)),
      ),
    );
    await tester.pumpAndSettle();

    await swipe(tester, '999800001');
    await tester.pumpAndSettle();

    expect(controller.text, isEmpty);
  });

  testWidgets('a second card is dropped while the first is being dealt with', (
    tester,
  ) async {
    // Two cards cannot be in front of one clerk at once, and stacking the
    // prompts turns an unsure customer's double swipe into two dialogs.
    final seen = <SwipedCard>[];
    final gate = Completer<void>();
    await tester.pumpWidget(
      harness(
        onCard: (c) async {
          seen.add(c);
          await gate.future;
        },
      ),
    );
    await tester.pumpAndSettle();

    await swipe(tester, '1000000000003');
    await tester.pump();
    await swipe(tester, '1000000000004');
    await tester.pump();

    expect(seen.map((c) => c.number), ['1000000000003']);

    gate.complete();
    await tester.pumpAndSettle();
  });

  testWidgets('a till with no reader hears nothing', (tester) async {
    final seen = <SwipedCard>[];
    await tester.pumpWidget(
      harness(onCard: (c) async => seen.add(c), enabled: false),
    );
    await tester.pumpAndSettle();

    await swipe(tester, '1000000000003');
    await tester.pumpAndSettle();

    expect(seen, isEmpty);
  });

  // ---------------------------------------------------------------------------
  // The mock reader
  // ---------------------------------------------------------------------------

  group('mock reader', () {
    testWidgets('a mocked card arrives exactly as a swiped one does', (
      tester,
    ) async {
      final seen = <SwipedCard>[];
      await tester.pumpWidget(harness(onCard: (c) async => seen.add(c)));
      await tester.pumpAndSettle();

      expect(MockCardReader.instance.swipe('1000000000003'), isTrue);
      await tester.pumpAndSettle();

      expect(seen, hasLength(1));
      expect(seen.single.number, '1000000000003');
      // Framed like a real track-2 read, so anything showing `raw` on a
      // diagnostics screen shows what the counter would have sent.
      expect(seen.single.raw, ';1000000000003?');
    });

    testWidgets('and it asks for a frame too', (tester) async {
      // The mock shares the till's delivery path precisely so that it cannot
      // pass while the real reader is broken. This is that claim, checked.
      await tester.pumpWidget(harness(onCard: (_) async {}));
      await tester.pumpAndSettle();
      expect(tester.binding.hasScheduledFrame, isFalse);

      MockCardReader.instance.swipe('1000000000003');
      // `idle()` and not `pump()`: pumping *is* the tap this test exists to
      // prove is unnecessary. A broadcast stream delivers on a microtask, and
      // draining those is all the delivery needs.
      await tester.idle();

      expect(tester.binding.hasScheduledFrame, isTrue);
      await tester.pumpAndSettle();
    });

    test('typing through the buffer reads the same number back', () {
      // The longer path: characters, sentinels, state machine. For tests that
      // want the reader exercised rather than bypassed, without a widget tree.
      final buffer = SwipeBuffer();
      final card = MockCardReader.typeInto(buffer, number: '999800001');

      expect(card, isNotNull);
      expect(card!.number, '999800001');
      expect(card.raw, ';999800001?');
    });

    test('a card with no digits in it is not a card', () {
      expect(MockCardReader.instance.swipe('   '), isFalse);
    });
  });
}
